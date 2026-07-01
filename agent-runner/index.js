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
  TERMINAL_TOOLS,
  MAX_PIPELINE_STEPS,
  MAX_RETRIES,
  RETRY_BASE_DELAY,
  EVENT_TEMPLATES,
  SYSTEM_PROMPT_TEMPLATE,
} from "./agent-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".runner.pid");
const QUEUE_DIR = process.env.TRANSCRIPTION_QUEUE_DIR || path.resolve(__dirname, "..", "queue");
const TRIGGER_FILE = path.join(QUEUE_DIR, ".transcription-trigger");
const TASK_CHECK_INTERVAL = parseInt(process.env.TASK_CHECK_INTERVAL || "60000", 10);

// ── Config loaded from agent-config/tools.json + agent-config/pipeline.json ──
// TOOLS, PIPELINE_HINTS, TERMINAL_TOOLS, MAX_PIPELINE_STEPS, MAX_RETRIES,
// RETRY_BASE_DELAY, and EVENT_TEMPLATES are all imported from ./agent-config.js

/**
 * Enqueue a failed event directly to the queue file and touch the trigger,
 * so the pipeline status is properly recorded and the UI can display the error.
 * This mirrors what the Python agent_bridge.py's enqueue_failed does.
 */
function enqueueFailed(event, errorMsg) {
  try {
    const queueDir = process.env.TRANSCRIPTION_QUEUE_DIR || path.resolve(__dirname, "..", "queue");
    const queueFile = path.join(queueDir, "transcription.jsonl");
    const triggerFile = path.join(queueDir, ".transcription-trigger");

    const failedEvent = {
      id: crypto.randomUUID(),
      source: "agent-runner",
      type: "failed",
      data: {
        jobId: event.data?.jobId || event.id,
        title: event.data?.title || "Unknown",
        error: errorMsg,
        originalType: event.type,
      },
      queuedAt: new Date().toISOString(),
    };

    fs.mkdirSync(queueDir, { recursive: true });
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

    console.log(`   📝 [RUNNER] Failed event enqueued for job ${event.data?.jobId?.slice(0, 8) || "?"}`);
  } catch (err) {
    console.error(`   ❌ [RUNNER] Could not enqueue failed event: ${err.message}`);
  }
}

/**
 * Retry an async function with exponential backoff.
 * Returns the result on success, or throws after all retries are exhausted.
 */
async function withRetry(fn, label, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`   🔄 [RUNNER] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function processEvent(event) {
  const eventId = event.id;
  const tag = eventId?.slice(0, 8) || "???";

  console.log(`\n   ╔══════════════════════════════════════════╗`);
  console.log(`   ║   🔄 JOB ${tag.padEnd(27)}║`);
  console.log(`   ╚══════════════════════════════════════════╝`);
  console.log(`   📋 ${event.source}/${event.type} — "${event.data?.title || "?"}"`);

  acquireLock(eventId);
  const jobData = event.data || {};
  const rawTranscript = jobData.transcript || [];

  // Sanitize transcript data before building LLM context (Tier 2 — optional)
  const transcript = sanitizeTranscriptSegments(rawTranscript);

  // Sanitize context strings (Tier 2 — optional)
  const safeTitle = sanitizeContextString(jobData.title || "");
  const safeAttendees = (jobData.attendees || []).map((a) => sanitizeContextString(a));

  // Build initial context with job info + transcript preview
  let context = buildInitialContext(event, transcript, safeTitle, safeAttendees, eventId);

  // ── Hard-wired: Fetch existing memory context before the pipeline starts ──
  // This gives the LLM awareness of past action items, decisions, budgets,
  // and semantically similar meetings — so it can reference continuity and
  // identify recurring topics (repetition is itself valuable signal).
  console.log(`   🧠 [RUNNER] Fetching existing memory context...`);

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
    if (titleWords) {
      const semanticResult = await executeToolCall("transcribe_search_memory", {
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
    console.log(`   ✅ [RUNNER] Memory context injected (${memoryLines.length - 3} items)`);
  } catch (err) {
    console.log(`   ⚠️  [RUNNER] Memory fetch failed (non-fatal): ${err.message}`);
  }

  // ── Skip-steps configuration ──
  // `skip_steps` is an array of tool names to exclude from the LLM's available
  // tools. Default skips analysis and delivery. When a tool is skipped, the
  // pipeline hint chain is walked forward past it so the LLM gets the correct
  // "what to do next" guidance.
  const skippedTools = new Set(jobData.skip_steps || []);
  if (skippedTools.size > 0) {
    console.log(`   ⏭️  [RUNNER] Skipped tools: ${[...skippedTools].join(", ")}`);
  }

  // Filter the available tools: remove any that are in the skip list
  const availableTools = TOOLS.filter((t) => !skippedTools.has(t.name));

  // ── Render the system prompt ──
  // Generate a version of the system prompt with skipped sections removed
  // and {{TOOL_LIST}} injected. Pass it directly to callModel() in-memory
  // so model-client.js doesn't need any stripping logic.
  let renderedPrompt = null;
  {
    const toolLines = availableTools.map((t) => `  - ${t.name}: ${t.description}`).join("\n");
    let rendered = SYSTEM_PROMPT_TEMPLATE.replace("{{TOOL_LIST}}", toolLines);

    // Strip numbered sections that reference skipped tools
    if (skippedTools.size > 0) {
      for (const toolName of skippedTools) {
        const sectionRegex = new RegExp(
          `\\d+\\.\\s+\\*\\*[^*]+\\*\\*\\s+[—–-]\\s+[^\\n]*\\b${toolName}\\b[^\\n]*(?:\\n(?!\\d+\\.\\s+\\*\\*|##|$)[^\\n]*)*`,
          "g",
        );
        rendered = rendered.replace(sectionRegex, "");
        const commentRegex = new RegExp(`<!--\\s*\\d+\\.\\s+\\*\\*[^*]+\\*\\*[^>]*\\b${toolName}\\b[^>]*-->`, "g");
        rendered = rendered.replace(commentRegex, "");
      }
      rendered = rendered.replace(/\n{3,}/g, "\n\n").trim();
      console.log(`   📝 [RUNNER] Stripped system prompt sections for ${skippedTools.size} skipped tool(s):`);
      for (const toolName of skippedTools) {
        console.log(`   📝 [RUNNER]   - ${toolName}`);
      }
    }
    renderedPrompt = rendered;
  }

  // Dynamically resolve the next non-skipped pipeline hint.
  // Walks the hint chain: if the next referenced tool is skipped, recurse.
  // Logs every resolution step so the stage-order system is observable.
  function resolveNextHint(currentTool, hints) {
    const hint = hints[currentTool];
    if (!hint) {
      console.log(`   🔍 [RUNNER] resolveNextHint("${currentTool}"): no hint defined — LLM will decide autonomously`);
      return null;
    }
    console.log(`   🔍 [RUNNER] resolveNextHint("${currentTool}"): hint found — "${hint.slice(0, 100)}..."`);
    // Extract the first referenced tool name from the hint prose
    const match = hint.match(/\b(transcribe_\w+)\b/);
    if (!match) {
      console.log(`   🔍 [RUNNER] resolveNextHint: no next tool reference in hint, returning as-is`);
      return hint;
    }
    const nextTool = match[0];
    if (skippedTools.has(nextTool)) {
      console.log(`   ⏭️  [RUNNER] resolveNextHint: "${nextTool}" is in skip list, walking past it`);
      // Try the hint of the tool after the skipped one
      const nextHint = hints[nextTool];
      if (!nextHint) {
        console.log(`   ⏭️  [RUNNER] resolveNextHint: no hint for skipped "${nextTool}", returning original hint (fallback)`);
        return hint;
      }
      const nextMatch = nextHint.match(/\b(transcribe_\w+)\b/);
      if (nextMatch && skippedTools.has(nextMatch[0])) {
        // Multiple consecutive skips — recurse deeper
        console.log(`   🔄 [RUNNER] resolveNextHint: "${nextMatch[0]}" is also skipped, recursing deeper`);
        return resolveNextHint(nextTool, hints);
      }
      // Return the hint that points past the skipped tool
      const overridden = nextHint
        .replace(new RegExp(`\\b${nextMatch ? nextMatch[0].replace(/\./g, "\\.") : ""}\\b`), `(skipped ${nextTool}) ${nextMatch ? nextMatch[0] : ""}`)
        .trim();
      console.log(`   ⏭️  [RUNNER] resolveNextHint: overridden hint — "${overridden.slice(0, 120)}..."`);
      return overridden;
    }
    console.log(`   🔍 [RUNNER] resolveNextHint: next tool "${nextTool}" is available, returning original hint`);
    return hint;
  }

  // ── Multi-step pipeline loop ──
  // Each iteration: LLM picks one tool → executes it → result appended to context
  // Loop ends when a terminal tool is called, LLM returns nothing, or max steps hit.
  let pipelineComplete = false;
  let pipelineError = null;
  const tokenUsage = []; // per-step token usage records
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let step = 1; step <= MAX_PIPELINE_STEPS && !pipelineComplete; step++) {
    console.log(`   🤖 [RUNNER] Asking LLM (step ${step})...`);
    let decision;
    try {
      decision = await withRetry(() => callModel(context, availableTools, renderedPrompt), `LLM call (step ${step})`);
    } catch (err) {
      pipelineError = `LLM call failed after ${MAX_RETRIES} retries: ${err.message}`;
      console.log(`   ❌ [RUNNER] ${pipelineError}`);
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
    }

    if (!decision) {
      console.log(`   ⏭️  [RUNNER] No decision — pipeline complete`);
      logAction({ eventId, eventType: event.type, action: "complete", detail: `ended at step ${step}, no LLM decision` });
      pipelineComplete = true;
      break;
    }

    console.log(`   🎯 [RUNNER] ${decision.name}`);
    let result;
    try {
      result = await withRetry(() => executeToolCall(decision.name, decision.arguments), `${decision.name}`);
    } catch (err) {
      pipelineError = `${decision.name} failed after ${MAX_RETRIES} retries: ${err.message}`;
      console.log(`   ❌ [RUNNER] ${pipelineError}`);
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
      pipelineError = errorMsg || `Unknown error in ${decision.name}`;
      console.log(`   ❌ [RUNNER] ${pipelineError}`);
      logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
      pipelineComplete = true;
      break;
    }

    console.log(`   ✅ [RUNNER] ${decision.name} succeeded`);

    // Check if this was a terminal delivery tool — pipeline ends
    if (TERMINAL_TOOLS.has(decision.name)) {
      console.log(`   📬 [RUNNER] Delivery complete — pipeline finished`);
      logAction({ eventId, eventType: event.type, action: "complete", detail: `delivered via ${decision.name}` });
      pipelineComplete = true;
      break;
    }

    // If delivery tools are skipped and we just saved context, pipeline is done
    if (decision.name === "transcribe_save_context" && skippedTools.size > 0) {
      const hasRemainingDelivery = [...TERMINAL_TOOLS].some((t) => !skippedTools.has(t));
      if (!hasRemainingDelivery) {
        console.log(`   ⏭️  [RUNNER] Delivery skipped — pipeline finished after save_context`);
        logAction({ eventId, eventType: event.type, action: "complete", detail: "delivery skipped, ended after save_context" });
        pipelineComplete = true;
        break;
      }
    }

    // Append result summary to context so the LLM knows what happened
    const resultSummary =
      result && typeof result === "object" && !Array.isArray(result) ? JSON.stringify(result).slice(0, 500) : String(result || "ok").slice(0, 500);
    context += `\n\n[Step ${step} Complete] Tool: ${decision.name}\nResult: ${resultSummary}`;

    // Add a hint about the next logical pipeline step, skipping over any
    // tools that are in the skip list.
    const hint = resolveNextHint(decision.name, PIPELINE_HINTS);
    if (hint) {
      console.log(`   🧭 [RUNNER] Pipeline hint appended for next step: "${hint.slice(0, 100)}..."`);
      context += `\n${hint}`;
    } else {
      console.log(`   🧭 [RUNNER] No pipeline hint for "${decision.name}" — LLM will decide next step autonomously`);
    }
  }

  if (pipelineError) {
    console.log(`   ❌ [RUNNER] Pipeline failed for job ${tag}: ${pipelineError}`);
    logAction({ eventId, eventType: event.type, action: "failed", detail: pipelineError });
    // Enqueue a failed event so the UI and user know what happened
    await enqueueFailed(event, pipelineError);
  } else {
    console.log(`   ✅ [RUNNER] Pipeline finished for job ${tag}`);
  }

  // ── Save token usage data to the job's storage directory ──
  if (tokenUsage.length > 0) {
    try {
      const jobId = jobData.jobId || eventId;
      const storageDir = path.resolve(__dirname, "..", "storage", jobId);
      const usageData = {
        job_id: jobId,
        title: safeTitle,
        provider: process.env.LLM_PROVIDER || "deepseek",
        model: process.env.LLM_PROVIDER === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : "deepseek-v4-flash",
        steps: tokenUsage,
        totals: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalTokens,
        },
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(path.join(storageDir, "usage.json"), JSON.stringify(usageData, null, 2), "utf8");
      console.log(`   💰 [RUNNER] Token usage saved: ${totalTokens} total tokens across ${tokenUsage.length} steps`);
    } catch (err) {
      console.log(`   ⚠️  [RUNNER] Failed to save token usage: ${err.message}`);
    }
  }

  markCleared(eventId);
}

/**
 * Build the initial LLM context for a queue event.
 * Includes job metadata, transcript preview, and pipeline instructions.
 */
function buildInitialContext(event, transcript, safeTitle, safeAttendees, eventId) {
  const jobData = event.data || {};
  const lines = [
    `Transcription job: "${safeTitle}"`,
    `Attendees: ${safeAttendees.join(", ") || "none"}`,
    `Type: ${jobData.eventType || "unknown"}`,
    `Job ID: ${jobData.jobId || eventId}`,
    ``,
  ];

  // Use event templates from agent-config/pipeline.json, with variable substitution
  const template = EVENT_TEMPLATES[event.type] || "";
  if (template) {
    const rendered = template
      .replace("{{segment_count}}", String(transcript.length))
      .replace("{{error}}", jobData.error || "unknown")
      .replace("{{error_message}}", jobData.error || "unknown");

    // Build transcript preview for ready_for_processing
    if (event.type === "ready_for_processing") {
      const previewLines = [];
      for (const seg of transcript.slice(0, 10)) {
        previewLines.push(`  [${seg.start?.toFixed(1)}s] ${seg.speaker}: ${(seg.text || "").slice(0, 100)}`);
      }
      if (transcript.length > 10) previewLines.push(`  ... (${transcript.length - 10} more)`);
      lines.push(rendered.replace("{{transcript_preview}}", previewLines.join("\n")));
    } else if (event.type === "labeling_needed") {
      const speakerLines = [];
      for (const uk of jobData.unknownSpeakers || []) {
        speakerLines.push(`  - ${uk.speaker_id}: "${(uk.sample_text || "").slice(0, 80)}"`);
      }
      lines.push(rendered.replace("{{speaker_details}}", speakerLines.join("\n")));
    } else {
      lines.push(rendered);
    }
  } else {
    // Fallback if no template is defined for this event type
    if (event.type === "ready_for_processing") {
      lines.push(`Transcript (${transcript.length} segments):`);
      for (const seg of transcript.slice(0, 10)) {
        lines.push(`  [${seg.start?.toFixed(1)}s] ${seg.speaker}: ${(seg.text || "").slice(0, 100)}`);
      }
      if (transcript.length > 10) lines.push(`  ... (${transcript.length - 10} more)`);
    } else if (event.type === "labeling_needed") {
      lines.push(`Unknown speakers detected:`);
      for (const uk of jobData.unknownSpeakers || []) {
        lines.push(`  - ${uk.speaker_id}: "${(uk.sample_text || "").slice(0, 80)}"`);
      }
    } else if (event.type === "failed") {
      lines.push(`Processing failed. Error: ${jobData.error || "unknown"}`);
    }
  }

  return lines.join("\n");
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
    console.log(`\n   🔔 [RUNNER] ${pending.length} pending job(s)`);
    await processEvent(pending[0]);
  }

  isProcessing = false;
}

// ── Startup ──

const provider = process.env.LLM_PROVIDER || "deepseek";
const model = provider === "ollama" ? process.env.OLLAMA_MODEL || "llama3.1:8b" : "deepseek-v4-flash";
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
