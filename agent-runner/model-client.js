/**
 * Model Client — calls DeepSeek V4 or Ollama with function calling
 *
 * LLM_PROVIDER=deepseek (default, requires DEEPSEEK_API_KEY)
 * LLM_PROVIDER=ollama   (uses OLLAMA_BASE_URL + OLLAMA_MODEL)
 */

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.resolve(__dirname, "system-prompt.md");

const PROVIDER = process.env.LLM_PROVIDER || "deepseek";

function createClient() {
  if (PROVIDER === "ollama") {
    return new OpenAI({
      apiKey: "ollama",
      baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    });
  }
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseURL: "https://api.deepseek.com",
  });
}

function getModel() {
  if (PROVIDER === "ollama") return process.env.OLLAMA_MODEL || "llama3.1:8b";
  return process.env.API_AGENT_MODEL || "deepseek-v4-flash";
}

const client = createClient();
const MODEL = getModel();

function mapTools(defs) {
  return defs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export async function callModel(context, toolDefs) {
  if (PROVIDER === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    console.error("   ❌ [MODEL] DEEPSEEK_API_KEY not set");
    return null;
  }

  const tools = mapTools(toolDefs);

  // Load system prompt from external file, inject tool list
  let promptTemplate =
    "You are an AI meeting transcription assistant. Process completed transcription jobs: refine transcripts, extract action items, generate summaries, and deliver results.";
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      promptTemplate = fs.readFileSync(PROMPT_FILE, "utf8");
    }
  } catch {
    /* fallback to default */
  }
  const toolLines = toolDefs.map((t) => `  - ${t.name}: ${t.description}`).join("\n");
  const systemMessage = promptTemplate.replace("{{TOOL_LIST}}", toolLines);

  console.log(`   🤖 [MODEL] Calling ${PROVIDER}/${MODEL}...`);

  try {
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
    });

    const choice = response.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) return null;

    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return null;
    }

    return { name: toolCall.function.name, arguments: args };
  } catch (err) {
    console.error(`   ❌ [MODEL] ${err.message}`);
    return null;
  }
}
