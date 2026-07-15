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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Icon from "./Icon";
import LoadingModal from "./LoadingModal";
import type { PipelineStep, ConfigValueSource } from "../types";

interface Props {
  onClose: () => void;
}

type ConfigTab = "config" | "agent" | "logging";

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
  TRELLO_KEY: string;
  TRELLO_TOKEN: string;
  HUGGING_FACE_TOKEN: string;
  GITHUB_TOKEN: string;
  WHISPER_MODEL_SIZE: string;
  KEEP_TRANSCRIPT_TIMESTAMPS: string;
  LOG_LLM_DATA: string;
  LOG_COLLAPSE_REPEATED_PREFIXES: string;
  DELIVERY_RECIPIENT_EMAILS: string;
  DELIVERY_EMAIL_SUBJECT: string;
  DELIVERY_EMAIL_ADDITIONAL_CONTENT: string;
  DELIVERY_DRIVE_FOLDER: string;
}

interface AgentConfig {
  tools?: any[];
  pipeline?: {
    max_pipeline_steps?: number;
    max_retries?: number;
    retry_base_delay_ms?: number;
    terminal_tools?: string[];
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
  { key: "HUGGING_FACE_TOKEN", label: "Hugging Face Token", required: false, secret: true, section: "LLM Provider" },
  { key: "GITHUB_TOKEN", label: "GitHub PAT (for private repo auto-updates)", required: false, secret: true, section: "Auto-Update" },
  { key: "WHISPER_MODEL_SIZE", label: "Whisper Model Size", required: false, secret: false, section: "LLM Provider" },
  { key: "KEEP_TRANSCRIPT_TIMESTAMPS", label: "Keep Transcript Timestamps", required: false, secret: false, section: "LLM Provider" },
  { key: "GMAIL_CLIENT_ID", label: "Gmail Client ID", required: false, secret: true, section: "Services" },
  { key: "GMAIL_CLIENT_SECRET", label: "Gmail Client Secret", required: false, secret: true, section: "Services" },
  { key: "GMAIL_REFRESH_TOKEN", label: "Gmail Refresh Token", required: false, secret: true, section: "Services" },
  { key: "GMAIL_USER", label: "Gmail User Email", required: false, secret: false, section: "Services" },
  { key: "TRELLO_KEY", label: "Trello API Key", required: false, secret: true, section: "Services" },
  { key: "TRELLO_TOKEN", label: "Trello Token", required: false, secret: true, section: "Services" },
  { key: "DELIVERY_RECIPIENT_EMAILS", label: "Default Recipient Emails", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_EMAIL_SUBJECT", label: "Email Subject Template", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_EMAIL_ADDITIONAL_CONTENT", label: "Additional Email Content", required: false, secret: false, section: "Delivery Config" },
  { key: "DELIVERY_DRIVE_FOLDER", label: "Drive Destination Folder", required: false, secret: false, section: "Delivery Config" },
];

const SOURCE_LABELS: Record<string, string> = {
  user_config: "User Config (config.json)",
  environment: "Environment (.env)",
  default: "Default value",
};

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

/**
 * Generate default pipeline steps from tools.json and pipeline hints.
 * Used when pipeline.json has no `pipeline_steps` array yet (migration).
 */

// ── Security helpers for agent instruction generation ──

/** Max lengths enforced at generation time (matches schema.json) */
const MAX_TEMPLATE_LENGTH = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_DESC_LENGTH = 200;

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

export default function ConfigPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("config");
  const [configSection, setConfigSection] = useState<string>("LLM Provider");
  const [values, setValues] = useState<ConfigValues>({} as ConfigValues);
  const [sourceInfo, setSourceInfo] = useState<Record<string, ConfigValueSource>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<keyof ConfigValues>>(new Set());
  // ── Email validation state ──
  const [emailValidationError, setEmailValidationError] = useState<string | null>(null);

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

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const result = await window.electronAPI?.exportConfig();
      if (result?.success) {
        setExportResult(`Exported to ${result.filePath}`);
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
        const agentMsg = result.agentConfigImported ? " (agent instructions included)" : "";
        setImportResult(`Configuration imported successfully${agentMsg}`);
        // Reload config values after import
        window.electronAPI?.getConfigWithSources().then((cfg) => {
          setValues({
            DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY?.value || "",
            LLM_PROVIDER: cfg.LLM_PROVIDER?.value || "deepseek",
            OLLAMA_BASE_URL: cfg.OLLAMA_BASE_URL?.value || "http://127.0.0.1:11434/v1",
            OLLAMA_MODEL: cfg.OLLAMA_MODEL?.value || "",
            OLLAMA_NUM_CTX: cfg.OLLAMA_NUM_CTX?.value || "32768",
            HUGGING_FACE_TOKEN: cfg.HUGGING_FACE_TOKEN?.value || "",
            GITHUB_TOKEN: cfg.GITHUB_TOKEN?.value || "",
            WHISPER_MODEL_SIZE: cfg.WHISPER_MODEL_SIZE?.value || "medium",
            KEEP_TRANSCRIPT_TIMESTAMPS: cfg.KEEP_TRANSCRIPT_TIMESTAMPS?.value || "false",
            GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID?.value || "",
            GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET?.value || "",
            GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN?.value || "",
            GMAIL_USER: cfg.GMAIL_USER?.value || "",
            TRELLO_KEY: cfg.TRELLO_KEY?.value || "",
            TRELLO_TOKEN: cfg.TRELLO_TOKEN?.value || "",
            LOG_LLM_DATA: cfg.LOG_LLM_DATA?.value || "false",
            LOG_COLLAPSE_REPEATED_PREFIXES: cfg.LOG_COLLAPSE_REPEATED_PREFIXES?.value || "true",
            DELIVERY_RECIPIENT_EMAILS: cfg.DELIVERY_RECIPIENT_EMAILS?.value || "",
            DELIVERY_EMAIL_SUBJECT: cfg.DELIVERY_EMAIL_SUBJECT?.value || "Meeting Summary: {title}",
            DELIVERY_EMAIL_ADDITIONAL_CONTENT: cfg.DELIVERY_EMAIL_ADDITIONAL_CONTENT?.value || "",
            DELIVERY_DRIVE_FOLDER: cfg.DELIVERY_DRIVE_FOLDER?.value || "Meeting Transcripts",
          });
          setSourceInfo(cfg);
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

  // ── Check active jobs on mount (blocks editing on ALL tabs while running) ──
  useEffect(() => {
    setActiveJobsLoading(true);
    window.electronAPI
      ?.getActiveJobs()
      .then((jobs) => {
        setActiveJobs(jobs || []);
        setActiveJobsLoading(false);
      })
      .catch(() => {
        setActiveJobs([]);
        setActiveJobsLoading(false);
      });
  }, []);

  // ── Load config on open ──
  useEffect(() => {
    setSaved(false);
    setError(null);
    setRestartNeeded(false);
    // Use getConfigWithSources so .env values appear as fallback when not in config.json
    window.electronAPI?.getConfigWithSources().then((cfg) => {
      setValues({
        DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY?.value || "",
        LLM_PROVIDER: cfg.LLM_PROVIDER?.value || "deepseek",
        OLLAMA_BASE_URL: cfg.OLLAMA_BASE_URL?.value || "http://127.0.0.1:11434/v1",
        OLLAMA_MODEL: cfg.OLLAMA_MODEL?.value || "",
        OLLAMA_NUM_CTX: cfg.OLLAMA_NUM_CTX?.value || "32768",
        HUGGING_FACE_TOKEN: cfg.HUGGING_FACE_TOKEN?.value || "",
        GITHUB_TOKEN: cfg.GITHUB_TOKEN?.value || "",
        WHISPER_MODEL_SIZE: cfg.WHISPER_MODEL_SIZE?.value || "medium",
        KEEP_TRANSCRIPT_TIMESTAMPS: cfg.KEEP_TRANSCRIPT_TIMESTAMPS?.value || "false",
        GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID?.value || "",
        GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET?.value || "",
        GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN?.value || "",
        GMAIL_USER: cfg.GMAIL_USER?.value || "",
        TRELLO_KEY: cfg.TRELLO_KEY?.value || "",
        TRELLO_TOKEN: cfg.TRELLO_TOKEN?.value || "",
        LOG_LLM_DATA: cfg.LOG_LLM_DATA?.value || "false",
        LOG_COLLAPSE_REPEATED_PREFIXES: cfg.LOG_COLLAPSE_REPEATED_PREFIXES?.value || "true",
        DELIVERY_RECIPIENT_EMAILS: cfg.DELIVERY_RECIPIENT_EMAILS?.value || "",
        DELIVERY_EMAIL_SUBJECT: cfg.DELIVERY_EMAIL_SUBJECT?.value || "Meeting Summary: {title}",
        DELIVERY_EMAIL_ADDITIONAL_CONTENT: cfg.DELIVERY_EMAIL_ADDITIONAL_CONTENT?.value || "",
        DELIVERY_DRIVE_FOLDER: cfg.DELIVERY_DRIVE_FOLDER?.value || "Meeting Transcripts",
      });
      setSourceInfo(cfg);
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

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI?.saveConfig(values);
      setSaved(true);
      setTimeout(() => onClose(), 1200);
    } catch {
      setError("Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [values, onClose]);

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

    // Skip _fetch_memory_context — it's a pre-processing step, not an LLM tool
    const hintSteps = enabledSteps.filter((s) => s.toolName !== "_fetch_memory_context");

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
  const [agentSubTab, setAgentSubTab] = useState<AgentSubTab>("pipeline-steps");

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
    // Reset the edit buffers to the auto-generated versions from the checklist
    setEditSystemPrompt(generatedPromptPreview);
    setEditPipelineHints(generatedHintsPreview);
    setSaved(false);
    setRestartNeeded(false);
  }, [generatedPromptPreview, generatedHintsPreview]);

  const handleRestartAgent = useCallback(async () => {
    await window.electronAPI?.restartAgent();
    onClose();
  }, [onClose]);

  const handleRestoreDefaults = useCallback(async () => {
    if (
      !window.confirm(
        "Restore default agent configs?\n\nThis will overwrite your current system prompt, pipeline steps, and tool definitions with the original shipped defaults. The agent runner will need a restart.\n\nThis cannot be undone.",
      )
    ) {
      return;
    }
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
          <button
            className="config-io-btn"
            onClick={handleExport}
            disabled={exporting}
            title="Export configuration to a JSON file"
            data-tooltip="Save current configuration to a JSON file for backup or transfer">
            {exporting ? <Icon name="sync" size="14" /> : <Icon name="upload" size="14" />} Export
          </button>
          <button
            className="config-io-btn"
            onClick={handleImport}
            disabled={importing}
            title="Import configuration from a JSON file"
            data-tooltip="Load configuration from a previously exported JSON file">
            {importing ? <Icon name="sync" size="14" /> : <Icon name="download" size="14" />} Import
          </button>
        </div>
        <button className="config-close-btn" onClick={onClose} title="Close configuration panel" data-tooltip="Close the configuration panel">
          <Icon name="close" size="16" />
        </button>
      </div>

      {/* Tab bar (full width, styled like dev-panel-tabs) */}
      <div className="config-tab-bar">
        <button
          className={`config-tab ${activeTab === "config" ? "config-tab--active" : ""}`}
          onClick={() => setActiveTab("config")}
          title="Configure LLM provider, API keys, and delivery services"
          data-tooltip="Configure LLM provider, API keys, and delivery services">
          <Icon name="vpn_key" size="14" /> LLM &amp; Delivery
        </button>
        <button
          className={`config-tab ${activeTab === "agent" ? "config-tab--active" : ""}`}
          onClick={() => setActiveTab("agent")}
          title="Edit agent system prompt, tool definitions, and pipeline hints"
          data-tooltip="Edit agent system prompt, tool definitions, and pipeline hints">
          <Icon name="smart_toy" size="14" /> Agent Instructions
        </button>
        <button
          className={`config-tab ${activeTab === "logging" ? "config-tab--active" : ""}`}
          onClick={() => setActiveTab("logging")}
          title="Configure log sources, levels, file size, and rotation"
          data-tooltip="Configure log sources, levels, file size, and rotation">
          <Icon name="edit_note" size="14" /> Logging
        </button>
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
                <button
                  key={name}
                  className={`config-section-tab ${configSection === name ? "config-section-tab--active" : ""}`}
                  onClick={() => setConfigSection(name)}
                  title={`Switch to ${name} settings`}
                  data-tooltip={`Switch to ${name} settings section`}>
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
                  {name}
                </button>
              ))}
            </div>

            <p className="config-hint">
              Enter your API keys and credentials. Required fields are marked with <span className="config-required">*</span>. Values are stored in
              your user data directory{activeJobs.length > 0 ? <strong>. Editing disabled while {activeJobs.length} job(s) running</strong> : ""}.
            </p>

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
                                <button
                                  className="config-visibility-toggle"
                                  onClick={() => toggleVisible(field.key)}
                                  title={visibleKeys.has(field.key) ? "Hide the secret value" : "Reveal the secret value"}
                                  type="button"
                                  tabIndex={-1}
                                  data-tooltip={
                                    visibleKeys.has(field.key) ? "Click to mask the secret value" : "Click to temporarily reveal the secret value"
                                  }>
                                  {visibleKeys.has(field.key) ? <Icon name="visibility" size="14" /> : <Icon name="visibility_off" size="14" />}
                                </button>
                              </div>
                            </div>
                          ))}

                      {values.LLM_PROVIDER === "ollama" &&
                        fields
                          .filter(
                            (f) =>
                              f.key !== "DEEPSEEK_API_KEY" &&
                              f.key !== "OLLAMA_MODEL" &&
                              f.key !== "OLLAMA_NUM_CTX" &&
                              f.key !== "WHISPER_MODEL_SIZE" &&
                              f.key !== "KEEP_TRANSCRIPT_TIMESTAMPS" &&
                              f.key !== "WHISPER_INITIAL_PROMPT_ENABLED" &&
                              f.key !== "WHISPER_INITIAL_PROMPT",
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
                              ["DELIVERY_RECIPIENT_EMAILS", "DELIVERY_EMAIL_SUBJECT", "DELIVERY_EMAIL_ADDITIONAL_CONTENT"].includes(f.key as string),
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
                  ) : sectionName !== "LLM Provider" ? (
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
      </div>

      {/* ── Saving overlay ── */}
      <LoadingModal visible={saving} message="Saving configuration…" />

      <div className="config-footer">
        {exportResult && <span className="config-success">{exportResult}</span>}
        {importResult && <span className="config-success">{importResult}</span>}
        {error && <span className="config-error">{error}</span>}
        {saved && !restartNeeded && <span className="config-success">✓ Configuration saved</span>}
        {saved && restartNeeded && (
          <span className="config-warning">
            <Icon name="check" size="12" color="green" /> Saved — <Icon name="warning" size="12" color="orange" /> Restart agent runner to apply
            changes
          </span>
        )}

        {activeTab === "config" && (
          <>
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for
                completion.
              </span>
            ) : (
              <button
                className="config-save-btn"
                onClick={handleSave}
                disabled={saving || saved}
                title="Save all configuration values to disk"
                data-tooltip="Save all API keys, provider settings, and delivery config to disk">
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
              </button>
            )}
          </>
        )}

        {activeTab === "logging" && (
          <>
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for
                completion.
              </span>
            ) : (
              <button
                className="config-save-btn"
                onClick={handleSave}
                disabled={saving || saved}
                title="Save logging configuration"
                data-tooltip="Save log source filters, levels, and rotation settings">
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
              </button>
            )}
          </>
        )}

        {activeTab === "agent" && (
          <div className="config-footer-actions">
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                <Icon name="block" color="red" size="14" /> Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for
                completion.
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
                <button
                  className="config-save-btn"
                  onClick={handleSaveAgentConfig}
                  disabled={saving || saved}
                  title={
                    agentSubTab === "pipeline-steps"
                      ? "Regenerate system prompt and hints from step order"
                      : agentSubTab === "system-prompt"
                        ? "Save system prompt (preserves your edits)"
                        : agentSubTab === "pipeline-hints"
                          ? "Save pipeline hints (preserves your edits)"
                          : "Save pipeline constants"
                  }>
                  {saving ? "Saving..." : saved && !restartNeeded ? "Saved" : "Save"}
                </button>
                <button
                  className="config-restore-btn"
                  onClick={handleRestoreDefaults}
                  disabled={saving || restoringDefaults || activeJobs.length > 0}
                  title="Restore the original shipped agent configs (tools, pipeline, system prompt)"
                  data-tooltip="Reset agent configuration to factory defaults — tools, pipeline steps, and system prompt">
                  {restoringDefaults ? (
                    <span>
                      <Icon name="sync" size="14" /> Restoring...
                    </span>
                  ) : (
                    <span>
                      <Icon name="restore" size="14" /> Restore Defaults
                    </span>
                  )}
                </button>
                {restartNeeded && (
                  <button
                    className="config-restart-btn"
                    onClick={handleRestartAgent}
                    title="Restart the agent runner to apply new configuration"
                    data-tooltip="Restart the agent runner service to apply the updated configuration">
                    <Icon name="restart_alt" size="14" /> Restart Agent Runner Now
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Compact update status card for the Auto-Update config section ── */

function UpdateStatusCard() {
  const [status, setStatus] = useState<any>(null);
  const [working, setWorking] = useState(false);

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
            onClick={handleDownload}
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
    </div>
  );
}
