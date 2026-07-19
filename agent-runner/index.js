#!/usr/bin/env node

/**
 * Transcription Agent Runner — event-driven, no polling
 *
 * Watches .transcription-trigger via fs.watch (touched by the Python backend
 * whenever a job is ready). On trigger: reads queue, sends to LLM, executes tool.
 *
 * Usage:
 *   node agent-runner/index.js
 *
 * Interactive commands (at the runner> prompt):
 *   status   — Show pending queue items
 *   trigger  — Manually trigger processing
 *   stop     — Shut down
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { fileURLToPath } from "url";
import { callModel } from "./model-client.js";
import { executeToolCall } from "./tool-executor.js";
import { logAction } from "./logger.js";
import { readPending, markCleared, acquireLock, releaseLock } from "./poller.js";
import { sanitizeTranscriptSegments, sanitizeContextString } from "./sanitize.js";
import {
  TOOLS,
  PIPELINE_HINTS,
  PIPELINE_STEPS,
  TERMINAL_TOOLS,
  MAX_PIPELINE_STEPS,
  MAX_RETRIES,
  RETRY_BASE_DELAY,
  OLLAMA_MAX_RETRIES,
  OLLAMA_RETRY_BASE_DELAY,
  EVENT_TEMPLATES,
  SYSTEM_PROMPT_TEMPLATE,
  DELIVERY_TOOL_NAMES,
  LLM_CONTEXT_WINDOW,
} from "./agent-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".runner.pid");
const QUEUE_DIR = process.env.TRANSCRIPTION_QUEUE_DIR || path.resolve(__dirname, "..", "queue");
const TRIGGER_FILE = path.join(QUEUE_DIR, ".transcription-trigger");
const TASK_CHECK_INTERVAL = parseInt(process.env.TASK_CHECK_INTERVAL || "60000", 10);

const LLM_PROVIDER = process.env.LLM_PROVIDER || "deepseek";

// ── Config loaded from agent-config/tools.json + agent-config/pipeline.json ──
// TOOLS, PIPELINE_HINTS, TERMINAL_TOOLS, MAX_PIPELINE_STEPS, MAX_RETRIES,
// RETRY_BASE_DELAY, OLLAMA_MAX_RETRIES, OLLAMA_RETRY_BASE_DELAY, and
// EVENT_TEMPLATES are all imported from ./agent-config.js

/**
 * Enqueue a failed event directly to the queue file and touch the trigger,
 * so the pipeline status is properly recorded and the UI can display the error.
 * This mirrors what the Python agent_bridge.py's enqueue_failed does.
 */
function enqueueFailed(event, errorMsg) {
  // Guard against infinite loops: if the event is already a retry from the
  // agent-runner (e.g., "No handler" errors), don't re-enqueue — it will
  // just fail again with the same error and burn tokens forever.
  if (event.source === "agent-runner") {
    console.log(`⛔ [RUNNER] Not re-enqueuing failed event from agent-runner (source=${event.source}) — prevents infinite loop`);
    return;
  }

  try {
    const queueDir = process.env.TRANSCRIPTION_QUEUE_DIR || path.resolve(__dirname, "..", "queue");
    const queueFile = path.join(queueDir, "transcription.jsonl");
    const triggerFile = path.join(queueDir, ".transcription-trigger");

    // Carry forward skip_steps and original metadata so the retry pipeline
    // has the same constraints as the original run. Without this, the LLM
    // gets ALL tools (including analyze, delivery, etc.) and wastes tokens
    // re-running the full pipeline.
    const originalData = event.data || {};
    const failedEvent = {
      id: crypto.randomUUID(),
      source: "agent-runner",
      type: "failed",
      data: {
        jobId: originalData.jobId || event.id,
        title: originalData.title || "Unknown",
        error: errorMsg,
        originalType: event.type,
        // Preserve skip_steps so the retry doesn't expose irrelevant tools
        skip_steps: originalData.skip_steps,
        // Preserve transcript so the retry has immediate access to it
        transcript: originalData.transcript,
        attendees: originalData.attendees,
        eventType: originalData.eventType,
      },
      queuedAt: new Date().toISOString(),
    };

    fs.appendFileSync(queueFile, JSON.stringify(failedEvent) + "\n", "utf8");

    // Touch the trigger so the poller/mainLoop picks it up
    try {
      if (fs.existsSync(triggerFile)) {
        fs.utimesSync(triggerFile, new Date(), new Date());
      } else {
        fs.writeFileSync(triggerFile, "");
      }
    } catch {
      /* non-fatal */
    }

    console.log(`📝 [RUNNER] Failed event enqueued for job ${event.data?.jobId?.slice(0, 8) || "?"}`);
  } catch (err) {
    console.error(`❌ [RUNNER] Could not enqueue failed event: ${err.message}`);
  }
}

/**
 * Retry an async function with exponential backoff.
 * Uses Ollama-specific retry config when LLM_PROVIDER is "ollama".
 * Returns the result on success, or throws after all retries are exhausted.
 */
async function withRetry(fn, label, maxRetries) {
  const isOllama = LLM_PROVIDER === "ollama";
  const retries = maxRetries ?? (isOllama ? OLLAMA_MAX_RETRIES : MAX_RETRIES);
  const baseDelay = isOllama ? OLLAMA_RETRY_BASE_DELAY : RETRY_BASE_DELAY;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`🔄 [RUNNER] ${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function processEvent(event) {
  const eventId = event.id;
  const tag = eventId?.slice(0, 8) || "???";

  // Emit a machine-parseable marker so the Electron main process can track
  // which job the agent is currently processing and route log entries to the
  // correct per-job pipeline.log file. The backend-manager.ts parses this.
  console.log(`[JOB_START] ${event.data?.jobId || eventId}`);

  console.log(`\n   ╔══════════════════════════════════════════╗`);
  console.log(`   ║   🔄 JOB ${tag.padEnd(27)}║`);
  console.log(`   ╚══════════════════════════════════════════╝`);
  console.log(`   📋 ${event.source}/${event.type} — "${event.data?.title || "?"}"`);

  acquireLock(eventId);
  const jobData = event.data || {};
  const rawTranscript = jobData.transcript || [];

  // Sanitize transcript data before building LLM context (Tier 2 — optional)
  const transcript = sanitizeTranscriptSegments(rawTranscript);

  // ── Failed event guard ──
  // If the ML pipeline reported a failure (event.type === "failed"), skip LLM
  // processing entirely. The job is already marked as "failed" by the pipeline.
  if (event.type === "failed") {
    const errMsg = jobData.error || "Unknown pipeline error";
    console.log(`⏭️  [RUNNER] Skipping failed event (event.type=failed): ${errMsg}`);
    logAction({ eventId, eventType: event.type, action: "skipped", detail: `Pipeline failed: ${errMsg}` });
    markCleared(eventId);
    releaseLock(eventId);
    return;
  }

  // ── Empty transcript guard ──
  // If the ML pipeline failed (no transcript produced), skip LLM processing
  // entirely to avoid wasting tokens on empty content. The job is marked as
  // complete with a warning so the frontend knows there's nothing to show.
  const transcriptHasContent = transcript.some((seg) => seg.text && seg.text.trim().length > 0);
  if (!transcriptHasContent && (event.type === "ready_for_processing" || event.type === "labeling_needed")) {
    console.log(`⏭️  [RUNNER] Empty transcript — skipping LLM processing (event.type=${event.type})`);
    console.log(`⏭️  [RUNNER]   Transcript has ${transcript.length} segment(s), 0 words of text`);
    logAction({ eventId, eventType: event.type, action: "skipped", detail: "Empty transcript — no LLM processing needed" });
    try {
      const jobId = jobData.jobId || eventId;
      const errorMsg = "ML pipeline produced empty transcript — check pipeline logs for details";
      await executeToolCall("transcribe_fail_job", { jobId, error: errorMsg });
      console.log(`❌ [RUNNER] Job ${jobId.slice(0, 8)} marked as failed (empty transcript — pipeline error)`);
    } catch (completeErr) {
      console.log(`⚠️  [RUNNER] Could not update job status for empty transcript: ${completeErr.message}`);
    }
    markCleared(eventId);
    releaseLock(eventId);
    return;
  }

  // Sanitize context strings (Tier 2 — optional)
  const safeTitle = sanitizeContextString(jobData.title || "");
  const safeAttendees = (jobData.attendees || []).map((a) => sanitizeContextString(a));

  // Build initial context with job info + transcript preview
  let context = buildInitialContext(event, transcript, safeTitle, safeAttendees, eventId);
  const initialContextLength = context.length;
  console.log(`📝 [RUNNER] Initial context built: ${context.length} chars`);

  // Use TRANSCRIPTION_STORAGE env var if set (matches Python backend), otherwise fall back to project-relative path.
  const STORAGE_BASE = process.env.TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");

  // ── Phase B: Enrich the job's config_snapshot with agent-runner config ──
  // The Python backend captured its own config at upload time (Phase A).
  // Now we add the agent runner's config: LLM provider, tools, pipeline steps,
  // system prompt, delivery settings, and logging config.
  {
    const jobId = jobData.jobId || eventId;
    const agentConfigSnapshot = {
      // ── LLM / Agent config ──
      llm_provider: process.env.LLM_PROVIDER || "deepseek",
      llm_model:
        process.env.LLM_PROVIDER === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : process.env.API_AGENT_MODEL || "deepseek-v4-flash",
      ollama_base_url: process.env.OLLAMA_BASE_URL || "",
      ollama_model: process.env.OLLAMA_MODEL || "",
      ollama_num_ctx: process.env.OLLAMA_NUM_CTX || "",
      llm_temperature: process.env.LLM_TEMPERATURE || "",

      // ── Agent instructions (from agent-config/) ──
      agent_tools: TOOLS.map((t) => t.name),
      agent_pipeline_steps: PIPELINE_STEPS.map((s) => ({
        id: s.id,
        toolName: s.toolName,
        label: s.label,
        enabled: s.enabled,
        isTerminal: s.isTerminal,
      })),
      // Full pipeline step details with descriptions and templates
      agent_pipeline_steps_full: PIPELINE_STEPS.map((s) => ({
        id: s.id,
        toolName: s.toolName,
        label: s.label,
        description: s.description,
        systemPromptTemplate: s.systemPromptTemplate || "",
        hintTemplate: s.hintTemplate || "",
        enabled: s.enabled,
        isTerminal: s.isTerminal,
      })),
      agent_terminal_tools: [...TERMINAL_TOOLS],
      agent_system_prompt_length: SYSTEM_PROMPT_TEMPLATE.length,
      agent_system_prompt: SYSTEM_PROMPT_TEMPLATE,
      agent_pipeline_hints: Object.keys(PIPELINE_HINTS).length,
      agent_pipeline_hints_full: { ...PIPELINE_HINTS },
      agent_event_templates: { ...EVENT_TEMPLATES },
      agent_max_pipeline_steps: MAX_PIPELINE_STEPS,
      agent_llm_context_window: LLM_CONTEXT_WINDOW,
      agent_ollama_max_retries: OLLAMA_MAX_RETRIES,
      agent_ollama_retry_base_delay_ms: OLLAMA_RETRY_BASE_DELAY,
      agent_max_retries: MAX_RETRIES,
      agent_retry_base_delay_ms: RETRY_BASE_DELAY,

      // ── Delivery config (redacted) ──
      gmail_user: process.env.GMAIL_USER || "",
      delivery_recipient_emails: process.env.DELIVERY_RECIPIENT_EMAILS || "",
      delivery_email_subject: process.env.DELIVERY_EMAIL_SUBJECT || "",
      delivery_drive_folder: process.env.DELIVERY_DRIVE_FOLDER || "",

      // ── Logging config ──
      log_llm_data: process.env.LOG_LLM_DATA || "false",
      log_collapse_repeated_prefixes: process.env.LOG_COLLAPSE_REPEATED_PREFIXES || "true",
    };

    try {
      await executeToolCall("transcribe_upsert_job", {
        jobId,
        configSnapshot: JSON.stringify(agentConfigSnapshot),
      });
      console.log(`📸 [RUNNER] Agent config snapshot upserted for job ${jobId.slice(0, 8)}`);
    } catch (snapshotErr) {
      console.log(`⚠️  [RUNNER] Failed to upsert agent config snapshot: ${snapshotErr.message}`);
    }
  }

  // ── Configurable: Fetch existing memory context before the pipeline starts ──
  // Controlled by the "_fetch_memory_context" pipeline step in pipeline.json.
  // (ConfigPanel → Agent Instructions → Pipeline Steps). When the step is
  // unchecked/disabled, skips all ephemeral and semantic memory queries to
  // reduce LLM context size and save tokens.
  const memoryStep = PIPELINE_STEPS.find((s) => s.toolName === "_fetch_memory_context");
  const useMemory = memoryStep ? memoryStep.enabled : true;
  if (!useMemory) {
    console.log(`⏭️  [RUNNER] Memory context disabled via pipeline step (_fetch_memory_context)`);
  } else {
    try {
      // 1. Query ephemeral memory for existing action items, decisions, budgets
      const [queryActions, queryDecisions, queryBudgets] = await Promise.allSettled([
        executeToolCall("transcribe_query_ephemeral", { table: "action_items", limit: 15 }),
        executeToolCall("transcribe_query_ephemeral", { table: "decisions", limit: 10 }),
        executeToolCall("transcribe_query_ephemeral", { table: "budgets", limit: 10 }),
      ]);

      const memoryLines = ["", "── Existing Memory Context (use for continuity, not dedup) ──"];

      if (queryActions.status === "fulfilled" && queryActions.value?.results?.length) {
        const items = queryActions.value.results;
        const totalCount = items.length;
        const openItems = items.filter((ai) => ai.status === "open");
        memoryLines.push(`Action items: ${openItems.length} open of ${totalCount} total in history`);
        for (const ai of openItems.slice(0, 6)) {
          const meeting = ai.source_meeting ? ` [from: ${ai.source_meeting}]` : "";
          memoryLines.push(`  - ${ai.description} (assignee: ${ai.assignee || "unassigned"}${meeting})`);
        }
      }
      if (queryDecisions.status === "fulfilled" && queryDecisions.value?.results?.length) {
        const items = queryDecisions.value.results;
        memoryLines.push(`Recent decisions (${items.length} total in history):`);
        for (const d of items.slice(0, 5)) {
          const meeting = d.source_meeting ? ` [from: ${d.source_meeting}]` : "";
          memoryLines.push(`  - ${d.description}${meeting}`);
        }
      }
      if (queryBudgets.status === "fulfilled" && queryBudgets.value?.results?.length) {
        const items = queryBudgets.value.results;
        memoryLines.push(`Recent budget items (${items.length} total in history):`);
        for (const b of items.slice(0, 5)) {
          const meeting = b.source_meeting ? ` [from: ${b.source_meeting}]` : "";
          memoryLines.push(`  - ${b.description} (${b.currency || "USD"} ${b.amount})${meeting}`);
        }
      }

      // 2. Try semantic search for similar past meetings by title
      const titleWords = safeTitle
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 4)
        .join(" ");
      let semanticResult = null;
      if (titleWords) {
        semanticResult = await executeToolCall("transcribe_search_memory", {
          query: titleWords,
          nResults: 3,
        });
        if (semanticResult?.results?.length) {
          memoryLines.push(`Similar past meetings:`);
          for (const r of semanticResult.results.slice(0, 3)) {
            const meta = r.metadata || {};
            memoryLines.push(`  - "${meta.title || "?"}" (relevance: ${(1 - r.score).toFixed(2)})`);
          }
        }
      }

      memoryLines.push("── End Memory Context ──\n");
      context += "\n" + memoryLines.join("\n");
      const memoryContextLen = memoryLines.join("\n").length;
      console.log(`✅ [RUNNER] Memory context injected (${memoryLines.length - 3} items, ${memoryContextLen} chars)`);
      console.log(`📝 [RUNNER] Context now: ${context.length} chars (was ${initialContextLength}, +${context.length - initialContextLength})`);
    } catch (err) {
      console.log(`⚠️  [RUNNER] Memory fetch failed (non-fatal): ${err.message}`);
    }
  }

  // ── Skip-steps configuration ──
  // `skip_steps` is an array of tool names to exclude from the LLM's available
  // tools. Default skips analysis and delivery. When a tool is skipped, the
  // pipeline hint chain is walked forward past it so the LLM gets the correct
  // "what to do next" guidance.
  const skippedTools = new Set(jobData.skip_steps || []);
  if (skippedTools.size > 0) {
    console.log(`⏭️  [RUNNER] Skipped tools: ${[...skippedTools].join(", ")}`);
  }

  // Filter the available tools: remove any that are in the skip list
  let availableTools = TOOLS.filter((t) => !skippedTools.has(t.name));
  let summarizeCalled = false;
  let hasReadTranscript = false;
  let hasCalledAnalyze = false;
  let hasSavedContext = false;
  let forcedStepRetries = 0;
  const MAX_FORCED_STEP_RETRIES = 3;

  // ── Render the system prompt ──
  // Generate a version of the system prompt with skipped sections removed
  // and {{TOOL_LIST}} injected. Pass it directly to callModel() in-memory
  // so model-client.js doesn't need any stripping logic.
  let renderedPrompt = null;
  {
    console.log(`📝 [RUNNER] Compiling system prompt from template (${SYSTEM_PROMPT_TEMPLATE.length} chars)`);
    console.log(`📝 [RUNNER]   Injecting ${availableTools.length} tool definitions into {{TOOL_LIST}}`);
    const toolLines = availableTools.map((t) => `  - ${t.name}: ${t.description}`).join("\n");
    let rendered = SYSTEM_PROMPT_TEMPLATE.replace("{{TOOL_LIST}}", toolLines);
    console.log(`📝 [RUNNER]   System prompt after tool injection: ${rendered.length} chars`);

    // Strip numbered sections that reference skipped tools
    if (skippedTools.size > 0) {
      console.log(`📝 [RUNNER]   Stripping sections for ${skippedTools.size} skipped tool(s):`);
      for (const toolName of skippedTools) {
        const sectionRegex = new RegExp(
          `\\d+\\.\\s+\\*\\*[^*]+\\*\\*\\s+[—–-]\\s+[^\\n]*\\b${toolName}\\b[^\\n]*(?:\\n(?!\\d+\\.\\s+\\*\\*|##|$)[^\\n]*)*`,
          "g",
        );
        rendered = rendered.replace(sectionRegex, "");
        const commentRegex = new RegExp(`<!--\\s*\\d+\\.\\s+\\*\\*[^*]+\\*\\*[^>]*\\b${toolName}\\b[^>]*-->`, "g");
        rendered = rendered.replace(commentRegex, "");
        console.log(`📝 [RUNNER]     - ${toolName}`);
      }
      rendered = rendered.replace(/\n{3,}/g, "\n\n").trim();
      console.log(
        `   📝 [RUNNER]   System prompt after stripping: ${rendered.length} chars (removed ${SYSTEM_PROMPT_TEMPLATE.length - rendered.length} chars)`,
      );
    }
    renderedPrompt = rendered;

    // Log the full instruction composition breakdown
    const contextBeforeLLM = context;
    const totalInstructionsLength = renderedPrompt.length + contextBeforeLLM.length;
    console.log(`\n📝 [RUNNER] ═══ Instructions Composition Breakdown ═══`);
    console.log(
      `   📝 [RUNNER]   System prompt          : ${renderedPrompt.length.toString().padStart(7)} chars (${((renderedPrompt.length / totalInstructionsLength) * 100).toFixed(1)}%)`,
    );
    console.log(`📝 [RUNNER]     - Template base       : ${SYSTEM_PROMPT_TEMPLATE.length.toString().padStart(7)} chars`);
    console.log(`📝 [RUNNER]     - Tool definitions    : ${toolLines.length.toString().padStart(7)} chars (${availableTools.length} tools)`);
    if (skippedTools.size > 0) {
      console.log(
        `   📝 [RUNNER]     - Stripped sections   : removed ${(SYSTEM_PROMPT_TEMPLATE.length - renderedPrompt.length).toString().padStart(4)} chars (${skippedTools.size} tools)`,
      );
    }
    console.log(`📝 [RUNNER]   User context           : ${String(contextBeforeLLM.length).padStart(7)} chars`);
    console.log(`📝 [RUNNER]     - Job metadata        : part of initial context`);
    console.log(`📝 [RUNNER]     - Event template      : from pipeline.json event_templates`);
    console.log(`📝 [RUNNER]     - Transcript preview  : included in event template`);
    console.log(`📝 [RUNNER]     - Memory context      : injected from ephemeral + semantic memory`);
    console.log(`📝 [RUNNER]   Total instructions      : ${totalInstructionsLength.toString().padStart(7)} chars`);
    console.log(`📝 [RUNNER] ═══════════════════════════════════════════\n`);

    // Log the actual built system prompt for debugging
    const promptLine = `   📝 [RUNNER] ═══ Built System Prompt ═══`;
    const promptDivider = `   📝 [RUNNER] ${"=".repeat(50)}`;
    console.log(`\n${promptDivider}`);
    console.log(promptLine);
    console.log(promptDivider);
    // Split into lines and log each with the prefix for readability
    const promptLines = renderedPrompt.split("\n");
    for (const line of promptLines) {
      console.log(`📝 [RUNNER] | ${line}`);
    }
    console.log(`${promptDivider}\n`);
  }

  // Dynamically resolve the next non-skipped pipeline hint.
  // Walks the hint chain: if the next referenced tool is skipped, recurse.
  // Logs every resolution step so the stage-order system is observable.
  function resolveNextHint(currentTool, hints) {
    const hint = hints[currentTool];
    if (!hint) {
      console.log(`🔍 [RUNNER] resolveNextHint("${currentTool}"): no hint defined — LLM will decide autonomously`);
      return null;
    }
    console.log(`🔍 [RUNNER] resolveNextHint("${currentTool}"): hint found — "${hint}"`);
    // Extract the first referenced tool name from the hint prose
    const match = hint.match(/\b(transcribe_\w+)\b/);
    if (!match) {
      console.log(`🔍 [RUNNER] resolveNextHint: no next tool reference in hint, returning as-is`);
      return hint;
    }
    const nextTool = match[0];
    if (skippedTools.has(nextTool)) {
      console.log(`⏭️  [RUNNER] resolveNextHint: "${nextTool}" is in skip list, walking past it`);
      // Try the hint of the tool after the skipped one
      const nextHint = hints[nextTool];
      if (!nextHint) {
        console.log(`⏭️  [RUNNER] resolveNextHint: no hint for skipped "${nextTool}", returning original hint (fallback)`);
        return hint;
      }
      const nextMatch = nextHint.match(/\b(transcribe_\w+)\b/);
      if (nextMatch && skippedTools.has(nextMatch[0])) {
        // Multiple consecutive skips — recurse deeper
        console.log(`🔄 [RUNNER] resolveNextHint: "${nextMatch[0]}" is also skipped, recursing deeper`);
        const result = resolveNextHint(nextTool, hints);
        return result;
      }
      // Return the hint that points past the skipped tool
      const overridden = nextHint
        .replace(new RegExp(`\\b${nextMatch ? nextMatch[0].replace(/\./g, "\\.") : ""}\\b`), `(skipped ${nextTool}) ${nextMatch ? nextMatch[0] : ""}`)
        .trim();
      console.log(`⏭️  [RUNNER] resolveNextHint: overridden hint — "${overridden.slice(0, 120)}..."`);
      return overridden;
    }
    console.log(`🔍 [RUNNER] resolveNextHint: next tool "${nextTool}" is available, returning original hint`);
    return hint;
  }

  // ── LLM data logging ──
  // When LOG_LLM_DATA=true, every LLM input (context) and output (decision)
  // is saved to <jobStorageDir>/llm-data.jsonl for debugging.
  const LOG_LLM_DATA = process.env.LOG_LLM_DATA === "true";
  const jobStorageDir = path.join(STORAGE_BASE, jobData.jobId || eventId);
  let llmDataStream = null;
  if (LOG_LLM_DATA) {
    try {
      fs.mkdirSync(jobStorageDir, { recursive: true });
      llmDataStream = fs.createWriteStream(path.join(jobStorageDir, "llm-data.jsonl"), { flags: "a" });
    } catch (err) {
      console.log(`⚠️  [RUNNER] Could not open llm-data.jsonl: ${err.message}`);
    }
  }
  function logLlmData(type, data) {
    if (!llmDataStream) return;
    try {
      llmDataStream.write(JSON.stringify({ timestamp: new Date().toISOString(), type, data }) + "\n");
    } catch {
      /* non-fatal */
    }
  }

  // ── Load existing token usage from previous retries ──
  // When a pipeline fails and is retried, we accumulate across runs instead of
  // overwriting, so the frontend shows the total tokens actually burned.
  const jobId = jobData.jobId || eventId;
  const storageDir = path.join(STORAGE_BASE, jobId);
  const existingUsagePath = path.join(storageDir, "usage.json");
  let existingSteps = [];
  if (fs.existsSync(existingUsagePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingUsagePath, "utf8"));
      if (existing.steps?.length) {
        existingSteps = existing.steps;
        console.log(`💰 [RUNNER] Loaded ${existingSteps.length} existing token usage steps — accumulating across retries`);
        console.log(`[USAGE] Job ${jobId?.slice(0, 8) || "???"}: loaded ${existingSteps.length} existing usage steps (retry accumulation)`);
      }
    } catch (err) {
      console.log(`⚠️  [RUNNER] Could not read existing usage.json: ${err.message}`);
    }
  }

  // ── Delivery results tracking ──
  // Captures success/failure data from send_delivery_email, save_to_drive,
  // and create_trello_action_items. Saved to delivery-results.json alongside usage.json.
  const deliveryResults = [];

  /** Track whether a delivery tool has already handled job completion/failure inline. */
  let deliveryHandled = false;

  /** Record a delivery tool result for later persistence. */
  function recordDeliveryResult(toolName, success, resultData, errorMsg) {
    deliveryResults.push({
      tool: toolName,
      success,
      result: resultData || null,
      error: errorMsg || null,
      timestamp: new Date().toISOString(),
    });
  }

  /** Save delivery results to disk immediately. */
  function saveDeliveryResults() {
    if (deliveryResults.length === 0) return;
    try {
      const deliveryData = {
        job_id: jobId,
        title: safeTitle,
        results: deliveryResults,
        summary: {
          total: deliveryResults.length,
          success: deliveryResults.filter((r) => r.success).length,
          failed: deliveryResults.filter((r) => !r.success).length,
        },
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(path.join(storageDir, "delivery-results.json"), JSON.stringify(deliveryData, null, 2), "utf8");
      console.log(
        `   📬 [RUNNER] Delivery results saved for job ${jobId?.slice(0, 8) || "???"}: ${deliveryData.summary.success} success, ${deliveryData.summary.failed} failed`,
      );
    } catch (err) {
      console.log(`⚠️  [RUNNER] Failed to save delivery results: ${err.message}`);
    }
  }

  // ── Multi-step pipeline loop ──
  // Each iteration: LLM picks one tool → executes it → result appended to context
  // Loop ends when a terminal tool is called, LLM returns nothing, or max steps hit.
  let pipelineComplete = false;
  let pipelineError = null;
  const tokenUsage = []; // per-step token usage records for THIS run
  let totalPromptTokens = existingSteps.reduce((sum, s) => sum + (s.prompt_tokens || 0), 0);
  let totalCompletionTokens = existingSteps.reduce((sum, s) => sum + (s.completion_tokens || 0), 0);
  let totalTokens = existingSteps.reduce((sum, s) => sum + (s.total_tokens || 0), 0);

  for (let step = 1; step <= MAX_PIPELINE_STEPS && !pipelineComplete; step++) {
    console.log(`🤖 [RUNNER] Asking LLM (step ${step}) — context: ${context.length} chars, ${availableTools.length} tools available`);
    let decision;
    logLlmData("step_input", {
      step,
      context: context.slice(0, 10000),
      context_length: context.length,
      available_tools: availableTools.map((t) => t.name),
    });
    try {
      decision = await withRetry(() => callModel(context, availableTools, renderedPrompt), `LLM call (step ${step})`);
      logLlmData("step_response", {
        step,
        decision: decision ? { name: decision.name, arguments: decision.arguments, usage: decision.usage } : null,
      });
    } catch (err) {
      const llmRetries = LLM_PROVIDER === "ollama" ? OLLAMA_MAX_RETRIES : MAX_RETRIES;
      pipelineError = `LLM call failed after ${llmRetries} retries: ${err.message}`;
      console.log(`❌ [RUNNER] ${pipelineError}`);
      logLlmData("step_error", { step, error: pipelineError });
      logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
      pipelineComplete = true;
      break;
    }

    // Track token usage from this LLM call
    if (decision?.usage) {
      const stepUsage = {
        step,
        tool: decision.name || "unknown",
        prompt_tokens: decision.usage.prompt_tokens || 0,
        completion_tokens: decision.usage.completion_tokens || 0,
        total_tokens: decision.usage.total_tokens || 0,
      };
      tokenUsage.push(stepUsage);
      totalPromptTokens += stepUsage.prompt_tokens;
      totalCompletionTokens += stepUsage.completion_tokens;
      totalTokens += stepUsage.total_tokens;
      console.log(
        `   💰 [RUNNER] Tracked usage for step ${step} (${decision.name}): ${stepUsage.total_tokens} tokens (prompt: ${stepUsage.prompt_tokens}, completion: ${stepUsage.completion_tokens})`,
      );
      console.log(`[USAGE] Step ${step} (${decision.name}): ${stepUsage.total_tokens} tokens`);
    } else {
      console.log(`⚠️  [RUNNER] No usage data from LLM at step ${step} — decision.usage is ${JSON.stringify(decision?.usage)}`);
    }

    // ── Touchpoint C: Persist cumulative LLM progress ──
    // After each step, upsert the running token total so the jobs table
    // has a record of LLM progress even if the pipeline is interrupted.
    if (tokenUsage.length > 0 || totalTokens > 0) {
      try {
        await executeToolCall("transcribe_upsert_job", {
          jobId,
          totalPromptTokens,
          totalCompletionTokens,
          totalTokens,
          llmProvider: process.env.LLM_PROVIDER || "deepseek",
          llmModel:
            process.env.LLM_PROVIDER === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : process.env.API_AGENT_MODEL || "deepseek-v4-flash",
          pipelineSteps: JSON.stringify([...existingSteps, ...tokenUsage]),
        });
      } catch (upsertErr) {
        console.log(`⚠️  [RUNNER] Failed to upsert job usage at step ${step}: ${upsertErr.message}`);
      }
    }

    if (!decision || !decision.name) {
      // ── Forced step enforcement ──
      // When the LLM returns null without calling a tool, check whether a mandatory
      // pipeline step is pending. If so, re-prompt with a strong directive instead
      // of ending the pipeline. This prevents the LLM from skipping summarization,
      // analysis, or memory persistence.
      if (hasReadTranscript && !summarizeCalled) {
        forcedStepRetries++;
        if (forcedStepRetries >= MAX_FORCED_STEP_RETRIES) {
          console.log(`⏭️  [RUNNER] Forced step retry limit reached (${MAX_FORCED_STEP_RETRIES}) — ending pipeline`);
          logAction({ eventId, eventType: event.type, action: "complete", detail: `ended at step ${step}, forced step retry limit` });
          pipelineComplete = true;
          break;
        }
        const msg = `[System: Pipeline requires summarization. You MUST call transcribe_summarize now to generate a structured summary of the transcript you have read. This step is mandatory before the pipeline can proceed.]`;
        console.log(
          `⏭️  [RUNNER] No decision — re-prompting: must call transcribe_summarize (retry ${forcedStepRetries}/${MAX_FORCED_STEP_RETRIES})`,
        );
        context += `\n\n${msg}`;
        continue;
      }
      if (summarizeCalled && !hasCalledAnalyze) {
        forcedStepRetries++;
        if (forcedStepRetries >= MAX_FORCED_STEP_RETRIES) {
          console.log(`⏭️  [RUNNER] Forced step retry limit reached (${MAX_FORCED_STEP_RETRIES}) — ending pipeline`);
          logAction({ eventId, eventType: event.type, action: "complete", detail: `ended at step ${step}, forced step retry limit` });
          pipelineComplete = true;
          break;
        }
        const msg = `[System: Pipeline requires analysis. You MUST call transcribe_analyze now to analyze topics, sentiment, entities, and follow-ups. This step is mandatory before the pipeline can proceed.]`;
        console.log(`⏭️  [RUNNER] No decision — re-prompting: must call transcribe_analyze (retry ${forcedStepRetries}/${MAX_FORCED_STEP_RETRIES})`);
        context += `\n\n${msg}`;
        continue;
      }
      if (hasCalledAnalyze && !hasSavedContext) {
        forcedStepRetries++;
        if (forcedStepRetries >= MAX_FORCED_STEP_RETRIES) {
          console.log(`⏭️  [RUNNER] Forced step retry limit reached (${MAX_FORCED_STEP_RETRIES}) — ending pipeline`);
          logAction({ eventId, eventType: event.type, action: "complete", detail: `ended at step ${step}, forced step retry limit` });
          pipelineComplete = true;
          break;
        }
        const msg = `[System: Pipeline requires saving to memory. You MUST call transcribe_save_context now to persist the meeting context to semantic and ephemeral memory. This step is mandatory before the pipeline can proceed.]`;
        console.log(
          `⏭️  [RUNNER] No decision — re-prompting: must call transcribe_save_context (retry ${forcedStepRetries}/${MAX_FORCED_STEP_RETRIES})`,
        );
        context += `\n\n${msg}`;
        continue;
      }
      console.log(`⏭️  [RUNNER] No decision — pipeline complete`);
      logAction({ eventId, eventType: event.type, action: "complete", detail: `ended at step ${step}, no LLM decision` });
      pipelineComplete = true;
      break;
    }

    // Reset forced-step retry counter on any successful tool call
    forcedStepRetries = 0;

    // ── Validate: reject tools that are no longer in the available set ──
    // The LLM can sometimes return tool calls for tools that were locked
    // (e.g. transcribe_get_transcript after the first read). This guard
    // silently skips them instead of executing, preventing wasted tokens
    // and bogus errors like "Transcript not ready" with missing job IDs.
    if (!availableTools.some((t) => t.name === decision.name)) {
      console.log(`⏭️  [RUNNER] LLM returned locked/removed tool "${decision.name}" — skipping`);
      logAction({
        eventId,
        eventType: event.type,
        action: "skipped",
        detail: `LLM returned locked tool "${decision.name}" at step ${step}`,
      });
      // Append a note to context so the LLM doesn't retry the same tool
      context += `\n\n[Step ${step}] Tool "${decision.name}" is no longer available. Choose a different tool.`;
      continue;
    }

    console.log(`🎯 [RUNNER] ${decision.name}`);
    let result;
    try {
      result = await withRetry(() => executeToolCall(decision.name, decision.arguments), `${decision.name}`);
    } catch (err) {
      const toolRetries = LLM_PROVIDER === "ollama" ? OLLAMA_MAX_RETRIES : MAX_RETRIES;
      pipelineError = `${decision.name} failed after ${toolRetries} retries: ${err.message}`;
      console.log(`❌ [RUNNER] ${pipelineError}`);
      logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
      pipelineComplete = true;
      break;
    }

    // Check for errors returned by the tool (not thrown)
    const ok = result && result.ok !== false;
    const errorMsg = !ok && result?.error ? result.error : null;

    logAction({
      eventId,
      eventType: event.type,
      toolName: decision.name,
      step,
      toolResult: ok ? "success" : "failed",
      error: errorMsg,
    });

    if (!ok) {
      // Record failed delivery result and update terminal steps immediately
      if (DELIVERY_TOOL_NAMES.has(decision.name)) {
        recordDeliveryResult(decision.name, false, null, errorMsg);
        console.log(`📬 [RUNNER] Delivery failure recorded for ${decision.name}: ${errorMsg}`);
        // Save delivery results and mark job failed immediately (within the delivery step)
        saveDeliveryResults();

        // ── Touchpoint D: Persist delivery failure to jobs table ──
        try {
          await executeToolCall("transcribe_upsert_job", {
            jobId,
            deliveryAttempted: true,
            deliveryResults: JSON.stringify(deliveryResults),
            errorMessage: errorMsg,
          });
        } catch (upsertErr) {
          console.log(`⚠️  [RUNNER] Failed to upsert delivery failure: ${upsertErr.message}`);
        }

        try {
          await executeToolCall("transcribe_fail_job", { jobId, error: errorMsg });
          console.log(`✅ [RUNNER] Job ${jobId.slice(0, 8)} marked as failed by delivery tool`);
        } catch (failErr) {
          console.log(`⚠️  [RUNNER] Could not update job status to failed from delivery: ${failErr.message}`);
        }
        deliveryHandled = true;
      }

      pipelineError = errorMsg || `Unknown error in ${decision.name}`;
      console.log(`❌ [RUNNER] ${pipelineError}`);
      logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
      pipelineComplete = true;
      break;
    }

    console.log(`✅ [RUNNER] ${decision.name} succeeded`);

    // ── Log voiceprint identification results ──
    if (decision.name === "transcribe_list_voiceprints") {
      const vps = result?.voiceprints || [];
      if (vps.length > 0) {
        console.log(`🗣️ [RUNNER] Enrolled voiceprints (${vps.length}):`);
        for (const vp of vps) {
          console.log(`🗣️ [RUNNER]   - ${vp.name}${vp.email ? ` (${vp.email})` : ""}`);
        }
      } else {
        console.log(`🗣️ [RUNNER] No enrolled voiceprints`);
      }
    }
    if (decision.name === "transcribe_label_speaker" && result) {
      const labelArgs = decision.arguments || {};
      console.log(`🏷️  [RUNNER] Speaker labeled: ${labelArgs.name || "?"} (speaker_id=${labelArgs.speakerId || "?"})`);
    }

    // ── Record delivery tool results ──
    if (DELIVERY_TOOL_NAMES.has(decision.name)) {
      const resultData = result?.result || null;
      // send_delivery_email now returns per-recipient results when multiple recipients
      if (decision.name === "send_delivery_email" && resultData?.recipients) {
        for (const r of resultData.recipients) {
          recordDeliveryResult(decision.name, r.success, { id: r.id, to: r.email, subject: resultData.subject }, r.error);
        }
        console.log(
          `📬 [RUNNER] Delivery results recorded for send_delivery_email: ${resultData.recipients.filter((r) => r.success).length} success, ${resultData.recipients.filter((r) => !r.success).length} failed`,
        );
      } else {
        recordDeliveryResult(decision.name, true, resultData, null);
        console.log(`📬 [RUNNER] Delivery result recorded for ${decision.name}`);
      }
    }

    // ── One-shot tool removal ──
    // After a transcript has been read successfully, remove the read-transcript
    // tool from the available set so the LLM cannot loop on it. The transcript
    // content is already embedded in the context — re-reading it would only
    // bloat the context window and waste tokens.
    // Also lock speaker-labeling tools — the LLM must summarize before labeling,
    // otherwise it gets sidetracked and never returns to call transcribe_summarize.
    if (decision.name === "transcribe_get_transcript") {
      hasReadTranscript = true;
      availableTools = availableTools.filter(
        (t) => t.name !== "transcribe_get_transcript" && t.name !== "transcribe_label_speaker" && t.name !== "transcribe_list_voiceprints",
      );
      console.log(`🔒 [RUNNER] transcribe_get_transcript + labeling tools locked — must summarize first`);
    }

    // ── Lock transcribe_get_summary until transcribe_summarize is called ──
    // The LLM frequently calls transcribe_get_summary (read-only) instead of
    // transcribe_summarize (write), getting a "Summary not ready" 404. Lock the
    // read tool and unlock it only after summarize succeeds.
    if (decision.name === "transcribe_analyze") {
      hasCalledAnalyze = true;
    }
    if (decision.name === "transcribe_save_context") {
      hasSavedContext = true;
    }
    if (!summarizeCalled) {
      if (decision.name === "transcribe_summarize") {
        summarizeCalled = true;
        // Re-add transcribe_get_summary to availableTools now that summarize was called.
        // Find the tool def from the original TOOLS array so it's the full definition.
        const summaryReadTool = TOOLS.find((t) => t.name === "transcribe_get_summary");
        if (summaryReadTool) {
          availableTools.push(summaryReadTool);
        }
        console.log(`🔓 [RUNNER] transcribe_get_summary unlocked — summarize was called`);
      } else {
        // Remove transcribe_get_summary if it's still in the available set
        const hadIt = availableTools.some((t) => t.name === "transcribe_get_summary");
        if (hadIt) {
          availableTools = availableTools.filter((t) => t.name !== "transcribe_get_summary");
          console.log(`🔒 [RUNNER] transcribe_get_summary locked — must call transcribe_summarize first`);
        }
      }
    }

    // Check if this was a terminal delivery tool — pipeline ends
    // Delivery tools update terminal steps immediately: save results and mark job complete.
    if (TERMINAL_TOOLS.has(decision.name)) {
      console.log(`📬 [RUNNER] Delivery complete — pipeline finished`);
      logAction({ eventId, eventType: event.type, action: "complete", detail: `delivered via ${decision.name}` });
      // Save delivery results and mark job complete immediately (within the delivery step)
      saveDeliveryResults();

      // ── Touchpoint D: Persist delivery results to jobs table ──
      try {
        await executeToolCall("transcribe_upsert_job", {
          jobId,
          deliveryAttempted: true,
          deliveryResults: JSON.stringify(deliveryResults),
        });
      } catch (upsertErr) {
        console.log(`⚠️  [RUNNER] Failed to upsert delivery results: ${upsertErr.message}`);
      }
      try {
        await executeToolCall("transcribe_complete_job", { jobId });
        console.log(`✅ [RUNNER] Job ${jobId.slice(0, 8)} marked as complete by delivery tool`);
      } catch (completeErr) {
        console.log(`⚠️  [RUNNER] Could not update job status to complete from delivery: ${completeErr.message}`);
      }
      deliveryHandled = true;
      pipelineComplete = true;
      break;
    }

    // If delivery tools are skipped and we just saved context, pipeline is done
    if (decision.name === "transcribe_save_context" && skippedTools.size > 0) {
      const hasRemainingDelivery = [...TERMINAL_TOOLS].some((t) => !skippedTools.has(t));
      if (!hasRemainingDelivery) {
        console.log(`⏭️  [RUNNER] Delivery skipped — pipeline finished after save_context`);
        logAction({ eventId, eventType: event.type, action: "complete", detail: "delivery skipped, ended after save_context" });
        pipelineComplete = true;
        break;
      }
    }

    // Append result to context so the LLM knows what happened.
    // For transcribe_get_transcript, format the full transcript as readable text
    // so the LLM can actually see the content and summarize it. Otherwise the
    // LLM gets only a 500-char snippet and loops calling the tool repeatedly.
    let resultBlock;
    if (decision.name === "transcribe_get_transcript" && result?.transcript) {
      const segs = result.transcript;
      const MAX_TRANSCRIPT_SEGMENTS = 200;
      const lines = segs.slice(0, MAX_TRANSCRIPT_SEGMENTS).map((s) => `[${(s.start || 0).toFixed(1)}s] ${s.speaker || "?"}: ${s.text || ""}`);
      const remaining = segs.length - MAX_TRANSCRIPT_SEGMENTS;
      resultBlock = `Full transcript (${segs.length} segments):\n${lines.join("\n")}`;
      if (remaining > 0) {
        resultBlock += `\n... (${remaining} more segments omitted — use the transcript above to generate the summary)`;
      }
      console.log(
        `   📝 [RUNNER] Transcript included in context (${segs.length} segments, showing ${Math.min(segs.length, MAX_TRANSCRIPT_SEGMENTS)})`,
      );
    } else if (decision.name === "transcribe_get_transcript" && result?.text) {
      const text = result.text;
      const MAX_TRANSCRIPT_CHARS = 15000;
      resultBlock = `Transcript text (${text.length} chars):\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}`;
      if (text.length > MAX_TRANSCRIPT_CHARS) {
        resultBlock += `\n... (${text.length - MAX_TRANSCRIPT_CHARS} more chars omitted — use the excerpt above to generate the summary)`;
      }
      console.log(
        `   📝 [RUNNER] Transcript text included in context (${text.length} chars, showing ${Math.min(text.length, MAX_TRANSCRIPT_CHARS)})`,
      );
    } else {
      resultBlock = JSON.stringify(result || "ok").slice(0, 500);
    }
    const contextBeforeUpdate = context.length;
    context += `\n\n[Step ${step} Complete] Tool: ${decision.name}\nResult: ${resultBlock}`;
    const resultBlockLen = context.length - contextBeforeUpdate;

    // Add a hint about the next logical pipeline step, skipping over any
    // tools that are in the skip list.
    let hintAppended = false;
    const hint = resolveNextHint(decision.name, PIPELINE_HINTS);
    if (hint) {
      console.log(`🧭 [RUNNER] Pipeline hint appended for next step: "${hint}"`);
      const hintStart = context.length;
      context += `\n${hint}`;
      const hintLen = context.length - hintStart;
      hintAppended = true;
      const contextLengthDelta = context.length - contextBeforeUpdate;
      console.log(`📝 [RUNNER] Context growth at step ${step}: +${contextLengthDelta} chars (result: +${resultBlockLen}, hint: +${hintLen})`);
    } else {
      const contextLengthDelta = context.length - contextBeforeUpdate;
      console.log(`🧭 [RUNNER] No pipeline hint for "${decision.name}" — LLM will decide next step autonomously`);
      console.log(`📝 [RUNNER] Context growth at step ${step}: +${contextLengthDelta} chars (result only, no hint)`);
    }

    // ── Log step completion for pipeline log visibility ──
    console.log(`[STEP-COMPLETE] Step ${step}: ${decision.name}`);

    // ── Configurable context window ──
    // When LLM_CONTEXT_WINDOW > 0, keep only the last N step result blocks
    // plus the initial context (job metadata + memory). This bounds context
    // growth for long pipelines.
    if (LLM_CONTEXT_WINDOW > 0) {
      const stepMarker = "\n\n[Step ";
      const headerEnd = context.indexOf(stepMarker);
      if (headerEnd !== -1) {
        const afterHeader = context.slice(headerEnd);
        const stepBlocks = afterHeader.split(stepMarker);
        if (stepBlocks.length > LLM_CONTEXT_WINDOW + 1) {
          const keptBlocks = stepBlocks.slice(-LLM_CONTEXT_WINDOW);
          const beforeLen = context.length;
          context = context.slice(0, headerEnd) + keptBlocks.join(stepMarker);
          // Ensure the first kept block's [Step marker is not preceded by a dangling newline
          if (!context.endsWith("\n\n")) {
            context = context.replace(/\n{2,}$/, "\n\n");
          }
          console.log(
            `📝 [RUNNER] Context window trimmed: ${beforeLen} → ${context.length} chars ` +
              `(keeping last ${LLM_CONTEXT_WINDOW} of ${stepBlocks.length - 1} step blocks)`,
          );
        }
      }
    }
  }

  // ── Save token usage data BEFORE marking job as complete/failed ──
  // This avoids a race condition where the frontend polls "complete" status
  // and tries to fetch token usage before the file is written to disk.
  // Also accumulates with any existing steps from previous retries so the
  // frontend shows total tokens actually burned, not just the last retry.
  if (tokenUsage.length > 0 || existingSteps.length > 0) {
    try {
      // Combine existing steps (from previous retries) with new steps from this run
      const allSteps = [...existingSteps, ...tokenUsage];
      // DeepSeek V4 Flash pricing (per 1M tokens): input=$0.25, output=$1.00
      // Ollama is local — no cost but we still track tokens for reference
      const isOllama = (process.env.LLM_PROVIDER || "deepseek") === "ollama";
      const INPUT_RATE_PER_1M = isOllama ? 0 : 0.25;
      const OUTPUT_RATE_PER_1M = isOllama ? 0 : 1.0;
      const inputCost = (totalPromptTokens / 1_000_000) * INPUT_RATE_PER_1M;
      const outputCost = (totalCompletionTokens / 1_000_000) * OUTPUT_RATE_PER_1M;

      const usageData = {
        job_id: jobId,
        title: safeTitle,
        provider: process.env.LLM_PROVIDER || "deepseek",
        model: process.env.LLM_PROVIDER === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : process.env.API_AGENT_MODEL || "deepseek-v4-flash",
        steps: allSteps,
        totals: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalTokens,
        },
        costs: {
          input_cost: parseFloat(inputCost.toFixed(6)),
          output_cost: parseFloat(outputCost.toFixed(6)),
          total_cost: parseFloat((inputCost + outputCost).toFixed(6)),
        },
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(path.join(storageDir, "usage.json"), JSON.stringify(usageData, null, 2), "utf8");
      const traceTag = jobId?.slice(0, 8) || "???";
      console.log(
        `   💰 [RUNNER] Token usage saved: ${totalTokens.toLocaleString()} total tokens across ${allSteps.length} steps (${tokenUsage.length} new + ${existingSteps.length} existing)`,
      );
      console.log(
        `   [USAGE] Token usage saved for job ${traceTag}: ${totalTokens.toLocaleString()} total tokens (${allSteps.length} steps, ${tokenUsage.length} new)`,
      );
    } catch (err) {
      console.log(`⚠️  [RUNNER] Failed to save token usage: ${err.message}`);
    }
  } else {
    const traceTag = jobId?.slice(0, 8) || "???";
    console.log(
      `   ⚠️  [RUNNER] No token usage to save — tokenUsage.length=${tokenUsage.length}, existingSteps.length=${existingSteps.length}. Check upstream logs for why usage was not captured.`,
    );
    console.log(
      `   ⚠️  [USAGE] No token usage to save for job ${traceTag} (tokenUsage: ${tokenUsage.length}, existingSteps: ${existingSteps.length})`,
    );
  }

  // ── Save delivery results (only if not already handled by a delivery tool inline) ──
  if (!deliveryHandled && deliveryResults.length > 0) {
    try {
      const deliveryData = {
        job_id: jobId,
        title: safeTitle,
        results: deliveryResults,
        summary: {
          total: deliveryResults.length,
          success: deliveryResults.filter((r) => r.success).length,
          failed: deliveryResults.filter((r) => !r.success).length,
        },
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(path.join(storageDir, "delivery-results.json"), JSON.stringify(deliveryData, null, 2), "utf8");
      console.log(
        `   📬 [RUNNER] Delivery results saved for job ${jobId?.slice(0, 8) || "???"}: ${deliveryData.summary.success} success, ${deliveryData.summary.failed} failed`,
      );
    } catch (err) {
      console.log(`⚠️  [RUNNER] Failed to save delivery results: ${err.message}`);
    }
  }

  // ── Log instruction building summary at pipeline end ──
  const finalContextLength = context.length;
  const contextGrowth = finalContextLength - initialContextLength;
  console.log(`\n📝 [RUNNER] ═══ Pipeline Instructions Summary ═══`);
  console.log(`📝 [RUNNER]   Initial context            : ${String(initialContextLength).padStart(7)} chars`);
  console.log(`📝 [RUNNER]   Final context              : ${String(finalContextLength).padStart(7)} chars`);
  console.log(
    `   📝 [RUNNER]   Total context growth       : ${String(contextGrowth).padStart(7)} chars (+${contextGrowth > 0 ? ((contextGrowth / initialContextLength) * 100).toFixed(1) : 0}%)`,
  );
  console.log(`📝 [RUNNER]   Pipeline steps             : ${String(tokenUsage.length).padStart(7)}`);
  console.log(`📝 [RUNNER]   Tokens consumed            : ${String(totalTokens).padStart(7)}`);
  const charsPerToken = finalContextLength / Math.max(totalTokens || 1, 1);
  console.log(`📝 [RUNNER]   Avg chars per token        : ${charsPerToken.toFixed(2)}`);
  console.log(`📝 [RUNNER] ════════════════════════════════════════════\n`);

  // Only update job status here if a delivery tool did not already handle it inline.
  // When a delivery tool succeeds or fails, it saves delivery results and calls
  // transcribe_complete_job / transcribe_fail_job immediately within the pipeline loop.
  if (!deliveryHandled) {
    if (pipelineError) {
      console.log(`❌ [RUNNER] Pipeline failed for job ${tag}: ${pipelineError}`);
      logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
      // Directly fail the job on the Python backend so the UI sees the error
      try {
        const jobId = jobData.jobId || eventId;
        await executeToolCall("transcribe_fail_job", { jobId, error: pipelineError });
        console.log(`✅ [RUNNER] Job ${jobId.slice(0, 8)} marked as failed on backend`);
      } catch (failErr) {
        console.log(`⚠️  [RUNNER] Could not update job status to failed: ${failErr.message}`);
      }
      // Also enqueue a failed event as a fallback
      await enqueueFailed(event, pipelineError);
    } else {
      console.log(`✅ [RUNNER] Pipeline finished for job ${tag}`);
      // Mark the job as complete on the backend so the frontend knows all
      // processing (including LLM summarization, analysis, memory context)
      // is done and the summary.json is ready to be fetched.
      try {
        const jobId = jobData.jobId || eventId;
        await executeToolCall("transcribe_complete_job", { jobId });
        console.log(`✅ [RUNNER] Job ${jobId.slice(0, 8)} marked as complete on backend`);
      } catch (completeErr) {
        console.log(`⚠️  [RUNNER] Could not update job status to complete: ${completeErr.message}`);
      }
    }
  } else {
    console.log(`📬 [RUNNER] Job status already updated by delivery tool — skipping post-loop complete/fail`);
  }

  // ── Close LLM data stream ──
  if (llmDataStream) {
    try {
      llmDataStream.end();
    } catch {
      /* non-fatal */
    }
    llmDataStream = null;
  }

  markCleared(eventId);
}

/**
 * Build the initial LLM context for a queue event.
 * Includes job metadata, transcript preview, and pipeline instructions.
 */
function buildInitialContext(event, transcript, safeTitle, safeAttendees, eventId) {
  const jobData = event.data || {};
  const emailRecipients = jobData.emailRecipients || [];
  // Read delivery config from env vars (set via ConfigPanel → config.json)
  const deliverySubject = process.env.DELIVERY_EMAIL_SUBJECT || "Meeting Summary: {title}";
  const deliveryExtraContent = process.env.DELIVERY_EMAIL_ADDITIONAL_CONTENT || "";
  const deliveryDriveFolder = process.env.DELIVERY_DRIVE_FOLDER || "Meeting Transcripts";
  const lines = [
    `Transcription job: "${safeTitle}"`,
    `Attendees: ${safeAttendees.join(", ") || "none"}`,
    `Email recipients for delivery: ${emailRecipients.join(", ") || "none set (will use config defaults)"}`,
    `Delivery email subject template: "${deliverySubject}"`,
    deliveryExtraContent ? `Delivery email additional content: "${deliveryExtraContent}"` : null,
    `Delivery drive folder: "${deliveryDriveFolder}"`,
    `Type: ${jobData.eventType || "unknown"}`,
    `Job ID: ${jobData.jobId || eventId}`,
    ``,
  ].filter(Boolean);

  console.log(`📝 [BUILD-CONTEXT] Building initial context for event type "${event.type}"`);
  console.log(`📝 [BUILD-CONTEXT]   Metadata section: job title, ${safeAttendees.length} attendee(s), delivery config`);

  // Use event templates from agent-config/pipeline.json, with variable substitution
  const template = EVENT_TEMPLATES[event.type] || "";
  const templateName = template ? `event_templates["${event.type}"]` : "none (using fallback)";
  console.log(`📝 [BUILD-CONTEXT]   Template: ${templateName}`);
  if (template) {
    console.log(`📝 [BUILD-CONTEXT]   Template raw length: ${template.length} chars`);
    // Log variable substitutions that will be applied
    const substitutions = [
      { var: "{{segment_count}}", value: String(transcript.length) },
      { var: "{{error}}", value: jobData.error || "unknown" },
      { var: "{{error_message}}", value: jobData.error || "unknown" },
    ];
    if (event.type === "ready_for_processing")
      substitutions.push({ var: "{{transcript_preview}}", value: `${Math.min(transcript.length, 50)} segments preview` });
    if (event.type === "labeling_needed")
      substitutions.push({ var: "{{speaker_details}}", value: `${(jobData.unknownSpeakers || []).length} unknown speakers` });
    console.log(`📝 [BUILD-CONTEXT]   Variable substitutions: ${substitutions.map((s) => `${s.var} → ${s.value}`).join(", ")}`);

    const nonSpeakingList = (jobData.nonSpeakingAttendees || []).join(", ") || "none";
    const rendered = template
      .replace("{{segment_count}}", String(transcript.length))
      .replace("{{error}}", jobData.error || "unknown")
      .replace("{{error_message}}", jobData.error || "unknown")
      .replace("{{non_speaking_attendees}}", nonSpeakingList);

    // Build transcript preview for ready_for_processing (capped at 5000 chars)
    if (event.type === "ready_for_processing") {
      const MAX_PREVIEW_CHARS = 5000;
      const previewLines = [];
      let previewChars = 0;
      for (const seg of transcript) {
        const line = `  [${seg.start?.toFixed(1)}s] ${seg.speaker}: ${(seg.text || "").slice(0, 100)}`;
        if (previewChars + line.length > MAX_PREVIEW_CHARS && previewLines.length > 0) break;
        previewLines.push(line);
        previewChars += line.length;
      }
      const remaining = transcript.length - previewLines.length;
      if (remaining > 0) previewLines.push(`  ... (${remaining} more segments omitted — preview capped at ${MAX_PREVIEW_CHARS} chars)`);
      const transcriptPreview = previewLines.join("\n");
      console.log(
        `   📝 [BUILD-CONTEXT]   Transcript preview: ${previewLines.length} segments, ${previewChars} chars${remaining > 0 ? ` (${remaining} more omitted)` : ""}`,
      );
      lines.push(rendered.replace("{{transcript_preview}}", transcriptPreview));
    } else if (event.type === "labeling_needed") {
      const speakerLines = [];
      for (const uk of jobData.unknownSpeakers || []) {
        speakerLines.push(`  - ${uk.speaker_id}: "${(uk.sample_text || "").slice(0, 80)}"`);
      }
      console.log(`📝 [BUILD-CONTEXT]   Unknown speakers: ${(jobData.unknownSpeakers || []).length} speaker(s) in preview`);
      lines.push(rendered.replace("{{speaker_details}}", speakerLines.join("\n")));
    } else {
      lines.push(rendered);
    }
  } else {
    console.log(`📝 [BUILD-CONTEXT]   No template found for event type "${event.type}" — using hard-coded fallback`);
    // Fallback if no template is defined for this event type
    if (event.type === "ready_for_processing") {
      console.log(`📝 [BUILD-CONTEXT]   Fallback: inline transcript preview (${transcript.length} segments)`);
      lines.push(`Transcript (${transcript.length} segments):`);
      for (const seg of transcript.slice(0, 10)) {
        lines.push(`  [${seg.start?.toFixed(1)}s] ${seg.speaker}: ${(seg.text || "").slice(0, 100)}`);
      }
      if (transcript.length > 10) lines.push(`  ... (${transcript.length - 10} more)`);
    } else if (event.type === "labeling_needed") {
      console.log(`📝 [BUILD-CONTEXT]   Fallback: inline unknown speakers (${(jobData.unknownSpeakers || []).length})`);
      lines.push(`Unknown speakers detected:`);
      for (const uk of jobData.unknownSpeakers || []) {
        lines.push(`  - ${uk.speaker_id}: "${(uk.sample_text || "").slice(0, 80)}"`);
      }
    } else if (event.type === "failed") {
      console.log(`📝 [BUILD-CONTEXT]   Fallback: inline error message`);
      lines.push(`Processing failed. Error: ${jobData.error || "unknown"}`);
    }
  }

  const result = lines.join("\n");
  const sectionCount = lines.filter(Boolean).length;
  console.log(`📝 [BUILD-CONTEXT]   Total sections in context: ${sectionCount}, total length: ${result.length} chars`);
  return result;
}

// ── Main loop ──
// The shared entry point for all three activation paths:
//   1. fs.watch push event (primary)
//   2. setInterval fallback poll (safety net)
//   3. Startup check (catch up after restart)
//
// isProcessing acts as a concurrency gate — if a trigger fires while a job
// is already being processed, the subsequent call returns immediately.
// This prevents overlapping pipeline runs for different events.
//
// watchTimer is used by fs.watch's debounce (declared in scope so the
// closure inside the watch handler can clear/reset it). It is NOT a poll
// interval.
let isProcessing = false;
let watchTimer = null;

async function mainLoop() {
  if (isProcessing) return;
  isProcessing = true;

  const pending = readPending();
  if (pending.length > 0) {
    console.log(`\n🔔 [RUNNER] ${pending.length} pending job(s)`);
    await processEvent(pending[0]);
  }

  isProcessing = false;
}

// ── Startup ──

const provider = process.env.LLM_PROVIDER || "deepseek";
const model = provider === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : process.env.API_AGENT_MODEL || "deepseek-v4-flash";
console.log(`\n${"─".repeat(50)}`);
console.log(`   🎙️  Transcription Agent Runner`);
console.log(`   🤖 ${provider} (${model})`);
console.log(`   🔄 fs.watch on .transcription-trigger (push-based)`);
console.log(`   🛠️  ${TOOLS.length} tools`);
console.log(`${"─".repeat(50)}\n`);

fs.writeFileSync(PID_FILE, String(process.pid));

// ── Ensure trigger file exists ──
// The Python backend (agent_bridge.py) touches this file via os.utime()
// after writing an event to queue/transcription.jsonl. If the file doesn't
// exist yet (first run), create it so fs.watch has something to observe.
try {
  if (!fs.existsSync(TRIGGER_FILE)) fs.writeFileSync(TRIGGER_FILE, "");
} catch {
  /* */
}

// ── PRIMARY TRIGGER: Push-based via fs.watch ──
// fs.watch is a native OS-level file change notification. When the Python
// backend calls os.utime() on .transcription-trigger, the kernel pushes a
// change event to this Node.js process — no polling required.
//
// The watchTimer (100ms debounce) coalesces rapid multiple firings that
// can occur on macOS (fs.watch often fires 2-3 times per single utime).
// This is NOT a polling interval — it's a guard against duplicate processing.
const watcher = fs.watch(TRIGGER_FILE, () => {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => mainLoop(), 100);
});

// ── FALLBACK: Timer-based polling ──
// TASK_CHECK_INTERVAL (default: 60000ms = 1 minute) acts as a safety net.
// fs.watch can silently fail on network filesystems, Docker-mounted volumes,
// or when rapid file replacements occur. This fallback ensures the queue
// is never stranded even if the push mechanism misses an event.
// Set TASK_CHECK_INTERVAL=0 in environment to disable polling entirely.
let taskTimer = null;
if (TASK_CHECK_INTERVAL > 0) taskTimer = setInterval(mainLoop, TASK_CHECK_INTERVAL);

// ── Initial startup check ──
// If a job was enqueued while the runner was offline, pick it up immediately
// without waiting for the next fs.watch event or poll interval.
mainLoop();

// ── Interactive terminal ──

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "runner> ", terminal: true });
rl.prompt();

rl.on("line", (input) => {
  const cmd = input.trim().toLowerCase();
  if (["stop", "exit", "quit"].includes(cmd)) {
    console.log("   👋 Shutting down...");
    watcher.close();
    if (taskTimer) clearInterval(taskTimer);
    rl.close();
    process.exit(0);
  } else if (cmd === "status") {
    const items = readPending();
    console.log(`   📋 Queue: ${items.length} pending`);
    for (const item of items) console.log(`      ${item.id?.slice(0, 8)} ${item.source}/${item.type} — "${item.data?.title || "?"}"`);
    rl.prompt();
  } else if (cmd === "trigger") {
    try {
      fs.utimesSync(TRIGGER_FILE, new Date(), new Date());
      console.log("   🔔 Triggered");
    } catch {
      console.log("   ❌ Failed");
    }
    rl.prompt();
  } else if (cmd === "help") {
    console.log("   stop/exit/quit  — Shut down");
    console.log("   status — Show queue");
    console.log("   trigger — Manually trigger");
    rl.prompt();
  } else {
    rl.prompt();
  }
});

rl.on("close", () => process.exit(0));
