/**
 * Agent Config — loads agent instructions from external JSON + markdown files
 *
 * Loads at startup from agent-config/:
 *   tools.json        — Tool definitions (name, description, inputSchema, terminal flag)
 *   pipeline.json     — Pipeline hints, terminal tools, constants, event templates
 *   system-prompt.md  — LLM system prompt with {{TOOL_LIST}} placeholder
 *
 * All files are read synchronously at import time so the runner has
 * a consistent snapshot for the entire lifetime. A restart is required
 * to pick up edits — no hot-reload.
 *
 * On any load failure, hard-coded fallbacks ensure the runner still works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveConfigDir() {
  // Priority 1: AGENT_CONFIG_DIR env var (for testing / non-standard setups)
  if (process.env.AGENT_CONFIG_DIR) {
    const envDir = path.resolve(process.env.AGENT_CONFIG_DIR);
    if (fs.existsSync(envDir)) {
      console.log(`📝 [agent-config] Using AGENT_CONFIG_DIR: ${envDir}`);
      return envDir;
    }
    console.warn(`   ⚠️  [agent-config] AGENT_CONFIG_DIR set but not found: ${envDir}`);
  }

  // Priority 2: User's live config directory (set by Electron app ConfigPanel)
  const userConfigDir = path.resolve(
    process.env.HOME || process.env.USERPROFILE || "",
    "Library/Application Support/Transcription Agent/agent-config",
  );
  if (userConfigDir && fs.existsSync(userConfigDir)) {
    console.log(`📝 [agent-config] Using user config: ${userConfigDir}`);
    return userConfigDir;
  }

  // Priority 3: Project-relative directories
  const candidates = [
    path.resolve(__dirname, "..", "agent-config"),
    path.resolve(__dirname, "..", "..", "agent-config"),
    path.resolve(__dirname, "agent-config"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  // Fall back to project-root agent-config/ (may not exist, will use fallbacks)
  const projectRoot = path.resolve(__dirname, "..");
  const fallback = path.resolve(projectRoot, "agent-config");
  console.warn(`   ⚠️  [agent-config] No config dir found — using fallback at ${fallback}`);
  return fallback;
}

const CONFIG_DIR = resolveConfigDir();

// ── Helpers ──

function readJson(filename) {
  const filePath = path.resolve(CONFIG_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`   ⚠️  [agent-config] ${filename} not found at ${filePath}`);
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`   ⚠️  [agent-config] Failed to load ${filename}: ${err.message}`);
    return null;
  }
}

function readMarkdown(filename) {
  const filePath = path.resolve(CONFIG_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ── Default fallbacks (hard-coded, same as original inline values) ──

const FALLBACK_TOOLS = [
  {
    name: "transcribe_refine",
    description:
      "Clean a transcript: removes filler words (um, uh, ah, like, you know, etc.) and redacts PII (emails, phone numbers, SSNs, credit cards, account numbers). Timestamps are preserved. Pass optional custom rules for additional redactions.",
    terminal: false,
    handler: "bridge",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" }, rules: { type: "array", items: { type: "string" } } },
      required: ["jobId"],
    },
  },
  {
    name: "transcribe_register_attendees",
    description: "Register meeting attendees. Use when you know who attended a meeting but they weren't pre-registered.",
    terminal: false,
    handler: "bridge",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        names: { type: "array", items: { type: "string" } },
        emails: { type: "array", items: { type: "string" } },
        source: { type: "string", enum: ["new_job_form", "manual_labeling"], default: "manual_labeling" },
      },
      required: ["jobId", "names"],
    },
  },
  {
    name: "transcribe_list_attendees",
    description: "List all registered attendees across all meetings, newest first.",
    terminal: false,
    handler: "bridge",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 100 } } },
  },
  {
    name: "transcribe_search_attendees",
    description: "Search registered attendees by name substring.",
    terminal: false,
    handler: "bridge",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, limit: { type: "number", default: 50 } },
      required: ["name"],
    },
  },
  {
    name: "transcribe_upsert_job",
    description:
      "Upsert a job record in the ephemeral jobs table. Accepts any subset of fields: token usage, pipeline steps, delivery results, content metrics, and terminal state.",
    terminal: false,
    handler: "bridge",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        result: { type: "string", enum: ["pending", "success", "failed", "cancelled"] },
        totalPromptTokens: { type: "integer" },
        totalCompletionTokens: { type: "integer" },
        totalTokens: { type: "integer" },
        llmProvider: { type: "string" },
        llmModel: { type: "string" },
        inputCost: { type: "number" },
        outputCost: { type: "number" },
        totalCost: { type: "number" },
        pipelineSteps: { type: "string" },
        deliveryAttempted: { type: "boolean" },
        deliveryResults: { type: "string" },
        errorMessage: { type: "string" },
        completedAt: { type: "string" },
      },
      required: ["jobId"],
    },
  },
];

const FALLBACK_PIPELINE = {
  max_pipeline_steps: 25,
  max_retries: 3,
  retry_base_delay_ms: 2000,
  ollama_max_retries: 5,
  ollama_retry_base_delay_ms: 5000,
  terminal_tools: ["send_delivery_email", "save_to_drive", "create_trello_action_items"],
  pipeline_steps: [
    {
      id: "step-0",
      toolName: "_fetch_memory_context",
      label: "Fetch Memory Context",
      description: "Retrieve existing action items, decisions, budgets, and similar past meetings for LLM context",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-1",
      toolName: "transcribe_refine",
      label: "Refine Transcript",
      description: "Clean filler words and redact PII",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-2",
      toolName: "transcribe_get_transcript",
      label: "Read Transcript",
      description: "Retrieve the refined speaker-labeled transcript",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-3",
      toolName: "transcribe_summarize",
      label: "Summarize",
      description: "Generate and store a structured meeting summary",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-4",
      toolName: "transcribe_analyze",
      label: "Analyze",
      description: "Analyze topics, sentiment, entities, and follow-ups",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-5",
      toolName: "transcribe_approve_delivery",
      label: "Review & Approve Delivery",
      description: "Pause pipeline for user to review transcript, summary, analysis and confirm or change delivery options",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: false,
      isTerminal: false,
    },
    {
      id: "step-6",
      toolName: "transcribe_save_context",
      label: "Save to Memory",
      description: "Persist meeting to semantic and ephemeral memory",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-7",
      toolName: "transcribe_prepare_delivery",
      label: "Prepare Delivery",
      description: "Package results for delivery destinations",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: false,
    },
    {
      id: "step-8",
      toolName: "send_delivery_email",
      label: "Deliver via Email",
      description: "Send results via email",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: true,
    },
    {
      id: "step-9",
      toolName: "save_to_drive",
      label: "Save to Drive",
      description: "Save results to Google Drive",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: true,
    },
    {
      id: "step-10",
      toolName: "create_trello_action_items",
      label: "Create Trello Cards",
      description: "Create action items as Trello cards",
      systemPromptTemplate: "",
      hintTemplate: "",
      enabled: true,
      isTerminal: true,
    },
  ],
  pipeline_hints: {
    transcribe_refine:
      "Refinement cleaned filler words and PII (timestamps preserved). Next: Call transcribe_get_transcript to read the cleaned transcript, then call transcribe_summarize to generate a structured summary, then call transcribe_analyze to analyze topics/sentiment/entities...",
    transcribe_get_transcript:
      "Next: Call transcribe_summarize to generate a structured summary from the transcript, then call transcribe_analyze to store analysis results...",
    transcribe_summarize: "Next: Call transcribe_analyze to store analysis of topics, sentiment, entities, and follow-ups...",
    transcribe_analyze: "Next: If delivery review is enabled, call transcribe_approve_delivery to pause for user approval. Otherwise call transcribe_save_context.",
    transcribe_approve_delivery: "Next: After user approves, call transcribe_save_context to persist the meeting...",
    transcribe_save_context: "Next: Call transcribe_prepare_delivery to package results for delivery.",
    transcribe_prepare_delivery: "Next: Deliver results using send_delivery_email, save_to_drive, or create_trello_action_items.",
    transcribe_label_speaker: "Next: If more unknown speakers remain, call transcribe_label_speaker again; otherwise the pipeline is complete.",
    transcribe_register_attendees:
      "Attendees registered. Use transcribe_search_attendees to verify or find existing attendees before registering duplicates.",
    transcribe_list_attendees:
      "Use to see the full attendee registry. Cross-reference with voiceprints via matching email addresses or name lookups.",
    transcribe_search_attendees: "Search results returned. Use transcribe_register_attendees to add new attendees if the person isn't found.",
  },
  event_templates: {
    ready_for_processing:
      "Actions: refine transcript (removes fillers and PII, preserves timestamps), extract action items, generate summary, generate analysis, prepare delivery.\nExisting memory context is provided below...",
    labeling_needed: "Unknown speakers detected. List voiceprints, notify user, or apply labels if info available.",
    failed: "Processing failed. Notify the user. Error: {{error}}",
  },
};

const FALLBACK_SYSTEM_PROMPT =
  "You are an AI meeting transcription assistant. Process completed transcription jobs: refine transcripts (removes fillers and PII, preserves timestamps), extract action items, generate summaries, generate analysis, and deliver results.";

// ── Loaded config (immutable after import) ──

/** @type {Array<{name: string, description: string, terminal: boolean, handler: string, inputSchema: object}>} */
export const TOOLS = readJson("tools.json") || FALLBACK_TOOLS;

/** @type {{max_pipeline_steps: number, max_retries: number, retry_base_delay_ms: number, ollama_max_retries: number, ollama_retry_base_delay_ms: number, terminal_tools: string[], pipeline_hints: Record<string, string>, event_templates: Record<string, string>}} */
export const PIPELINE_CONFIG = readJson("pipeline.json") || FALLBACK_PIPELINE;

/** Convenience aliases */
export const PIPELINE_HINTS = PIPELINE_CONFIG.pipeline_hints;
export const PIPELINE_STEPS = PIPELINE_CONFIG.pipeline_steps || [];
export const TERMINAL_TOOLS = new Set(PIPELINE_CONFIG.terminal_tools || []);
export const MAX_PIPELINE_STEPS = PIPELINE_CONFIG.max_pipeline_steps ?? 25;
export const MAX_RETRIES = PIPELINE_CONFIG.max_retries ?? 3;
export const RETRY_BASE_DELAY = PIPELINE_CONFIG.retry_base_delay_ms ?? 2000;
export const OLLAMA_MAX_RETRIES = PIPELINE_CONFIG.ollama_max_retries ?? 5;
export const OLLAMA_RETRY_BASE_DELAY = PIPELINE_CONFIG.ollama_retry_base_delay_ms ?? 5000;

/** @type {string} */
export const SYSTEM_PROMPT_TEMPLATE = readMarkdown("system-prompt.md") || FALLBACK_SYSTEM_PROMPT;

/** @type {Record<string, string>} */
export const EVENT_TEMPLATES = PIPELINE_CONFIG.event_templates || FALLBACK_PIPELINE.event_templates;

/** Path to the config directory (for the bridge server to know where to write) */
export const CONFIG_DIR_PATH = CONFIG_DIR;

/** Delivery tool names — used to track delivery results in the pipeline loop. */
export const DELIVERY_TOOL_NAMES = new Set(["send_delivery_email", "save_to_drive", "create_trello_action_items"]);

/**
 * LLM context window size (number of step result blocks to keep).
 * 0 = disabled (keep all accumulated context).
 * When > 0, only the last N step result blocks are retained to bound context growth.
 */
export const LLM_CONTEXT_WINDOW = PIPELINE_CONFIG.llm_context_window ?? 0;

console.log(`   📋 [agent-config] Loaded from ${CONFIG_DIR}`);
console.log(`   📋 [agent-config]   ${TOOLS.length} tools, ${Object.keys(PIPELINE_HINTS).length} pipeline hints`);
console.log(
  `   📋 [agent-config]   ${TERMINAL_TOOLS.size} terminal tools, ${PIPELINE_STEPS.length} pipeline steps, ${Object.keys(EVENT_TEMPLATES).length} event templates`,
);
