/**
 * Model Client — calls DeepSeek V4, OpenAI, Anthropic, or Ollama with function calling
 *
 * LLM_PROVIDER=deepseek  (default, requires DEEPSEEK_API_KEY)
 * LLM_PROVIDER=openai    (requires OPENAI_API_KEY)
 * LLM_PROVIDER=anthropic (requires ANTHROPIC_API_KEY; Messages API + tool_use)
 * LLM_PROVIDER=ollama    (uses OLLAMA_BASE_URL + OLLAMA_MODEL)
 *
 * The effective provider is flattened from the app's two-level config
 * (LLM_PROVIDER=api + API_PROVIDER) by getChildEnv() before this module loads.
 *
 * When using Ollama, a periodic health check is started to monitor the
 * Ollama server and log its status. The health check interval is controlled
 * by the OLLAMA_HEALTH_CHECK_INTERVAL env var (default: 60000ms).
 */

import path from "path";
import fs from "fs";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { SYSTEM_PROMPT_TEMPLATE } from "./agent-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROVIDER = process.env.LLM_PROVIDER || "deepseek";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const HEALTH_CHECK_INTERVAL = parseInt(process.env.OLLAMA_HEALTH_CHECK_INTERVAL || "60000", 10);

let healthCheckTimer = null;
let lastHealthStatus = null;

/**
 * Check the Ollama server health by hitting its /api/tags endpoint.
 * Returns true if the server is reachable, false otherwise.
 */
export async function checkOllamaHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      lastHealthStatus = true;
      return true;
    }
    lastHealthStatus = false;
    return false;
  } catch {
    lastHealthStatus = false;
    return false;
  }
}

/**
 * Get the last known Ollama health status.
 */
export function getLastOllamaHealth() {
  return lastHealthStatus;
}

/**
 * Start the periodic Ollama health check.
 * Only starts if the provider is ollama.
 * Logs the result on each check.
 */
export function startOllamaHealthCheck() {
  if (PROVIDER !== "ollama") return;
  if (healthCheckTimer) return; // already running

  console.log(`🩺 [MODEL] Starting Ollama health check (interval: ${HEALTH_CHECK_INTERVAL}ms)`);

  // Immediate first check
  (async () => {
    const healthy = await checkOllamaHealth();
    console.log(`🩺 [MODEL] Ollama health check: ${healthy ? "✅ UP" : "❌ DOWN"}`);
  })();

  healthCheckTimer = setInterval(async () => {
    const healthy = await checkOllamaHealth();
    console.log(`🩺 [MODEL] Ollama health check: ${healthy ? "✅ UP" : "❌ DOWN"}`);
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop the periodic Ollama health check.
 */
export function stopOllamaHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    console.log(`🩺 [MODEL] Ollama health check stopped`);
  }
}

function createClient() {
  if (PROVIDER === "ollama") {
    return new OpenAI({
      apiKey: "ollama",
      baseURL: `${OLLAMA_BASE_URL}/v1`,
    });
  }
  if (PROVIDER === "openai") {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "",
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  if (PROVIDER === "anthropic") {
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseURL: "https://api.deepseek.com",
  });
}

function getModel() {
  if (PROVIDER === "ollama") {
    const model = process.env.OLLAMA_MODEL;
    if (!model) {
      throw new Error(
        "OLLAMA_MODEL not configured. Set a model name in Config (e.g. deepseek-v2, qwen3.6:27b) " +
          "or pull one from the Ollama section in the Configuration panel.",
      );
    }
    return model;
  }
  if (PROVIDER === "openai") return process.env.OPENAI_MODEL || process.env.API_AGENT_MODEL || "gpt-4o";
  if (PROVIDER === "anthropic") return process.env.ANTHROPIC_MODEL || process.env.API_AGENT_MODEL || "claude-sonnet-4-5";
  return process.env.DEEPSEEK_MODEL || process.env.API_AGENT_MODEL || "deepseek-v4-flash";
}

let client = null;

/**
 * Lazily construct the provider client. Deferred until the first LLM call so
 * a missing API key surfaces as the friendly key-guard error in callModel()
 * rather than a startup crash (the OpenAI SDK validates credentials at construction).
 */
function getClient() {
  if (!client) client = createClient();
  return client;
}

const MODEL = getModel();

// Start health check on module load if using Ollama
startOllamaHealthCheck();

function getNumCtx() {
  if (PROVIDER !== "ollama") return undefined;
  const val = parseInt(process.env.OLLAMA_NUM_CTX || "32768", 10);
  // Only allow valid values: 32768, 65536, 131072
  if ([32768, 65536, 131072].includes(val)) return val;
  return 32768;
}

function mapTools(defs) {
  return defs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export async function callModel(context, toolDefs, systemMessageOverride) {
  // Provider-scoped key guard — the runner restarts after config changes, so
  // the effective provider (flattened by getChildEnv) is authoritative here.
  if (PROVIDER === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not set — configure it in Config or .env");
  }
  if (PROVIDER === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set — configure it in Config or .env");
  }
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — configure it in Config or .env");
  }

  // Check Ollama health before each call to fail fast instead of retrying 3 times
  if (PROVIDER === "ollama") {
    const healthy = await checkOllamaHealth();
    if (!healthy) {
      throw new Error(
        "Ollama server is not responding. Check that Ollama is running (http://127.0.0.1:11434/api/tags). " +
          "Use the ▶ Start button in the status bar or start Ollama manually.",
      );
    }
  }

  // Use the pre-rendered system prompt if provided (with skipped sections
  // already stripped), otherwise fall back to the cached template.
  const systemMessage =
    systemMessageOverride || SYSTEM_PROMPT_TEMPLATE.replace("{{TOOL_LIST}}", toolDefs.map((t) => `  - ${t.name}: ${t.description}`).join("\n"));

  if (process.env.LOG_LLM_DATA === "true") {
    console.log(`🤖 [MODEL] Calling ${PROVIDER}/${MODEL}... w/`, context);
  } else {
    console.log(`🤖 [MODEL] Calling ${PROVIDER}/${MODEL} (context: ${context.length} chars, ${toolDefs?.length || 0} tools)`);
  }

  try {
    if (PROVIDER === "anthropic") {
      return await callAnthropic(context, toolDefs, systemMessage);
    }
    return await callOpenAiCompatible(context, toolDefs, systemMessage);
  } catch (err) {
    console.error(`❌ [MODEL] ${err.message}`);
    throw err;
  }
}

/**
 * Anthropic Messages API path — different request/response shape from OpenAI.
 * Tools use `input_schema` and responses surface tool calls as content blocks
 * of type `tool_use` (stop_reason === "tool_use").
 */
async function callAnthropic(context, toolDefs, systemMessage) {
  const tools = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const response = await getClient().messages.create({
    model: MODEL,
    system: systemMessage,
    messages: [{ role: "user", content: context }],
    tools,
    tool_choice: { type: "auto" },
    max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || "4096", 10),
    temperature: parseFloat(process.env.LLM_TEMPERATURE || "0.1"),
  });

  if (process.env.LOG_LLM_DATA === "true") {
    console.log(`📊 [MODEL] Raw API — usage: ${JSON.stringify(response.usage)}`);
    console.log(`📊 [MODEL] Raw API — messages: ${JSON.stringify(response.content)}`);
  }

  const toolUse = (response.content || []).find((b) => b && b.type === "tool_use");

  // Normalize Anthropic usage to the OpenAI-compatible shape so per-job token
  // totals (Usage tab) work identically across providers.
  const usage = response.usage
    ? {
        prompt_tokens: response.usage.input_tokens || 0,
        completion_tokens: response.usage.output_tokens || 0,
        total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
        prompt_tokens_details: { cached_tokens: response.usage.cache_read_input_tokens || 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }
    : null;

  if (!toolUse || response.stop_reason !== "tool_use") {
    console.log(`\u26a0\ufe0f  [MODEL] No tool call in Anthropic response — returning null`);
    return null;
  }

  return { name: toolUse.name, arguments: toolUse.input || {}, usage };
}

/** OpenAI-compatible path — shared by deepseek, openai, and ollama. */
async function callOpenAiCompatible(context, toolDefs, systemMessage) {
  const tools = mapTools(toolDefs);

  // Ollama-specific parameters (num_ctx is forwarded by Ollama's /v1 endpoint)
  const ollamaParams = PROVIDER === "ollama" ? { num_ctx: getNumCtx() } : {};

  const response = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: context },
    ],
    tools,
    tool_choice: "auto",
    temperature: parseFloat(process.env.LLM_TEMPERATURE || "0.1"),
    stream: false,
    ...ollamaParams,
  });

  const choice = response.choices?.[0];
  const usage = response.usage || null;

  // Only log usage & full message content when LLM data logging is explicitly enabled
  if (process.env.LOG_LLM_DATA === "true") {
    console.log(`📊 [MODEL] Raw API — usage: ${JSON.stringify(usage)}`);
    console.log(`📊 [MODEL] Raw API — messages: ${JSON.stringify(response.choices?.[0]?.message)}`);
  }

  const message = choice?.message;
  const toolCall = message?.tool_calls?.[0];

  // Some providers (DeepSeek) return tool_calls alongside empty content.
  // If there IS a tool_call, process it even when content is empty.
  if (!toolCall) {
    // Only bail if there's genuinely no tool_call AND no content
    if (!message?.content || message.content.trim().length === 0) {
      console.log(`\u26a0\ufe0f  [MODEL] No tool call in response — returning null`);
      return null;
    }
    console.log(`\u26a0\ufe0f  [MODEL] Content-only response (no tool call) — returning null`);
    return null;
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return null;
  }

  return { name: toolCall.function.name, arguments: args, usage };
}

/** Current model name — used by the runner for logging / usage attribution. */
export function getModelName() {
  return MODEL;
}
