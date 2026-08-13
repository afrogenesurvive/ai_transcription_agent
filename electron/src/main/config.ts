/**
 * Config Manager — reads/writes app configuration.
 *
 * Two user-level config files in app.getPath("userData"):
 *   config.json          — UI-written values (user overrides)
 *   config.defaults.json — shipped-defaults snapshot (version-stamped copy)
 *
 * Hardcoded DEFAULTS are used as fallback when no value is set in config.json.
 * config.defaults.json is snapshotted on first launch and re-snapshotted on
 * every app-version change so users can restore the current shipped defaults,
 * symmetric to agent-config/.defaults/.
 *
 * The user config file is written by the ConfigPanel in the renderer.
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
  /** Ollama context window size (num_ctx) in tokens: 32768, 65536, or 131072 */
  OLLAMA_NUM_CTX: string;
  /** Gmail delivery credentials */
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  /** Microsoft Teams meeting integration (Entra ID, public client — no secret; work/school accounts) */
  MS_CLIENT_ID: string;
  MS_REFRESH_TOKEN: string;
  MS_USER: string;
  /** Zoom meeting integration (Marketplace OAuth app — client secret required) */
  ZOOM_CLIENT_ID: string;
  ZOOM_CLIENT_SECRET: string;
  ZOOM_REFRESH_TOKEN: string;
  ZOOM_USER: string;
  /** Trello delivery credentials */
  TRELLO_KEY: string;
  TRELLO_TOKEN: string;
  /** Hugging Face token (required for gated models like pyannote/speaker-diarization-3.1) */
  HUGGING_FACE_TOKEN: string;
  /** GitHub personal access token for private repo auto-updates */
  GITHUB_TOKEN: string;
  /** Performance metrics polling interval (ms) for DevPanel */
  PERF_METRICS_POLL_INTERVAL: string;
  /** Credit balance polling interval (ms) for Usage tab */
  CREDIT_POLL_INTERVAL: string;
  /** Speaker embedding model provider: "pyannote" or "speechbrain" */
  EMBEDDING_PROVIDER: string;
  /** Whisper ASR model size: "medium" or "large" */
  WHISPER_MODEL_SIZE: string;
  /** Keep start/end timestamps in refined transcript */
  KEEP_TRANSCRIPT_TIMESTAMPS: string;
  /** Enable passing an initial prompt to Whisper for domain-specific vocabulary */
  WHISPER_INITIAL_PROMPT_ENABLED: string;
  /** Initial prompt text sent to Whisper before transcription (e.g. "Technical discussion about Kubernetes") */
  WHISPER_INITIAL_PROMPT: string;
  /** Log LLM input/output data to job storage directory */
  LOG_LLM_DATA: string;
  /** Collapse consecutive log lines with identical source/subsource/level in Results Viewer */
  LOG_COLLAPSE_REPEATED_PREFIXES: string;
  /** Route Chromium (Electron) renderer/GPU/console logs to stderr (--enable-logging). Debug aid. */
  LOG_CHROMIUM: string;
  /** LLM temperature (0.0–2.0). Lower = more deterministic, higher = more creative. Default 0.1 */
  LLM_TEMPERATURE: string;
  /** Fetch memory context — controlled via pipeline step _fetch_memory_context in pipeline.json */
  /* USE_MEMORY_FOR_CONTEXT removed — now a pipeline step toggle in Agent Instructions */
  /** UI theme: "dark" or "light" */
  APPEARANCE_THEME: string;
  /** Accent color override (CSS color value, e.g. "#58a6ff") */
  APPEARANCE_ACCENT_COLOR: string;
  /** UI font size preset: "small", "medium", or "large" */
  APPEARANCE_FONT_SIZE: string;
  /** Sidebar width in px */
  APPEARANCE_SIDEBAR_WIDTH: string;
  /** Delivery config — default recipient emails (comma-separated) */
  DELIVERY_RECIPIENT_EMAILS: string;
  /** Delivery config — email subject template */
  DELIVERY_EMAIL_SUBJECT: string;
  /** Delivery config — additional content appended to delivery emails */
  DELIVERY_EMAIL_ADDITIONAL_CONTENT: string;
  /** Delivery config — Google Drive destination folder name */
  DELIVERY_DRIVE_FOLDER: string;
  /** Path to audio file for Playwright screenshot tests */
  PLAYWRIGHT_AUDIO_FILE_PATH: string;
  /** Title template for test jobs (use {autoNum}) */
  PLAYWRIGHT_TITLE_TEMPLATE: string;
  /** Comma-separated list of 20 generic speaker names for labeling modal */
  PLAYWRIGHT_GENERIC_NAMES: string;
  /** Pipeline wall-clock timeout (minutes) before a hung job fails itself */
  PIPELINE_TIMEOUT_MINUTES: string;
  /** Gate 1: Pause after ASR+alignment for raw transcript review/editing before LLM processing */
  GATE_RAW_REVIEW_ENABLED: string;
  /** Gate 2: Pause after LLM analysis for transcript/summary/analysis review before memory save + delivery */
  GATE_DELIVERY_REVIEW_ENABLED: string;
  /** Custom delivery per meeting: when enabled, delivery review always pauses so the user picks which attendees receive the email */
  CUSTOM_DELIVERY_PER_MEETING: string;
  /** Keep ML models loaded between transcription jobs (faster startup, higher memory) */
  KEEP_MODELS_WARM: string;
  /** Static DS-mon push URL (e.g. https://<tunnel-id>.cfargotunnel.com/sync/push) */
  DSMON_PUSH_URL: string;
  /** Instance identifier sent with each usage record (defaults to hostname) */
  DSMON_INSTANCE_ID: string;
  /** DS-mon push interval in milliseconds (default 300000) */
  DSMON_PUSH_INTERVAL: string;
  /** Shared bearer token required by the DS-mon host's /sync/push endpoint (empty = no auth) */
  DSMON_PUSH_TOKEN: string;
  /** Master toggle: enable/disable DS-mon usage tracking entirely */
  USAGE_TRACKING_ENABLED: string;
  /** Optional named Cloudflare tunnel for the Quick Action (empty = quick tunnel) */
  CLOUDFLARED_TUNNEL_NAME: string;
  /** Cloudflare tunnel token for the Quick Action Start button (cloudflared tunnel run --token … --protocol http2) */
  CLOUDFLARED_TUNNEL_TOKEN: string;

  // ── Diarization tuning (ASV phantom speaker suppression) ──
  /** Minimum total speech duration (s) for a valid speaker; below this = phantom */
  DIARIZATION_MIN_SPEAKER_DURATION: string;
  /** Minimum segment count for a valid speaker */
  DIARIZATION_MIN_SPEAKER_SEGMENTS: string;
  /** Max gap (s) between same-speaker segments to merge them */
  DIARIZATION_MERGING_GAP: string;
  /** pyannote clustering threshold override; 0 = model default */
  DIARIZATION_CLUSTERING_THRESHOLD: string;
  /** Hard upper bound on speaker count; 0 = no limit */
  DIARIZATION_MAX_SPEAKERS: string;
  /** Diarization subprocess timeout floor (minutes); auto-scaled to audio length */
  DIARIZATION_TIMEOUT_MINUTES: string;
}

const DEFAULTS: AppConfig = {
  DEEPSEEK_API_KEY: "",
  LLM_PROVIDER: "deepseek",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
  OLLAMA_MODEL: "",
  OLLAMA_NUM_CTX: "32768",
  GMAIL_CLIENT_ID: "",
  GMAIL_CLIENT_SECRET: "",
  GMAIL_REFRESH_TOKEN: "",
  GMAIL_USER: "",
  MS_CLIENT_ID: "",
  MS_REFRESH_TOKEN: "",
  MS_USER: "",
  ZOOM_CLIENT_ID: "",
  ZOOM_CLIENT_SECRET: "",
  ZOOM_REFRESH_TOKEN: "",
  ZOOM_USER: "",
  TRELLO_KEY: "",
  TRELLO_TOKEN: "",
  HUGGING_FACE_TOKEN: "",
  GITHUB_TOKEN: "",
  PERF_METRICS_POLL_INTERVAL: "10000",
  CREDIT_POLL_INTERVAL: "60000",
  WHISPER_MODEL_SIZE: "medium",
  EMBEDDING_PROVIDER: "pyannote",
  KEEP_TRANSCRIPT_TIMESTAMPS: "false",
  WHISPER_INITIAL_PROMPT_ENABLED: "false",
  WHISPER_INITIAL_PROMPT: "",
  LOG_LLM_DATA: "false",
  LOG_COLLAPSE_REPEATED_PREFIXES: "true",
  LOG_CHROMIUM: "true",
  LLM_TEMPERATURE: "0.1",
  APPEARANCE_THEME: "dark",
  APPEARANCE_ACCENT_COLOR: "#58a6ff",
  APPEARANCE_FONT_SIZE: "medium",
  APPEARANCE_SIDEBAR_WIDTH: "48",
  DELIVERY_RECIPIENT_EMAILS: "",
  DELIVERY_EMAIL_SUBJECT: "Meeting Summary: {title}",
  DELIVERY_EMAIL_ADDITIONAL_CONTENT: "",
  DELIVERY_DRIVE_FOLDER: "Meeting Transcripts",
  PLAYWRIGHT_AUDIO_FILE_PATH: "",
  PLAYWRIGHT_TITLE_TEMPLATE: "test {autoNum}",
  PLAYWRIGHT_GENERIC_NAMES:
    "Alex,Blake,Casey,Drew,Ellis,Finley,Gray,Harper,Indigo,Jade,Kai,Logan,Morgan,Nico,Oakley,Parker,Quinn,Reese,Skyler,Taylor",
  PIPELINE_TIMEOUT_MINUTES: "60",
  GATE_RAW_REVIEW_ENABLED: "true",
  GATE_DELIVERY_REVIEW_ENABLED: "true",
  CUSTOM_DELIVERY_PER_MEETING: "true",
  KEEP_MODELS_WARM: "false",
  DSMON_PUSH_URL: "",
  DSMON_INSTANCE_ID: "",
  DSMON_PUSH_INTERVAL: "300000",
  DSMON_PUSH_TOKEN: "",
  USAGE_TRACKING_ENABLED: "false",
  CLOUDFLARED_TUNNEL_NAME: "",
  CLOUDFLARED_TUNNEL_TOKEN: "",
  // ── Diarization tuning defaults ──
  DIARIZATION_MIN_SPEAKER_DURATION: "3.0",
  DIARIZATION_MIN_SPEAKER_SEGMENTS: "3",
  DIARIZATION_MERGING_GAP: "0.5",
  DIARIZATION_CLUSTERING_THRESHOLD: "0.0",
  DIARIZATION_MAX_SPEAKERS: "0",
  DIARIZATION_TIMEOUT_MINUTES: "60",
};

/** Keys the UI considers "required" before the pipeline can run. */
export const REQUIRED_CONFIG_KEYS: (keyof AppConfig)[] = ["DEEPSEEK_API_KEY"];

/** All known config keys (from the hardcoded DEFAULTS object). Used to validate imported data. */
export const CONFIG_KEYS: (keyof AppConfig)[] = Object.keys(DEFAULTS) as (keyof AppConfig)[];

let userConfigPath: string;
let userConfigDefaultsPath: string;
let cachedConfig: AppConfig | null = null;

function ensureUserDataDir(): void {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  userConfigPath = path.join(dir, "config.json");
  userConfigDefaultsPath = path.join(dir, "config.defaults.json");
  ensureUserConfigDefaults();
}

/** Key inside config.defaults.json that stamps the app version the snapshot was created for. */
const USER_CONFIG_DEFAULTS_VERSION_KEY = "__version";

/**
 * Snapshot the shipped DEFAULTS to config.defaults.json.
 *
 * Written on first launch; then regenerated whenever the app version changes
 * so "restore defaults" always yields the CURRENT shipped defaults (not the
 * ones frozen at install time). The snapshot stores an `__version` stamp.
 *
 * Symmetric to how the bridge snapshots agent-config/.defaults/.
 */
function ensureUserConfigDefaults(): void {
  try {
    if (fs.existsSync(userConfigDefaultsPath)) {
      // Snapshot already exists — only regenerate if it was created for a
      // different app version (new keys / changed defaults after an upgrade).
      let snapshotVersion = "";
      try {
        const raw = fs.readFileSync(userConfigDefaultsPath, "utf8");
        const existing = JSON.parse(raw);
        if (existing && typeof existing[USER_CONFIG_DEFAULTS_VERSION_KEY] === "string") {
          snapshotVersion = existing[USER_CONFIG_DEFAULTS_VERSION_KEY];
        }
      } catch {
        // ignore parse errors — regenerate below
      }
      if (snapshotVersion === app.getVersion()) return;

      // App version changed — regenerate from the CURRENT shipped DEFAULTS.
      // Deliberately NOT merged with the previous snapshot or the user's live
      // config, so "restore defaults" restores true current defaults.
      const snapshot = { ...DEFAULTS, [USER_CONFIG_DEFAULTS_VERSION_KEY]: app.getVersion() };
      fs.writeFileSync(userConfigDefaultsPath, JSON.stringify(snapshot, null, 2), "utf8");
      return;
    }

    // First launch — merge DEFAULTS with any already-saved user values so the
    // snapshot captures the full picture of what was originally shipped.
    const existing: Partial<AppConfig> = {};
    if (fs.existsSync(userConfigPath)) {
      try {
        const raw = fs.readFileSync(userConfigPath, "utf8");
        Object.assign(existing, JSON.parse(raw));
      } catch {
        // ignore parse errors
      }
    }
    const snapshot = { ...DEFAULTS, ...existing, [USER_CONFIG_DEFAULTS_VERSION_KEY]: app.getVersion() };
    fs.writeFileSync(userConfigDefaultsPath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {
    // Non-fatal — defaults just won't be snapshotted
  }
}

/** Read the user config defaults file. Returns empty object if missing. */
export function readUserConfigDefaults(): Partial<AppConfig> {
  try {
    if (!userConfigDefaultsPath) ensureUserDataDir();
    if (!fs.existsSync(userConfigDefaultsPath)) return {};
    return JSON.parse(fs.readFileSync(userConfigDefaultsPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Restore user config from the defaults snapshot.
 * Copies config.defaults.json over config.json, invalidates cache.
 */
export function restoreUserConfigDefaults(): AppConfig {
  invalidateConfigCache();
  ensureUserDataDir();
  if (!fs.existsSync(userConfigDefaultsPath)) {
    // No snapshot yet — write DEFAULTS as both snapshot and live config
    ensureUserConfigDefaults();
  }
  const defaults = readUserConfigDefaults();
  // Only keep keys that are in DEFAULTS (strip any stale/unknown keys)
  const clean: Partial<AppConfig> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
    if (defaults[key] !== undefined) clean[key] = defaults[key];
  }
  fs.writeFileSync(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
  return getConfig();
}

/**
 * Snapshot the CURRENT user config as the defaults.
 *
 * Writes DEFAULTS merged with the current user config.json values into
 * config.defaults.json, stamped with the current app version so
 * ensureUserConfigDefaults() won't regenerate it on the next launch. This lets
 * a user make the current setup the "restore defaults" target. Note: on a
 * future app-version change the snapshot is regenerated from shipped DEFAULTS
 * again (intentional — user-set defaults apply per version).
 */
export function setUserConfigDefaults(): AppConfig {
  ensureUserDataDir();
  const userVals = parseUserConfig();
  const snapshot = { ...DEFAULTS, ...userVals, [USER_CONFIG_DEFAULTS_VERSION_KEY]: app.getVersion() };
  fs.writeFileSync(userConfigDefaultsPath, JSON.stringify(snapshot, null, 2), "utf8");
  return getConfig();
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
  source: "user_config" | "env_file" | "environment" | "default";
}

/**
 * Non-empty process.env overrides for known config keys.
 *
 * Only non-empty values participate so an empty-string env var can't shadow
 * the hardcoded defaults (mirrors the `else if (process.env[key])` check in
 * getConfigWithSources()).
 */
function getEnvOverrides(): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
    const v = process.env[key];
    if (v) result[key] = v;
  }
  return result;
}

/** Merge config from: user file > env > defaults. */
export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = { ...DEFAULTS, ...getEnvOverrides(), ...parseUserConfig() };
  return cachedConfig;
}

/** Get config with per-key source info (for showing in the UI). */
export function getConfigWithSources(): Record<keyof AppConfig, ConfigValueSource> {
  const userVals = parseUserConfig();
  const result = {} as Record<keyof AppConfig, ConfigValueSource>;

  for (const key of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
    let source: ConfigValueSource["source"] = "default";
    let value = DEFAULTS[key];

    if (userVals[key]) {
      value = userVals[key]!;
      source = "user_config";
    } else if (process.env[key]) {
      value = process.env[key]!;
      source = "environment";
    }

    result[key] = { value, source };
  }
  return result;
}

/** Invalidate cache so next getConfig() re-reads from disk. */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/** Clear all user config values, reverting all values to defaults. */
export function clearConfig(): AppConfig {
  invalidateConfigCache();
  ensureUserDataDir();
  fs.writeFileSync(userConfigPath, "{}", "utf8");
  return getConfig();
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
  // Remove empty strings so they don't override saved values
  for (const key of Object.keys(merged) as (keyof AppConfig)[]) {
    if (merged[key] === "") delete merged[key];
  }

  fs.writeFileSync(userConfigPath, JSON.stringify(merged, null, 2), "utf8");
  return getConfig();
}

/**
 * Replace the entire user config with the given values.
 *
 * Unlike saveConfig() (which merges into the existing file), this writes
 * exactly the provided keys: any key absent from `values` is removed from
 * config.json, so omitted keys fall back to env/default. Used by config import
 * so importing a file restores that file's state instead of silently merging.
 * Unknown keys are filtered out and empty strings are dropped (they mean
 * "use the default").
 */
export function replaceConfig(values: Partial<AppConfig>): AppConfig {
  invalidateConfigCache();
  ensureUserDataDir();

  const clean: Partial<AppConfig> = {};
  for (const key of Object.keys(values) as (keyof AppConfig)[]) {
    if (!(key in DEFAULTS)) continue; // strip stale/unknown keys
    const v = values[key];
    if (v === undefined || v === null || v === "") continue;
    clean[key] = v;
  }

  fs.writeFileSync(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
  return getConfig();
}

/** Check if all required config values are present. */
export function checkConfig(): { ok: boolean; missing: string[] } {
  invalidateConfigCache(); // Force re-read from disk so removed keys are detected
  const config = getConfig();
  const missing: string[] = [];

  // If using Ollama, DEEPSEEK_API_KEY is not required, but a model name is.
  // Checked here so the UI surfaces it early instead of the runner failing at
  // the first LLM call.
  if (config.LLM_PROVIDER === "ollama") {
    const model = config.OLLAMA_MODEL || process.env.OLLAMA_MODEL || "";
    if (!model) missing.push("OLLAMA_MODEL");
  } else {
    for (const key of REQUIRED_CONFIG_KEYS) {
      // Check config.json first, then process.env as fallback (for .env values)
      const val = config[key] || process.env[key] || "";
      if (!val) missing.push(key);
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Get environment variables for child processes (config values merged in). */
export function getChildEnv(): NodeJS.ProcessEnv {
  const config = getConfig();
  // Use parseUserConfig() (explicitly-set keys only, NOT DEFAULTS) as the
  // primary source so that non-empty DEFAULTS (truthy strings like "false")
  // don't prevent fallthrough to process.env. This lets .env or host env vars
  // override whenever the user hasn't explicitly set a value in config.json.
  const userVals = parseUserConfig();
  const userData = app.getPath("userData");

  return {
    ...process.env,
    APP_VERSION: app.getVersion(),
    DEEPSEEK_API_KEY: userVals.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    LLM_PROVIDER: userVals.LLM_PROVIDER || process.env.LLM_PROVIDER || "deepseek",
    OLLAMA_BASE_URL: userVals.OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    OLLAMA_MODEL: userVals.OLLAMA_MODEL || process.env.OLLAMA_MODEL || "",
    OLLAMA_NUM_CTX: userVals.OLLAMA_NUM_CTX || process.env.OLLAMA_NUM_CTX || "32768",
    GMAIL_CLIENT_ID: userVals.GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || "",
    GMAIL_CLIENT_SECRET: userVals.GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || "",
    GMAIL_REFRESH_TOKEN: userVals.GMAIL_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN || "",
    GMAIL_USER: userVals.GMAIL_USER || process.env.GMAIL_USER || "",
    TRELLO_KEY: userVals.TRELLO_KEY || process.env.TRELLO_KEY || "",
    TRELLO_TOKEN: userVals.TRELLO_TOKEN || process.env.TRELLO_TOKEN || "",
    HUGGING_FACE_TOKEN: userVals.HUGGING_FACE_TOKEN || process.env.HUGGING_FACE_TOKEN || "",
    GITHUB_TOKEN: userVals.GITHUB_TOKEN || process.env.GITHUB_TOKEN || "",
    GH_TOKEN: config.GITHUB_TOKEN || process.env.GH_TOKEN || "", // electron-updater uses GH_TOKEN
    PERF_METRICS_POLL_INTERVAL: userVals.PERF_METRICS_POLL_INTERVAL || process.env.PERF_METRICS_POLL_INTERVAL || "10000",
    CREDIT_POLL_INTERVAL: userVals.CREDIT_POLL_INTERVAL || process.env.CREDIT_POLL_INTERVAL || "60000",
    EMBEDDING_PROVIDER: userVals.EMBEDDING_PROVIDER || process.env.EMBEDDING_PROVIDER || "pyannote",
    WHISPER_MODEL_SIZE: userVals.WHISPER_MODEL_SIZE || process.env.WHISPER_MODEL_SIZE || "medium",
    KEEP_TRANSCRIPT_TIMESTAMPS: userVals.KEEP_TRANSCRIPT_TIMESTAMPS || process.env.KEEP_TRANSCRIPT_TIMESTAMPS || "false",
    WHISPER_INITIAL_PROMPT_ENABLED: userVals.WHISPER_INITIAL_PROMPT_ENABLED || process.env.WHISPER_INITIAL_PROMPT_ENABLED || "false",
    WHISPER_INITIAL_PROMPT: userVals.WHISPER_INITIAL_PROMPT || process.env.WHISPER_INITIAL_PROMPT || "",
    LOG_LLM_DATA: userVals.LOG_LLM_DATA || process.env.LOG_LLM_DATA || "false",
    LOG_COLLAPSE_REPEATED_PREFIXES: userVals.LOG_COLLAPSE_REPEATED_PREFIXES || process.env.LOG_COLLAPSE_REPEATED_PREFIXES || "true",
    LLM_TEMPERATURE: userVals.LLM_TEMPERATURE || process.env.LLM_TEMPERATURE || "0.1",
    APPEARANCE_THEME: userVals.APPEARANCE_THEME || process.env.APPEARANCE_THEME || "dark",
    APPEARANCE_ACCENT_COLOR: userVals.APPEARANCE_ACCENT_COLOR || process.env.APPEARANCE_ACCENT_COLOR || "#58a6ff",
    APPEARANCE_FONT_SIZE: userVals.APPEARANCE_FONT_SIZE || process.env.APPEARANCE_FONT_SIZE || "medium",
    APPEARANCE_SIDEBAR_WIDTH: userVals.APPEARANCE_SIDEBAR_WIDTH || process.env.APPEARANCE_SIDEBAR_WIDTH || "48",
    PLAYWRIGHT_AUDIO_FILE_PATH: userVals.PLAYWRIGHT_AUDIO_FILE_PATH || process.env.PLAYWRIGHT_AUDIO_FILE_PATH || "",
    PLAYWRIGHT_TITLE_TEMPLATE: userVals.PLAYWRIGHT_TITLE_TEMPLATE || process.env.PLAYWRIGHT_TITLE_TEMPLATE || "test {autoNum}",
    PLAYWRIGHT_GENERIC_NAMES:
      userVals.PLAYWRIGHT_GENERIC_NAMES ||
      process.env.PLAYWRIGHT_GENERIC_NAMES ||
      "Alex,Blake,Casey,Drew,Ellis,Finley,Gray,Harper,Indigo,Jade,Kai,Logan,Morgan,Nico,Oakley,Parker,Quinn,Reese,Skyler,Taylor",
    PIPELINE_TIMEOUT_MINUTES: userVals.PIPELINE_TIMEOUT_MINUTES || process.env.PIPELINE_TIMEOUT_MINUTES || "60",
    // Delivery config — forwarded to Python backend for email + drive delivery
    DELIVERY_RECIPIENT_EMAILS: userVals.DELIVERY_RECIPIENT_EMAILS || process.env.DELIVERY_RECIPIENT_EMAILS || "",
    DELIVERY_EMAIL_SUBJECT: userVals.DELIVERY_EMAIL_SUBJECT || process.env.DELIVERY_EMAIL_SUBJECT || "Meeting Summary: {title}",
    DELIVERY_EMAIL_ADDITIONAL_CONTENT: userVals.DELIVERY_EMAIL_ADDITIONAL_CONTENT || process.env.DELIVERY_EMAIL_ADDITIONAL_CONTENT || "",
    DELIVERY_DRIVE_FOLDER: userVals.DELIVERY_DRIVE_FOLDER || process.env.DELIVERY_DRIVE_FOLDER || "Meeting Transcripts",
    GATE_RAW_REVIEW_ENABLED: userVals.GATE_RAW_REVIEW_ENABLED || process.env.GATE_RAW_REVIEW_ENABLED || "true",
    GATE_DELIVERY_REVIEW_ENABLED: userVals.GATE_DELIVERY_REVIEW_ENABLED || process.env.GATE_DELIVERY_REVIEW_ENABLED || "true",
    CUSTOM_DELIVERY_PER_MEETING: userVals.CUSTOM_DELIVERY_PER_MEETING || process.env.CUSTOM_DELIVERY_PER_MEETING || "true",
    KEEP_MODELS_WARM: userVals.KEEP_MODELS_WARM || process.env.KEEP_MODELS_WARM || "false",
    DSMON_PUSH_URL: userVals.DSMON_PUSH_URL || process.env.DSMON_PUSH_URL || "",
    DSMON_INSTANCE_ID: userVals.DSMON_INSTANCE_ID || process.env.DSMON_INSTANCE_ID || "",
    DSMON_PUSH_INTERVAL: userVals.DSMON_PUSH_INTERVAL || process.env.DSMON_PUSH_INTERVAL || "300000",
    DSMON_PUSH_TOKEN: userVals.DSMON_PUSH_TOKEN || process.env.DSMON_PUSH_TOKEN || "",
    USAGE_TRACKING_ENABLED: userVals.USAGE_TRACKING_ENABLED || process.env.USAGE_TRACKING_ENABLED || "false",
    CLOUDFLARED_TUNNEL_NAME: userVals.CLOUDFLARED_TUNNEL_NAME || process.env.CLOUDFLARED_TUNNEL_NAME || "",
    // ── Diarization tuning (passed to Python backend) ──
    DIARIZATION_MIN_SPEAKER_DURATION: userVals.DIARIZATION_MIN_SPEAKER_DURATION || process.env.DIARIZATION_MIN_SPEAKER_DURATION || "3.0",
    DIARIZATION_MIN_SPEAKER_SEGMENTS: userVals.DIARIZATION_MIN_SPEAKER_SEGMENTS || process.env.DIARIZATION_MIN_SPEAKER_SEGMENTS || "3",
    DIARIZATION_MERGING_GAP: userVals.DIARIZATION_MERGING_GAP || process.env.DIARIZATION_MERGING_GAP || "0.5",
    DIARIZATION_CLUSTERING_THRESHOLD: userVals.DIARIZATION_CLUSTERING_THRESHOLD || process.env.DIARIZATION_CLUSTERING_THRESHOLD || "0.0",
    DIARIZATION_MAX_SPEAKERS: userVals.DIARIZATION_MAX_SPEAKERS || process.env.DIARIZATION_MAX_SPEAKERS || "0",
    DIARIZATION_TIMEOUT_MINUTES: userVals.DIARIZATION_TIMEOUT_MINUTES || process.env.DIARIZATION_TIMEOUT_MINUTES || "60",
    // Storage paths — only override in packaged (prod) mode so DBs land in a
    // writable location. In dev the Python backend defaults to the project-
    // relative storage/ dir, which is already writable.
    ...(app.isPackaged
      ? {
          TRANSCRIPTION_STORAGE: process.env.TRANSCRIPTION_STORAGE || path.join(userData, "storage"),
          TRANSCRIPTION_QUEUE_DIR: process.env.TRANSCRIPTION_QUEUE_DIR || path.join(userData, "queue"),
          TRANSCRIPTION_TRIGGER_FILE: process.env.TRANSCRIPTION_TRIGGER_FILE || path.join(userData, "queue", ".transcription-trigger"),
        }
      : {}),
  };
}

/** Agent config file names to write. */
const AGENT_CONFIG_FILES = ["pipeline.json", "tools.json", "system-prompt.md"] as const;

/** Result of writing agent config to disk. */
export interface AgentConfigDiskResult {
  success: boolean;
  written: string[];
  error?: string;
}

/**
 * Write agent config files directly to userData/agent-config/ on disk.
 *
 * This bypasses the bridge server, so it works even on a clean install
 * where the bridge isn't running yet. Uses atomic rename (write .tmp → rename)
 * for crash safety.
 *
 * Also touches .restart-flag so the watcher in index.ts triggers a runner restart.
 */
export function saveAgentConfigToDisk(config: { systemPrompt?: string; pipeline?: any; tools?: any }): AgentConfigDiskResult {
  const agentConfigDir = path.join(app.getPath("userData"), "agent-config");
  const written: string[] = [];

  try {
    fs.mkdirSync(agentConfigDir, { recursive: true });

    if (config.pipeline !== undefined) {
      const filePath = path.join(agentConfigDir, "pipeline.json");
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(config.pipeline, null, 2), "utf8");
      fs.renameSync(tmpPath, filePath);
      written.push("pipeline.json");
    }

    if (config.tools !== undefined) {
      const filePath = path.join(agentConfigDir, "tools.json");
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(config.tools, null, 2), "utf8");
      fs.renameSync(tmpPath, filePath);
      written.push("tools.json");
    }

    if (config.systemPrompt !== undefined) {
      const filePath = path.join(agentConfigDir, "system-prompt.md");
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, config.systemPrompt, "utf8");
      fs.renameSync(tmpPath, filePath);
      written.push("system-prompt.md");
    }

    // Touch .restart-flag so the watcher restarts the runner
    if (written.length > 0) {
      const restartFlagPath = path.join(agentConfigDir, ".restart-flag");
      fs.writeFileSync(restartFlagPath, JSON.stringify({ timestamp: new Date().toISOString(), source: "saveAgentConfigToDisk" }), "utf8");
    }

    return { success: true, written };
  } catch (err: any) {
    return { success: false, written, error: err.message };
  }
}
