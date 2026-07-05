/**
 * Model Client — calls DeepSeek V4 or Ollama with function calling
 *
 * LLM_PROVIDER=deepseek (default, requires DEEPSEEK_API_KEY)
 * LLM_PROVIDER=ollama   (uses OLLAMA_BASE_URL + OLLAMA_MODEL)
 *
 * When using Ollama, a periodic health check is started to monitor the
 * Ollama server and log its status. The health check interval is controlled
 * by the OLLAMA_HEALTH_CHECK_INTERVAL env var (default: 60000ms).
 */

import path from "path";
import fs from "fs";
import OpenAI from "openai";
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

  console.log(`   🩺 [MODEL] Starting Ollama health check (interval: ${HEALTH_CHECK_INTERVAL}ms)`);

  // Immediate first check
  (async () => {
    const healthy = await checkOllamaHealth();
    console.log(`   🩺 [MODEL] Ollama health check: ${healthy ? "✅ UP" : "❌ DOWN"}`);
  })();

  healthCheckTimer = setInterval(async () => {
    const healthy = await checkOllamaHealth();
    console.log(`   🩺 [MODEL] Ollama health check: ${healthy ? "✅ UP" : "❌ DOWN"}`);
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop the periodic Ollama health check.
 */
export function stopOllamaHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    console.log(`   🩺 [MODEL] Ollama health check stopped`);
  }
}

function createClient() {
  if (PROVIDER === "ollama") {
    return new OpenAI({
      apiKey: "ollama",
      baseURL: `${OLLAMA_BASE_URL}/v1`,
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
  return process.env.API_AGENT_MODEL || "deepseek-v4-flash";
}

const client = createClient();
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
  if (PROVIDER === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not set — configure it in Config or .env");
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

  const tools = mapTools(toolDefs);

  // Use the pre-rendered system prompt if provided (with skipped sections
  // already stripped), otherwise fall back to the cached template.
  const systemMessage =
    systemMessageOverride || SYSTEM_PROMPT_TEMPLATE.replace("{{TOOL_LIST}}", toolDefs.map((t) => `  - ${t.name}: ${t.description}`).join("\n"));

  console.log(`   🤖 [MODEL] Calling ${PROVIDER}/${MODEL}...`);

  try {
    // Ollama-specific parameters (num_ctx is forwarded by Ollama's /v1 endpoint)
    const ollamaParams = PROVIDER === "ollama" ? { num_ctx: getNumCtx() } : {};

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: context },
      ],
      tools,
      tool_choice: "auto",
      temperature: 0.1,
      stream: false,
      ...ollamaParams,
    });

    const choice = response.choices?.[0];
    const usage = response.usage || null;

    console.log(`   📊 [MODEL] Raw API response — usage: ${JSON.stringify(usage)}`);

    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.log(`   ⚠️  [MODEL] No tool call in response — usage from this call will NOT be tracked`);
      return null;
    }

    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return null;
    }

    return { name: toolCall.function.name, arguments: args, usage };
  } catch (err) {
    console.error(`   ❌ [MODEL] ${err.message}`);
    throw err;
  }
}
