/**
 * Config Manager — reads/writes app configuration.
 *
 * Priority order:
 *   1. User config file (app.getPath("userData")/config.json) — UI-written values
 *   2. .env file (project root) — developer-set values
 *   3. Hardcoded defaults
 *
 * The user config file is written by the ConfigPanel in the renderer.
 * .env is never written by the app — only read.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

export interface AppConfig {
  /** DeepSeek API key (required for LLM) */
  DEEPSEEK_API_KEY: string;
  /** LLM provider: "deepseek" or "ollama" */
  LLM_PROVIDER: string;
  /** Ollama endpoint (only used if LLM_PROVIDER=ollama) */
  OLLAMA_BASE_URL: string;
  /** Ollama model name */
  OLLAMA_MODEL: string;
  /** Gmail delivery credentials */
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  /** Trello delivery credentials */
  TRELLO_KEY: string;
  TRELLO_TOKEN: string;
}

const DEFAULTS: AppConfig = {
  DEEPSEEK_API_KEY: "",
  LLM_PROVIDER: "deepseek",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
  OLLAMA_MODEL: "llama3.1:8b",
  GMAIL_CLIENT_ID: "",
  GMAIL_CLIENT_SECRET: "",
  GMAIL_REFRESH_TOKEN: "",
  GMAIL_USER: "",
  TRELLO_KEY: "",
  TRELLO_TOKEN: "",
};

/** Keys the UI considers "required" before the pipeline can run. */
export const REQUIRED_CONFIG_KEYS: (keyof AppConfig)[] = ["DEEPSEEK_API_KEY"];

let userConfigPath: string;
let cachedConfig: AppConfig | null = null;

function ensureUserDataDir(): void {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  userConfigPath = path.join(dir, "config.json");
}

/** Read the .env file from the project root (dev) or extraResources (prod). */
function parseDotEnv(): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};

  // In dev: project root is app.getAppPath()/..
  // In prod: .env isn't bundled, so this will silently return empty
  const rootDir = app.isPackaged ? path.join(process.resourcesPath, "..") : path.join(app.getAppPath(), "..");

  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return result;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim() as keyof AppConfig;
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key in DEFAULTS && value) result[key] = value;
  }
  return result;
}

/** Read the user config file from app.getPath("userData")/config.json. */
function parseUserConfig(): Partial<AppConfig> {
  try {
    if (!userConfigPath) ensureUserDataDir();
    if (!fs.existsSync(userConfigPath)) return {};
    const raw = fs.readFileSync(userConfigPath, "utf8");
    const data = JSON.parse(raw);
    // Only pick known keys
    const result: Partial<AppConfig> = {};
    for (const key of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
      if (data[key] !== undefined && data[key] !== "") result[key] = data[key];
    }
    return result;
  } catch {
    return {};
  }
}

/** Describes the source of a config value for the UI. */
export interface ConfigValueSource {
  value: string;
  source: "user_config" | "env_file" | "default";
}

/** Merge config from: user file > .env > defaults. */
export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = { ...DEFAULTS, ...parseDotEnv(), ...parseUserConfig() };
  return cachedConfig;
}

/** Get config with per-key source info (for showing in the UI). */
export function getConfigWithSources(): Record<keyof AppConfig, ConfigValueSource> {
  const envVals = parseDotEnv();
  const userVals = parseUserConfig();
  const result = {} as Record<keyof AppConfig, ConfigValueSource>;

  for (const key of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
    let source: ConfigValueSource["source"] = "default";
    let value = DEFAULTS[key];

    if (userVals[key]) {
      value = userVals[key]!;
      source = "user_config";
    } else if (envVals[key]) {
      value = envVals[key]!;
      source = "env_file";
    }

    result[key] = { value, source };
  }
  return result;
}

/** Invalidate cache so next getConfig() re-reads from disk. */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/** Save config values to user config file. Merges with existing. */
export function saveConfig(values: Partial<AppConfig>): AppConfig {
  invalidateConfigCache();
  ensureUserDataDir();

  // Read existing user config to merge
  let existing: Partial<AppConfig> = {};
  try {
    if (fs.existsSync(userConfigPath)) {
      existing = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    }
  } catch {
    // ignore
  }

  const merged = { ...existing, ...values };
  // Remove empty strings so they don't override .env values
  for (const key of Object.keys(merged) as (keyof AppConfig)[]) {
    if (merged[key] === "") delete merged[key];
  }

  fs.writeFileSync(userConfigPath, JSON.stringify(merged, null, 2), "utf8");
  return getConfig();
}

/** Check if all required config values are present. */
export function checkConfig(): { ok: boolean; missing: string[] } {
  const config = getConfig();
  const missing: string[] = [];
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!config[key]) missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

/** Get environment variables for child processes (config values merged in). */
export function getChildEnv(): NodeJS.ProcessEnv {
  const config = getConfig();
  return {
    ...process.env,
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    LLM_PROVIDER: config.LLM_PROVIDER || process.env.LLM_PROVIDER || "deepseek",
    OLLAMA_BASE_URL: config.OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    OLLAMA_MODEL: config.OLLAMA_MODEL || process.env.OLLAMA_MODEL || "llama3.1:8b",
    GMAIL_CLIENT_ID: config.GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || "",
    GMAIL_CLIENT_SECRET: config.GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || "",
    GMAIL_REFRESH_TOKEN: config.GMAIL_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN || "",
    GMAIL_USER: config.GMAIL_USER || process.env.GMAIL_USER || "",
    TRELLO_KEY: config.TRELLO_KEY || process.env.TRELLO_KEY || "",
    TRELLO_TOKEN: config.TRELLO_TOKEN || process.env.TRELLO_TOKEN || "",
  };
}
