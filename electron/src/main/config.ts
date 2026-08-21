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
import { isLicensed, readStoredLicenseKey } from "./license";
import { writeEncryptedFileAtRest, readEncryptedFileAtRest, migratePlaintextConfig, getOrCreateConfigSecret, decryptLegacyConfigEnvelope } from "./config-encryption";

export interface AppConfig {
  /** DeepSeek API key (required when API_PROVIDER=deepseek) */
  DEEPSEEK_API_KEY: string;
  /** OpenAI API key (required when API_PROVIDER=openai) */
  OPENAI_API_KEY: string;
  /** Anthropic API key (required when API_PROVIDER=anthropic) */
  ANTHROPIC_API_KEY: string;
  /** LLM provider umbrella: "api" (cloud) or "ollama" (local) */
  LLM_PROVIDER: string;
  /** Cloud LLM provider when LLM_PROVIDER=api: "deepseek" | "openai" | "anthropic" */
  API_PROVIDER: string;
  /** DeepSeek model override (default baked into the runner) */
  DEEPSEEK_MODEL: string;
  /** OpenAI model override (default baked into the runner) */
  OPENAI_MODEL: string;
  /** Anthropic model override (default baked into the runner) */
  ANTHROPIC_MODEL: string;
  /** Optional OpenAI-compatible base URL override (empty = api.openai.com) */
  OPENAI_BASE_URL: string;
  /** Optional Anthropic base URL override (empty = api.anthropic.com) */
  ANTHROPIC_BASE_URL: string;
  /** Anthropic max output tokens (default 4096) */
  ANTHROPIC_MAX_TOKENS: string;
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
  /** Enable the DS-mon license-authority revocation check (default ON) */
  DSMON_LICENSE_CHECK_ENABLED: string;
  /** DS-mon license re-check interval in milliseconds (default 43200000 = 12h, min 60000) */
  DSMON_LICENSE_CHECK_INTERVAL: string;
  /** Base64url 32-byte AES-256-GCM key — encrypts DS-mon push + license payloads when set (secret) */
  DSMON_ENCRYPTION_KEY: string;
  /** Key id placed in each DS-mon encryption envelope (default "dsmon") */
  DSMON_ENCRYPTION_KEY_ID: string;
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
  /** Show images in the in-app User Guide / Dev Guide (DocViewer renderer) */
  USER_GUIDE_IMAGES_ENABLED: string;
}

const DEFAULTS: AppConfig = {
  DEEPSEEK_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  LLM_PROVIDER: "api",
  API_PROVIDER: "deepseek",
  DEEPSEEK_MODEL: "",
  OPENAI_MODEL: "",
  ANTHROPIC_MODEL: "",
  OPENAI_BASE_URL: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_MAX_TOKENS: "4096",
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
  APPEARANCE_THEME: "light",
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
  DSMON_LICENSE_CHECK_ENABLED: "true",
  DSMON_LICENSE_CHECK_INTERVAL: "43200000",
  DSMON_ENCRYPTION_KEY: "",
  DSMON_ENCRYPTION_KEY_ID: "dsmon",
  CLOUDFLARED_TUNNEL_NAME: "",
  CLOUDFLARED_TUNNEL_TOKEN: "",
  // ── Diarization tuning defaults ──
  DIARIZATION_MIN_SPEAKER_DURATION: "3.0",
  DIARIZATION_MIN_SPEAKER_SEGMENTS: "3",
  DIARIZATION_MERGING_GAP: "0.5",
  DIARIZATION_CLUSTERING_THRESHOLD: "0.0",
  DIARIZATION_MAX_SPEAKERS: "0",
  DIARIZATION_TIMEOUT_MINUTES: "60",
  USER_GUIDE_IMAGES_ENABLED: "true",
};

/** Keys the UI considers "required" before the pipeline can run. */
export const REQUIRED_CONFIG_KEYS: (keyof AppConfig)[] = ["DEEPSEEK_API_KEY"];

/** All known config keys (from the hardcoded DEFAULTS object). Used to validate imported data. */
export const CONFIG_KEYS: (keyof AppConfig)[] = Object.keys(DEFAULTS) as (keyof AppConfig)[];

/** Config keys holding secrets — never persisted to the plaintext config.defaults.json snapshot. */
export const SECRET_CONFIG_KEYS: (keyof AppConfig)[] = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_USER",
  "MS_CLIENT_ID",
  "MS_REFRESH_TOKEN",
  "MS_USER",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
  "ZOOM_REFRESH_TOKEN",
  "ZOOM_USER",
  "TRELLO_KEY",
  "TRELLO_TOKEN",
  "HUGGING_FACE_TOKEN",
  "GITHUB_TOKEN",
  "DSMON_PUSH_TOKEN",
  "DSMON_ENCRYPTION_KEY",
  "CLOUDFLARED_TUNNEL_TOKEN",
];

/** Cloud LLM providers selectable under the "api" umbrella. */
export const API_LLM_PROVIDERS = ["deepseek", "openai", "anthropic"] as const;
export type ApiLlmProvider = (typeof API_LLM_PROVIDERS)[number];
/** Effective provider consumed by the agent runner. */
export type EffectiveLlmProvider = ApiLlmProvider | "ollama";

const API_PROVIDER_SET = new Set<string>(API_LLM_PROVIDERS);

/** True if v is a valid cloud (API) LLM provider id. */
export function isApiLlmProvider(v: string | null | undefined): v is ApiLlmProvider {
  return !!v && API_PROVIDER_SET.has(v);
}

/**
 * Resolve the two-level LLM config (LLM_PROVIDER: api|ollama + API_PROVIDER)
 * into the single effective provider the runner consumes. Also accepts legacy
 * configs where LLM_PROVIDER held the cloud provider directly.
 */
export function effectiveLlmProvider(cfg: { LLM_PROVIDER?: string; API_PROVIDER?: string }): EffectiveLlmProvider {
  const lp = (cfg.LLM_PROVIDER || "").toLowerCase();
  if (lp === "ollama") return "ollama";
  if (lp === "api") return isApiLlmProvider(cfg.API_PROVIDER) ? (cfg.API_PROVIDER as ApiLlmProvider) : "deepseek";
  if (isApiLlmProvider(lp)) return lp as ApiLlmProvider;
  return "deepseek";
}

/**
 * Normalize a raw config object's provider fields in place to the canonical
 * two-level form (LLM_PROVIDER ∈ {api, ollama} + valid API_PROVIDER). Legacy
 * `LLM_PROVIDER: "deepseek"` becomes {LLM_PROVIDER: "api", API_PROVIDER: "deepseek"}.
 */
export function normalizeProviderPair(vals: Partial<AppConfig>): void {
  const lp = (vals.LLM_PROVIDER || "").toLowerCase();
  if (isApiLlmProvider(lp)) {
    vals.LLM_PROVIDER = "api";
    if (!vals.API_PROVIDER) vals.API_PROVIDER = lp;
  } else if (lp && lp !== "api" && lp !== "ollama") {
    vals.LLM_PROVIDER = "api";
    if (!vals.API_PROVIDER) vals.API_PROVIDER = "deepseek";
  }
  if ((vals.LLM_PROVIDER || "api") === "api" && !isApiLlmProvider(vals.API_PROVIDER)) {
    vals.API_PROVIDER = "deepseek";
  }
}

let userConfigPath: string;
let userConfigGpgPath: string;
let userConfigDefaultsPath: string;
let cachedConfig: AppConfig | null = null;

function ensureUserDataDir(): void {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  userConfigPath = path.join(dir, "config.json");
  userConfigGpgPath = path.join(dir, "config.json.gpg");
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
    // Secrets are scrubbed so the plaintext defaults snapshot never holds them.
    const existing: Partial<AppConfig> = {};
    try {
      const raw = readUserConfigRaw();
      if (raw) Object.assign(existing, JSON.parse(raw));
    } catch {
      // ignore parse errors
    }
    for (const key of SECRET_CONFIG_KEYS) existing[key] = "";
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
  syncConfigToEnv();
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
  const snapshot = { ...DEFAULTS, ...userVals, [USER_CONFIG_DEFAULTS_VERSION_KEY]: app.getVersion() } as Record<string, string>;
  for (const key of SECRET_CONFIG_KEYS) snapshot[key] = "";
  fs.writeFileSync(userConfigDefaultsPath, JSON.stringify(snapshot, null, 2), "utf8");
  syncConfigToEnv();
  return getConfig();
}

/** The active license key used to encrypt/decrypt the at-rest config, if licensed. */
function getActiveLicenseKey(): string | null {
  return isLicensed() ? readStoredLicenseKey() : null;
}

/**
 * Read the raw user-config JSON string.
 * When licensed this decrypts config.json.gpg (falling back to a legacy
 * plaintext config.json if present). When unlicensed the user config is
 * deliberately not read (locked mode runs on defaults only).
 */
export function readUserConfigRaw(): string | null {
  if (!userConfigPath) ensureUserDataDir();
  // v2: the at-rest config is encrypted under the per-machine secret, NOT the
  // license key — a license change / revocation never affects it. Locked mode
  // still never reads it (parseUserConfig gates on isLicensed()).
  if (isLicensed()) {
    const secret = getOrCreateConfigSecret();
    if (secret && fs.existsSync(userConfigGpgPath)) {
      try {
        return readEncryptedFileAtRest(userConfigGpgPath, secret);
      } catch {
        // wrong secret / corrupt — fall back to plaintext below
      }
    }
  }
  if (fs.existsSync(userConfigPath)) {
    return fs.readFileSync(userConfigPath, "utf8");
  }
  return null;
}

/** Write the user-config JSON string (encrypted at-rest when licensed). */
function writeUserConfigRaw(contents: string): void {
  if (!userConfigPath) ensureUserDataDir();
  const secret = isLicensed() ? getOrCreateConfigSecret() : null;
  if (secret) {
    writeEncryptedFileAtRest(userConfigGpgPath, contents, secret);
  } else {
    fs.writeFileSync(userConfigPath, contents, "utf8");
  }
  // Always keep a plaintext recovery copy so a license change / corruption can
  // always be recovered via restore-backup or the on-activation auto-restore.
  try {
    fs.writeFileSync(`${userConfigPath}.bak`, contents, "utf8");
  } catch {
    // non-fatal — the encrypted copy is authoritative
  }
}

/**
 * Migrate a legacy plaintext config.json → config.json.gpg.
 * Called after first license activation. Keeps config.json.bak until verified.
 */
export function migrateConfigToEncrypted(): { migrated: boolean; backupPath?: string } {
  ensureUserDataDir();
  if (!isLicensed()) return { migrated: false };
  const secret = getOrCreateConfigSecret();
  if (!secret) return { migrated: false };
  // Only auto-restore from backup when there is NO encrypted config yet — i.e.
  // a genuinely deleted config.json.gpg. If the .gpg already exists, never
  // resurrect a plaintext copy (that would leak secrets next to the encrypted one).
  if (!fs.existsSync(userConfigGpgPath) && !fs.existsSync(userConfigPath) && fs.existsSync(`${userConfigPath}.bak`)) {
    try {
      const raw = fs.readFileSync(`${userConfigPath}.bak`, "utf8");
      JSON.parse(raw); // sanity check
      fs.writeFileSync(userConfigPath, raw, "utf8");
    } catch {
      // ignore — leave a broken backup alone
    }
  }
  return migratePlaintextConfig(userConfigPath, userConfigGpgPath, secret);
}

/** On-disk config integrity, for recovery UI (never silently default). */
export interface ConfigIntegrity {
  configGpg: "present" | "missing" | "corrupt";
  backupExists: boolean;
}

export function getConfigIntegrity(): ConfigIntegrity {
  ensureUserDataDir();
  const gpgExists = fs.existsSync(userConfigGpgPath);
  const backupExists = fs.existsSync(`${userConfigPath}.bak`);
  let configGpg: ConfigIntegrity["configGpg"] = "missing";
  if (gpgExists) {
    if (isLicensed()) {
      const secret = getOrCreateConfigSecret();
      try {
        if (secret) readEncryptedFileAtRest(userConfigGpgPath, secret);
        configGpg = "present";
      } catch {
        configGpg = "corrupt";
      }
    } else {
      // Present but can't be verified without a license — report as present.
      configGpg = "present";
    }
  }
  return { configGpg, backupExists };
}

/**
 * Restore the config from config.json.bak (re-encrypts under the active license
 * key when licensed, otherwise stages a plaintext config.json for migration).
 */
export function restoreConfigFromBackup(): { ok: boolean; error?: string } {
  ensureUserDataDir();
  const backupPath = `${userConfigPath}.bak`;
  if (!fs.existsSync(backupPath)) return { ok: false, error: "No config backup found." };
  try {
    const raw = fs.readFileSync(backupPath, "utf8");
    JSON.parse(raw); // sanity check
    writeUserConfigRaw(raw);
    invalidateConfigCache();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Could not restore the config backup." };
  }
}

/**
 * Re-encrypt the at-rest config under a NEW license key (master rotation /
 * re-issued seat key). Requires the old key (still stored) to decrypt first.
 */
export function reKeyConfig(newKey: string, oldKeyOverride?: string): { ok: boolean; error?: string } {
  ensureUserDataDir();
  const secret = getOrCreateConfigSecret();
  if (secret && fs.existsSync(userConfigGpgPath)) {
    try {
      const raw = fs.readFileSync(userConfigGpgPath, "utf8");
      // v2: config is encrypted under the per-machine secret, NOT the license
      // key, so a license change never requires re-encryption. Only a legacy
      // v1 envelope (license-key-derived) is migrated to v2 once.
      if (raw.startsWith("v1.")) {
        const oldKey = oldKeyOverride || getActiveLicenseKey();
        if (!oldKey) return { ok: false, error: "No previous license key available to decrypt the existing config." };
        const plaintext = decryptLegacyConfigEnvelope(raw, oldKey);
        writeEncryptedFileAtRest(userConfigGpgPath, plaintext, secret);
      }
    } catch {
      return { ok: false, error: "Could not migrate the existing config." };
    }
  }
  // If a legacy plaintext config.json still exists, migrate it under the machine secret.
  if (secret && fs.existsSync(userConfigPath)) {
    migratePlaintextConfig(userConfigPath, userConfigGpgPath, secret);
  }
  return { ok: true };
}

/** Read the user config file from app.getPath("userData")/config.json (or config.json.gpg when licensed). */
function parseUserConfig(): Partial<AppConfig> {
  try {
    if (!userConfigPath) ensureUserDataDir();
    // Locked mode (no license): defaults only — user config is never read.
    if (!isLicensed()) return {};
    const raw = readUserConfigRaw();
    if (!raw) return {};
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
  // Normalize legacy provider values (deepseek → api + API_PROVIDER) so the
  // UI and consumers always read the canonical two-level form.
  normalizeProviderPair(cachedConfig);
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

  // Normalize legacy provider values for the UI (deepseek → api + API_PROVIDER).
  const llmSrc = result.LLM_PROVIDER;
  if (isApiLlmProvider(llmSrc.value)) {
    result.LLM_PROVIDER = { value: "api", source: llmSrc.source };
    if (!isApiLlmProvider(result.API_PROVIDER.value)) {
      result.API_PROVIDER = { value: llmSrc.value, source: llmSrc.source };
    }
  }
  if ((result.LLM_PROVIDER?.value || "api") === "api" && !isApiLlmProvider(result.API_PROVIDER?.value)) {
    result.API_PROVIDER = { value: "deepseek", source: "default" };
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
  writeUserConfigRaw("{}");
  syncConfigToEnv();
  return getConfig();
}

/** Save config values to user config file. Merges with existing. */
export function saveConfig(values: Partial<AppConfig>): AppConfig {
  invalidateConfigCache();
  ensureUserDataDir();

  // Read existing user config to merge
  let existing: Partial<AppConfig> = {};
  try {
    const raw = readUserConfigRaw();
    if (raw) existing = JSON.parse(raw);
  } catch {
    // ignore
  }

  const merged: Partial<AppConfig> = { ...existing, ...values };
  // Normalize legacy provider values before persisting (deepseek → api + API_PROVIDER).
  normalizeProviderPair(merged);
  // Remove empty strings so they don't override saved values
  for (const key of Object.keys(merged) as (keyof AppConfig)[]) {
    if (merged[key] === "") delete merged[key];
  }

  writeUserConfigRaw(JSON.stringify(merged, null, 2));
  syncConfigToEnv();
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
  // Normalize legacy provider values (deepseek → api + API_PROVIDER).
  normalizeProviderPair(clean);

  writeUserConfigRaw(JSON.stringify(clean, null, 2));
  syncConfigToEnv();
  return getConfig();
}

/**
 * Ensure every known config key is present in the app's .env file(s).
 *
 * Reads the current effective config and appends any DEFAULTS key that is
 * missing from the target .env file (repo-root `.env` in dev, `userData/.env`
 * when packaged, plus `python-backend/.env` in dev). Existing lines — user
 * comments, unrelated vars, secrets — are preserved verbatim; this is purely
 * additive so a fresh reader of the .env sees the full configuration.
 * Best-effort: failures are swallowed (the .env is optional).
 */
export function syncConfigToEnv(): void {
  try {
    const rootDir = app.isPackaged ? app.getPath("userData") : path.join(app.getAppPath(), "..");
    const envPaths: string[] = [path.join(rootDir, ".env")];
    if (!app.isPackaged) {
      envPaths.push(path.join(rootDir, "python-backend", ".env"));
    }

    const config = getConfig();

    for (const envPath of envPaths) {
      let content = "";
      const existingKeys = new Set<string>();
      if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq === -1) continue;
          existingKeys.add(trimmed.slice(0, eq).trim());
        }
      }

      const missing = (Object.keys(DEFAULTS) as (keyof AppConfig)[]).filter((k) => !existingKeys.has(k));
      if (missing.length === 0) continue;

      const lines: string[] = [];
      if (content && !content.endsWith("\n")) lines.push("");
      lines.push("", "# ── Synced from app config (config.json) ──");
      for (const key of missing) {
        lines.push(`${key}=${config[key] ?? ""}`);
      }
      fs.writeFileSync(envPath, content + lines.join("\n") + "\n", "utf8");
    }
  } catch {
    // Non-fatal — .env sync is best-effort
  }
}

/** Check if all required config values are present. */
export function checkConfig(): { ok: boolean; missing: string[] } {
  invalidateConfigCache(); // Force re-read from disk so removed keys are detected
  const config = getConfig();
  const missing: string[] = [];

  // Required values depend on the effective provider. Surfaced here so the UI
  // flags the right key early instead of the runner failing at the first LLM call.
  const effective = effectiveLlmProvider(config);
  if (effective === "ollama") {
    const model = config.OLLAMA_MODEL || process.env.OLLAMA_MODEL || "";
    if (!model) missing.push("OLLAMA_MODEL");
  } else if (effective === "deepseek") {
    const key = config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "";
    if (!key) missing.push("DEEPSEEK_API_KEY");
  } else if (effective === "openai") {
    const key = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!key) missing.push("OPENAI_API_KEY");
  } else if (effective === "anthropic") {
    const key = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
    if (!key) missing.push("ANTHROPIC_API_KEY");
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
    OPENAI_API_KEY: userVals.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    ANTHROPIC_API_KEY: userVals.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "",
    // Flatten the two-level config (api + API_PROVIDER) to the single effective
    // provider the agent runner / model-client consume — "api" never leaks through.
    LLM_PROVIDER: effectiveLlmProvider(config),
    API_PROVIDER: userVals.API_PROVIDER || process.env.API_PROVIDER || "",
    DEEPSEEK_MODEL: userVals.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || "",
    OPENAI_MODEL: userVals.OPENAI_MODEL || process.env.OPENAI_MODEL || "",
    ANTHROPIC_MODEL: userVals.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || "",
    OPENAI_BASE_URL: userVals.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "",
    ANTHROPIC_BASE_URL: userVals.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "",
    ANTHROPIC_MAX_TOKENS: userVals.ANTHROPIC_MAX_TOKENS || process.env.ANTHROPIC_MAX_TOKENS || "4096",
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
    APPEARANCE_THEME: userVals.APPEARANCE_THEME || process.env.APPEARANCE_THEME || "light",
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
    DSMON_LICENSE_CHECK_ENABLED: userVals.DSMON_LICENSE_CHECK_ENABLED || process.env.DSMON_LICENSE_CHECK_ENABLED || "true",
    DSMON_LICENSE_CHECK_INTERVAL: userVals.DSMON_LICENSE_CHECK_INTERVAL || process.env.DSMON_LICENSE_CHECK_INTERVAL || "43200000",
    DSMON_ENCRYPTION_KEY: userVals.DSMON_ENCRYPTION_KEY || process.env.DSMON_ENCRYPTION_KEY || "",
    DSMON_ENCRYPTION_KEY_ID: userVals.DSMON_ENCRYPTION_KEY_ID || process.env.DSMON_ENCRYPTION_KEY_ID || "dsmon",
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
