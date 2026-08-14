/**
 * ConfigPanel — modal overlay for entering app configuration.
 *
 * Two tabs:
 *   "config" — API keys, LLM provider, delivery credentials
 *   "agent"  — Agent instructions: system prompt, tool definitions, pipeline hints
 *
 * Supports two modes:
 *   "edit"   — Edit and save config values
 *   "view"   — Read-only view showing current config with source annotations
 *
 * The agent instructions tab saves via the bridge server (POST /agent/config)
 * and flags the agent runner for restart via the restart-flag mechanism.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useUiState, useUiStateValue } from "../hooks/useUiState";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import LoadingModal from "./LoadingModal";
import { loadAndApplyAppearance } from "../appearance";
import { Validator } from "@cfworker/json-schema";
import { agentConfigSchema } from "../utils/agentConfigSchema";
import type { PipelineStep, ConfigValueSource } from "../types";

interface Props {
  onClose: () => void;
  configOk?: boolean;
}

type ConfigTab = "config" | "agent" | "logging" | "ui";

interface ConfigValues {
  [key: string]: string;
  DEEPSEEK_API_KEY: string;
  LLM_PROVIDER: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_MODEL: string;
  OLLAMA_NUM_CTX: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  MS_CLIENT_ID: string;
  MS_REFRESH_TOKEN: string;
  MS_USER: string;
  ZOOM_CLIENT_ID: string;
  ZOOM_CLIENT_SECRET: string;
  ZOOM_REFRESH_TOKEN: string;
  ZOOM_USER: string;
  TRELLO_KEY: string;
  TRELLO_TOKEN: string;
  DSMON_INSTANCE_ID: string;
  DSMON_PUSH_INTERVAL: string;
  DSMON_PUSH_URL: string;
  DSMON_PUSH_TOKEN: string;
  USAGE_TRACKING_ENABLED: string;
  CLOUDFLARED_TUNNEL_NAME: string;
  CLOUDFLARED_TUNNEL_TOKEN: string;
  HUGGING_FACE_TOKEN: string;
  GITHUB_TOKEN: string;
  EMBEDDING_PROVIDER: string;
  WHISPER_MODEL_SIZE: string;
  KEEP_TRANSCRIPT_TIMESTAMPS: string;
  WHISPER_INITIAL_PROMPT_ENABLED: string;
  WHISPER_INITIAL_PROMPT: string;
  LOG_LLM_DATA: string;
  LOG_COLLAPSE_REPEATED_PREFIXES: string;
  LOG_CHROMIUM: string;
  LLM_TEMPERATURE: string;
  PIPELINE_TIMEOUT_MINUTES: string;
  // ── Diarization tuning (ASV phantom speaker suppression) ──
  DIARIZATION_MIN_SPEAKER_DURATION: string;
  DIARIZATION_MIN_SPEAKER_SEGMENTS: string;
  DIARIZATION_MERGING_GAP: string;
  DIARIZATION_CLUSTERING_THRESHOLD: string;
  DIARIZATION_MAX_SPEAKERS: string;
  GATE_RAW_REVIEW_ENABLED: string;
  GATE_DELIVERY_REVIEW_ENABLED: string;
  CUSTOM_DELIVERY_PER_MEETING: string;
  KEEP_MODELS_WARM: string;
  DELIVERY_RECIPIENT_EMAILS: string;
  DELIVERY_EMAIL_SUBJECT: string;
  DELIVERY_EMAIL_ADDITIONAL_CONTENT: string;
  DELIVERY_DRIVE_FOLDER: string;
  USER_GUIDE_IMAGES_ENABLED: string;
}

interface AgentConfig {
  tools?: any[];
  pipeline?: {
    max_pipeline_steps?: number;
    max_retries?: number;
    retry_base_delay_ms?: number;
    terminal_tools?: string[];
    llm_context_window?: number;
    pipeline_hints?: Record<string, string>;
    event_templates?: Record<string, string>;
    /** Ordered pipeline steps for the draggable checklist UI */
    pipeline_steps?: PipelineStep[];
  };
  systemPrompt?: string;
}

const FIELDS: { key: keyof ConfigValues; label: string; required: boolean; secret: boolean; section: string }[] = [
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key", required: true, secret: true, section: "LLM Provider" },
  { key: "OLLAMA_BASE_URL", label: "Ollama Base URL", required: false, secret: false, section: "LLM Provider" },
  { key: "OLLAMA_MODEL", label: "Ollama Model", required: false, secret: false, section: "LLM Provider" },
  { key: "OLLAMA_NUM_CTX", label: "Ollama Context Window", required: false, secret: false, section: "LLM Provider" },
  { key: "LLM_TEMPERATURE", label: "LLM Temperature (0.0–2.0)", required: false, secret: false, section: "LLM Provider" },
  { key: "PIPELINE_TIMEOUT_MINUTES", label: "Pipeline/Polling Timeout (minutes)", required: false, secret: false, section: "Pipeline" },
  { key: "HUGGING_FACE_TOKEN", label: "Hugging Face Token", required: false, secret: true, section: "LLM Provider" },
  { key: "GITHUB_TOKEN", label: "GitHub PAT (for private repo auto-updates)", required: false, secret: true, section: "Auto-Update" },
  { key: "EMBEDDING_PROVIDER", label: "Speaker Embedding Model", required: false, secret: false, section: "LLM Provider" },
  { key: "WHISPER_MODEL_SIZE", label: "Whisper Model Size", required: false, secret: false, section: "LLM Provider" },
  { key: "KEEP_TRANSCRIPT_TIMESTAMPS", label: "Keep Transcript Timestamps", required: false, secret: false, section: "LLM Provider" },
  { key: "WHISPER_INITIAL_PROMPT_ENABLED", label: "Whisper Initial Prompt", required: false, secret: false, section: "LLM Provider" },
  { key: "WHISPER_INITIAL_PROMPT", label: "Initial Prompt Text", required: false, secret: false, section: "LLM Provider" },
  { key: "GMAIL_CLIENT_ID", label: "Gmail Client ID", required: false, secret: true, section: "Services" },
  { key: "GMAIL_CLIENT_SECRET", label: "Gmail Client Secret", required: false, secret: true, section: "Services" },
  { key: "GMAIL_REFRESH_TOKEN", label: "Gmail Refresh Token", required: false, secret: true, section: "Services" },
  { key: "GMAIL_USER", label: "Gmail User Email", required: false, secret: false, section: "Services" },
  { key: "MS_CLIENT_ID", label: "Teams Client ID", required: false, secret: true, section: "Services" },
  { key: "MS_REFRESH_TOKEN", label: "Teams Refresh Token", required: false, secret: true, section: "Services" },
  { key: "MS_USER", label: "Teams User", required: false, secret: false, section: "Services" },
  { key: "ZOOM_CLIENT_ID", label: "Zoom Client ID", required: false, secret: true, section: "Services" },
  { key: "ZOOM_CLIENT_SECRET", label: "Zoom Client Secret", required: false, secret: true, section: "Services" },
  { key: "ZOOM_REFRESH_TOKEN", label: "Zoom Refresh Token", required: false, secret: true, section: "Services" },
  { key: "ZOOM_USER", label: "Zoom User", required: false, secret: false, section: "Services" },
  { key: "TRELLO_KEY", label: "Trello API Key", required: false, secret: true, section: "Services" },
  { key: "TRELLO_TOKEN", label: "Trello Token", required: false, secret: true, section: "Services" },
  { key: "DSMON_INSTANCE_ID", label: "DS-mon Instance ID", required: false, secret: false, section: "Usage Tracking" },
  { key: "DSMON_PUSH_INTERVAL", label: "DS-mon Push Interval (ms)", required: false, secret: false, section: "Usage Tracking" },
  { key: "DSMON_PUSH_URL", label: "DS-mon Push URL", required: false, secret: false, section: "Usage Tracking" },
  { key: "DSMON_PUSH_TOKEN", label: "DS-mon Push Token", required: false, secret: true, section: "Usage Tracking" },
  { key: "CLOUDFLARED_TUNNEL_TOKEN", label: "Cloudflare Tunnel Token", required: false, secret: true, section: "Usage Tracking" },
  { key: "USAGE_TRACKING_ENABLED", label: "Enable Usage Tracking", required: false, secret: false, section: "Usage Tracking" },
  // ── Diarization tuning ──
  { key: "DIARIZATION_MIN_SPEAKER_DURATION", label: "Min Speaker Duration (s)", required: false, secret: false, section: "Diarization" },
  { key: "DIARIZATION_MIN_SPEAKER_SEGMENTS", label: "Min Speaker Segments", required: false, secret: false, section: "Diarization" },
  { key: "DIARIZATION_MERGING_GAP", label: "Merging Gap (s)", required: false, secret: false, section: "Diarization" },
  { key: "DIARIZATION_CLUSTERING_THRESHOLD", label: "Clustering Threshold (0 = default)", required: false, secret: false, section: "Diarization" },
  { key: "DIARIZATION_MAX_SPEAKERS", label: "Max Speakers (0 = auto)", required: false, secret: false, section: "Diarization" },
  { key: "DIARIZATION_TIMEOUT_MINUTES", label: "Diarization Timeout (minutes)", required: false, secret: false, section: "Diarization" },
  { key: "DELIVERY_RECIPIENT_EMAILS", label: "Default Recipient Emails", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_EMAIL_SUBJECT", label: "Email Subject Template", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_EMAIL_ADDITIONAL_CONTENT", label: "Additional Email Content", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_DRIVE_FOLDER", label: "Drive Destination Folder", required: false, secret: false, section: "Delivery Config" },
  { key: "CUSTOM_DELIVERY_PER_MEETING", label: "Custom Delivery per Meeting", required: false, secret: false, section: "Delivery Config" },
  { key: "GATE_RAW_REVIEW_ENABLED", label: "Raw Transcript Review (Gate 1)", required: false, secret: false, section: "Pipeline" },
  { key: "GATE_DELIVERY_REVIEW_ENABLED", label: "Delivery Review (Gate 2)", required: false, secret: false, section: "Pipeline" },
  { key: "KEEP_MODELS_WARM", label: "Keep Models Warm", required: false, secret: false, section: "Pipeline" },
];

const SOURCE_LABELS: Record<string, string> = {
  user_config: "User Config (config.json)",
  environment: "Environment (.env)",
  default: "Default value",
};

/**
 * Build the full ConfigValues object from getConfigWithSources() output.
 * Centralizes every key so mount/import/clear/restore all reload identically
 * (including keys not rendered in this panel: PERF_METRICS, APPEARANCE, PLAYWRIGHT).
 */
function loadConfigValues(cfg: Record<string, { value: string; source: string }>): ConfigValues {
  return {
    DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY?.value || "",
    LLM_PROVIDER: cfg.LLM_PROVIDER?.value || "deepseek",
    OLLAMA_BASE_URL: cfg.OLLAMA_BASE_URL?.value || "http://127.0.0.1:11434/v1",
    OLLAMA_MODEL: cfg.OLLAMA_MODEL?.value || "",
    OLLAMA_NUM_CTX: cfg.OLLAMA_NUM_CTX?.value || "32768",
    EMBEDDING_PROVIDER: cfg.EMBEDDING_PROVIDER?.value || "",
    HUGGING_FACE_TOKEN: cfg.HUGGING_FACE_TOKEN?.value || "",
    GITHUB_TOKEN: cfg.GITHUB_TOKEN?.value || "",
    WHISPER_MODEL_SIZE: cfg.WHISPER_MODEL_SIZE?.value || "medium",
    KEEP_TRANSCRIPT_TIMESTAMPS: cfg.KEEP_TRANSCRIPT_TIMESTAMPS?.value || "false",
    WHISPER_INITIAL_PROMPT_ENABLED: cfg.WHISPER_INITIAL_PROMPT_ENABLED?.value || "false",
    WHISPER_INITIAL_PROMPT: cfg.WHISPER_INITIAL_PROMPT?.value || "",
    GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID?.value || "",
    GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET?.value || "",
    GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN?.value || "",
    GMAIL_USER: cfg.GMAIL_USER?.value || "",
    MS_CLIENT_ID: cfg.MS_CLIENT_ID?.value || "",
    MS_REFRESH_TOKEN: cfg.MS_REFRESH_TOKEN?.value || "",
    MS_USER: cfg.MS_USER?.value || "",
    ZOOM_CLIENT_ID: cfg.ZOOM_CLIENT_ID?.value || "",
    ZOOM_CLIENT_SECRET: cfg.ZOOM_CLIENT_SECRET?.value || "",
    ZOOM_REFRESH_TOKEN: cfg.ZOOM_REFRESH_TOKEN?.value || "",
    ZOOM_USER: cfg.ZOOM_USER?.value || "",
    TRELLO_KEY: cfg.TRELLO_KEY?.value || "",
    TRELLO_TOKEN: cfg.TRELLO_TOKEN?.value || "",
    DSMON_INSTANCE_ID: cfg.DSMON_INSTANCE_ID?.value || "",
    DSMON_PUSH_INTERVAL: cfg.DSMON_PUSH_INTERVAL?.value || "300000",
    DSMON_PUSH_URL: cfg.DSMON_PUSH_URL?.value || "",
    DSMON_PUSH_TOKEN: cfg.DSMON_PUSH_TOKEN?.value || "",
    USAGE_TRACKING_ENABLED: cfg.USAGE_TRACKING_ENABLED?.value || "false",
    CLOUDFLARED_TUNNEL_NAME: cfg.CLOUDFLARED_TUNNEL_NAME?.value || "",
    CLOUDFLARED_TUNNEL_TOKEN: cfg.CLOUDFLARED_TUNNEL_TOKEN?.value || "",
    LOG_LLM_DATA: cfg.LOG_LLM_DATA?.value || "false",
    LOG_COLLAPSE_REPEATED_PREFIXES: cfg.LOG_COLLAPSE_REPEATED_PREFIXES?.value || "true",
    LOG_CHROMIUM: cfg.LOG_CHROMIUM?.value || "true",
    LLM_TEMPERATURE: cfg.LLM_TEMPERATURE?.value || "0.1",
    PERF_METRICS_POLL_INTERVAL: cfg.PERF_METRICS_POLL_INTERVAL?.value || "10000",
    CREDIT_POLL_INTERVAL: cfg.CREDIT_POLL_INTERVAL?.value || "60000",
    PIPELINE_TIMEOUT_MINUTES: cfg.PIPELINE_TIMEOUT_MINUTES?.value || "60",
    GATE_RAW_REVIEW_ENABLED: cfg.GATE_RAW_REVIEW_ENABLED?.value || "true",
    GATE_DELIVERY_REVIEW_ENABLED: cfg.GATE_DELIVERY_REVIEW_ENABLED?.value || "true",
    KEEP_MODELS_WARM: cfg.KEEP_MODELS_WARM?.value || "false",
    DIARIZATION_MIN_SPEAKER_DURATION: cfg.DIARIZATION_MIN_SPEAKER_DURATION?.value || "3.0",
    DIARIZATION_MIN_SPEAKER_SEGMENTS: cfg.DIARIZATION_MIN_SPEAKER_SEGMENTS?.value || "3",
    DIARIZATION_MERGING_GAP: cfg.DIARIZATION_MERGING_GAP?.value || "0.5",
    DIARIZATION_CLUSTERING_THRESHOLD: cfg.DIARIZATION_CLUSTERING_THRESHOLD?.value || "0.0",
    DIARIZATION_MAX_SPEAKERS: cfg.DIARIZATION_MAX_SPEAKERS?.value || "0",
    DIARIZATION_TIMEOUT_MINUTES: cfg.DIARIZATION_TIMEOUT_MINUTES?.value || "60",
    DELIVERY_RECIPIENT_EMAILS: cfg.DELIVERY_RECIPIENT_EMAILS?.value || "",
    DELIVERY_EMAIL_SUBJECT: cfg.DELIVERY_EMAIL_SUBJECT?.value || "Meeting Summary: {title}",
    DELIVERY_EMAIL_ADDITIONAL_CONTENT: cfg.DELIVERY_EMAIL_ADDITIONAL_CONTENT?.value || "",
    DELIVERY_DRIVE_FOLDER: cfg.DELIVERY_DRIVE_FOLDER?.value || "Meeting Transcripts",
    CUSTOM_DELIVERY_PER_MEETING: cfg.CUSTOM_DELIVERY_PER_MEETING?.value || "true",
    APPEARANCE_THEME: cfg.APPEARANCE_THEME?.value || "dark",
    APPEARANCE_ACCENT_COLOR: cfg.APPEARANCE_ACCENT_COLOR?.value || "#58a6ff",
    APPEARANCE_FONT_SIZE: cfg.APPEARANCE_FONT_SIZE?.value || "medium",
    APPEARANCE_SIDEBAR_WIDTH: cfg.APPEARANCE_SIDEBAR_WIDTH?.value || "48",
    PLAYWRIGHT_AUDIO_FILE_PATH: cfg.PLAYWRIGHT_AUDIO_FILE_PATH?.value || "",
    PLAYWRIGHT_TITLE_TEMPLATE: cfg.PLAYWRIGHT_TITLE_TEMPLATE?.value || "test {autoNum}",
    PLAYWRIGHT_GENERIC_NAMES: cfg.PLAYWRIGHT_GENERIC_NAMES?.value || "",
    USER_GUIDE_IMAGES_ENABLED: cfg.USER_GUIDE_IMAGES_ENABLED?.value || "true",
  };
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

function validateEmailList(value: string): { valid: string[]; invalid: string[] } {
  const emails = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const e of emails) {
    if (validateEmail(e)) valid.push(e);
    else invalid.push(e);
  }
  return { valid, invalid };
}

// ── Numeric / enum config validation ──

/**
 * Validate numeric/enum config values. Returns a map of config key → error
 * message. Empty values are allowed (they mean "use the default").
 *
 * A bad value here (e.g. a non-numeric DIARIZATION_MIN_SPEAKER_DURATION) would
 * be forwarded to the Python backend via getChildEnv() and crash it at import
 * time, so we block saving before that can happen.
 */
function validateNumericConfig(values: ConfigValues): Record<string, string> {
  const errors: Record<string, string> = {};

  const requireNumber = (key: keyof ConfigValues, label: string, min?: number, max?: number) => {
    const raw = values[key];
    if (raw === undefined || raw.trim() === "") return; // empty = use default
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors[key] = `${label} must be a number`;
      return;
    }
    if (min !== undefined && n < min) errors[key] = `${label} must be at least ${min}`;
    else if (max !== undefined && n > max) errors[key] = `${label} must be at most ${max}`;
  };

  // OLLAMA_NUM_CTX only allows the documented values
  const ctx = (values.OLLAMA_NUM_CTX || "").trim();
  if (ctx && !["32768", "65536", "131072"].includes(ctx)) {
    errors.OLLAMA_NUM_CTX = "Ollama Context Window must be 32768, 65536, or 131072";
  }

  requireNumber("LLM_TEMPERATURE", "LLM Temperature", 0, 2);
  requireNumber("PIPELINE_TIMEOUT_MINUTES", "Pipeline/Polling Timeout (minutes)", 1);
  requireNumber("DIARIZATION_MIN_SPEAKER_DURATION", "Min Speaker Duration", 0);
  requireNumber("DIARIZATION_MIN_SPEAKER_SEGMENTS", "Min Speaker Segments", 1);
  requireNumber("DIARIZATION_MERGING_GAP", "Merging Gap", 0);
  requireNumber("DIARIZATION_CLUSTERING_THRESHOLD", "Clustering Threshold", 0, 1);
  requireNumber("DIARIZATION_MAX_SPEAKERS", "Max Speakers", 0);
  requireNumber("DIARIZATION_TIMEOUT_MINUTES", "Diarization Timeout (minutes)", 1);
  requireNumber("PERF_METRICS_POLL_INTERVAL", "Perf Metrics Poll Interval (ms)", 1000);
  requireNumber("CREDIT_POLL_INTERVAL", "Credit Poll Interval (ms)", 1000);
  requireNumber("DSMON_PUSH_INTERVAL", "DS-mon Push Interval (ms)", 1000);

  return errors;
}

/**
 * Generate default pipeline steps from tools.json and pipeline hints.
 * Used when pipeline.json has no `pipeline_steps` array yet (migration).
 */

// ── Security helpers for agent instruction generation ──

/** Max lengths enforced at generation time (matches schema.json) */
const MAX_TEMPLATE_LENGTH = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_DESC_LENGTH = 200;

// ── Agent-config schema validation (mirrors agent-config/schema.json) ──
// Validates tools.json / pipeline.json before they're written so a malformed
// config never reaches the agent runner (which would fall back to defaults).
//
// @cfworker/json-schema is eval-free — ajv compiles schemas with `new Function`,
// which the app's Content Security Policy blocks (unsafe-eval is not allowed).
// One validator runs the root schema's oneOf, which selects tools_file (array)
// vs pipeline_file (object) by shape and resolves the internal `$ref`s to
// #/definitions.
const agentConfigSchemaValidator = new Validator(agentConfigSchema, "7");

/**
 * Sanitize a string for safe injection into the system prompt.
 * - Truncates to maxLen
 * - Strips backticks (prevents code-block injection)
 * - Strips markdown control characters that could break prompt structure
 */
function sanitizePromptText(input: string, maxLen: number = 500): string {
  return input
    .slice(0, maxLen)
    .replace(/`/g, "'") // backticks → single quotes (prevents code-block breakout)
    .replace(/\\(?!['"\n])/g, "") // stray backslashes (prevents escape-sequence injection)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // strip control chars except tab/newline
}

function getDefaultPipelineSteps(cfg: AgentConfig): PipelineStep[] {
  const hints = cfg.pipeline?.pipeline_hints || {};
  const tools = cfg.tools || [];

  // Canonical step order based on the system prompt numbering
  const defaultStepOrder = [
    {
      toolName: "_fetch_memory_context",
      label: "Fetch Memory Context",
      description: "Retrieve existing action items, decisions, budgets, and similar past meetings for LLM context",
      isTerminal: false,
    },
    { toolName: "transcribe_refine", label: "Refine Transcript", description: "Clean filler words and redact PII", isTerminal: false },
    {
      toolName: "transcribe_get_transcript",
      label: "Read Transcript",
      description: "Retrieve the refined speaker-labeled transcript",
      isTerminal: false,
    },
    { toolName: "transcribe_summarize", label: "Summarize", description: "Generate and store a structured meeting summary", isTerminal: false },
    { toolName: "transcribe_analyze", label: "Analyze", description: "Analyze topics, sentiment, entities, and follow-ups", isTerminal: false },
    {
      toolName: "transcribe_save_context",
      label: "Save to Memory",
      description: "Persist meeting to semantic and ephemeral memory",
      isTerminal: false,
    },
    {
      toolName: "transcribe_prepare_delivery",
      label: "Prepare Delivery",
      description: "Package results for delivery destinations",
      isTerminal: false,
    },
    { toolName: "send_delivery_email", label: "Deliver via Email", description: "Send results via email", isTerminal: true },
    { toolName: "save_to_drive", label: "Save to Drive", description: "Save results to Google Drive", isTerminal: true },
    {
      toolName: "create_trello_action_items",
      label: "Create Trello Cards",
      description: "Create action items as Trello cards",
      isTerminal: true,
      enabled: false,
    },
  ];

  const terminalToolsSet = new Set(cfg.pipeline?.terminal_tools || []);

  return defaultStepOrder
    .filter((def) => def.toolName === "_fetch_memory_context" || tools.some((t: any) => t.name === def.toolName))
    .map((def, i) => ({
      id: `step-${i}`,
      toolName: def.toolName,
      label: def.label,
      description: def.description,
      systemPromptTemplate: "",
      hintTemplate: hints[def.toolName] || "",
      enabled: (def as any).enabled ?? true,
      isTerminal: def.isTerminal || terminalToolsSet.has(def.toolName),
    }));
}

function formatOllamaSize(bytes: number): string {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function ConfigPanel({ onClose, configOk }: Props) {
  // Persisted Config tab + section selection (rule 6)
  const [activeTab, setActiveTab] = useUiStateValue<ConfigTab>("config.tab", "config");
  const [configSection, setConfigSection] = useUiStateValue<string>("config.section", "LLM Provider");
  const [values, setValues] = useState<ConfigValues>({} as ConfigValues);
  const [sourceInfo, setSourceInfo] = useState<Record<string, ConfigValueSource>>({});
  /** Keys the user has edited since the panel opened (or the last load/import/clear/restore). */
  const [dirtyKeys, setDirtyKeys] = useState<Set<keyof ConfigValues>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<keyof ConfigValues>>(new Set());
  // ── Email validation state ──
  const [emailValidationError, setEmailValidationError] = useState<string | null>(null);
  /** Per-key validation errors for numeric/enum config fields (config tab). */
  const [numericErrors, setNumericErrors] = useState<Record<string, string>>({});

  // Reset a stale persisted section (e.g. a section renamed/removed in a newer build)
  useEffect(() => {
    const valid = new Set(FIELDS.map((f) => f.section));
    if (configSection && !valid.has(configSection)) {
      setConfigSection("LLM Provider");
    }
  }, [configSection, setConfigSection]);

  const toggleVisible = (key: keyof ConfigValues) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Agent config state ──
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null);
  // ── Ollama model management state ──
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number; modified_at: string }>>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullSuccess, setPullSuccess] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  // Tracks whether the Ollama server was started by us (so we can stop it)
  const [ollamaWasStartedByUs, setOllamaWasStartedByUs] = useState(false);
  const [restoringDefaults, setRestoringDefaults] = useState(false);

  // ── Tunnel state ──
  const [tunnelStatus, setTunnelStatus] = useState<{ running: boolean; connected: boolean; url: string | null; error: string | null }>({
    running: false,
    connected: false,
    url: null,
    error: null,
  });
  const [tunnelStarting, setTunnelStarting] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // ── Gmail OAuth state ("Connect with Google") ──
  const [gmailAuthPending, setGmailAuthPending] = useState(false);
  const [gmailAuthFeedback, setGmailAuthFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // ── Teams / Zoom OAuth state (Config → Services connect rows) ──
  const [teamsAuthPending, setTeamsAuthPending] = useState(false);
  const [teamsAuthFeedback, setTeamsAuthFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [zoomAuthPending, setZoomAuthPending] = useState(false);
  const [zoomAuthFeedback, setZoomAuthFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Poll tunnel status every 5s when usage tracking is enabled
  useEffect(() => {
    if (values.USAGE_TRACKING_ENABLED !== "true") return;
    const poll = async () => {
      try {
        const ts = await window.electronAPI?.getTunnelStatus();
        if (ts) setTunnelStatus(ts);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [values.USAGE_TRACKING_ENABLED]);

  // ── Tunnel action handlers ──

  const startTunnel = useCallback(async () => {
    setTunnelStarting(true);
    try {
      const result = await window.electronAPI?.startTunnel();
      if (result?.success) {
        setTunnelStatus({ running: true, connected: true, url: result.url || null, error: null });
      } else {
        setTunnelStatus((prev) => ({ ...prev, error: result?.error || "Failed to start" }));
      }
    } catch (err: any) {
      setTunnelStatus((prev) => ({ ...prev, error: err.message }));
    } finally {
      setTunnelStarting(false);
    }
  }, []);

  const stopTunnel = useCallback(async () => {
    try {
      await window.electronAPI?.stopTunnel();
      setTunnelStatus({ running: false, connected: false, url: null, error: null });
    } catch (err: any) {
      setTunnelStatus((prev) => ({ ...prev, error: err.message }));
    }
  }, []);

  const forceStopTunnel = useCallback(async () => {
    setTunnelStarting(true);
    try {
      const result = await window.electronAPI?.forceStopTunnel();
      if (result?.success) {
        setTunnelStatus({ running: false, connected: false, url: null, error: null });
      } else {
        setTunnelStatus((prev) => ({ ...prev, error: result?.error || "Failed to force-stop tunnel" }));
      }
    } catch (err: any) {
      setTunnelStatus((prev) => ({ ...prev, error: err.message }));
    } finally {
      setTunnelStarting(false);
    }
  }, []);

  // Fetch Ollama models when provider is "ollama"
  const fetchOllamaModels = useCallback(async () => {
    if (values.LLM_PROVIDER !== "ollama") {
      setOllamaModels([]);
      setOllamaModelsError(null);
      return;
    }
    setOllamaModelsLoading(true);
    setOllamaModelsError(null);
    try {
      const result = await window.electronAPI?.listOllamaModels();
      if (result) {
        setOllamaModels(result.models || []);
        if (result.error) setOllamaModelsError(result.error);
        if (result.wasStarted) setOllamaWasStartedByUs(true);
      }
    } catch (err: any) {
      setOllamaModelsError(err.message || "Failed to list models");
    } finally {
      setOllamaModelsLoading(false);
    }
  }, [values.LLM_PROVIDER]);

  // ── Ollama server health check state ──
  const [ollamaHealthy, setOllamaHealthy] = useState<boolean | null>(null);
  const [ollamaHealthChecking, setOllamaHealthChecking] = useState(false);

  // Poll Ollama health when provider is "ollama"
  const checkOllamaHealth = useCallback(async () => {
    if (values.LLM_PROVIDER !== "ollama") {
      setOllamaHealthy(null);
      return;
    }
    setOllamaHealthChecking(true);
    try {
      const result = await window.electronAPI?.checkOllamaHealth();
      setOllamaHealthy(result?.healthy ?? false);
    } catch {
      setOllamaHealthy(false);
    } finally {
      setOllamaHealthChecking(false);
    }
  }, [values.LLM_PROVIDER]);

  useEffect(() => {
    if (values.LLM_PROVIDER !== "ollama") {
      setOllamaHealthy(null);
      return;
    }
    // Check immediately
    checkOllamaHealth();
    // Then poll every 15 seconds
    const interval = setInterval(checkOllamaHealth, 15000);
    return () => clearInterval(interval);
  }, [values.LLM_PROVIDER, checkOllamaHealth]);

  // Fetch models when provider changes to "ollama"
  useEffect(() => {
    fetchOllamaModels();
  }, [fetchOllamaModels]);

  // Stop Ollama if the user switches away from the Ollama provider
  // and we were the ones who started it
  useEffect(() => {
    if (values.LLM_PROVIDER !== "ollama" && ollamaWasStartedByUs) {
      setOllamaWasStartedByUs(false);
      window.electronAPI?.stopOllamaServer();
    }
  }, [values.LLM_PROVIDER, ollamaWasStartedByUs]);

  // Pull a model from Ollama
  const handlePullModel = useCallback(
    async (modelName: string) => {
      setPullingModel(modelName);
      setPullSuccess(null);
      setPullError(null);
      try {
        const result = await window.electronAPI?.pullOllamaModel(modelName);
        if (result?.success) {
          setPullSuccess(`Model "${modelName}" pulled successfully`);
          // Refresh the model list
          await fetchOllamaModels();
        } else {
          setPullError(result?.error || `Failed to pull ${modelName}`);
        }
      } catch (err: any) {
        setPullError(err.message || `Failed to pull ${modelName}`);
      } finally {
        setPullingModel(null);
      }
    },
    [fetchOllamaModels],
  );

  // Active jobs guard — editing agent instructions is blocked while jobs run
  const [activeJobs, setActiveJobs] = useState<any[]>([]);
  const [activeJobsLoading, setActiveJobsLoading] = useState(false);
  // Local edit buffers
  const [editSystemPrompt, setEditSystemPrompt] = useState("");
  const [editPipelineHints, setEditPipelineHints] = useState<Record<string, string>>({});
  const [editMaxSteps, setEditMaxSteps] = useState(25);
  const [editMaxRetries, setEditMaxRetries] = useState(3);
  const [editRetryDelay, setEditRetryDelay] = useState(2000);
  const [editContextWindow, setEditContextWindow] = useState(0);
  const [editTerminalTools, setEditTerminalTools] = useState("");
  const [restartNeeded, setRestartNeeded] = useState(false);

  // ── Pipeline steps (draggable checklist) state ──
  const [editPipelineSteps, setEditPipelineSteps] = useState<PipelineStep[]>([]);
  const [trelloToggleEnabled, setTrelloToggleEnabled] = useState(false); // Developer toggle unlocks Trello step checkbox
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  // ── Export / Import state ──
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [clearingConfig, setClearingConfig] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [restoringUserDefaults, setRestoringUserDefaults] = useState(false);
  const [restoreUserDefaultsResult, setRestoreUserDefaultsResult] = useState<string | null>(null);
  const [showClearConfigConfirm, setShowClearConfigConfirm] = useState(false);
  const [showRestoreUserDefaultsConfirm, setShowRestoreUserDefaultsConfirm] = useState(false);
  const [showRestoreDefaultsConfirm, setShowRestoreDefaultsConfirm] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [saveDefaultsResult, setSaveDefaultsResult] = useState<string | null>(null);
  const [showSaveDefaultsConfirm, setShowSaveDefaultsConfirm] = useState(false);

  // ── Config action feedback — auto-scroll to the newest message ──
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedbackRef.current?.scrollTo({ top: feedbackRef.current.scrollHeight });
  }, [exportResult, importResult, clearResult, restoreUserDefaultsResult, saveDefaultsResult, error, saved]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const result = await window.electronAPI?.exportConfig();
      if (result?.success) {
        const warn = result.warnings?.length ? ` (${result.warnings.length} warning(s): ${result.warnings.join("; ")})` : "";
        setExportResult(`Exported to ${result.filePath}${warn}`);
      } else if (result?.cancelled) {
        setExportResult(null);
      } else {
        setExportResult(`Export failed: ${result?.error || "Unknown error"}`);
      }
    } catch (err: any) {
      setExportResult(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await window.electronAPI?.importConfig();
      if (result?.success) {
        const parts: string[] = [];
        if (result.agentConfigImported) parts.push("agent instructions");
        if (result.defaultsImported) parts.push("agent defaults");
        if (result.userDefaultsImported) parts.push("user defaults");
        const detail = parts.length > 0 ? ` (${parts.join(", ")} included)` : "";
        setImportResult(`Configuration imported successfully${detail}`);
        // Re-apply appearance settings (theme/accent may have been imported)
        loadAndApplyAppearance().catch(() => {});
        // Reload config values after import
        window.electronAPI?.getConfigWithSources().then((cfg) => {
          setValues(loadConfigValues(cfg));
          setSourceInfo(cfg);
          setDirtyKeys(new Set());
        });
        // Refresh active jobs list after import (services were restarted)
        window.electronAPI
          ?.getActiveJobs()
          .then((jobs) => setActiveJobs(jobs || []))
          .catch(() => {});
      } else if (result?.cancelled) {
        setImportResult(null);
      } else if (result?.blocked) {
        setImportResult(`${result.error}`);
        // Re-check active jobs to show up-to-date guard banner
        window.electronAPI
          ?.getActiveJobs()
          .then((jobs) => setActiveJobs(jobs || []))
          .catch(() => {});
      } else {
        setImportResult(`Import failed: ${result?.error || "Unknown error"}`);
      }
    } catch (err: any) {
      setImportResult(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  }, []);

  const handleClearConfig = useCallback(async () => {
    setShowClearConfigConfirm(false);
    setClearingConfig(true);
    setClearResult(null);
    try {
      const result = await window.electronAPI?.clearConfig();
      if (result?.success) {
        // Reload config values (will now show defaults)
        window.electronAPI?.getConfigWithSources().then((cfg) => {
          setValues(loadConfigValues(cfg));
          setSourceInfo(cfg);
          setDirtyKeys(new Set());
        });
        setClearResult("Configuration cleared — all values reset to defaults");
      } else if (result?.blocked) {
        setClearResult(result.error || "Cannot clear: jobs are running");
      } else {
        setClearResult(result?.error || "Failed to clear configuration");
      }
    } catch (err: any) {
      setClearResult(`Clear failed: ${err.message}`);
    } finally {
      setClearingConfig(false);
    }
  }, []);

  // ── UI state (persisted view state) — Clear all ──
  const [showClearUiStateConfirm, setShowClearUiStateConfirm] = useState(false);
  const [clearingUiState, setClearingUiState] = useState(false);
  const [uiStateResult, setUiStateResult] = useState<string | null>(null);
  const { reset: resetUiState, set: setUiState } = useUiState();

  const handleClearUiState = useCallback(() => {
    setShowClearUiStateConfirm(false);
    setClearingUiState(true);
    setUiStateResult(null);
    try {
      resetUiState(); // wipes every scope (including config.tab → "config")
      setUiState("config.tab", "ui"); // keep the user on the UI tab so the result is visible
      setUiStateResult("UI state cleared — all panels reset to defaults.");
    } finally {
      setClearingUiState(false);
    }
  }, [resetUiState, setUiState]);

  const handleRestoreUserDefaults = useCallback(async () => {
    setShowRestoreUserDefaultsConfirm(false);
    setRestoringUserDefaults(true);
    setRestoreUserDefaultsResult(null);
    try {
      const result = await window.electronAPI?.restoreDefaultUserConfig();
      if (result?.success) {
        // Reload config values (will now show defaults)
        window.electronAPI?.getConfigWithSources().then((cfg) => {
          setValues(loadConfigValues(cfg));
          setSourceInfo(cfg);
          setDirtyKeys(new Set());
        });
        setRestoreUserDefaultsResult("User configuration restored to shipped defaults");
        // Re-apply appearance settings (theme/accent may have been restored)
        loadAndApplyAppearance().catch(() => {});
      } else if (result?.blocked) {
        setRestoreUserDefaultsResult(result.error || "Cannot restore: jobs are running");
      } else {
        setRestoreUserDefaultsResult(result?.error || "Failed to restore defaults");
      }
    } catch (err: any) {
      setRestoreUserDefaultsResult(`Restore failed: ${err.message}`);
    } finally {
      setRestoringUserDefaults(false);
    }
  }, []);

  const handleSaveDefaults = useCallback(async () => {
    setShowSaveDefaultsConfirm(false);
    setSavingDefaults(true);
    setSaveDefaultsResult(null);
    try {
      const result = await window.electronAPI?.setDefaultConfig();
      if (result?.success) {
        const warn = result.warnings?.length ? ` (${result.warnings.join("; ")})` : "";
        setSaveDefaultsResult(`Defaults updated — current user + agent config saved as the new defaults${warn}`);
      } else {
        setSaveDefaultsResult(result?.error || "Failed to save defaults");
      }
    } catch (err: any) {
      setSaveDefaultsResult(`Save defaults failed: ${err.message}`);
    } finally {
      setSavingDefaults(false);
    }
  }, []);

  // ── Check active jobs (blocks editing on ALL tabs while running) ──
  // Checks both the ML pipeline (/transcribe/active) and bot-created jobs (test-bot-log.jsonl)
  // so config editing is disabled whenever any job is actively processing.
  // Re-checked on mount and polled periodically so the gates go live if a job
  // starts while the panel is open.
  const refreshActiveJobs = useCallback(() => {
    return Promise.all([window.electronAPI?.getActiveJobs() ?? Promise.resolve([]), window.electronAPI?.getRunningBotJobs() ?? Promise.resolve([])])
      .then(([pipelineJobs, botJobs]) => {
        // Merge pipeline jobs and non-terminal bot jobs
        const seen = new Set<string>();
        const merged: Array<{ job_id: string; status: string; progress: number; title: string }> = [];
        for (const j of pipelineJobs) {
          if (!seen.has(j.job_id)) {
            seen.add(j.job_id);
            merged.push(j);
          }
        }
        for (const j of botJobs) {
          if (!seen.has(j.job_id)) {
            seen.add(j.job_id);
            merged.push({ job_id: j.job_id, status: j.status, progress: 0, title: "Bot Job" });
          }
        }
        setActiveJobs(merged);
      })
      .catch(() => {
        setActiveJobs([]);
      });
  }, []);

  useEffect(() => {
    setActiveJobsLoading(true);
    refreshActiveJobs().finally(() => setActiveJobsLoading(false));
    const id = setInterval(refreshActiveJobs, 10000);
    return () => clearInterval(id);
  }, [refreshActiveJobs]);

  // ── Load config on open ──
  useEffect(() => {
    setSaved(false);
    setError(null);
    setRestartNeeded(false);
    // Use getConfigWithSources so .env values appear as fallback when not in config.json
    window.electronAPI?.getConfigWithSources().then((cfg) => {
      setValues(loadConfigValues(cfg));
      setSourceInfo(cfg);
      setDirtyKeys(new Set());
    });
  }, []);

  // ── Load agent config when switching to agent tab ──
  useEffect(() => {
    if (activeTab !== "agent") return;
    setSaved(false);
    setRestartNeeded(false);

    if (agentConfig) return; // already loaded config data

    setAgentConfigLoading(true);
    setAgentConfigError(null);
    window.electronAPI
      ?.getAgentConfig()
      .then((cfg) => {
        if (cfg.error) {
          setAgentConfigError(cfg.error);
          setAgentConfigLoading(false);
          return;
        }
        setAgentConfig(cfg as AgentConfig);
        setEditSystemPrompt(cfg.systemPrompt || "");
        setEditPipelineHints(cfg.pipeline?.pipeline_hints || {});
        setEditPipelineSteps(cfg.pipeline?.pipeline_steps || getDefaultPipelineSteps(cfg));
        setEditMaxSteps(cfg.pipeline?.max_pipeline_steps ?? 25);
        setEditMaxRetries(cfg.pipeline?.max_retries ?? 3);
        setEditRetryDelay(cfg.pipeline?.retry_base_delay_ms ?? 2000);
        setEditContextWindow(cfg.pipeline?.llm_context_window ?? 0);
        setEditTerminalTools((cfg.pipeline?.terminal_tools || []).join(", "));
        setAgentConfigLoading(false);
      })
      .catch((err) => {
        setAgentConfigError(err.message);
        setAgentConfigLoading(false);
      });
  }, [activeTab, agentConfig]);

  const handleChange = (key: keyof ConfigValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setDirtyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    // Clear any previous validation error for this key
    setNumericErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // Validate emails for the recipient field
    if (key === "DELIVERY_RECIPIENT_EMAILS") {
      if (value.trim()) {
        const { valid, invalid } = validateEmailList(value);
        if (invalid.length > 0) {
          setEmailValidationError(`Invalid email(s): ${invalid.join(", ")}`);
        } else {
          setEmailValidationError(null);
        }
      } else {
        setEmailValidationError(null);
      }
    }
  };

  /** Run the in-app "Connect with Google" OAuth flow and fill the Gmail fields. */
  const connectGmail = useCallback(async () => {
    const clientId = (values.GMAIL_CLIENT_ID || "").trim();
    const clientSecret = (values.GMAIL_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
      setGmailAuthFeedback({ type: "err", text: "Enter (or import) your Gmail Client ID and Client Secret first." });
      return;
    }
    setGmailAuthPending(true);
    setGmailAuthFeedback(null);
    try {
      const res = await window.electronAPI?.startGmailOAuth(clientId, clientSecret);
      if (res?.ok) {
        handleChange("GMAIL_REFRESH_TOKEN", res.refreshToken ?? "");
        if (res.clientId) handleChange("GMAIL_CLIENT_ID", res.clientId);
        if (res.clientSecret) handleChange("GMAIL_CLIENT_SECRET", res.clientSecret);
        if (res.user) handleChange("GMAIL_USER", res.user);
        // Auto-save immediately on authorize (consistency with the New Job form),
        // so the chosen account's email + refresh token persist right away.
        try {
          await window.electronAPI?.saveConfig({
            GMAIL_CLIENT_ID: res.clientId ?? "",
            GMAIL_CLIENT_SECRET: res.clientSecret ?? "",
            GMAIL_REFRESH_TOKEN: res.refreshToken ?? "",
            GMAIL_USER: res.user ?? "",
          });
          setGmailAuthFeedback({ type: "ok", text: "Google account connected and saved." });
        } catch {
          setGmailAuthFeedback({ type: "err", text: "Google connected, but saving failed — click Save to apply." });
        }
      } else {
        setGmailAuthFeedback({ type: "err", text: res?.error || "Google authorization failed or was cancelled — try again." });
      }
    } catch {
      setGmailAuthFeedback({ type: "err", text: "Google authorization failed — try again." });
    } finally {
      setGmailAuthPending(false);
    }
  }, [values, handleChange]);

  /** Run the in-app Teams OAuth flow and fill the Teams fields. */
  const connectTeams = useCallback(async () => {
    setTeamsAuthPending(true);
    setTeamsAuthFeedback(null);
    try {
      const res = await window.electronAPI?.teamsConnect();
      if (res?.ok) {
        handleChange("MS_CLIENT_ID", res.clientId ?? "");
        handleChange("MS_REFRESH_TOKEN", res.refreshToken ?? "");
        if (res.user) handleChange("MS_USER", res.user);
        try {
          await window.electronAPI?.saveConfig({
            MS_CLIENT_ID: res.clientId ?? "",
            MS_REFRESH_TOKEN: res.refreshToken ?? "",
            MS_USER: res.user ?? "",
          });
          setTeamsAuthFeedback({ type: "ok", text: res.user ? `Microsoft Teams connected: ${res.user}` : "Microsoft Teams connected." });
        } catch {
          setTeamsAuthFeedback({ type: "err", text: "Teams connected, but saving failed — click Save to apply." });
        }
      } else {
        setTeamsAuthFeedback({ type: "err", text: res?.error || "Teams authorization failed or was cancelled — try again." });
      }
    } catch {
      setTeamsAuthFeedback({ type: "err", text: "Teams authorization failed — try again." });
    } finally {
      setTeamsAuthPending(false);
    }
  }, [handleChange]);

  /** Run the in-app Zoom OAuth flow and fill the Zoom fields. */
  const connectZoom = useCallback(async () => {
    setZoomAuthPending(true);
    setZoomAuthFeedback(null);
    try {
      const res = await window.electronAPI?.zoomConnect();
      if (res?.ok) {
        handleChange("ZOOM_CLIENT_ID", res.clientId ?? "");
        handleChange("ZOOM_CLIENT_SECRET", res.clientSecret ?? "");
        handleChange("ZOOM_REFRESH_TOKEN", res.refreshToken ?? "");
        if (res.user) handleChange("ZOOM_USER", res.user);
        try {
          await window.electronAPI?.saveConfig({
            ZOOM_CLIENT_ID: res.clientId ?? "",
            ZOOM_CLIENT_SECRET: res.clientSecret ?? "",
            ZOOM_REFRESH_TOKEN: res.refreshToken ?? "",
            ZOOM_USER: res.user ?? "",
          });
          setZoomAuthFeedback({ type: "ok", text: res.user ? `Zoom connected: ${res.user}` : "Zoom connected." });
        } catch {
          setZoomAuthFeedback({ type: "err", text: "Zoom connected, but saving failed — click Save to apply." });
        }
      } else {
        setZoomAuthFeedback({ type: "err", text: res?.error || "Zoom authorization failed or was cancelled — try again." });
      }
    } catch {
      setZoomAuthFeedback({ type: "err", text: "Zoom authorization failed — try again." });
    } finally {
      setZoomAuthPending(false);
    }
  }, [handleChange]);

  // Cancel any pending Gmail/Teams/Zoom OAuth flow when the panel closes.
  useEffect(() => {
    return () => {
      window.electronAPI?.cancelGmailOAuth();
      window.electronAPI?.teamsCancel();
      window.electronAPI?.zoomCancel();
    };
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // Block save if any numeric/enum config value is invalid — a bad value
      // would be forwarded to the Python backend and crash it at startup.
      const invalid = validateNumericConfig(values);
      if (Object.keys(invalid).length > 0) {
        setNumericErrors(invalid);
        setError(`Cannot save — invalid value(s): ${Object.values(invalid).join("; ")}`);
        setSaving(false);
        return;
      }
      setNumericErrors({});
      // Only persist keys the user actually changed. Saving the full `values`
      // object would write every default into config.json, freezing defaults
      // and shadowing .env / host-env overrides for untouched keys.
      const payload: Record<string, string> = {};
      for (const key of dirtyKeys) payload[key] = values[key];
      if (Object.keys(payload).length === 0) {
        setSaving(false);
        return;
      }
      await window.electronAPI?.saveConfig(payload);
      setDirtyKeys(new Set());
      setSaved(true);
    } catch {
      setError("Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [values, dirtyKeys]);

  /**
   * Generate the system prompt from the ordered pipeline steps.
   * Creates numbered sections for each enabled step, injecting tool names.
   */
  const generateSystemPromptFromSteps = useCallback(
    (steps: PipelineStep[]): string => {
      const enabledSteps = steps.filter((s) => s.enabled);
      if (enabledSteps.length === 0) return editSystemPrompt;

      // Exclude _fetch_memory_context from numbered pipeline rules — it's a
      // pre-processing step (context injection), not an LLM-callable tool.
      const pipelineSteps = enabledSteps.filter((s) => s.toolName !== "_fetch_memory_context");

      const header = `You are an AI meeting transcription assistant. Process completed transcription jobs through a multi-step pipeline: refine the transcript, extract action items, generate summaries, persist to memory, and deliver results.

## Available Tools

{{TOOL_LIST}}

## Pipeline Rules (execute in this exact order)

`;
      const stepTexts = pipelineSteps
        .map((step, i) => {
          // #2: Enforce max template length at generation
          let template = (step.systemPromptTemplate || "").slice(0, MAX_TEMPLATE_LENGTH);
          if (template) {
            // #1: Sanitize template before injection
            template = sanitizePromptText(template, MAX_TEMPLATE_LENGTH);
            const filled = template.replace(/\{tool\}/g, step.toolName);
            return `${i + 1}. ${filled}`;
          }
          // #1: Sanitize label and description before auto-generation
          const safeLabel = sanitizePromptText(step.label, MAX_LABEL_LENGTH);
          const safeDesc = sanitizePromptText(step.description, MAX_DESC_LENGTH);
          return `${i + 1}. **${safeLabel}** — Call \`${step.toolName}\` to ${safeDesc.toLowerCase()}.`;
        })
        .join("\n\n");

      // Conditionally include Memory Context section based on _fetch_memory_context step state
      const memoryStep = steps.find((s) => s.toolName === "_fetch_memory_context");
      const includeMemorySection = memoryStep ? memoryStep.enabled : true;

      let footer = `

## General Rules

- Call **one tool per response** — the runner will loop back to let you call the next one
- Never make up job IDs or speaker names — use the Job ID provided in the context
- Use \`transcribe_search_memory\` to find past meetings by topic (e.g. "budget discussions")
- Use \`transcribe_query_ephemeral\` to retrieve stored action items, contacts, budgets, or decisions
- Use \`transcribe_save_ephemeral\` to store cross-meeting context like contact details or budget figures`;

      if (includeMemorySection) {
        footer += `

## Memory Context & Continuity

The system provides existing memory context at the start of each pipeline run. Use it to:

1. **Show continuity** — reference past decisions, recurring action items, and budget discussions in your summary. Repetition is valuable signal (e.g., "Alice to finish report" appearing 3 weeks in a row suggests a blocker).
2. **Track resolution** — if an action item from a previous meeting is explicitly resolved in this transcript, generate a new action item noting "Completed: ..." with the resolved date.
3. **Preserve history** — never skip or suppress entries. Every row in ephemeral memory has a \`created_at\` timestamp. The save functions preserve everything for audit.
4. **Use past context for better summaries** — reference how topics evolved across meetings.`;
      }

      footer += `

- Respond only with a tool call
- Respond only with a tool call`;

      const result = header + stepTexts + footer;

      // #4: Log the generation for audit trail
      console.log(`[generateSystemPrompt] Generated from ${enabledSteps.length} enabled steps (${result.length} chars)`);

      return result;
    },
    [editSystemPrompt],
  );

  /**
   * Generate pipeline hints from the ordered pipeline steps.
   * Each hint tells the LLM what to do next based on the step order.
   * Includes security hardening: input sanitization, chain validation, length enforcement.
   */
  const generateHintsFromSteps = useCallback((steps: PipelineStep[]): Record<string, string> => {
    const enabledSteps = steps.filter((s) => s.enabled);
    const enabledToolNames = new Set(enabledSteps.map((s) => s.toolName));
    const hints: Record<string, string> = {};

    // Include all enabled steps (including _fetch_memory_context) for auto-generated hints
    const hintSteps = enabledSteps;

    for (let i = 0; i < hintSteps.length; i++) {
      const step = hintSteps[i];
      const nextStep = hintSteps[i + 1];

      if (step.hintTemplate) {
        // #2: Enforce max template length
        let hint = step.hintTemplate.slice(0, MAX_TEMPLATE_LENGTH);
        // #1: Sanitize hint text
        hint = sanitizePromptText(hint, MAX_TEMPLATE_LENGTH);

        // #3: Validate hint chain — extract referenced tool name and check it exists
        const refMatch = hint.match(/\b(transcribe_\w+|send_delivery_email|save_to_drive|create_trello_action_items)\b/);
        if (refMatch && !enabledToolNames.has(refMatch[0]) && refMatch[0] !== step.toolName) {
          // Referenced tool is not in the enabled steps — fall back to auto-generated hint
          console.warn(
            `[generateHints] Hint for "${step.toolName}" references "${refMatch[0]}" which is not in enabled steps — using auto-generated fallback`,
          );
          hints[step.toolName] = buildAutoHint(step, nextStep);
        } else {
          hints[step.toolName] = hint;
        }
      } else {
        // Auto-generate hint pointing to the next enabled step
        hints[step.toolName] = buildAutoHint(step, nextStep);
      }
    }

    // #4: Log the generation for audit trail
    console.log(`[generateHints] Generated ${Object.keys(hints).length} hints from ${enabledSteps.length} enabled steps`);

    return hints;
  }, []);

  /** Build an auto-generated hint for a step, pointing to the next step or terminal. */
  function buildAutoHint(step: PipelineStep, nextStep: PipelineStep | undefined): string {
    if (nextStep) {
      const safeDesc = sanitizePromptText(nextStep.description, MAX_DESC_LENGTH);
      return `Next: Call \`${nextStep.toolName}\` to ${safeDesc.toLowerCase()}.`;
    }
    return `Pipeline complete. Call a delivery tool (send_delivery_email, save_to_drive, create_trello_action_items) or finish.`;
  }

  /**
   * Determine terminal tools from the pipeline steps (last enabled step that isTerminal + any explicitly listed)
   */
  const getTerminalToolsFromSteps = useCallback((steps: PipelineStep[]): string[] => {
    const terminalSteps = steps.filter((s) => s.enabled && s.isTerminal);
    return terminalSteps.map((s) => s.toolName);
  }, []);

  // ── Agent sub-tab state (must be declared before handleSaveAgentConfig which uses it) ──
  type AgentSubTab = "pipeline-steps" | "system-prompt" | "pipeline-hints" | "pipeline-constants" | "defaults";
  // Persisted so the agent-instructions sub-tab survives panel close/restart (rule 6)
  const [agentSubTab, setAgentSubTab] = useUiStateValue<AgentSubTab>("config.agentSubTab", "pipeline-steps");

  // ── Defaults viewer state (after agentSubTab to avoid hoisting issues) ──
  const [defaultAgentConfig, setDefaultAgentConfig] = useState<{ tools?: any; pipeline?: any; systemPrompt?: string } | null>(null);
  const [defaultsLoading, setDefaultsLoading] = useState(false);

  // Fetch defaults when the sub-tab is activated
  useEffect(() => {
    if (agentSubTab !== "defaults") return;
    if (defaultAgentConfig) return; // already fetched
    setDefaultsLoading(true);
    window.electronAPI?.getDefaultAgentConfig().then((cfg) => {
      if (cfg && !cfg.error) setDefaultAgentConfig(cfg);
      setDefaultsLoading(false);
    });
  }, [agentSubTab, defaultAgentConfig]);

  const handleSaveAgentConfig = useCallback(async () => {
    if (!agentConfig) return;
    setSaving(true);
    setError(null);
    try {
      // Context-aware save: use the edit buffer from whichever sub-tab is active
      // so manual edits in system-prompt or pipeline-hints tabs are not overwritten.
      const isSavingFromStepsTab = agentSubTab === "pipeline-steps";
      const isSavingFromPromptTab = agentSubTab === "system-prompt";
      const isSavingFromHintsTab = agentSubTab === "pipeline-hints";

      // Determine what to use for system prompt
      // - From steps tab: regenerate from the ordered checklist
      // - From prompt/hints/constants tab: use the textarea content as-is
      const finalSystemPrompt = isSavingFromStepsTab ? generateSystemPromptFromSteps(editPipelineSteps) : editSystemPrompt;

      // Determine what to use for pipeline hints
      // - From steps tab: regenerate from the ordered checklist
      // - From hints tab: use the inline-edited hints as-is
      // - From prompt/constants tab: keep current editPipelineHints (already synced)
      const finalHints = isSavingFromStepsTab
        ? generateHintsFromSteps(editPipelineSteps)
        : isSavingFromHintsTab
          ? editPipelineHints
          : editPipelineHints;

      // Terminal tools always come from pipeline steps (the source of truth for isTerminal flag)
      const terminalTools = getTerminalToolsFromSteps(editPipelineSteps);

      const pipeline = {
        ...agentConfig.pipeline,
        max_pipeline_steps: editMaxSteps,
        max_retries: editMaxRetries,
        retry_base_delay_ms: editRetryDelay,
        llm_context_window: editContextWindow,
        terminal_tools:
          terminalTools.length > 0
            ? terminalTools
            : editTerminalTools
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        pipeline_hints: finalHints,
        // Always save the ordered step definitions so the UI can restore them
        pipeline_steps: editPipelineSteps,
      };

      // Validate the pipeline against schema.json before writing — a malformed
      // pipeline would break the agent runner at load.
      const pipelineResult = agentConfigSchemaValidator.validate(pipeline);
      if (!pipelineResult.valid) {
        const msgs = (pipelineResult.errors || [])
          .map((e) => `${e.instanceLocation || "/"} ${e.error || ""}`.trim())
          .slice(0, 5)
          .join("; ");
        setError(`Pipeline is invalid per schema.json: ${msgs || "unknown validation error"}`);
        setSaving(false);
        return;
      }
      // Validate tool definitions too (defense-in-depth; the save payload only
      // writes systemPrompt + pipeline, but a broken tools.json would still
      // make the runner fall back to defaults).
      if (agentConfig.tools !== undefined) {
        const toolsResult = agentConfigSchemaValidator.validate(agentConfig.tools);
        if (!toolsResult.valid) {
          const msgs = (toolsResult.errors || [])
            .map((e) => `${e.instanceLocation || "/"} ${e.error || ""}`.trim())
            .slice(0, 5)
            .join("; ");
          setError(`Tool definitions are invalid per schema.json: ${msgs || "unknown validation error"}`);
          setSaving(false);
          return;
        }
      }

      const payload = {
        systemPrompt: finalSystemPrompt,
        pipeline,
      };
      const result = await window.electronAPI?.saveAgentConfig(payload);
      if (result?.error) {
        setError(result.error);
      } else {
        // Sync both edit buffers so switching tabs doesn't lose state
        setEditSystemPrompt(finalSystemPrompt);
        setEditPipelineHints(finalHints);
        setSaved(true);
        setRestartNeeded(true);
      }
    } catch (err: any) {
      setError(err.message || "Failed to save agent config");
    } finally {
      setSaving(false);
    }
  }, [
    agentConfig,
    agentSubTab,
    editSystemPrompt,
    editPipelineSteps,
    editPipelineHints,
    editMaxSteps,
    editMaxRetries,
    editRetryDelay,
    editContextWindow,
    editTerminalTools,
    generateSystemPromptFromSteps,
    generateHintsFromSteps,
    getTerminalToolsFromSteps,
  ]);

  /** Preview: system prompt generated from current pipeline steps (read-only) */
  const generatedPromptPreview = useMemo(() => generateSystemPromptFromSteps(editPipelineSteps), [editPipelineSteps, generateSystemPromptFromSteps]);

  /** Preview: hints generated from current pipeline steps (read-only) */
  const generatedHintsPreview = useMemo(() => generateHintsFromSteps(editPipelineSteps), [editPipelineSteps, generateHintsFromSteps]);

  const handleRegenerateFromSteps = useCallback(() => {
    // Merge auto-generated hints over existing hints, preserving manual entries for non-step tools
    setEditSystemPrompt(generatedPromptPreview);
    setEditPipelineHints((prev) => ({ ...prev, ...generatedHintsPreview }));
    setSaved(false);
    setRestartNeeded(false);
  }, [generatedPromptPreview, generatedHintsPreview]);

  const handleRestartAgent = useCallback(async () => {
    await window.electronAPI?.restartAgent();
    onClose();
  }, [onClose]);

  const handleRestoreDefaults = useCallback(async () => {
    setShowRestoreDefaultsConfirm(false);
    setRestoringDefaults(true);
    setError(null);
    try {
      const result = await window.electronAPI?.restoreDefaultAgentConfig();
      if (result?.error) {
        setError(result.error);
      } else if (result?.success) {
        // Re-fetch the restored config immediately so the edit buffers reflect the new content
        const freshConfig = await window.electronAPI?.getAgentConfig();
        if (freshConfig && !freshConfig.error) {
          setEditSystemPrompt(freshConfig.systemPrompt || "");
          setEditPipelineHints(freshConfig.pipeline?.pipeline_hints || {});
          setEditPipelineSteps(freshConfig.pipeline?.pipeline_steps || getDefaultPipelineSteps(freshConfig));
          setEditMaxSteps(freshConfig.pipeline?.max_pipeline_steps ?? 25);
          setEditMaxRetries(freshConfig.pipeline?.max_retries ?? 3);
          setEditRetryDelay(freshConfig.pipeline?.retry_base_delay_ms ?? 2000);
          setEditContextWindow(freshConfig.pipeline?.llm_context_window ?? 0);
          setEditTerminalTools((freshConfig.pipeline?.terminal_tools || []).join(", "));
          setAgentConfig(freshConfig);
        } else {
          setAgentConfig(null);
        }
        setRestartNeeded(true);
        setSaved(true);
        setError(null); // clear any previous error
      }
    } catch (err: any) {
      setError(err.message || "Failed to restore defaults");
    } finally {
      setRestoringDefaults(false);
    }
  }, []);

  /**
   * Shared footer action buttons (Save Configuration / Restore Defaults /
   * Save as Defaults), used identically by the config, logging, UI and agent
   * tabs so every tab exposes the same set of actions on the left.
   */
  const renderConfigFooterButtons = (opts: {
    onSave: () => void;
    saveTitle: string;
    openRestore: () => void;
    restoreTitle: string;
    restoreRunning: boolean;
    restoreRunningLabel: string;
    restoreLabel: string;
  }) => (
    <>
      <Tooltip content={opts.saveTitle}>
        <button className="config-save-btn" onClick={opts.onSave} disabled={saving || saved} title={opts.saveTitle}>
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
        </button>
      </Tooltip>
      <Tooltip content={opts.restoreTitle}>
        <button
          className="config-restore-btn"
          onClick={opts.openRestore}
          disabled={saving || opts.restoreRunning || activeJobs.length > 0}
          title={opts.restoreTitle}>
          {opts.restoreRunning ? (
            <span>
              <Icon name="sync" size="14" /> {opts.restoreRunningLabel}
            </span>
          ) : (
            <span>
              <Icon name="restore" size="14" /> {opts.restoreLabel}
            </span>
          )}
        </button>
      </Tooltip>
      <Tooltip content="Save the current user + agent configuration as the new defaults (overwrites the shipped snapshot)">
        <button
          className="config-restore-btn"
          onClick={() => setShowSaveDefaultsConfirm(true)}
          disabled={saving || savingDefaults || activeJobs.length > 0}
          title="Save the current user + agent config as the new defaults">
          {savingDefaults ? (
            <span>
              <Icon name="sync" size="14" /> Saving...
            </span>
          ) : (
            <span>
              <Icon name="save" size="14" /> Save as Defaults
            </span>
          )}
        </button>
      </Tooltip>
    </>
  );

  // Group fields by section
  const sections = new Map<string, typeof FIELDS>();
  for (const field of FIELDS) {
    if (!sections.has(field.section)) sections.set(field.section, []);
    sections.get(field.section)!.push(field);
  }
  const sectionNames = Array.from(sections.keys());

  return (
    <div className="config-panel config-panel--full">
      {/* Header: action buttons only */}
      <div className="config-header">
        <div className="config-io-buttons">
          <Tooltip content="Save current configuration to a JSON file for backup or transfer">
            <button
              className="config-io-btn"
              onClick={handleExport}
              disabled={exporting || activeJobs.length > 0}
              title="Export configuration to a JSON file">
              {exporting ? <Icon name="sync" size="14" /> : <Icon name="upload" size="14" />} Export
            </button>
          </Tooltip>
          <Tooltip content="Load configuration from a previously exported JSON file">
            <button
              className={`config-io-btn ${!configOk ? "config-io-btn--import-highlight" : ""}`}
              onClick={handleImport}
              disabled={importing || activeJobs.length > 0}
              title="Import configuration from a JSON file">
              {importing ? <Icon name="sync" size="14" /> : <Icon name="download" size="14" />} Import
            </button>
          </Tooltip>
          <div className="config-separator" />
          <Tooltip content="Clear ALL configuration values and revert to defaults">
            <button
              className="config-io-btn config-io-btn--danger"
              onClick={() => setShowClearConfigConfirm(true)}
              disabled={clearingConfig || activeJobs.length > 0}
              title="Clear all saved configuration values">
              {clearingConfig ? <Icon name="sync" size="14" /> : <Icon name="delete" size="14" />} Clear
            </button>
          </Tooltip>
        </div>
        <Tooltip content="Close the configuration panel">
          <button className="config-close-btn" onClick={onClose} title="Close configuration panel">
            <Icon name="close" size="16" />
          </button>
        </Tooltip>
      </div>

      {/* Tab bar (full width, styled like dev-panel-tabs) */}
      <div className="config-tab-bar">
        <Tooltip content="Configure LLM provider, API keys, and delivery services">
          <button
            className={`config-tab ${activeTab === "config" ? "config-tab--active" : ""}`}
            onClick={() => setActiveTab("config")}
            title="Configure LLM provider, API keys, and delivery services">
            <Icon name="vpn_key" size="14" /> LLM &amp; Delivery
          </button>
        </Tooltip>
        <Tooltip content="Edit agent system prompt, tool definitions, and pipeline hints">
          <button
            className={`config-tab ${activeTab === "agent" ? "config-tab--active" : ""}`}
            onClick={() => setActiveTab("agent")}
            title="Edit agent system prompt, tool definitions, and pipeline hints">
            <Icon name="smart_toy" size="14" /> Agent Instructions
          </button>
        </Tooltip>
        <Tooltip content="Configure log sources, levels, file size, and rotation">
          <button
            className={`config-tab ${activeTab === "logging" ? "config-tab--active" : ""}`}
            onClick={() => setActiveTab("logging")}
            title="Configure log sources, levels, file size, and rotation">
            <Icon name="edit_note" size="14" /> Logging
          </button>
        </Tooltip>
        <Tooltip content="View and reset the app's saved UI state (tabs, filters, selections)">
          <button
            className={`config-tab ${activeTab === "ui" ? "config-tab--active" : ""}`}
            onClick={() => setActiveTab("ui")}
            title="View and reset the app's saved UI state (tabs, filters, selections)">
            <Icon name="tune" size="14" /> UI
          </button>
        </Tooltip>
      </div>

      <div className="config-body">
        {/* ── Active jobs guard (all tabs) ── */}
        {activeJobs.length > 0 && (
          <div className="config-blocked-banner" style={{ marginBottom: 12 }}>
            <strong>
              <Icon name="block" color="red" size="14" /> Editing blocked
            </strong>{" "}
            — {activeJobs.length} pipeline job{activeJobs.length > 1 ? "s" : ""} currently running:
            <ul className="config-blocked-list">
              {activeJobs.map((j: any) => (
                <li key={j.job_id}>
                  &ldquo;{j.title}&rdquo; — {j.status} ({(j.progress * 100).toFixed(0)}%)
                </li>
              ))}
            </ul>
            <p>Configuration cannot be modified while jobs are in progress. Wait for jobs to complete.</p>
          </div>
        )}

        {/* ── TAB 1: LLM & Delivery Config ── */}
        {activeTab === "config" && (
          <>
            {/* Section sub-tabs — above the hint, full width */}
            <div className="config-section-tabs">
              {sectionNames.map((name) => (
                <Tooltip content={`Switch to ${name} settings section`}>
                  <button
                    key={name}
                    className={`config-section-tab ${configSection === name ? "config-section-tab--active" : ""}`}
                    onClick={() => setConfigSection(name)}
                    title={`Switch to ${name} settings`}>
                    {name === "LLM Provider" && (
                      <>
                        <Icon name="psychology" size="14" />{" "}
                      </>
                    )}
                    {name === "Services" && (
                      <>
                        <Icon name="link" size="14" />{" "}
                      </>
                    )}
                    {name === "Delivery Config" && (
                      <>
                        <Icon name="mail" size="14" />{" "}
                      </>
                    )}
                    {name === "Auto-Update" && (
                      <>
                        <Icon name="sync" size="14" />{" "}
                      </>
                    )}
                    {name === "Pipeline" && (
                      <>
                        <Icon name="flag" size="14" />{" "}
                      </>
                    )}
                    {name === "Usage Tracking" && (
                      <>
                        <Icon name="monitoring" size="14" />{" "}
                      </>
                    )}
                    {name === "Diarization" && (
                      <>
                        <Icon name="record_voice_over" size="14" />{" "}
                      </>
                    )}
                    {name}
                  </button>
                </Tooltip>
              ))}
            </div>

            <p className="config-hint">
              Enter your API keys and credentials. Required fields are marked with <span className="config-required">*</span>. Values are stored in
              your user data directory{activeJobs.length > 0 ? <strong>. Editing disabled while {activeJobs.length} job(s) running</strong> : ""}.
            </p>

            {Object.keys(numericErrors).length > 0 && (
              <div className="config-error-banner">
                <Icon name="warning" color="orange" size="14" /> Please fix the following values before saving:
                <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  {Object.entries(numericErrors).map(([key, msg]) => (
                    <li key={key}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}

            {Array.from(sections.entries())
              .filter(([name]) => name === configSection)
              .map(([sectionName, fields]) => (
                <div key={sectionName} className="config-section">
                  <h3 className="config-section-title">{sectionName}</h3>

                  {sectionName === "LLM Provider" && (
                    <>
                      <div className="config-field">
                        <label className="config-label">
                          LLM Provider <span className="config-required">*</span>
                        </label>
                        <div className="config-radio-group">
                          <label className={`config-radio ${values.LLM_PROVIDER === "deepseek" ? "config-radio--selected" : ""}`}>
                            <input
                              type="radio"
                              name="llm-provider"
                              value="deepseek"
                              checked={values.LLM_PROVIDER === "deepseek"}
                              onChange={() => handleChange("LLM_PROVIDER", "deepseek")}
                              disabled={activeJobs.length > 0}
                            />
                            <span className="config-radio-label">DeepSeek (API)</span>
                            <span className="config-radio-desc">Cloud API — requires API key</span>
                          </label>
                          <label className={`config-radio ${values.LLM_PROVIDER === "ollama" ? "config-radio--selected" : ""}`}>
                            <input
                              type="radio"
                              name="llm-provider"
                              value="ollama"
                              checked={values.LLM_PROVIDER === "ollama"}
                              onChange={() => handleChange("LLM_PROVIDER", "ollama")}
                              disabled={activeJobs.length > 0}
                            />
                            <span className="config-radio-label">Ollama (Local)</span>
                            <span className="config-radio-desc">Local LLM — no API key needed</span>
                          </label>
                        </div>
                        {/* ── Ollama server status indicator ── */}
                        {values.LLM_PROVIDER === "ollama" && (
                          <div className="config-ollama-status">
                            {ollamaHealthChecking && ollamaHealthy === null ? (
                              <span className="config-ollama-status-indicator config-ollama-status--checking" title="Checking Ollama server…">
                                <Icon name="sync" size="14" /> Checking…
                              </span>
                            ) : ollamaHealthy ? (
                              <span className="config-ollama-status-indicator config-ollama-status--up" title="Ollama server is reachable">
                                <span className="config-ollama-status-dot config-ollama-status-dot--up" />
                                Server Online
                              </span>
                            ) : (
                              <span className="config-ollama-status-indicator config-ollama-status--down" title="Ollama server is not reachable">
                                <span className="config-ollama-status-dot config-ollama-status-dot--down" />
                                Server Offline
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {values.LLM_PROVIDER === "deepseek" &&
                        fields
                          .filter((f) => f.key === "DEEPSEEK_API_KEY")
                          .map((field) => (
                            <div key={field.key} className="config-field">
                              <label className="config-label">
                                {field.label}
                                {field.required && <span className="config-required"> *</span>}
                              </label>
                              <div className="config-input-row">
                                <input
                                  className="config-input"
                                  type={visibleKeys.has(field.key) ? "text" : "password"}
                                  value={values[field.key] || ""}
                                  onChange={(e) => handleChange(field.key, e.target.value)}
                                  placeholder="sk-..."
                                  disabled={activeJobs.length > 0}
                                />
                                <Tooltip
                                  content={
                                    visibleKeys.has(field.key) ? "Click to mask the secret value" : "Click to temporarily reveal the secret value"
                                  }>
                                  <button
                                    className="config-visibility-toggle"
                                    onClick={() => toggleVisible(field.key)}
                                    title={visibleKeys.has(field.key) ? "Hide the secret value" : "Reveal the secret value"}
                                    type="button"
                                    tabIndex={-1}>
                                    {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                  </button>
                                </Tooltip>
                              </div>
                            </div>
                          ))}

                      {values.LLM_PROVIDER === "ollama" &&
                        fields
                          .filter(
                            (f) =>
                              f.key !== "DEEPSEEK_API_KEY" &&
                              f.key !== "EMBEDDING_PROVIDER" &&
                              f.key !== "OLLAMA_MODEL" &&
                              f.key !== "OLLAMA_NUM_CTX" &&
                              f.key !== "WHISPER_MODEL_SIZE" &&
                              f.key !== "KEEP_TRANSCRIPT_TIMESTAMPS",
                          )
                          .map((field) => (
                            <div key={field.key} className="config-field">
                              <label className="config-label">{field.label}</label>
                              <div className="config-input-row">
                                <input
                                  className="config-input"
                                  type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                  value={values[field.key] || ""}
                                  onChange={(e) => handleChange(field.key, e.target.value)}
                                  placeholder="Optional"
                                  disabled={activeJobs.length > 0}
                                />
                                {field.secret && (
                                  <button
                                    className="config-visibility-toggle"
                                    onClick={() => toggleVisible(field.key)}
                                    title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                    type="button"
                                    tabIndex={-1}>
                                    {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}

                      {/* ── Ollama Model + Context Window (only when provider is ollama) ── */}
                      {values.LLM_PROVIDER === "ollama" && (
                        <div className="config-section">
                          <h3 className="config-section-title">
                            <Icon name="psychology" size="16" color="accent" /> Model &amp; Context Window
                          </h3>

                          {/* Model selector — fixed options: qwen3.6, deepseekv2 */}
                          <div className="config-field-row">
                            <div className="config-field config-field--compact">
                              <label className="config-label">
                                Model <span className="config-required">*</span>
                              </label>
                              <select
                                className="config-select"
                                value={values.OLLAMA_MODEL || "qwen3.6"}
                                onChange={(e) => handleChange("OLLAMA_MODEL", e.target.value)}
                                disabled={activeJobs.length > 0}>
                                <option value="qwen3.6">qwen3.6</option>
                                <option value="deepseekv2">deepseekv2</option>
                              </select>
                            </div>

                            {/* Context window — fixed options: 32K, 64K, 128K */}
                            <div className="config-field config-field--compact">
                              <label className="config-label">
                                Context Window <span className="config-required">*</span>
                              </label>
                              <select
                                className="config-select"
                                value={values.OLLAMA_NUM_CTX || "32768"}
                                onChange={(e) => handleChange("OLLAMA_NUM_CTX", e.target.value)}
                                disabled={activeJobs.length > 0}>
                                <option value="32768">32K (32,768 tokens)</option>
                                <option value="65536">64K (65,536 tokens)</option>
                                <option value="131072">128K (131,072 tokens)</option>
                              </select>
                            </div>
                          </div>
                          <p className="config-field-hint" style={{ marginTop: 4 }}>
                            Larger context windows let the LLM process longer transcripts but use more RAM/VRAM.
                          </p>
                        </div>
                      )}

                      {/* ── Ollama Model Status — only when provider is ollama ── */}
                      {values.LLM_PROVIDER === "ollama" && (
                        <div className="config-section">
                          <h3 className="config-section-title">
                            <Icon name="smart_toy" size="16" color="accent" /> Ollama Models
                          </h3>

                          {/* Server status line */}
                          <div className="config-ollama-status config-ollama-status--section">
                            {ollamaHealthChecking && ollamaHealthy === null ? (
                              <span className="config-ollama-status-indicator config-ollama-status--checking">
                                <Icon name="sync" size="14" /> Checking server…
                              </span>
                            ) : ollamaHealthy ? (
                              <span className="config-ollama-status-indicator config-ollama-status--up">
                                <span className="config-ollama-status-dot config-ollama-status-dot--up" />
                                Server Online
                              </span>
                            ) : (
                              <span className="config-ollama-status-indicator config-ollama-status--down">
                                <span className="config-ollama-status-dot config-ollama-status-dot--down" />
                                Server Offline
                              </span>
                            )}
                          </div>

                          {/* Loading state */}
                          {ollamaModelsLoading && <p className="config-field-hint">Checking available models…</p>}

                          {/* Connection error */}
                          {ollamaModelsError && (
                            <div className="config-ollama-error">
                              <Icon name="warning" color="orange" size="14" /> {ollamaModelsError}
                              <button className="config-ollama-retry-btn" onClick={fetchOllamaModels} disabled={ollamaModelsLoading}>
                                <Icon name="refresh" size="14" /> Retry
                              </button>
                            </div>
                          )}

                          {/* No models — show pull options */}
                          {!ollamaModelsLoading && !ollamaModelsError && ollamaModels.length === 0 && (
                            <div className="config-ollama-warning">
                              <strong>
                                <Icon name="block" size="14" color="red" /> No models available
                              </strong>
                              <p>Ollama is running but no models are pulled yet. Pull a model below to get started, or add one via the Ollama CLI.</p>
                            </div>
                          )}

                          {/* Available models list */}
                          {ollamaModels.length > 0 && (
                            <div className="config-ollama-model-list">
                              <p className="config-field-hint">Available models on this system:</p>
                              {ollamaModels.map((m) => (
                                <div key={m.name} className="config-ollama-model-item">
                                  <span className="config-ollama-model-name">{m.name}</span>
                                  <span className="config-ollama-model-size">{formatOllamaSize(m.size)}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Pull success/error feedback */}
                          {pullSuccess && <div className="config-ollama-success">{pullSuccess}</div>}
                          {pullError && <div className="config-ollama-error">{pullError}</div>}

                          {/* Pull model buttons */}
                          <div className="config-ollama-pull-section">
                            <p className="config-field-hint">Pull a model for transcription processing:</p>
                            <div className="config-ollama-pull-buttons">
                              <button
                                className="config-ollama-pull-btn"
                                onClick={() => handlePullModel("deepseek-v2")}
                                disabled={
                                  pullingModel !== null ||
                                  activeJobs.length > 0 ||
                                  ollamaModelsLoading ||
                                  ollamaModelsError !== null ||
                                  ollamaModels.some((m) => m.name === "deepseek-v2" || m.name === "deepseek-v2:latest")
                                }
                                title={
                                  ollamaModelsLoading
                                    ? "Checking Ollama connection…"
                                    : ollamaModelsError
                                      ? "Ollama server is not reachable"
                                      : ollamaModels.some((m) => m.name === "deepseek-v2" || m.name === "deepseek-v2:latest")
                                        ? "deepseek-v2 is already pulled"
                                        : ""
                                }>
                                {pullingModel === "deepseek-v2" ? (
                                  <>
                                    <Icon name="sync" size="14" /> Pulling…
                                  </>
                                ) : ollamaModels.some((m) => m.name === "deepseek-v2" || m.name === "deepseek-v2:latest") ? (
                                  <>
                                    <Icon name="check_circle" size="14" color="green" /> deepseek-v2 pulled
                                  </>
                                ) : (
                                  <>
                                    <Icon name="download" size="14" /> Pull deepseek-v2
                                  </>
                                )}
                              </button>
                              <button
                                className="config-ollama-pull-btn"
                                onClick={() => handlePullModel("qwen3.6:27b")}
                                disabled={
                                  pullingModel !== null ||
                                  activeJobs.length > 0 ||
                                  ollamaModelsLoading ||
                                  ollamaModelsError !== null ||
                                  ollamaModels.some((m) => m.name === "qwen3.6:27b" || m.name === "qwen3.6:27b:latest")
                                }
                                title={
                                  ollamaModelsLoading
                                    ? "Checking Ollama connection…"
                                    : ollamaModelsError
                                      ? "Ollama server is not reachable"
                                      : ollamaModels.some((m) => m.name === "qwen3.6:27b" || m.name === "qwen3.6:27b:latest")
                                        ? "qwen3.6:27b is already pulled"
                                        : ""
                                }>
                                {pullingModel === "qwen3.6:27b" ? (
                                  <>
                                    <Icon name="sync" size="14" /> Pulling…
                                  </>
                                ) : ollamaModels.some((m) => m.name === "qwen3.6:27b" || m.name === "qwen3.6:27b:latest") ? (
                                  <>
                                    <Icon name="check_circle" size="14" color="green" /> qwen3.6:27b pulled
                                  </>
                                ) : (
                                  <>
                                    <Icon name="download" size="14" /> Pull qwen3.6:27b
                                  </>
                                )}
                              </button>
                            </div>
                            {pullingModel && (
                              <p className="config-field-hint" style={{ marginTop: 6 }}>
                                Pulling <strong>{pullingModel}</strong> — this may take a few minutes depending on your connection speed.
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Speaker Embedding Model — dropdown */}
                      <div className="config-field">
                        <label className="config-label">Speaker Embedding Model</label>
                        <select
                          className="config-select"
                          value={values.EMBEDDING_PROVIDER || "pyannote"}
                          onChange={(e) => handleChange("EMBEDDING_PROVIDER", e.target.value)}
                          disabled={activeJobs.length > 0}>
                          <option value="pyannote">pyannote/embedding — default (requires HF token)</option>
                          <option value="speechbrain">SpeechBrain ECAPA-TDNN — better with accents</option>
                        </select>
                        <p className="config-field-hint">
                          Switching requires a backend restart. speechbrain extra: <code>pip install speechbrain</code>
                        </p>
                      </div>

                      {/* Whisper Model Size — always shown */}
                      <div className="config-field">
                        <label className="config-label">Whisper Model Size</label>
                        <select
                          className="config-select"
                          value={values.WHISPER_MODEL_SIZE || "medium"}
                          onChange={(e) => handleChange("WHISPER_MODEL_SIZE", e.target.value)}
                          disabled={activeJobs.length > 0}>
                          <option value="medium">medium — balanced speed & accuracy</option>
                          <option value="large">large — highest accuracy, slower</option>
                        </select>
                      </div>

                      {/* Keep Transcript Timestamps — toggle */}
                      <div className="config-field">
                        <label className="config-label">Transcript Timestamps</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.KEEP_TRANSCRIPT_TIMESTAMPS === "true"}
                            onChange={(e) => handleChange("KEEP_TRANSCRIPT_TIMESTAMPS", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.KEEP_TRANSCRIPT_TIMESTAMPS === "true" ? "Keep timestamps in transcript" : "Strip timestamps from transcript"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          When enabled, start/end times are preserved in the refined transcript. When disabled (default), timestamps are stripped
                          during refinement.
                        </p>
                      </div>

                      {/* Whisper Initial Prompt — toggle */}
                      <div className="config-field">
                        <label className="config-label">Whisper Initial Prompt</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.WHISPER_INITIAL_PROMPT_ENABLED === "true"}
                            onChange={(e) => handleChange("WHISPER_INITIAL_PROMPT_ENABLED", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.WHISPER_INITIAL_PROMPT_ENABLED === "true" ? "Initial prompt enabled" : "Initial prompt disabled"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          Pass a text description of the meeting topic to Whisper before transcription to bias the model toward domain-specific
                          vocabulary (e.g. "This is a technical discussion about software architecture").
                        </p>
                      </div>

                      {/* Whisper Initial Prompt Text — shown only when enabled */}
                      {values.WHISPER_INITIAL_PROMPT_ENABLED === "true" && (
                        <div className="config-field">
                          <label className="config-label">Prompt Text</label>
                          <textarea
                            className="config-textarea"
                            value={values.WHISPER_INITIAL_PROMPT || ""}
                            onChange={(e) => handleChange("WHISPER_INITIAL_PROMPT", e.target.value)}
                            disabled={activeJobs.length > 0}
                            placeholder="e.g. This is a technical discussion about software architecture and Kubernetes deployment strategies."
                            rows={3}
                          />
                          <p className="config-field-hint" style={{ marginTop: 4 }}>
                            Describe the meeting topic or domain to help Whisper recognize specialized terminology.
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {sectionName === "Pipeline" && (
                    <>
                      {/* Pipeline Timeout — number input */}
                      <div className="config-field">
                        <label className="config-label">Pipeline/Polling Timeout (minutes)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="1"
                          max="600"
                          step="5"
                          value={values.PIPELINE_TIMEOUT_MINUTES || "60"}
                          onChange={(e) => handleChange("PIPELINE_TIMEOUT_MINUTES", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Total wall-clock budget for the whole pipeline run (diarization + voiceprint matching + ASR + alignment + enqueue), checked
                          between steps. Long audio or a slow/throttled machine needs this well above the diarization timeout — e.g.{" "}
                          <strong>60–90</strong> for hour-long meetings. Default: <strong>60</strong>.
                        </p>
                      </div>

                      {/* Gate 1: Raw Transcript Review — toggle */}
                      <div className="config-field">
                        <label className="config-label">Raw Transcript Review (Gate 1)</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.GATE_RAW_REVIEW_ENABLED === "true"}
                            onChange={(e) => handleChange("GATE_RAW_REVIEW_ENABLED", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.GATE_RAW_REVIEW_ENABLED === "true" ? "Pause for raw transcript review" : "Skip raw transcript review"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          When enabled, the pipeline pauses after ASR and speaker labeling so you can review and edit the raw transcript before it is
                          sent to the LLM for summarization and analysis.
                        </p>
                      </div>

                      {/* Gate 2: Delivery Review — toggle */}
                      <div className="config-field">
                        <label className="config-label">Delivery Review (Gate 2)</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.GATE_DELIVERY_REVIEW_ENABLED === "true"}
                            onChange={(e) => handleChange("GATE_DELIVERY_REVIEW_ENABLED", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.GATE_DELIVERY_REVIEW_ENABLED === "true" ? "Pause for delivery review" : "Skip delivery review"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          When enabled, the agent pauses after generating the summary and analysis so you can review the deliverable before it is
                          saved to memory and sent via email.
                        </p>
                      </div>

                      {/* Keep Models Warm — toggle */}
                      <div className="config-field">
                        <label className="config-label">Keep Models Warm</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.KEEP_MODELS_WARM === "true"}
                            onChange={(e) => handleChange("KEEP_MODELS_WARM", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.KEEP_MODELS_WARM === "true" ? "Models stay loaded between jobs" : "Models unloaded after each job"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          When enabled, ML models (whisper + diarization) remain loaded between transcription jobs. Subsequent jobs start faster with
                          no HuggingFace dependency, but memory usage stays high. Disable on Apple Silicon if you experience out-of-memory errors.
                        </p>
                      </div>
                    </>
                  )}

                  {sectionName === "Diarization" && (
                    <>
                      <div className="config-section-intro">
                        <p className="config-field-hint">
                          These settings control how <strong>pyannote/speaker-diarization-3.1</strong> identifies speakers. Phantom speakers (spurious
                          clusters from noise, coughs, door clicks) can be suppressed by raising the minimum duration/segment thresholds or setting a
                          max speaker count. Adjustments take effect on the <strong>next transcription job</strong>.
                        </p>
                      </div>

                      {/* Min Speaker Duration — number input */}
                      <div className="config-field">
                        <label className="config-label">Min Speaker Duration (seconds)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="0.5"
                          max="10.0"
                          step="0.5"
                          value={values.DIARIZATION_MIN_SPEAKER_DURATION || "3.0"}
                          onChange={(e) => handleChange("DIARIZATION_MIN_SPEAKER_DURATION", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Speakers whose total speech time is below this threshold are discarded as phantoms. Higher values (5–10s) filter more
                          aggressively but may drop a real speaker with very little airtime. Default: <strong>3.0s</strong>.
                        </p>
                      </div>

                      {/* Min Speaker Segments — number input */}
                      <div className="config-field">
                        <label className="config-label">Min Speaker Segments</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="1"
                          max="20"
                          step="1"
                          value={values.DIARIZATION_MIN_SPEAKER_SEGMENTS || "3"}
                          onChange={(e) => handleChange("DIARIZATION_MIN_SPEAKER_SEGMENTS", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Speakers with fewer than this many diarization segments are discarded as phantoms. Noise artifacts typically produce 1–2
                          short segments. A real speaker normally has 5+ segments over a meeting. Default: <strong>3</strong>.
                        </p>
                      </div>

                      {/* Merging Gap — number input */}
                      <div className="config-field">
                        <label className="config-label">Merging Gap (seconds)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="0.0"
                          max="2.0"
                          step="0.1"
                          value={values.DIARIZATION_MERGING_GAP || "0.5"}
                          onChange={(e) => handleChange("DIARIZATION_MERGING_GAP", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Adjacent same-speaker segments with gaps smaller than this are merged into one. Reduces fragmentation from breath pauses.
                          Higher values (1.0–2.0) merge more aggressively but may merge distinct utterances. Default: <strong>0.5s</strong>.
                        </p>
                      </div>

                      {/* Clustering Threshold — number input */}
                      <div className="config-field">
                        <label className="config-label">Clustering Threshold (0.0 = model default)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="0.0"
                          max="1.0"
                          step="0.05"
                          value={values.DIARIZATION_CLUSTERING_THRESHOLD || "0.0"}
                          onChange={(e) => handleChange("DIARIZATION_CLUSTERING_THRESHOLD", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Overrides pyannote's internal clustering threshold. Higher values (0.65–0.75) produce fewer, more conservative clusters.
                          Lower values (0.50–0.60) produce more clusters. Set to <strong>0.0</strong> to use the model's built-in default. Only adjust
                          if post-processing filters above aren't sufficient.
                        </p>
                      </div>

                      {/* Max Speakers — number input */}
                      <div className="config-field">
                        <label className="config-label">Max Speakers (0 = auto-detect)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="0"
                          max="20"
                          step="1"
                          value={values.DIARIZATION_MAX_SPEAKERS || "0"}
                          onChange={(e) => handleChange("DIARIZATION_MAX_SPEAKERS", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Hard upper bound on the number of speaker clusters pyannote will create. When set to a positive value (e.g., attendee count
                          + 1), it prevents phantom speakers by constraining the clustering algorithm. <strong>0</strong> = no limit (model decides).
                          Recommended: set to your expected participants + 1.
                        </p>
                      </div>

                      {/* Diarization Timeout — number input */}
                      <div className="config-field">
                        <label className="config-label">Diarization Timeout (minutes)</label>
                        <input
                          className="config-input config-input--number"
                          type="number"
                          min="1"
                          max="600"
                          step="5"
                          value={values.DIARIZATION_TIMEOUT_MINUTES || "60"}
                          onChange={(e) => handleChange("DIARIZATION_TIMEOUT_MINUTES", e.target.value)}
                          disabled={activeJobs.length > 0}
                        />
                        <p className="config-field-hint">
                          Floor for the diarization subprocess timeout. The effective budget auto-scales with audio length (default ~2× duration), so
                          this acts as a <strong>minimum</strong>. Raise it (e.g. 60–90) if long meetings time out at 60 min. Default:{" "}
                          <strong>60</strong>.
                        </p>
                      </div>
                    </>
                  )}

                  {sectionName === "Usage Tracking" && (
                    <>
                      <div className="config-section-intro">
                        <p className="config-field-hint">
                          Forward per-API-call token usage to a central <strong>DS-mon</strong> instance for per-machine comparison. Records buffer
                          locally when offline and flush on reconnect. Enter your stable DS-mon push URL below (e.g. a named Cloudflare tunnel URL).
                        </p>
                      </div>

                      {/* Master enable/disable toggle */}
                      <div className="config-field">
                        <label className="config-label">Enable Usage Tracking</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.USAGE_TRACKING_ENABLED === "true"}
                            onChange={(e) => handleChange("USAGE_TRACKING_ENABLED", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.USAGE_TRACKING_ENABLED === "true" ? "Usage tracking is active" : "Usage tracking is disabled"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          Enable to forward per-API-call token usage to a central DS-mon instance. When disabled, all usage tracking config is ignored
                          and no data is collected.
                        </p>
                      </div>

                      {values.USAGE_TRACKING_ENABLED === "true" &&
                        fields
                          .filter((f) => f.key !== "USAGE_TRACKING_ENABLED")
                          .map((field) => (
                            <div key={field.key} className="config-field">
                              <label className="config-label">{field.label}</label>
                              <div className="config-input-row">
                                <input
                                  className="config-input"
                                  type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                  value={values[field.key] || ""}
                                  onChange={(e) => handleChange(field.key, e.target.value)}
                                  placeholder={
                                    field.key === "DSMON_INSTANCE_ID"
                                      ? "my-mbp (default: hostname)"
                                      : field.key === "DSMON_PUSH_URL"
                                        ? "https://dsmon.yourdomain.com/sync/push"
                                        : field.key === "DSMON_PUSH_TOKEN"
                                          ? "Required — DS-mon enforces the push token"
                                          : field.key === "DSMON_PUSH_INTERVAL"
                                            ? "300000"
                                            : field.key === "CLOUDFLARED_TUNNEL_TOKEN"
                                              ? "cloudflared tunnel token <name>"
                                              : "Optional"
                                  }
                                  disabled={activeJobs.length > 0}
                                />
                                {field.secret && (
                                  <button
                                    className="config-visibility-toggle"
                                    onClick={() => toggleVisible(field.key)}
                                    title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                    type="button">
                                    {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                  </button>
                                )}
                              </div>
                              <p className="config-field-hint" style={{ marginTop: 2 }}>
                                {field.key === "DSMON_INSTANCE_ID" &&
                                  "Identifier sent with each usage record. Leave empty to auto-generate from hostname, username, and a persistent UUID."}
                                {field.key === "DSMON_PUSH_INTERVAL" &&
                                  "How often (ms) buffered usage records are pushed to DS-mon. Default: 300000 (5 min)."}
                                {field.key === "DSMON_PUSH_URL" &&
                                  "Static URL of the DS-mon sync server, e.g. https://dsmon.yourdomain.com/sync/push (a public hostname on your Cloudflare tunnel) or http://<host>:18888/sync/push on a LAN."}
                                {field.key === "DSMON_PUSH_TOKEN" &&
                                  "Required. Shared secret for the DS-mon host's /sync/push endpoint — DS-mon returns 401 without it. Must match the push token configured in DS-mon. Stored locally only."}
                                {field.key === "CLOUDFLARED_TUNNEL_TOKEN" &&
                                  "Token for the DS-mon Cloudflare tunnel (get it with: cloudflared tunnel token dsmon). Used by the Quick Actions Start button to run `cloudflared tunnel run --token … --protocol http2`. Stored locally only."}
                              </p>
                            </div>
                          ))}

                      <details className="delivery-config-details" style={{ marginTop: 16 }}>
                        <summary className="delivery-config-summary">
                          <Icon name="edit_note" size="14" color="accent" /> Instructions
                        </summary>
                        <div className="delivery-config-body">
                          <p className="config-field-hint" style={{ fontWeight: 600, marginBottom: 8 }}>
                            Setup Overview
                          </p>
                          <p className="config-field-hint" style={{ marginBottom: 12 }}>
                            Usage tracking requires a <strong>DS-mon host</strong> (your Mac, running the DS-mon sync server) and one or more{" "}
                            <strong>remote agent runners</strong> that push usage data to it. Below are step-by-step instructions for each side.
                          </p>

                          <p className="config-field-hint" style={{ fontWeight: 600, marginBottom: 8, marginTop: 16 }}>
                            🖥️ Host Machine Setup (your Mac)
                          </p>
                          <ol className="config-field-hint" style={{ paddingLeft: 20, lineHeight: 1.8, marginBottom: 12 }}>
                            <li>
                              Open DS-mon → Settings → <strong>Services</strong> tab
                            </li>
                            <li>
                              <strong>Turn OFF</strong> the Enable Sync toggle (mode/port fields are greyed out while sync is running)
                            </li>
                            <li>
                              Select <strong>Server</strong> mode
                            </li>
                            <li>
                              Set <strong>listen port</strong> to <code>18888</code>
                            </li>
                            <li>
                              <strong>Turn ON</strong> the Enable Sync toggle — status should show green &quot;Listening :18888&quot;
                            </li>
                            <li style={{ marginTop: 8 }}>
                              <strong>Set a DS-mon Push Token</strong> (Settings → Services → Push Token) — <strong>required</strong>. DS-mon now
                              enforces it: <code>/sync/push</code> returns <code>401</code> unless the request sends the matching{" "}
                              <code>Authorization: Bearer &lt;token&gt;</code>. Every remote must use the same value.
                            </li>
                            <li style={{ marginTop: 8 }}>
                              Expose the sync server with a <strong>Cloudflare tunnel</strong>. Add a <strong>public hostname</strong> (
                              <code>dsmon.yourdomain.com</code> → <code>http://localhost:18888</code>) and paste your tunnel token (get it with{" "}
                              <code>cloudflared tunnel token &lt;tunnel-name&gt;</code>) into the <strong>Cloudflare Tunnel Token</strong> field above
                              — the Quick Actions <strong>Start</strong> button then runs{" "}
                              <code>cloudflared tunnel run --token &lt;TOKEN&gt; --protocol http2</code>. Remotes then use{" "}
                              <code>https://dsmon.yourdomain.com/sync/push</code>.
                            </li>
                          </ol>

                          <p className="config-field-hint" style={{ fontWeight: 600, marginBottom: 8, marginTop: 16 }}>
                            🖥️ Remote Machine Setup (each agent runner)
                          </p>
                          <p className="config-field-hint" style={{ marginBottom: 4 }}>
                            Enable <strong>Usage Tracking</strong> above and paste your stable DS-mon push URL (or set <code>DSMON_PUSH_URL</code> via{" "}
                            <code>.env</code>). The runner pushes buffered records straight to that URL.
                          </p>
                          <ol className="config-field-hint" style={{ paddingLeft: 20, lineHeight: 1.8, marginBottom: 8 }}>
                            <li>
                              <strong>Enable Usage Tracking</strong> toggle → <code>ON</code>
                            </li>
                            <li>
                              <strong>DS-mon Push URL</strong> — paste your public URL, e.g. <code>https://dsmon.yourdomain.com/sync/push</code> (your
                              Cloudflare tunnel's public hostname) or <code>http://&lt;host&gt;:18888/sync/push</code> (LAN). Stored in this machine's
                              local config only — never shipped in the repo.
                            </li>
                            <li>
                              <strong>DS-mon Push Token</strong> — <strong>required</strong>. Same token set on the DS-mon host; DS-mon returns 401
                              without it.
                            </li>
                            <li>
                              <strong>DS-mon Instance ID</strong> auto-generates — override only if you want a custom label in DS-mon
                            </li>
                            <li>
                              <strong>DS-mon Push Interval</strong> defaults to 5 min — controls how often buffered records are flushed
                            </li>
                          </ol>
                          <p className="config-field-hint" style={{ fontWeight: 600, marginBottom: 8, marginTop: 16 }}>
                            ✅ Verification
                          </p>
                          <p className="config-field-hint" style={{ marginBottom: 4 }}>
                            On the remote machine, start a transcription job and check for these log lines:
                          </p>
                          <pre className="config-field-hint" style={{ background: "var(--bg-secondary)", padding: 8, borderRadius: 4, fontSize: 12 }}>
                            {`📊 [DSMON] Starting flush timer (interval: 300000ms, instance: ...)
📊 [DSMON] Pushed 3 usage records to http://host:18888/sync/push`}
                          </pre>
                          <p className="config-field-hint" style={{ marginTop: 8 }}>
                            On the DS-mon host, check <strong>StatsPopoverView → Usage by Source</strong> to see per-machine token usage.
                          </p>
                        </div>
                      </details>

                      {/* ── Quick Actions ── */}
                      {values.USAGE_TRACKING_ENABLED === "true" && (
                        <div style={{ marginTop: 16, borderTop: "1px solid var(--border-color)", paddingTop: 16 }}>
                          <p className="config-field-hint" style={{ fontWeight: 600, marginBottom: 8 }}>
                            🚀 Quick Actions
                          </p>

                          {/* ── Cloudflare Tunnel card ── */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "10px 14px",
                              background: "var(--surface)",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              marginBottom: 10,
                            }}>
                            {/* Status dot */}
                            <div
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: "50%",
                                background: tunnelStatus.connected ? "var(--green, #3fb950)" : "var(--red, #f85149)",
                                flexShrink: 0,
                              }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>
                                <Icon name="open_in_new" size="14" color="accent" /> Cloudflare Tunnel
                              </div>
                              {tunnelStatus.connected && tunnelStatus.url ? (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--text-muted)",
                                    fontFamily: '"SF Mono", "Fira Code", monospace',
                                    marginTop: 2,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}>
                                  {tunnelStatus.url}
                                </div>
                              ) : tunnelStatus.error ? (
                                <div style={{ fontSize: 11, color: "var(--red)", marginTop: 2 }}>Error: {tunnelStatus.error}</div>
                              ) : tunnelStatus.connected ? (
                                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                                  Connected{tunnelStatus.running ? "" : " (external)"}
                                </div>
                              ) : (
                                <div style={{ fontSize: 11, color: "var(--red)", marginTop: 2 }}>Not connected</div>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                              {tunnelStatus.running ? (
                                <button
                                  className="config-update-status-btn"
                                  onClick={stopTunnel}
                                  disabled={activeJobs.length > 0}
                                  title={activeJobs.length > 0 ? "Stop disabled while jobs are running" : "Stop tunnel (app-managed)"}>
                                  <Icon name="stop" size="12" /> Stop
                                </button>
                              ) : tunnelStatus.connected ? (
                                <button
                                  className="config-update-status-btn"
                                  onClick={forceStopTunnel}
                                  disabled={activeJobs.length > 0}
                                  title={
                                    activeJobs.length > 0 ? "Stop disabled while jobs are running" : "Stop the tunnel — sudo killall cloudflared"
                                  }>
                                  <Icon name="stop" size="12" /> Force Stop
                                </button>
                              ) : (
                                <button
                                  className="config-update-status-btn"
                                  onClick={startTunnel}
                                  disabled={!values.CLOUDFLARED_TUNNEL_TOKEN?.trim() || activeJobs.length > 0}
                                  title={
                                    activeJobs.length > 0
                                      ? "Start disabled while jobs are running"
                                      : values.CLOUDFLARED_TUNNEL_TOKEN?.trim()
                                        ? "Start cloudflared tunnel (token mode)"
                                        : "Set the Cloudflare Tunnel Token above to enable Start"
                                  }>
                                  Start
                                </button>
                              )}
                              {tunnelStatus.connected && tunnelStatus.url && (
                                <button
                                  className="config-update-status-btn"
                                  onClick={() => {
                                    navigator.clipboard.writeText(tunnelStatus.url!).then(
                                      () => {
                                        setCopyFeedback("URL copied!");
                                        setTimeout(() => setCopyFeedback(null), 2000);
                                      },
                                      () => {},
                                    );
                                  }}
                                  title="Copy tunnel URL">
                                  <Icon name="content_copy" size="12" /> Copy URL
                                </button>
                              )}
                            </div>
                          </div>

                          {!tunnelStatus.connected && !values.CLOUDFLARED_TUNNEL_TOKEN?.trim() && (
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                              Enter your Cloudflare tunnel token above to enable the Start button.
                            </div>
                          )}

                          {/* Copy feedback toast */}
                          {copyFeedback && (
                            <div
                              style={{
                                marginTop: 8,
                                fontSize: 11,
                                color: "var(--green, #3fb950)",
                                textAlign: "center",
                              }}>
                              {copyFeedback}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {sectionName === "Services" ? (
                    <div className="delivery-config-accordion">
                      {/* ── Gmail accordion section ── */}
                      <details className="delivery-config-details" open>
                        <summary className="delivery-config-summary">
                          <Icon name="email" size="14" color="accent" /> Gmail / Google Services
                        </summary>
                        <div className="delivery-config-body">
                          <p className="config-field-hint">
                            Google OAuth credentials for Gmail and Drive. Uses the same Google Cloud project for both services.
                          </p>
                          <div className="gmail-connect-row">
                            <button
                              className="config-update-status-btn config-update-status-btn--accent"
                              onClick={connectGmail}
                              disabled={
                                activeJobs.length > 0 ||
                                gmailAuthPending ||
                                !(values.GMAIL_CLIENT_ID || "").trim() ||
                                !(values.GMAIL_CLIENT_SECRET || "").trim()
                              }
                              title="Connect your Google account to enable email and Drive delivery"
                              type="button">
                              {gmailAuthPending ? (
                                <>
                                  <span className="updates-spinner updates-spinner--small" /> Waiting for Google authorization…
                                </>
                              ) : (
                                <>
                                  <Icon name="link" size="14" /> Connect with Google
                                </>
                              )}
                            </button>
                            {gmailAuthPending && (
                              <button
                                className="config-update-status-btn"
                                onClick={() => {
                                  window.electronAPI?.cancelGmailOAuth();
                                  setGmailAuthPending(false);
                                  setGmailAuthFeedback({ type: "err", text: "Google authorization cancelled." });
                                }}
                                title="Cancel Google authorization"
                                type="button">
                                <Icon name="close" size="14" /> Cancel
                              </button>
                            )}
                            {!(values.GMAIL_CLIENT_ID || "").trim() || !(values.GMAIL_CLIENT_SECRET || "").trim() ? (
                              <span className="gmail-connect-hint">
                                Import your provided config file (or enter your Client ID &amp; Secret) to enable Google Connect.
                              </span>
                            ) : null}
                          </div>
                          {gmailAuthFeedback && (
                            <div className={`gmail-connect-feedback gmail-connect-feedback--${gmailAuthFeedback.type}`}>{gmailAuthFeedback.text}</div>
                          )}
                          {fields
                            .filter((f) => ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_USER"].includes(f.key as string))
                            .map((field) => (
                              <div key={field.key} className="config-field">
                                <label className="config-label">{field.label}</label>
                                <div className="config-input-row">
                                  <input
                                    className="config-input"
                                    type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                    value={values[field.key] || ""}
                                    onChange={(e) => handleChange(field.key, e.target.value)}
                                    placeholder={field.label.includes("Email") ? "you@gmail.com" : "Optional"}
                                    disabled={activeJobs.length > 0}
                                  />
                                  {field.secret && (
                                    <button
                                      className="config-visibility-toggle"
                                      onClick={() => toggleVisible(field.key)}
                                      title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                      type="button"
                                      tabIndex={-1}>
                                      {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </details>

                      {/* ── Microsoft Teams accordion section ── */}
                      <details className="delivery-config-details">
                        <summary className="delivery-config-summary">
                          <Icon name="videocam" size="14" color="accent" /> Microsoft Teams
                        </summary>
                        <div className="delivery-config-body">
                          <p className="config-field-hint">
                            Pull Teams online meetings + cloud recordings (work/school accounts). Set the Client ID, then connect your Microsoft
                            account.
                          </p>
                          <ProviderConnectRow
                            label="Connect Microsoft Teams"
                            pending={teamsAuthPending}
                            disabled={activeJobs.length > 0}
                            onConnect={connectTeams}
                            onCancel={() => {
                              window.electronAPI?.teamsCancel();
                              setTeamsAuthPending(false);
                              setTeamsAuthFeedback({ type: "err", text: "Teams authorization cancelled." });
                            }}
                            feedback={teamsAuthFeedback}
                          />
                          <CredentialSteps
                            portalUrl="https://entra.microsoft.com"
                            portalLabel="Open Microsoft Entra admin center"
                            steps={[
                              "Go to the Microsoft Entra admin center → App registrations → New registration.",
                              "Name it and choose 'Accounts in this organizational directory only' (work/school) — Teams cloud recordings need a work/school account.",
                              "Platform → Add a platform → 'Mobile and desktop applications' → redirect URI http://localhost (native/public client — no client secret).",
                              "API permissions (delegated): User.Read, Calendars.Read, OnlineMeetings.Read, Files.Read.All.",
                              "Copy the Application (client) ID into the Teams Client ID field below.",
                            ]}
                          />
                          {fields
                            .filter((f) => ["MS_CLIENT_ID", "MS_REFRESH_TOKEN", "MS_USER"].includes(f.key as string))
                            .map((field) => (
                              <div key={field.key} className="config-field">
                                <label className="config-label">{field.label}</label>
                                <div className="config-input-row">
                                  <input
                                    className="config-input"
                                    type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                    value={values[field.key] || ""}
                                    onChange={(e) => handleChange(field.key, e.target.value)}
                                    placeholder="Optional"
                                    disabled={activeJobs.length > 0}
                                  />
                                  {field.secret && (
                                    <button
                                      className="config-visibility-toggle"
                                      onClick={() => toggleVisible(field.key)}
                                      title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                      type="button"
                                      tabIndex={-1}>
                                      {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </details>

                      {/* ── Zoom accordion section ── */}
                      <details className="delivery-config-details">
                        <summary className="delivery-config-summary">
                          <Icon name="videocam" size="14" color="accent" /> Zoom
                        </summary>
                        <div className="delivery-config-body">
                          <p className="config-field-hint">
                            Pull Zoom meetings with cloud recordings. Set the Client ID + Secret, then connect your Zoom account.
                          </p>
                          <ProviderConnectRow
                            label="Connect Zoom"
                            pending={zoomAuthPending}
                            disabled={activeJobs.length > 0}
                            onConnect={connectZoom}
                            onCancel={() => {
                              window.electronAPI?.zoomCancel();
                              setZoomAuthPending(false);
                              setZoomAuthFeedback({ type: "err", text: "Zoom authorization cancelled." });
                            }}
                            feedback={zoomAuthFeedback}
                          />
                          <CredentialSteps
                            portalUrl="https://marketplace.zoom.us"
                            portalLabel="Open Zoom Marketplace"
                            steps={[
                              "Go to the Zoom Marketplace → Build App → OAuth (general purpose).",
                              "Redirect URL for OAuth: http://localhost (also add http://localhost:PORT if your app uses a fixed port).",
                              "Scopes: meeting:read, recording:read, user:read.",
                              "Copy the Client ID and Client Secret into the Zoom fields below.",
                            ]}
                          />
                          {fields
                            .filter((f) => ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_REFRESH_TOKEN", "ZOOM_USER"].includes(f.key as string))
                            .map((field) => (
                              <div key={field.key} className="config-field">
                                <label className="config-label">{field.label}</label>
                                <div className="config-input-row">
                                  <input
                                    className="config-input"
                                    type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                    value={values[field.key] || ""}
                                    onChange={(e) => handleChange(field.key, e.target.value)}
                                    placeholder="Optional"
                                    disabled={activeJobs.length > 0}
                                  />
                                  {field.secret && (
                                    <button
                                      className="config-visibility-toggle"
                                      onClick={() => toggleVisible(field.key)}
                                      title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                      type="button"
                                      tabIndex={-1}>
                                      {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </details>

                      {/* ── Trello accordion section ── */}
                      <details className="delivery-config-details">
                        <summary className="delivery-config-summary">
                          <Icon name="dashboard" size="14" color="accent" /> Trello
                        </summary>
                        <div className="delivery-config-body">
                          <p className="config-field-hint">Trello API credentials for creating action item cards from meeting decisions.</p>
                          {fields
                            .filter((f) => ["TRELLO_KEY", "TRELLO_TOKEN"].includes(f.key as string))
                            .map((field) => (
                              <div key={field.key} className="config-field">
                                <label className="config-label">{field.label}</label>
                                <div className="config-input-row">
                                  <input
                                    className="config-input"
                                    type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                                    value={values[field.key] || ""}
                                    onChange={(e) => handleChange(field.key, e.target.value)}
                                    placeholder="Optional"
                                    disabled={activeJobs.length > 0}
                                  />
                                  {field.secret && (
                                    <button
                                      className="config-visibility-toggle"
                                      onClick={() => toggleVisible(field.key)}
                                      title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                      type="button"
                                      tabIndex={-1}>
                                      {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </details>
                    </div>
                  ) : sectionName === "Delivery Config" ? (
                    <>
                      {/* ── Custom Delivery per Meeting toggle ── */}
                      <div className="config-field">
                        <label className="config-label">Custom Delivery per Meeting</label>
                        <label className="config-toggle">
                          <input
                            type="checkbox"
                            checked={values.CUSTOM_DELIVERY_PER_MEETING === "true"}
                            onChange={(e) => handleChange("CUSTOM_DELIVERY_PER_MEETING", e.target.checked ? "true" : "false")}
                            disabled={activeJobs.length > 0}
                          />
                          <span className="config-toggle-slider" />
                          <span className="config-toggle-label">
                            {values.CUSTOM_DELIVERY_PER_MEETING === "true"
                              ? "Choose recipients for each meeting at delivery review"
                              : "Deliver to all attendees"}
                          </span>
                        </label>
                        <p className="config-field-hint" style={{ marginTop: 4 }}>
                          When enabled, every meeting pauses at the delivery review (Gate 2) so you can choose which attendees receive the email.
                          Config default recipients are always included. When disabled, delivery goes to all attendees.
                        </p>
                      </div>

                      <div className="delivery-config-accordion">
                        {/* ── Gmail accordion section ── */}
                        <details className="delivery-config-details" open>
                          <summary className="delivery-config-summary">
                            <Icon name="email" size="14" color="accent" /> Email Delivery Config
                          </summary>
                          <div className="delivery-config-body">
                            <p className="config-field-hint">
                              Default recipients receive emails in addition to per-job attendee emails. Subject and additional content are appended to
                              the delivery email.
                            </p>
                            {fields
                              .filter((f) =>
                                ["DELIVERY_RECIPIENT_EMAILS", "DELIVERY_EMAIL_SUBJECT", "DELIVERY_EMAIL_ADDITIONAL_CONTENT"].includes(
                                  f.key as string,
                                ),
                              )
                              .map((field) => (
                                <div key={field.key} className="config-field">
                                  <label className="config-label">{field.label}</label>
                                  <div className="config-input-row">
                                    {field.key === "DELIVERY_EMAIL_ADDITIONAL_CONTENT" ? (
                                      <textarea
                                        className="config-textarea"
                                        value={values[field.key] || ""}
                                        onChange={(e) => handleChange(field.key, e.target.value)}
                                        placeholder="Any extra text to append to delivery emails..."
                                        rows={3}
                                        disabled={activeJobs.length > 0}
                                      />
                                    ) : (
                                      <div style={{ width: "100%" }}>
                                        <input
                                          className={`config-input${field.key === "DELIVERY_RECIPIENT_EMAILS" && emailValidationError ? " config-input--error" : ""}`}
                                          type="text"
                                          value={values[field.key] || ""}
                                          onChange={(e) => handleChange(field.key, e.target.value)}
                                          placeholder={
                                            field.key === "DELIVERY_RECIPIENT_EMAILS"
                                              ? "alice@example.com, bob@example.com"
                                              : field.key === "DELIVERY_EMAIL_SUBJECT"
                                                ? "Meeting Summary: {title}"
                                                : ""
                                          }
                                          disabled={activeJobs.length > 0}
                                        />
                                        {field.key === "DELIVERY_RECIPIENT_EMAILS" && emailValidationError && (
                                          <span className="config-field-error">{emailValidationError}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </details>

                        {/* ── Drive accordion section ── */}
                        <details className="delivery-config-details">
                          <summary className="delivery-config-summary">
                            <Icon name="cloud" size="14" color="accent" /> Google Drive Delivery Config
                          </summary>
                          <div className="delivery-config-body">
                            {fields
                              .filter((f) => (f.key as string) === "DELIVERY_DRIVE_FOLDER")
                              .map((field) => (
                                <div key={field.key} className="config-field">
                                  <label className="config-label">{field.label}</label>
                                  <div className="config-input-row">
                                    <input
                                      className="config-input"
                                      type="text"
                                      value={values[field.key] || ""}
                                      onChange={(e) => handleChange(field.key, e.target.value)}
                                      placeholder="Meeting Transcripts"
                                      disabled={activeJobs.length > 0}
                                    />
                                  </div>
                                </div>
                              ))}
                          </div>
                        </details>
                      </div>
                    </>
                  ) : sectionName === "Auto-Update" ? (
                    <>
                      {/* Compact update status card */}
                      <UpdateStatusCard />

                      {fields.map((field) => (
                        <div key={field.key} className="config-field">
                          <label className="config-label">
                            {field.label}
                            {field.required && <span className="config-required"> *</span>}
                          </label>
                          <div className="config-input-row">
                            <input
                              className="config-input"
                              type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                              value={values[field.key] || ""}
                              onChange={(e) => handleChange(field.key, e.target.value)}
                              placeholder={field.required ? "Enter your API key..." : "Optional"}
                              disabled={activeJobs.length > 0}
                            />
                            {field.secret && (
                              <button
                                className="config-visibility-toggle"
                                onClick={() => toggleVisible(field.key)}
                                title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                                type="button"
                                tabIndex={-1}>
                                {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </>
                  ) : !["LLM Provider", "Pipeline", "Diarization", "Services", "Delivery Config", "Auto-Update", "Usage Tracking"].includes(
                      sectionName,
                    ) ? (
                    fields.map((field) => (
                      <div key={field.key} className="config-field">
                        <label className="config-label">
                          {field.label}
                          {field.required && <span className="config-required"> *</span>}
                        </label>
                        <div className="config-input-row">
                          <input
                            className="config-input"
                            type={field.secret && !visibleKeys.has(field.key) ? "password" : "text"}
                            value={values[field.key] || ""}
                            onChange={(e) => handleChange(field.key, e.target.value)}
                            placeholder={field.required ? "Enter your API key..." : "Optional"}
                            disabled={activeJobs.length > 0}
                          />
                          {field.secret && (
                            <button
                              className="config-visibility-toggle"
                              onClick={() => toggleVisible(field.key)}
                              title={visibleKeys.has(field.key) ? "Hide value" : "Show value"}
                              type="button"
                              tabIndex={-1}>
                              {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  ) : null}
                </div>
              ))}
          </>
        )}

        {/* ── TAB 2: Agent Instructions ── */}
        {activeTab === "agent" && agentConfigLoading && <div className="config-loading">Loading agent configuration…</div>}

        {activeTab === "agent" && agentConfigError && (
          <div className="config-error-banner">
            <Icon name="warning" color="orange" size="14" /> Could not load agent config from bridge server: {agentConfigError}
            <p className="config-hint">Make sure the bridge server (:5010) is running.</p>
          </div>
        )}

        {activeTab === "agent" && !agentConfigLoading && !agentConfigError && agentConfig && (
          <>
            {activeJobsLoading && <p className="config-hint">Checking for active jobs…</p>}

            <p className="config-hint">
              Edit the instructions that control the transcription agent's behavior. Changes take effect after restarting the agent runner.
            </p>

            {/* Agent sub-tab bar — System Prompt is at the right end, read-only */}
            <div className="config-section-tabs config-section-tabs--agent">
              <button
                className={`config-section-tab ${agentSubTab === "pipeline-steps" ? "config-section-tab--active" : ""}`}
                onClick={() => setAgentSubTab("pipeline-steps")}>
                <Icon name="checklist" size="14" color="accent" /> Pipeline Steps
              </button>
              <button
                className={`config-section-tab ${agentSubTab === "pipeline-hints" ? "config-section-tab--active" : ""}`}
                onClick={() => setAgentSubTab("pipeline-hints")}>
                <Icon name="explore" size="14" color="accent" /> Pipeline Hints
              </button>
              <button
                className={`config-section-tab ${agentSubTab === "pipeline-constants" ? "config-section-tab--active" : ""}`}
                onClick={() => setAgentSubTab("pipeline-constants")}>
                <Icon name="tune" size="14" color="accent" /> Pipeline Constants
              </button>
              <button
                className={`config-section-tab config-section-tab--readonly ${agentSubTab === "system-prompt" ? "config-section-tab--active" : ""}`}
                onClick={() => setAgentSubTab("system-prompt")}>
                <Icon name="edit_note" size="14" /> System Prompt
              </button>
              <button
                className={`config-section-tab config-section-tab--readonly ${agentSubTab === "defaults" ? "config-section-tab--active" : ""}`}
                onClick={() => setAgentSubTab("defaults")}>
                <Icon name="restore" size="14" /> Defaults
              </button>
            </div>

            {/* Pipeline Steps (draggable checklist) */}
            {agentSubTab === "pipeline-steps" && (
              <div className="config-section">
                <div className="pipeline-steps-header">
                  <h3 className="config-section-title">
                    <Icon name="checklist" size="16" color="accent" /> Pipeline Steps
                  </h3>
                  <span className="pipeline-steps-count">
                    {editPipelineSteps.length} step{editPipelineSteps.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <p className="config-field-hint">
                  Drag to reorder pipeline steps. Toggle the checkbox to enable/disable a step. Disabled steps are excluded from the system prompt and
                  pipeline hints. Click a step to expand and edit its label, description, and hint text.
                </p>

                {editPipelineSteps.length === 0 && (
                  <div className="config-empty">No pipeline steps defined. Save agent config to generate default steps.</div>
                )}

                <div className="pipeline-steps-list">
                  {editPipelineSteps.map((step, index) => (
                    <div
                      key={step.id}
                      className={`pipeline-step ${!step.enabled ? "pipeline-step--disabled" : ""} ${dragIndex === index ? "pipeline-step--dragging" : ""} ${dropIndex === index ? "pipeline-step--drop-target" : ""} ${expandedStepId === step.id ? "pipeline-step--expanded" : ""}`}
                      draggable={activeJobs.length === 0}
                      onDragStart={(e) => {
                        setDragIndex(index);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(index));
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropIndex(index);
                      }}
                      onDragLeave={() => {
                        setDropIndex((prev) => (prev === index ? null : prev));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
                        if (!isNaN(fromIdx) && fromIdx !== index) {
                          const updated = [...editPipelineSteps];
                          const [moved] = updated.splice(fromIdx, 1);
                          updated.splice(index, 0, moved);
                          // Re-assign IDs to match new order
                          const reordered = updated.map((s, i) => ({ ...s, id: `step-${i + 1}` }));
                          setEditPipelineSteps(reordered);
                          setSaved(false);
                          setRestartNeeded(false);
                        }
                        setDragIndex(null);
                        setDropIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setDropIndex(null);
                      }}>
                      {/* Step header — always visible */}
                      <div className="pipeline-step-header" onClick={() => setExpandedStepId(expandedStepId === step.id ? null : step.id)}>
                        {/* Drag handle */}
                        <span className={`pipeline-step-drag ${activeJobs.length > 0 ? "pipeline-step-drag--disabled" : ""}`} title="Drag to reorder">
                          ⠿
                        </span>

                        {/* Enable/disable toggle — Trello step checkbox is unlocked via Developer section toggle */}
                        <label className="pipeline-step-checkbox" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={step.enabled}
                            disabled={activeJobs.length > 0 || (step.toolName === "create_trello_action_items" && !trelloToggleEnabled)}
                            onChange={() => {
                              const updated = editPipelineSteps.map((s) => (s.id === step.id ? { ...s, enabled: !s.enabled } : s));
                              setEditPipelineSteps(updated);
                              setSaved(false);
                              setRestartNeeded(false);
                            }}
                          />
                          <span className="pipeline-step-checkmark" />
                        </label>

                        {/* Step label and description */}
                        <div className="pipeline-step-info">
                          <span className="pipeline-step-number">#{index + 1}</span>
                          <span className="pipeline-step-label">{step.label}</span>
                          <span className="pipeline-step-toolname">{step.toolName}</span>
                          {step.isTerminal && <span className="pipeline-step-badge pipeline-step-badge--terminal">⏹ Terminal</span>}
                        </div>

                        {/* Expand/collapse arrow */}
                        <span className={`pipeline-step-arrow ${expandedStepId === step.id ? "pipeline-step-arrow--open" : ""}`}>▾</span>
                      </div>

                      {/* Expanded editor — label, description, hint */}
                      {expandedStepId === step.id && (
                        <div className="pipeline-step-editor">
                          <div className="pipeline-step-editor-field">
                            <label className="config-label">Label</label>
                            <input
                              className="config-input"
                              type="text"
                              value={step.label}
                              disabled={activeJobs.length > 0}
                              onChange={(e) => {
                                const updated = editPipelineSteps.map((s) => (s.id === step.id ? { ...s, label: e.target.value } : s));
                                setEditPipelineSteps(updated);
                                setSaved(false);
                                setRestartNeeded(false);
                              }}
                            />
                          </div>
                          <div className="pipeline-step-editor-field">
                            <label className="config-label">Description</label>
                            <input
                              className="config-input"
                              type="text"
                              value={step.description}
                              disabled={activeJobs.length > 0}
                              onChange={(e) => {
                                const updated = editPipelineSteps.map((s) => (s.id === step.id ? { ...s, description: e.target.value } : s));
                                setEditPipelineSteps(updated);
                                setSaved(false);
                                setRestartNeeded(false);
                              }}
                            />
                          </div>
                          <div className="pipeline-step-editor-field">
                            <label className="config-label">System Prompt Template</label>
                            <p className="config-field-hint">
                              Use <code>{`{tool}`}</code> as placeholder for the tool name. Leave empty for default.
                            </p>
                            <textarea
                              className="config-textarea"
                              rows={2}
                              value={step.systemPromptTemplate}
                              disabled={activeJobs.length > 0}
                              placeholder={`Auto-generated from label and tool name`}
                              onChange={(e) => {
                                const updated = editPipelineSteps.map((s) => (s.id === step.id ? { ...s, systemPromptTemplate: e.target.value } : s));
                                setEditPipelineSteps(updated);
                                setSaved(false);
                                setRestartNeeded(false);
                              }}
                            />
                          </div>
                          <div className="pipeline-step-editor-field">
                            <label className="config-label">Pipeline Hint</label>
                            <p className="config-field-hint">Text shown to the LLM after this step executes, telling it what to do next.</p>
                            <textarea
                              className="config-textarea"
                              rows={2}
                              value={step.hintTemplate}
                              disabled={activeJobs.length > 0}
                              placeholder="Next: Call transcribe_..."
                              onChange={(e) => {
                                const updated = editPipelineSteps.map((s) => (s.id === step.id ? { ...s, hintTemplate: e.target.value } : s));
                                setEditPipelineSteps(updated);
                                setSaved(false);
                                setRestartNeeded(false);
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* ── Developer section (collapsed by default) ── */}
                <details className="config-preview-details" style={{ marginTop: 12 }}>
                  <summary
                    className="config-preview-summary"
                    style={{ cursor: "pointer", userSelect: "none", fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                    <Icon name="build" size="14" color="muted" /> Developer
                  </summary>
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--bg-secondary)", borderRadius: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        id="dev-trello-toggle"
                        checked={trelloToggleEnabled}
                        disabled={activeJobs.length > 0}
                        onChange={() => setTrelloToggleEnabled((prev) => !prev)}
                      />
                      <label htmlFor="dev-trello-toggle" style={{ fontSize: 12, cursor: "pointer" }}>
                        <Icon name="dashboard" size="14" color="accent" /> Unlock Trello Cards step checkbox
                      </label>
                    </div>
                    <p className="config-field-hint" style={{ marginTop: 4, marginBottom: 0 }}>
                      Enables the &ldquo;Create Trello Cards&rdquo; step checkbox above so you can toggle it on/off. This prevents accidental enabling
                      of Trello delivery without first visiting this section.
                    </p>
                  </div>
                </details>
              </div>
            )}

            {/* System Prompt — read-only. The system prompt is auto-generated from Pipeline Steps. */}
            {agentSubTab === "system-prompt" && (
              <div className="config-section">
                <div className="config-section-header-row">
                  <h3 className="config-section-title">
                    <Icon name="edit_note" size="16" color="accent" /> System Prompt
                  </h3>
                  <span className="config-section-badge config-section-badge--readonly">
                    <Icon name="lock" size="12" /> Read-only
                  </span>
                </div>
                <p className="config-field-hint">
                  The system prompt is auto-generated from the <strong>Pipeline Steps</strong> checklist. Edit step labels, descriptions, and
                  enabled/disabled state in the Pipeline Steps tab to change the prompt.
                </p>

                {/* Read-only preview of the auto-generated prompt */}
                <details className="config-preview-details" open>
                  <summary className="config-preview-summary">
                    <Icon name="search" size="14" color="muted" /> Auto-generated from Pipeline Steps (
                    {editPipelineSteps.filter((s) => s.enabled).length} enabled steps)
                  </summary>
                  <pre className="config-preview-block">{generatedPromptPreview}</pre>
                </details>

                <pre className="config-textarea config-textarea--large config-textarea--readonly">{editSystemPrompt}</pre>
              </div>
            )}

            {/* Pipeline Hints */}
            {agentSubTab === "pipeline-hints" && (
              <div className="config-section">
                <div className="config-section-header-row">
                  <h3 className="config-section-title">
                    <Icon name="explore" size="16" color="accent" /> Pipeline Hints
                  </h3>
                  <button
                    className="config-regenerate-btn"
                    onClick={handleRegenerateFromSteps}
                    disabled={activeJobs.length > 0}
                    title="Reset to auto-generated hints from the Pipeline Steps checklist">
                    <Icon name="sync" size="14" /> Regenerate from Steps
                  </button>
                </div>
                <p className="config-field-hint">
                  Hint text appended to the LLM context after each tool step. Key = tool name, value = hint text.{" "}
                  <strong>Edits are preserved when saving from this tab.</strong>
                </p>

                {/* Preview of auto-generated hints */}
                <details className="config-preview-details">
                  <summary className="config-preview-summary">
                    <Icon name="search" size="14" color="muted" /> Preview: auto-generated from Pipeline Steps (
                    {Object.keys(generatedHintsPreview).length} hints)
                  </summary>
                  <pre className="config-preview-block">
                    {Object.entries(generatedHintsPreview)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join("\n")}
                  </pre>
                </details>

                {Object.keys(editPipelineHints).length === 0 && <p className="config-empty">No pipeline hints loaded.</p>}
                {Object.entries(editPipelineHints)
                  .sort(([a], [b]) => {
                    // Sort by step order in the checklist
                    const order = editPipelineSteps.findIndex((s) => s.toolName === a) - editPipelineSteps.findIndex((s) => s.toolName === b);
                    return order;
                  })
                  .map(([key, val]) => (
                    <div key={key} className="config-field">
                      <div className="config-label-row">
                        <label className="config-label config-label--mono">{key}</label>
                        <span className="config-hint-badge">step #{editPipelineSteps.findIndex((s) => s.toolName === key) + 1 || "—"}</span>
                      </div>
                      <textarea
                        className="config-textarea config-textarea--hint"
                        rows={2}
                        value={val}
                        onChange={(e) => {
                          setEditPipelineHints((prev) => ({ ...prev, [key]: e.target.value }));
                          setSaved(false);
                          setRestartNeeded(false);
                        }}
                        disabled={activeJobs.length > 0}
                      />
                    </div>
                  ))}
              </div>
            )}

            {/* Pipeline Constants */}
            {agentSubTab === "pipeline-constants" && (
              <div className="config-section">
                <h3 className="config-section-title">
                  <Icon name="tune" size="16" color="accent" /> Pipeline Constants
                </h3>
                <div className="config-field-row">
                  <div className="config-field config-field--compact">
                    <label className="config-label">Max Steps</label>
                    <input
                      className="config-input config-input--number"
                      type="number"
                      min={1}
                      max={100}
                      value={editMaxSteps}
                      onChange={(e) => {
                        setEditMaxSteps(parseInt(e.target.value) || 15);
                        setSaved(false);
                      }}
                      disabled={activeJobs.length > 0}
                    />
                  </div>
                  <div className="config-field config-field--compact">
                    <label className="config-label">Max Retries</label>
                    <input
                      className="config-input config-input--number"
                      type="number"
                      min={0}
                      max={20}
                      value={editMaxRetries}
                      onChange={(e) => {
                        setEditMaxRetries(parseInt(e.target.value) || 3);
                        setSaved(false);
                      }}
                      disabled={activeJobs.length > 0}
                    />
                  </div>
                  <div className="config-field config-field--compact">
                    <label className="config-label">Retry Delay (ms)</label>
                    <input
                      className="config-input config-input--number"
                      type="number"
                      min={100}
                      max={30000}
                      step={100}
                      value={editRetryDelay}
                      onChange={(e) => {
                        setEditRetryDelay(parseInt(e.target.value) || 2000);
                        setSaved(false);
                      }}
                      disabled={activeJobs.length > 0}
                    />
                  </div>
                  <div className="config-field config-field--compact">
                    <label className="config-label">Context Window</label>
                    <input
                      className="config-input config-input--number"
                      type="number"
                      min={0}
                      max={100}
                      value={editContextWindow}
                      onChange={(e) => {
                        setEditContextWindow(parseInt(e.target.value) || 0);
                        setSaved(false);
                      }}
                      disabled={activeJobs.length > 0}
                    />
                    <p className="config-field-hint">Sliding window of step results sent to the LLM. 0 = send all steps (default).</p>
                  </div>
                </div>
                <div className="config-field">
                  <label className="config-label">Terminal Tools</label>
                  <p className="config-field-hint">Comma-separated list of tool names that end the pipeline when called.</p>
                  <input
                    className="config-input"
                    type="text"
                    value={editTerminalTools}
                    onChange={(e) => {
                      setEditTerminalTools(e.target.value);
                      setSaved(false);
                      setRestartNeeded(false);
                    }}
                    placeholder="send_delivery_email, save_to_drive, create_trello_action_items"
                    disabled={activeJobs.length > 0}
                  />
                </div>
              </div>
            )}
            {/* Factory Defaults — read-only viewer */}
            {agentSubTab === "defaults" && (
              <div className="config-section">
                <div className="config-section-header-row">
                  <h3 className="config-section-title">
                    <Icon name="restore" size="16" color="accent" /> Factory Defaults
                  </h3>
                  <span className="config-section-badge config-section-badge--readonly">
                    <Icon name="lock" size="12" /> Read-only
                  </span>
                </div>
                <p className="config-field-hint">These are the original shipped configuration files. Editable copies live in the other tabs above.</p>

                {defaultsLoading ? (
                  <div className="config-loading">Loading defaults…</div>
                ) : !defaultAgentConfig ? (
                  <div className="config-empty">No defaults found. Run a job first to generate the snapshot.</div>
                ) : (
                  <>
                    {/* System Prompt */}
                    <details className="config-preview-details" open>
                      <summary className="config-preview-summary">
                        <Icon name="edit_note" size="14" color="muted" /> system-prompt.md
                      </summary>
                      <pre className="config-preview-block">{defaultAgentConfig.systemPrompt}</pre>
                    </details>

                    {/* Pipeline */}
                    <details className="config-preview-details">
                      <summary className="config-preview-summary">
                        <Icon name="checklist" size="14" color="muted" /> pipeline.json
                      </summary>
                      <pre className="config-preview-block">{JSON.stringify(defaultAgentConfig.pipeline, null, 2)}</pre>
                    </details>

                    {/* Tools */}
                    <details className="config-preview-details">
                      <summary className="config-preview-summary">
                        <Icon name="build" size="14" color="muted" /> tools.json
                      </summary>
                      <pre className="config-preview-block">{JSON.stringify(defaultAgentConfig.tools, null, 2)}</pre>
                    </details>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* ── TAB 3: Logging Config ── */}
        {activeTab === "logging" && (
          <>
            <p className="config-hint">
              All log entries from every source (Python backend, bridge server, agent runner, Electron main) are written to the per-job
              <code>pipeline.log</code> file while a job is active. The log is automatically closed when the pipeline completes or fails.
            </p>

            {/* LLM Data Logging */}
            <div className="config-section">
              <h3 className="config-section-title">
                <Icon name="psychology" size="16" color="accent" /> LLM Data Logging
              </h3>
              <p className="config-field-hint">
                When enabled, the full LLM input (context/prompt) and output (response) for each pipeline step are saved to the job&apos;s storage
                directory as <code>llm-data.jsonl</code>. This can produce large files — use only for debugging.
              </p>
              <div className="config-field">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={values.LOG_LLM_DATA === "true"}
                    disabled={activeJobs.length > 0}
                    onChange={() => handleChange("LOG_LLM_DATA", values.LOG_LLM_DATA === "true" ? "false" : "true")}
                  />
                  <span className="config-toggle-slider" />
                  <span className="config-toggle-label">
                    <strong>Log LLM input/output data</strong>
                  </span>
                </label>
              </div>
            </div>

            {/* ── Electron / Chromium Logging ── */}
            <div className="config-section" style={{ marginTop: 16 }}>
              <h3 className="config-section-title">
                <Icon name="terminal" size="16" color="accent" /> Electron / Chromium Logging
              </h3>
              <p className="config-field-hint">
                When enabled, Chromium&apos;s renderer, GPU, and console messages are routed to the app console / log output. This surfaces low-level
                errors (e.g. GPU or compositor failures) that are otherwise invisible — useful when diagnosing blank or unrendered windows under
                Wine/CrossOver. Requires an app restart to take effect.
              </p>
              <div className="config-field">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={values.LOG_CHROMIUM === "true"}
                    disabled={activeJobs.length > 0}
                    onChange={() => handleChange("LOG_CHROMIUM", values.LOG_CHROMIUM === "true" ? "false" : "true")}
                  />
                  <span className="config-toggle-slider" />
                  <span className="config-toggle-label">
                    <strong>Enable Electron/Chromium logging</strong>
                  </span>
                </label>
              </div>
            </div>

            {/* ── Log Display Options ── */}
            <div className="config-section" style={{ marginTop: 16 }}>
              <h3 className="config-section-title">
                <Icon name="visibility" size="16" color="accent" /> Log Display
              </h3>
              <p className="config-field-hint">Controls how log entries are displayed in the Results Viewer Logs tab.</p>
              <div className="config-field">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={values.LOG_COLLAPSE_REPEATED_PREFIXES === "true"}
                    onChange={() =>
                      handleChange("LOG_COLLAPSE_REPEATED_PREFIXES", values.LOG_COLLAPSE_REPEATED_PREFIXES === "true" ? "false" : "true")
                    }
                  />
                  <span className="config-toggle-slider" />
                  <span className="config-toggle-label">
                    <strong>Collapse repeated prefixes</strong>
                    <br />
                    <span className="config-toggle-desc" style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>
                      Groups consecutive log lines with the same source, sub-source, and level into a single collapsible block.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </>
        )}

        {/* ── TAB 4: UI State ── */}
        {activeTab === "ui" && (
          <>
            <div className="config-section">
              <h3 className="config-section-title">
                <Icon name="tune" size="16" color="accent" /> UI State
              </h3>
              <p className="config-field-hint">
                The app remembers your view state — panel tabs, filters, selections, and the New-form draft — in <code>userData/ui-state.json</code>.
                This is separate from your configuration: it does not affect API keys, providers, delivery settings, or any saved data. Clearing it
                resets every panel to its defaults immediately (no restart needed).
              </p>
              <div className="config-field" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  className="config-io-btn config-io-btn--danger"
                  onClick={() => setShowClearUiStateConfirm(true)}
                  disabled={clearingUiState}
                  title="Clear all saved UI state (tabs, filters, selections, New-form draft)">
                  {clearingUiState ? <Icon name="sync" size="14" /> : <Icon name="delete_sweep" size="14" />} Clear all UI state
                </button>
                {uiStateResult && <span className="config-success">{uiStateResult}</span>}
              </div>
            </div>

            <div className="config-section">
              <h3 className="config-section-title">
                <Icon name="book" size="16" color="accent" /> Documentation
              </h3>
              <p className="config-field-hint">
                The in-app <strong>User Guide</strong> (About → Guide) and <strong>Dev Guide</strong> (Dev → Guide) render the markdown docs from{" "}
                <code>docs/</code>. Turn screenshots off here for a lighter, faster, more data-conscious view.
              </p>
              <div className="config-field">
                <label className="config-label">Show images in guides</label>
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={values.USER_GUIDE_IMAGES_ENABLED === "true"}
                    onChange={(e) => handleChange("USER_GUIDE_IMAGES_ENABLED", e.target.checked ? "true" : "false")}
                  />
                  <span className="config-toggle-slider" />
                  <span className="config-toggle-label">
                    {values.USER_GUIDE_IMAGES_ENABLED === "true" ? "Screenshots shown in guides" : "Screenshots hidden in guides"}
                  </span>
                </label>
                <p className="config-field-hint" style={{ marginTop: 4 }}>
                  When enabled, annotated screenshots display inline in the User Guide and Dev Guide. When disabled, image blocks are omitted. This is
                  a display-only preference — it never touches your configuration or data.
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Config action loading overlay (covers save / import / clear / restore / save-defaults) ── */}
      <LoadingModal
        visible={saving || importing || clearingConfig || restoringUserDefaults || restoringDefaults || savingDefaults}
        message={
          saving
            ? "Saving configuration…"
            : importing
              ? "Importing configuration — restarting backend services…"
              : clearingConfig
                ? "Clearing configuration — restarting backend services…"
                : restoringUserDefaults
                  ? "Restoring defaults — restarting backend services…"
                  : restoringDefaults
                    ? "Restoring agent defaults…"
                    : savingDefaults
                      ? "Saving current configuration as defaults…"
                      : undefined
        }
      />

      <div className="config-footer">
        {/* ── Buttons row (top of footer, horizontal) ── */}
        <div className="config-footer-buttons">
          {activeTab === "config" && (
            <>
              {activeJobs.length > 0 ? (
                <span className="config-footer-hint">
                  <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait
                  for completion.
                </span>
              ) : (
                <div className="config-footer-actions">
                  {renderConfigFooterButtons({
                    onSave: handleSave,
                    saveTitle: "Save all API keys, provider settings, and delivery config to disk",
                    openRestore: () => setShowRestoreUserDefaultsConfirm(true),
                    restoreTitle: "Restore the factory-default user config (API keys, provider settings, delivery config)",
                    restoreRunning: restoringUserDefaults,
                    restoreRunningLabel: "Restoring...",
                    restoreLabel: "Restore Defaults",
                  })}
                </div>
              )}
            </>
          )}

          {activeTab === "logging" && (
            <>
              {activeJobs.length > 0 ? (
                <span className="config-footer-hint">
                  <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait
                  for completion.
                </span>
              ) : (
                <div className="config-footer-actions">
                  {renderConfigFooterButtons({
                    onSave: handleSave,
                    saveTitle: "Save log source filters, levels, and rotation settings",
                    openRestore: () => setShowRestoreUserDefaultsConfirm(true),
                    restoreTitle: "Restore the factory-default user config (API keys, provider settings, delivery config)",
                    restoreRunning: restoringUserDefaults,
                    restoreRunningLabel: "Restoring...",
                    restoreLabel: "Restore Defaults",
                  })}
                </div>
              )}
            </>
          )}

          {activeTab === "ui" && (
            <>
              {activeJobs.length > 0 ? (
                <span className="config-footer-hint">
                  <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait
                  for completion.
                </span>
              ) : (
                <div className="config-footer-actions">
                  {renderConfigFooterButtons({
                    onSave: handleSave,
                    saveTitle: "Save UI / documentation display preferences",
                    openRestore: () => setShowRestoreUserDefaultsConfirm(true),
                    restoreTitle: "Restore the factory-default user config (API keys, provider settings, delivery config)",
                    restoreRunning: restoringUserDefaults,
                    restoreRunningLabel: "Restoring...",
                    restoreLabel: "Restore Defaults",
                  })}
                </div>
              )}
            </>
          )}

          {activeTab === "agent" && (
            <div className="config-footer-actions">
              {activeJobs.length > 0 ? (
                <span className="config-footer-hint">
                  <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait
                  for completion.
                </span>
              ) : (
                <>
                  <span className="config-footer-note">
                    {agentSubTab === "pipeline-steps" && (
                      <>
                        <Icon name="lightbulb" size="12" color="orange" /> Saves: regenerated system prompt + hints from step order
                      </>
                    )}
                    {agentSubTab === "system-prompt" && (
                      <>
                        <Icon name="lightbulb" size="12" color="orange" /> Saves: your edited system prompt (hints regenerated from steps)
                      </>
                    )}
                    {agentSubTab === "pipeline-hints" && (
                      <>
                        <Icon name="lightbulb" size="12" color="orange" /> Saves: your edited hints (system prompt regenerated from steps)
                      </>
                    )}
                    {agentSubTab === "pipeline-constants" && (
                      <>
                        <Icon name="lightbulb" size="12" color="orange" /> Saves: constants only (prompt + hints unchanged)
                      </>
                    )}
                  </span>
                  {renderConfigFooterButtons({
                    onSave: handleSaveAgentConfig,
                    saveTitle:
                      agentSubTab === "pipeline-steps"
                        ? "Regenerate system prompt and hints from step order"
                        : agentSubTab === "system-prompt"
                          ? "Save system prompt (preserves your edits)"
                          : agentSubTab === "pipeline-hints"
                            ? "Save pipeline hints (preserves your edits)"
                            : "Save pipeline constants",
                    openRestore: () => setShowRestoreDefaultsConfirm(true),
                    restoreTitle: "Restore the original shipped agent configs (tools, pipeline, system prompt)",
                    restoreRunning: restoringDefaults,
                    restoreRunningLabel: "Restoring...",
                    restoreLabel: "Restore Defaults",
                  })}
                  {restartNeeded && (
                    <Tooltip content="Restart the agent runner service to apply the updated configuration">
                      <button className="config-restart-btn" onClick={handleRestartAgent} title="Restart the agent runner to apply new configuration">
                        <Icon name="restart_alt" size="14" /> Restart Agent Runner Now
                      </button>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Feedback log (scrollable, under the buttons) ── */}
        <div className="config-footer-feedback" ref={feedbackRef}>
          {exportResult && (
            <span
              className={`config-footer-result ${exportResult.startsWith("Exported") ? "config-footer-result--ok" : "config-footer-result--err"}`}>
              {exportResult}
            </span>
          )}
          {importResult && (
            <span className={`config-footer-result ${importResult.includes("imported") ? "config-footer-result--ok" : "config-footer-result--err"}`}>
              {importResult}
            </span>
          )}
          {clearResult && (
            <span className={`config-footer-result ${clearResult.includes("cleared") ? "config-footer-result--ok" : "config-footer-result--err"}`}>
              {clearResult}
            </span>
          )}
          {restoreUserDefaultsResult && (
            <span
              className={`config-footer-result ${restoreUserDefaultsResult.includes("restored") ? "config-footer-result--ok" : "config-footer-result--err"}`}>
              {restoreUserDefaultsResult}
            </span>
          )}
          {saveDefaultsResult && (
            <span
              className={`config-footer-result ${saveDefaultsResult.includes("Defaults updated") ? "config-footer-result--ok" : "config-footer-result--err"}`}>
              {saveDefaultsResult}
            </span>
          )}
          {error && <span className="config-footer-result config-footer-result--err">{error}</span>}
          {saved && !restartNeeded && <span className="config-footer-result config-footer-result--ok">✓ Configuration saved</span>}
          {saved && restartNeeded && (
            <span className="config-footer-result config-footer-result--ok">
              <Icon name="check" size="12" color="green" /> Saved — <Icon name="warning" size="12" color="orange" /> Restart agent runner to apply
              changes
            </span>
          )}
        </div>
      </div>

      {/* ── Clear Config confirmation dialog ── */}
      {showClearConfigConfirm && (
        <div className="confirm-overlay" onClick={() => setShowClearConfigConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> Clear Configuration
            </h3>
            <p className="confirm-dialog-text">
              This will remove ALL saved API keys, provider settings, and delivery credentials. Configuration will revert to defaults. The agent
              runner will be restarted. This cannot be undone.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowClearConfigConfirm(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleClearConfig} disabled={clearingConfig || activeJobs.length > 0}>
                {clearingConfig ? "Clearing..." : "Clear All"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Clear UI State confirmation dialog ── */}
      {showClearUiStateConfirm && (
        <div className="confirm-overlay" onClick={() => setShowClearUiStateConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="orange" /> Clear All UI State
            </h3>
            <p className="confirm-dialog-text">
              This resets every panel to its defaults — tabs, filters, selections, and the New-form draft. It does <strong>not</strong> affect your
              configuration, API keys, or saved jobs. This cannot be undone.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowClearUiStateConfirm(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleClearUiState} disabled={clearingUiState}>
                {clearingUiState ? "Clearing..." : "Clear UI State"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Restore User Defaults confirmation dialog ── */}
      {showRestoreUserDefaultsConfirm && (
        <div className="confirm-overlay" onClick={() => setShowRestoreUserDefaultsConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> Restore Defaults
            </h3>
            <p className="confirm-dialog-text">
              This will overwrite ALL saved API keys, provider settings, and delivery credentials with the factory defaults that were shipped with
              this install. The agent runner will be restarted. This cannot be undone.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowRestoreUserDefaultsConfirm(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleRestoreUserDefaults} disabled={restoringUserDefaults || activeJobs.length > 0}>
                {restoringUserDefaults ? "Restoring..." : "Restore Defaults"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Restore Agent Defaults confirmation dialog ── */}
      {showRestoreDefaultsConfirm && (
        <div className="confirm-overlay" onClick={() => setShowRestoreDefaultsConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> Restore Agent Defaults
            </h3>
            <p className="confirm-dialog-text">
              This will overwrite your current system prompt, pipeline steps, and tool definitions with the original shipped defaults. The agent
              runner will need a restart. This cannot be undone.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowRestoreDefaultsConfirm(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleRestoreDefaults} disabled={restoringDefaults || activeJobs.length > 0}>
                {restoringDefaults ? "Restoring..." : "Restore Defaults"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save Current as Defaults confirmation dialog ── */}
      {showSaveDefaultsConfirm && (
        <div className="confirm-overlay" onClick={() => setShowSaveDefaultsConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="save" size="16" color="accent" /> Save Current as Defaults
            </h3>
            <p className="confirm-dialog-text">
              This overwrites the shipped defaults with your <strong>current</strong> configuration — user config (API keys, provider, delivery, usage
              tracking) <strong>and</strong> agent instructions (tools, pipeline, system prompt). A later &quot;Restore Defaults&quot; will restore
              this saved state. This applies until the next app version update. This cannot be undone.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowSaveDefaultsConfirm(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleSaveDefaults} disabled={savingDefaults || activeJobs.length > 0}>
                {savingDefaults ? "Saving..." : "Save as Defaults"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Connect-button row used by the Teams/Zoom Services accordions ──
   Pending state shows a spinner + a Cancel button so a consent flow that's
   left open (or whose browser tab was closed) can be aborted immediately
   instead of hanging until the 10-minute OAuth timeout. */

function ProviderConnectRow({
  label,
  pending,
  disabled,
  onConnect,
  onCancel,
  feedback,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onConnect: () => void;
  onCancel: () => void;
  feedback: { type: "ok" | "err"; text: string } | null;
}) {
  return (
    <>
      <div className="gmail-connect-row">
        <button
          className="config-update-status-btn config-update-status-btn--accent"
          onClick={onConnect}
          disabled={disabled || pending}
          type="button">
          {pending ? (
            <>
              <span className="updates-spinner updates-spinner--small" /> Waiting for authorization…
            </>
          ) : (
            <>
              <Icon name="link" size="14" /> {label}
            </>
          )}
        </button>
        {pending && (
          <button className="config-update-status-btn" onClick={onCancel} title="Cancel authorization" type="button">
            <Icon name="close" size="14" /> Cancel
          </button>
        )}
      </div>
      {feedback && <div className={`gmail-connect-feedback gmail-connect-feedback--${feedback.type}`}>{feedback.text}</div>}
    </>
  );
}

/* ── Collapsible "How to get these credentials" block (Teams/Zoom Services) ── */

function CredentialSteps({ steps, portalUrl, portalLabel }: { steps: string[]; portalUrl: string; portalLabel: string }) {
  return (
    <details className="credential-steps">
      <summary className="credential-steps-summary">
        <Icon name="help" size="13" color="accent" /> How to get these credentials
      </summary>
      <ol className="credential-steps-list">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <button
        className="config-update-status-btn"
        onClick={() => window.electronAPI?.openExternal(portalUrl)}
        title={`Open ${portalLabel}`}
        type="button">
        <Icon name="open_in_new" size="12" /> {portalLabel}
      </button>
    </details>
  );
}

/* ── Compact update status card for the Auto-Update config section ── */

function UpdateStatusCard() {
  const [status, setStatus] = useState<any>(null);
  const [working, setWorking] = useState(false);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);

  const refresh = useCallback(async () => {
    const s = await window.electronAPI?.getUpdateStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCheck = useCallback(async () => {
    setWorking(true);
    await window.electronAPI?.checkForUpdates();
    const poll = setInterval(async () => {
      const s = await window.electronAPI?.getUpdateStatus();
      setStatus(s);
      if (!s?.checking) {
        clearInterval(poll);
        setWorking(false);
      }
    }, 1000);
  }, []);

  const handleDownload = useCallback(async () => {
    setWorking(true);
    await window.electronAPI?.downloadUpdate();
    const poll = setInterval(async () => {
      const s = await window.electronAPI?.getUpdateStatus();
      setStatus(s);
      if (s?.updateDownloaded || s?.error) {
        clearInterval(poll);
        setWorking(false);
      }
    }, 1000);
  }, []);

  const handleInstall = useCallback(async () => {
    await window.electronAPI?.installUpdate();
  }, []);

  if (!status) {
    return (
      <p className="config-field-hint" style={{ marginBottom: 12 }}>
        Loading update status…
      </p>
    );
  }

  const isUpToDate = !status.checking && !status.updateAvailable && !status.updateDownloaded && !status.error;
  const hasUpdate = status.updateAvailable && !status.updateDownloaded;
  const isDownloaded = status.updateDownloaded;

  const statusColor = status.error
    ? "var(--red)"
    : status.checking
      ? "var(--accent)"
      : isDownloaded
        ? "var(--green)"
        : hasUpdate
          ? "var(--orange)"
          : "var(--green)";
  const statusIcon = status.error ? "error" : status.checking ? "sync" : isDownloaded ? "check_circle" : hasUpdate ? "system_update" : "check_circle";
  const statusText = status.error
    ? "Check failed"
    : status.checking
      ? "Checking…"
      : isDownloaded
        ? "Ready to install"
        : hasUpdate
          ? `v${status.updateAvailable} available`
          : "Up to date";

  const versionLabel = status.mode === "packaged" ? `v${status.currentVersion}` : status.currentVersion;
  const isMac = /Mac/i.test(navigator.userAgent);

  return (
    <div className="config-update-status">
      <div className="config-update-status-row">
        <span className="config-update-status-icon" style={{ color: statusColor }}>
          <Icon name={statusIcon} size="14" />
        </span>
        <span className="config-update-status-text" style={{ color: statusColor }}>
          {statusText}
        </span>
        <span className="config-update-status-version">{versionLabel}</span>
      </div>

      {status.lastCheck && (
        <p className="config-field-hint" style={{ margin: "2px 0 0 22px", fontSize: 11 }}>
          Last checked: {new Date(status.lastCheck).toLocaleString()}
        </p>
      )}

      {status.downloadProgress !== null && (
        <div className="updates-progress-section" style={{ margin: "6px 0 6px 22px" }}>
          <div className="updates-progress-header">
            <span className="updates-progress-label" style={{ fontSize: 11 }}>
              Downloading…
            </span>
            <span className="updates-progress-pct" style={{ fontSize: 11 }}>
              {status.downloadProgress}%
            </span>
          </div>
          <div className="updates-progress-track">
            <div className="updates-progress-fill" style={{ width: `${status.downloadProgress}%` }} />
          </div>
        </div>
      )}

      <div className="config-update-status-actions">
        <button className="config-update-status-btn" onClick={handleCheck} disabled={working || status.checking} title="Check for updates now">
          {status.checking ? (
            <>
              <span className="updates-spinner updates-spinner--small" /> Checking
            </>
          ) : (
            <>
              <Icon name="search" size="12" /> Check
            </>
          )}
        </button>
        {status.mode === "packaged" && hasUpdate && (
          <button
            className="config-update-status-btn config-update-status-btn--accent"
            onClick={() => setShowDownloadConfirm(true)}
            disabled={working}
            title="Download the available update">
            {working ? (
              <>
                <span className="updates-spinner updates-spinner--small" /> DL
              </>
            ) : (
              <>
                <Icon name="download" size="12" /> Download
              </>
            )}
          </button>
        )}
        {isDownloaded && (
          <button className="config-update-status-btn config-update-status-btn--install" onClick={handleInstall} title="Install update and restart">
            <Icon name="restart_alt" size="12" /> Install
          </button>
        )}
        <span className="config-update-status-mode">
          {status.mode === "packaged" ? "Packaged" : "Dev"} · {status.enabled ? "Auto" : "Manual"}
        </span>
      </div>

      {/* macOS unsigned fallback — auto-update may fail to install; link the release. */}
      {status.error && isMac && (
        <div className="config-update-status-actions" style={{ marginTop: 8 }}>
          <button
            className="config-update-status-btn"
            onClick={() => window.electronAPI?.openExternal("https://github.com/afrogenesurvive/ai_transcription_agent/releases/latest")}
            title="Open the latest GitHub release to download manually">
            <Icon name="download" size="12" /> Download manually (macOS)
          </button>
        </div>
      )}

      {/* ── Download confirmation ── */}
      {showDownloadConfirm && (
        <div className="confirm-overlay" onClick={() => setShowDownloadConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="download" size="16" color="accent" /> Download Update
            </h3>
            <p className="confirm-dialog-text">
              Download version <strong>{status.updateAvailable}</strong> now? The new version downloads in the background; you can install it
              (Restart &amp; Install) once the download finishes.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowDownloadConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowDownloadConfirm(false);
                  handleDownload();
                }}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Download progress modal ── */}
      <LoadingModal
        visible={status.downloadProgress !== null}
        message="Downloading update…"
        progress={status.downloadProgress}
        onCancel={async () => {
          await window.electronAPI?.cancelUpdateDownload();
          refresh();
        }}
      />
    </div>
  );
}
