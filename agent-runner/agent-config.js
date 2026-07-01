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

// Resolve paths — try agent-config/ next to the runner, fall back to project root
const CONFIG_DIR_CANDIDATES = [
  path.resolve(__dirname, "..", "agent-config"),
  path.resolve(__dirname, "..", "..", "agent-config"),
  path.resolve(__dirname, "agent-config"),
];

function resolveConfigDir() {
  for (const dir of CONFIG_DIR_CANDIDATES) {
    if (fs.existsSync(dir)) return dir;
  }
  // Fall back to project-root agent-config/
  const projectRoot = path.resolve(__dirname, "..");
  return path.resolve(projectRoot, "agent-config");
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
    description: "Apply refinement rules to a transcript: redact PII, clean formatting.",
    terminal: false,
    handler: "bridge",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" }, rules: { type: "array", items: { type: "string" } } },
      required: ["jobId"],
    },
  },
];

const FALLBACK_PIPELINE = {
  max_pipeline_steps: 15,
  max_retries: 3,
  retry_base_delay_ms: 2000,
  terminal_tools: ["send_delivery_email", "save_to_drive", "create_trello_action_items"],
  pipeline_hints: {
    transcribe_refine:
      "Next: Call transcribe_get_transcript to read the refined transcript, then call transcribe_summarize to generate a structured summary, then call transcribe_analyze to analyze topics/sentiment/entities...",
    transcribe_get_transcript:
      "Next: Call transcribe_summarize to generate a structured summary from the transcript, then call transcribe_analyze to store analysis results...",
    transcribe_summarize: "Next: Call transcribe_analyze to store analysis of topics, sentiment, entities, and follow-ups...",
    transcribe_analyze: "Next: Call transcribe_save_context to persist the meeting...",
    transcribe_save_context: "Next: Call transcribe_prepare_delivery to package results for delivery.",
    transcribe_prepare_delivery: "Next: Deliver results using send_delivery_email, save_to_drive, or create_trello_action_items.",
    transcribe_label_speaker: "Next: If more unknown speakers remain, call transcribe_label_speaker again; otherwise the pipeline is complete.",
  },
  event_templates: {
    ready_for_processing:
      "Actions: refine transcript, extract action items, generate summary, prepare delivery.\nExisting memory context is provided below...",
    labeling_needed: "Unknown speakers detected. List voiceprints, notify user, or apply labels if info available.",
    failed: "Processing failed. Notify the user. Error: {{error}}",
  },
};

const FALLBACK_SYSTEM_PROMPT =
  "You are an AI meeting transcription assistant. Process completed transcription jobs: refine transcripts, extract action items, generate summaries, and deliver results.";

// ── Loaded config (immutable after import) ──

/** @type {Array<{name: string, description: string, terminal: boolean, handler: string, inputSchema: object}>} */
export const TOOLS = readJson("tools.json") || FALLBACK_TOOLS;

/** @type {{max_pipeline_steps: number, max_retries: number, retry_base_delay_ms: number, terminal_tools: string[], pipeline_hints: Record<string, string>, event_templates: Record<string, string>}} */
export const PIPELINE_CONFIG = readJson("pipeline.json") || FALLBACK_PIPELINE;

/** Convenience aliases */
export const PIPELINE_HINTS = PIPELINE_CONFIG.pipeline_hints;
export const TERMINAL_TOOLS = new Set(PIPELINE_CONFIG.terminal_tools || []);
export const MAX_PIPELINE_STEPS = PIPELINE_CONFIG.max_pipeline_steps ?? 15;
export const MAX_RETRIES = PIPELINE_CONFIG.max_retries ?? 3;
export const RETRY_BASE_DELAY = PIPELINE_CONFIG.retry_base_delay_ms ?? 2000;

/** @type {string} */
export const SYSTEM_PROMPT_TEMPLATE = readMarkdown("system-prompt.md") || FALLBACK_SYSTEM_PROMPT;

/** @type {Record<string, string>} */
export const EVENT_TEMPLATES = PIPELINE_CONFIG.event_templates || FALLBACK_PIPELINE.event_templates;

/** Path to the config directory (for the bridge server to know where to write) */
export const CONFIG_DIR_PATH = CONFIG_DIR;

console.log(`   📋 [agent-config] Loaded from ${CONFIG_DIR}`);
console.log(`   📋 [agent-config]   ${TOOLS.length} tools, ${Object.keys(PIPELINE_HINTS).length} pipeline hints`);
console.log(`   📋 [agent-config]   ${TERMINAL_TOOLS.size} terminal tools, ${Object.keys(EVENT_TEMPLATES).length} event templates`);
