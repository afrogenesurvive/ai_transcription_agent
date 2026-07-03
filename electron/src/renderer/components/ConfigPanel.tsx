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

import React, { useState, useEffect, useCallback } from "react";

interface Props {
  onClose: () => void;
}

type ConfigMode = "edit" | "view";
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
  LOG_ENABLED_SOURCES: string;
  LOG_LEVEL: string;
  LOG_MAX_FILE_SIZE_MB: string;
  LOG_MAX_FILES: string;
  LOG_LLM_DATA: string;
}

interface ConfigSourceInfo {
  value: string;
  source: "user_config" | "env_file" | "default";
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
  { key: "GMAIL_CLIENT_ID", label: "Gmail Client ID", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_CLIENT_SECRET", label: "Gmail Client Secret", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_REFRESH_TOKEN", label: "Gmail Refresh Token", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_USER", label: "Gmail User Email", required: false, secret: false, section: "Email Delivery" },
  { key: "TRELLO_KEY", label: "Trello API Key", required: false, secret: true, section: "Trello Delivery" },
  { key: "TRELLO_TOKEN", label: "Trello Token", required: false, secret: true, section: "Trello Delivery" },
];

const SOURCE_LABELS: Record<string, string> = {
  user_config: "User Config (config.json)",
  env_file: ".env file",
  default: "Default value",
};

const SOURCE_COLORS: Record<string, string> = {
  user_config: "var(--green)",
  env_file: "var(--accent)",
  default: "var(--text-muted)",
};

function formatOllamaSize(bytes: number): string {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function ConfigPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("config");
  const [mode, setMode] = useState<ConfigMode>("edit");
  const [values, setValues] = useState<ConfigValues>({} as ConfigValues);
  const [sourceInfo, setSourceInfo] = useState<Record<string, ConfigSourceInfo>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const toggleVisible = (key: keyof ConfigValues) => {
    const k = key as string;
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
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
          setPullSuccess(`✅ Model "${modelName}" pulled successfully`);
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
  const [editMaxSteps, setEditMaxSteps] = useState(15);
  const [editMaxRetries, setEditMaxRetries] = useState(3);
  const [editRetryDelay, setEditRetryDelay] = useState(2000);
  const [editTerminalTools, setEditTerminalTools] = useState("");
  const [restartNeeded, setRestartNeeded] = useState(false);

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
    setMode("edit");
    setSaved(false);
    setError(null);
    setRestartNeeded(false);
    window.electronAPI?.getConfig().then((cfg) => {
      setValues({
        DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY || "",
        LLM_PROVIDER: cfg.LLM_PROVIDER || "deepseek",
        OLLAMA_BASE_URL: cfg.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        OLLAMA_MODEL: cfg.OLLAMA_MODEL || "",
        OLLAMA_NUM_CTX: cfg.OLLAMA_NUM_CTX || "32768",
        HUGGING_FACE_TOKEN: cfg.HUGGING_FACE_TOKEN || "",
        GITHUB_TOKEN: cfg.GITHUB_TOKEN || "",
        WHISPER_MODEL_SIZE: cfg.WHISPER_MODEL_SIZE || "medium",
        KEEP_TRANSCRIPT_TIMESTAMPS: cfg.KEEP_TRANSCRIPT_TIMESTAMPS || "false",
        GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID || "",
        GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET || "",
        GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN || "",
        GMAIL_USER: cfg.GMAIL_USER || "",
        TRELLO_KEY: cfg.TRELLO_KEY || "",
        TRELLO_TOKEN: cfg.TRELLO_TOKEN || "",
        LOG_ENABLED_SOURCES: cfg.LOG_ENABLED_SOURCES || "all",
        LOG_LEVEL: cfg.LOG_LEVEL || "info",
        LOG_MAX_FILE_SIZE_MB: cfg.LOG_MAX_FILE_SIZE_MB || "50",
        LOG_MAX_FILES: cfg.LOG_MAX_FILES || "10",
        LOG_LLM_DATA: cfg.LOG_LLM_DATA || "false",
      });
    });
    window.electronAPI
      ?.getConfigWithSources()
      .then(setSourceInfo)
      .catch(() => {});
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
        setEditMaxSteps(cfg.pipeline?.max_pipeline_steps ?? 15);
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

  const handleSaveAgentConfig = useCallback(async () => {
    if (!agentConfig) return;
    setSaving(true);
    setError(null);
    try {
      const pipeline = {
        ...agentConfig.pipeline,
        max_pipeline_steps: editMaxSteps,
        max_retries: editMaxRetries,
        retry_base_delay_ms: editRetryDelay,
        terminal_tools: editTerminalTools
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        pipeline_hints: editPipelineHints,
      };
      const payload = {
        systemPrompt: editSystemPrompt,
        pipeline,
      };
      const result = await window.electronAPI?.saveAgentConfig(payload);
      if (result?.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setRestartNeeded(true);
      }
    } catch (err: any) {
      setError(err.message || "Failed to save agent config");
    } finally {
      setSaving(false);
    }
  }, [agentConfig, editSystemPrompt, editPipelineHints, editMaxSteps, editMaxRetries, editRetryDelay, editTerminalTools]);

  const handleRestartAgent = useCallback(async () => {
    await window.electronAPI?.restartAgent();
    onClose();
  }, [onClose]);

  const handleRefreshSources = useCallback(async () => {
    const info = (await window.electronAPI?.getConfigWithSources()) || {};
    setSourceInfo(info);
  }, []);

  // Group fields by section
  const sections = new Map<string, typeof FIELDS>();
  for (const field of FIELDS) {
    if (!sections.has(field.section)) sections.set(field.section, []);
    sections.get(field.section)!.push(field);
  }

  return (
    <div className="config-panel config-panel--full">
      <div className="config-header">
        <h2>⚙️ Configuration</h2>
        <div className="config-header-actions">
          {/* Tab bar */}
          <div className="config-tab-bar">
            <button className={`config-tab ${activeTab === "config" ? "config-tab--active" : ""}`} onClick={() => setActiveTab("config")}>
              🔑 LLM & Delivery
            </button>
            <button className={`config-tab ${activeTab === "agent" ? "config-tab--active" : ""}`} onClick={() => setActiveTab("agent")}>
              🤖 Agent Instructions
            </button>
            <button className={`config-tab ${activeTab === "logging" ? "config-tab--active" : ""}`} onClick={() => setActiveTab("logging")}>
              📝 Logging
            </button>
          </div>
          <div className="config-mode-toggle">
            <button className={`config-mode-btn ${mode === "edit" ? "config-mode-btn--active" : ""}`} onClick={() => setMode("edit")}>
              ✏️ Edit
            </button>
            <button
              className={`config-mode-btn ${mode === "view" ? "config-mode-btn--active" : ""}`}
              onClick={() => {
                setMode("view");
                handleRefreshSources();
              }}>
              👁️ View Current
            </button>
          </div>
          <button className="config-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="config-body">
        {/* ── Active jobs guard (all tabs) ── */}
        {activeJobs.length > 0 && (
          <div className="config-blocked-banner" style={{ marginBottom: 12 }}>
            <strong>⛔ Editing blocked</strong> — {activeJobs.length} pipeline job{activeJobs.length > 1 ? "s" : ""} currently running:
            <ul className="config-blocked-list">
              {activeJobs.map((j: any) => (
                <li key={j.job_id}>
                  &ldquo;{j.title}&rdquo; — {j.status} ({(j.progress * 100).toFixed(0)}%)
                </li>
              ))}
            </ul>
            <p>
              Configuration cannot be modified while jobs are in progress. Switch to <strong>👁️ View Current</strong> mode to review, or wait for jobs
              to complete.
            </p>
          </div>
        )}

        {/* ── TAB 1: LLM & Delivery Config ── */}
        {activeTab === "config" && mode === "edit" && (
          <>
            <p className="config-hint">
              Enter your API keys and credentials. Required fields are marked with <span className="config-required">*</span>. Values are stored in
              your user data directory{activeJobs.length > 0 ? <strong>. Editing disabled while {activeJobs.length} job(s) running</strong> : ""}.
            </p>

            {Array.from(sections.entries()).map(([sectionName, fields]) => (
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
                              ⟳ Checking…
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
                            <input
                              className="config-input"
                              type="password"
                              value={values[field.key] || ""}
                              onChange={(e) => handleChange(field.key, e.target.value)}
                              placeholder="sk-..."
                              disabled={activeJobs.length > 0}
                            />
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
                            f.key !== "KEEP_TRANSCRIPT_TIMESTAMPS",
                        )
                        .map((field) => (
                          <div key={field.key} className="config-field">
                            <label className="config-label">{field.label}</label>
                            <input
                              className="config-input"
                              type="text"
                              value={values[field.key] || ""}
                              onChange={(e) => handleChange(field.key, e.target.value)}
                              placeholder="Optional"
                              disabled={activeJobs.length > 0}
                            />
                          </div>
                        ))}

                    {/* ── Ollama Model + Context Window (only when provider is ollama) ── */}
                    {values.LLM_PROVIDER === "ollama" && (
                      <div className="config-section">
                        <h3 className="config-section-title">🧠 Model & Context Window</h3>

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
                        <h3 className="config-section-title">🤖 Ollama Models</h3>

                        {/* Server status line */}
                        <div className="config-ollama-status config-ollama-status--section">
                          {ollamaHealthChecking && ollamaHealthy === null ? (
                            <span className="config-ollama-status-indicator config-ollama-status--checking">⟳ Checking server…</span>
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
                            ⚠️ {ollamaModelsError}
                            <button className="config-ollama-retry-btn" onClick={fetchOllamaModels} disabled={ollamaModelsLoading}>
                              ⟳ Retry
                            </button>
                          </div>
                        )}

                        {/* No models — show pull options */}
                        {!ollamaModelsLoading && !ollamaModelsError && ollamaModels.length === 0 && (
                          <div className="config-ollama-warning">
                            <strong>🚫 No models available</strong>
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
                              {pullingModel === "deepseek-v2"
                                ? "⟳ Pulling…"
                                : ollamaModels.some((m) => m.name === "deepseek-v2" || m.name === "deepseek-v2:latest")
                                  ? "✅ deepseek-v2 pulled"
                                  : "📥 Pull deepseek-v2"}
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
                              {pullingModel === "qwen3.6:27b"
                                ? "⟳ Pulling…"
                                : ollamaModels.some((m) => m.name === "qwen3.6:27b" || m.name === "qwen3.6:27b:latest")
                                  ? "✅ qwen3.6:27b pulled"
                                  : "📥 Pull qwen3.6:27b"}
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
                        When enabled, start/end times are preserved in the refined transcript. When disabled (default), timestamps are stripped during
                        refinement.
                      </p>
                    </div>
                  </>
                )}

                {sectionName !== "LLM Provider" &&
                  fields.map((field) => (
                    <div key={field.key} className="config-field">
                      <label className="config-label">
                        {field.label}
                        {field.required && <span className="config-required"> *</span>}
                      </label>
                      {field.secret ? (
                        <input
                          className="config-input"
                          type="password"
                          value={values[field.key] || ""}
                          onChange={(e) => handleChange(field.key, e.target.value)}
                          placeholder={field.required ? "Enter your API key..." : "Optional"}
                          disabled={activeJobs.length > 0}
                        />
                      ) : (
                        <input
                          className="config-input"
                          type="text"
                          value={values[field.key] || ""}
                          onChange={(e) => handleChange(field.key, e.target.value)}
                          placeholder={field.required ? "Required" : "Optional"}
                          disabled={activeJobs.length > 0}
                        />
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </>
        )}

        {activeTab === "config" && mode === "view" && (
          <>
            <p className="config-hint">
              Current configuration values and their sources. Priority: <strong>User Config</strong> &gt; <strong>.env file</strong> &gt;{" "}
              <strong>Defaults</strong>.
              <button className="config-refresh-btn" onClick={handleRefreshSources} title="Refresh config values">
                ↻ Refresh
              </button>
            </p>

            <div className="config-source-legend">
              <span className="config-source-tag config-source-tag--user_config">User Config</span>
              <span className="config-source-tag config-source-tag--env_file">.env File</span>
              <span className="config-source-tag config-source-tag--default">Default</span>
            </div>

            {/* ── LLM provider misconfiguration warning ── */}
            {(() => {
              const info = sourceInfo;
              const provider = info.LLM_PROVIDER?.value || "deepseek";
              const apiKey = info.DEEPSEEK_API_KEY?.value || "";
              const ollamaModel = info.OLLAMA_MODEL?.value || "";
              const providerMissing = (provider === "deepseek" && !apiKey) || (provider === "ollama" && !ollamaModel);
              if (!providerMissing) return null;
              const message =
                provider === "deepseek"
                  ? "DeepSeek API key is not set — the agent runner will fail to process jobs."
                  : "No Ollama model is configured — the agent runner will fail to process jobs.";
              return (
                <div className="config-llm-warning">
                  <strong>⚠️ LLM Provider Misconfigured</strong>
                  <p>{message}</p>
                </div>
              );
            })()}

            {Array.from(sections.entries()).map(([sectionName, fields]) => (
              <div key={sectionName} className="config-section">
                <h3 className="config-section-title">{sectionName}</h3>
                {fields.map((field) => {
                  const info = sourceInfo[field.key];
                  const isSecret = field.secret && info?.value ? true : false;
                  const fieldKey = field.key as string;
                  const isVisible = visibleKeys.has(fieldKey);
                  const displayValue = isSecret && !isVisible ? info.value.slice(0, 8) + "…" + info.value.slice(-4) : info.value || "(not set)";
                  return (
                    <div key={field.key} className="config-view-field">
                      <div className="config-view-label">
                        <span>{field.label}</span>
                        {info && <span className={`config-source-tag config-source-tag--${info.source}`}>{SOURCE_LABELS[info.source]}</span>}
                      </div>
                      <div className="config-view-value-row">
                        <span className="config-view-value">{displayValue}</span>
                        {isSecret && (
                          <button
                            className="config-visibility-toggle"
                            onClick={() => toggleVisible(fieldKey)}
                            title={isVisible ? "Hide value" : "Show value"}>
                            {isVisible ? "🙈" : "👁️"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {/* ── TAB 2: Agent Instructions ── */}
        {activeTab === "agent" && agentConfigLoading && <div className="config-loading">Loading agent configuration…</div>}

        {activeTab === "agent" && agentConfigError && (
          <div className="config-error-banner">
            ⚠️ Could not load agent config from bridge server: {agentConfigError}
            <p className="config-hint">Make sure the bridge server (:5010) is running.</p>
          </div>
        )}

        {activeTab === "agent" && !agentConfigLoading && !agentConfigError && agentConfig && mode === "edit" && (
          <>
            {activeJobsLoading && <p className="config-hint">Checking for active jobs…</p>}

            <p className="config-hint">
              Edit the instructions that control the transcription agent's behavior. Changes take effect after restarting the agent runner.
            </p>

            {/* System Prompt */}
            <div className="config-section">
              <h3 className="config-section-title">📝 System Prompt</h3>
              <p className="config-field-hint">
                The main instruction template sent to the LLM. Use <code>{`{{TOOL_LIST}}`}</code> as a placeholder where tool descriptions are
                injected.
              </p>
              <textarea
                className="config-textarea config-textarea--large"
                value={editSystemPrompt}
                onChange={(e) => {
                  setEditSystemPrompt(e.target.value);
                  setSaved(false);
                  setRestartNeeded(false);
                }}
                rows={14}
                placeholder="You are an AI meeting transcription assistant..."
                disabled={activeJobs.length > 0}
              />
            </div>

            {/* Pipeline Hints */}
            <div className="config-section">
              <h3 className="config-section-title">🧭 Pipeline Hints</h3>
              <p className="config-field-hint">Hint text appended to the LLM context after each tool step. Key = tool name, value = hint text.</p>
              {Object.keys(editPipelineHints).length === 0 && <p className="config-empty">No pipeline hints loaded.</p>}
              {Object.entries(editPipelineHints).map(([key, val]) => (
                <div key={key} className="config-field">
                  <label className="config-label config-label--mono">{key}</label>
                  <input
                    className="config-input"
                    type="text"
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

            {/* Pipeline Constants */}
            <div className="config-section">
              <h3 className="config-section-title">⚙️ Pipeline Constants</h3>
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
          </>
        )}

        {/* ── TAB 3: Logging Config ── */}
        {activeTab === "logging" && mode === "edit" && (
          <>
            <p className="config-hint">
              Control which log sources and severity levels are written to disk log files. The in-memory log buffer (visible in the DevPanel) is never
              affected — these settings only control disk space usage.
            </p>

            {/* Log Sources */}
            <div className="config-section">
              <h3 className="config-section-title">📡 Log Sources (disk writes)</h3>
              <p className="config-field-hint">
                Uncheck sources you don&apos;t want to write to log files. Reducing high-volume sources like python or bridge saves the most disk
                space.
              </p>
              {["python", "bridge", "agent", "main"].map((source) => {
                const enabledList =
                  values.LOG_ENABLED_SOURCES === "all"
                    ? ["python", "bridge", "agent", "main"]
                    : values.LOG_ENABLED_SOURCES.split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                const isChecked = enabledList.includes(source);
                const sourceLabels: Record<string, string> = {
                  python: "Python Backend (API calls, transcription progress)",
                  bridge: "Bridge Server (tool dispatch, proxy requests)",
                  agent: "Agent Runner (pipeline steps, LLM calls)",
                  main: "Electron Main Process (config saves, service mgmt)",
                };
                return (
                  <div key={source} className="config-field">
                    <label className="config-toggle">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={activeJobs.length > 0}
                        onChange={() => {
                          const current =
                            values.LOG_ENABLED_SOURCES === "all"
                              ? ["python", "bridge", "agent", "main"]
                              : values.LOG_ENABLED_SOURCES.split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                          const updated = isChecked ? current.filter((s) => s !== source) : [...current, source];
                          handleChange("LOG_ENABLED_SOURCES", updated.join(",") || "none");
                        }}
                      />
                      <span className="config-toggle-slider" />
                      <span className="config-toggle-label">
                        <strong>{source}</strong> — {sourceLabels[source]}
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>

            {/* LLM Data Logging */}
            <div className="config-section">
              <h3 className="config-section-title">🧠 LLM Data Logging</h3>
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

            {/* Log Level */}
            <div className="config-section">
              <h3 className="config-section-title">🔉 Minimum Log Level</h3>
              <p className="config-field-hint">
                Only log entries at or above this severity will be written to disk. &quot;off&quot; disables all disk logging.
              </p>
              <select
                className="config-select"
                value={values.LOG_LEVEL || "info"}
                onChange={(e) => handleChange("LOG_LEVEL", e.target.value)}
                disabled={activeJobs.length > 0}>
                <option value="debug">debug — everything (most verbose)</option>
                <option value="info">info — info + warnings + errors (recommended)</option>
                <option value="warn">warn — warnings + errors only</option>
                <option value="error">error — errors only</option>
                <option value="off">off — disable all disk logging</option>
              </select>
            </div>

            {/* File Rotation */}
            <div className="config-section">
              <h3 className="config-section-title">📦 File Rotation</h3>
              <div className="config-field-row">
                <div className="config-field config-field--compact">
                  <label className="config-label">Max File Size (MB)</label>
                  <input
                    className="config-input config-input--number"
                    type="number"
                    min={0}
                    max={1000}
                    value={parseInt(values.LOG_MAX_FILE_SIZE_MB) || 0}
                    onChange={(e) => handleChange("LOG_MAX_FILE_SIZE_MB", String(e.target.value))}
                    disabled={activeJobs.length > 0}
                  />
                  <p className="config-field-hint">0 = no size limit</p>
                </div>
                <div className="config-field config-field--compact">
                  <label className="config-label">Max Rotated Files</label>
                  <input
                    className="config-input config-input--number"
                    type="number"
                    min={0}
                    max={100}
                    value={parseInt(values.LOG_MAX_FILES) || 0}
                    onChange={(e) => handleChange("LOG_MAX_FILES", String(e.target.value))}
                    disabled={activeJobs.length > 0}
                  />
                  <p className="config-field-hint">0 = keep all rotations</p>
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "logging" && mode === "view" && (
          <>
            <p className="config-hint">
              Current logging configuration. The in-memory log buffer (DevPanel) is never affected — only disk writes are controlled here.
            </p>
            <div className="config-section">
              <h3 className="config-section-title">📡 Enabled Sources</h3>
              <div className="config-view-field">
                <div className="config-view-value">{sourceInfo.LOG_ENABLED_SOURCES?.value || "all"}</div>
              </div>
            </div>
            <div className="config-section">
              <h3 className="config-section-title">🔉 Minimum Level</h3>
              <div className="config-view-field">
                <div className="config-view-value">{sourceInfo.LOG_LEVEL?.value || "info"}</div>
              </div>
            </div>
            <div className="config-section">
              <h3 className="config-section-title">🧠 LLM Data Logging</h3>
              <div className="config-view-field">
                <div className="config-view-value">{sourceInfo.LOG_LLM_DATA?.value === "true" ? "Enabled" : "Disabled"}</div>
              </div>
            </div>
            <div className="config-section">
              <h3 className="config-section-title">📦 Rotation</h3>
              <div className="config-view-field">
                <div className="config-view-label">Max File Size</div>
                <div className="config-view-value">{sourceInfo.LOG_MAX_FILE_SIZE_MB?.value || "50"} MB</div>
              </div>
              <div className="config-view-field">
                <div className="config-view-label">Max Rotated Files</div>
                <div className="config-view-value">{sourceInfo.LOG_MAX_FILES?.value || "10"}</div>
              </div>
            </div>
          </>
        )}

        {activeTab === "agent" && !agentConfigLoading && !agentConfigError && agentConfig && mode === "view" && (
          <>
            <p className="config-hint">Current agent instructions — read-only. Switch to ✏️ Edit mode to make changes.</p>

            <div className="config-section">
              <h3 className="config-section-title">📝 System Prompt</h3>
              <pre className="config-pre">
                {(agentConfig.systemPrompt || "(not set)").slice(0, 2000)}
                {(agentConfig.systemPrompt || "").length > 2000 ? "…" : ""}
              </pre>
            </div>

            <div className="config-section">
              <h3 className="config-section-title">🧭 Pipeline Hints ({Object.keys(agentConfig.pipeline?.pipeline_hints || {}).length})</h3>
              {Object.entries(agentConfig.pipeline?.pipeline_hints || {}).map(([key, val]) => (
                <div key={key} className="config-view-field">
                  <div className="config-view-label">
                    <span className="config-label--mono">{key}</span>
                  </div>
                  <div className="config-view-value">{val as string}</div>
                </div>
              ))}
            </div>

            <div className="config-section">
              <h3 className="config-section-title">⚙️ Constants</h3>
              <div className="config-view-field">
                <div className="config-view-label">Max Steps</div>
                <div className="config-view-value">{agentConfig.pipeline?.max_pipeline_steps ?? 15}</div>
              </div>
              <div className="config-view-field">
                <div className="config-view-label">Max Retries</div>
                <div className="config-view-value">{agentConfig.pipeline?.max_retries ?? 3}</div>
              </div>
              <div className="config-view-field">
                <div className="config-view-label">Retry Delay</div>
                <div className="config-view-value">{agentConfig.pipeline?.retry_base_delay_ms ?? 2000} ms</div>
              </div>
              <div className="config-view-field">
                <div className="config-view-label">Terminal Tools</div>
                <div className="config-view-value">{(agentConfig.pipeline?.terminal_tools || []).join(", ") || "(none)"}</div>
              </div>
            </div>

            <div className="config-section">
              <h3 className="config-section-title">🔧 Tool Definitions ({agentConfig.tools?.length || 0})</h3>
              {agentConfig.tools?.map((tool) => (
                <details key={tool.name} className="config-details">
                  <summary className="config-details-summary">
                    <code>{tool.name}</code>
                    {tool.terminal ? <span className="config-badge config-badge--terminal">terminal</span> : null}
                    <span className={`config-badge config-badge--${tool.handler || "bridge"}`}>{tool.handler || "bridge"}</span>
                  </summary>
                  <div className="config-details-body">
                    <p>
                      <strong>Description:</strong> {tool.description}
                    </p>
                    <p>
                      <strong>Schema:</strong> <pre className="config-pre config-pre--inline">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    </p>
                  </div>
                </details>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="config-footer">
        {error && <span className="config-error">{error}</span>}
        {saved && !restartNeeded && <span className="config-success">✓ Configuration saved</span>}
        {saved && restartNeeded && <span className="config-warning">✓ Saved — ⚠️ Restart agent runner to apply changes</span>}

        {mode === "edit" && activeTab === "config" && (
          <>
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                ⛔ Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for completion.
              </span>
            ) : (
              <button className="config-save-btn" onClick={handleSave} disabled={saving || saved}>
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
              </button>
            )}
          </>
        )}

        {mode === "edit" && activeTab === "logging" && (
          <>
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                ⛔ Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for completion.
              </span>
            ) : (
              <button className="config-save-btn" onClick={handleSave} disabled={saving || saved}>
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
              </button>
            )}
          </>
        )}

        {mode === "edit" && activeTab === "agent" && (
          <div className="config-footer-actions">
            {activeJobs.length > 0 ? (
              <span className="config-footer-hint">
                ⛔ Cannot save — {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} running. Wait for completion.
              </span>
            ) : (
              <>
                <button className="config-save-btn" onClick={handleSaveAgentConfig} disabled={saving || saved}>
                  {saving ? "Saving…" : saved && !restartNeeded ? "Saved ✓" : "Save Agent Instructions"}
                </button>
                {restartNeeded && (
                  <button className="config-restart-btn" onClick={handleRestartAgent}>
                    🔄 Restart Agent Runner Now
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {mode === "view" && <span className="config-footer-hint">Switch to ✏️ Edit mode to change values.</span>}
      </div>
    </div>
  );
}
