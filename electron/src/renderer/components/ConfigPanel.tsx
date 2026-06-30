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
type ConfigTab = "config" | "agent";

interface ConfigValues {
  [key: string]: string;
  DEEPSEEK_API_KEY: string;
  LLM_PROVIDER: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_MODEL: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  TRELLO_KEY: string;
  TRELLO_TOKEN: string;
  HUGGING_FACE_TOKEN: string;
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
  { key: "HUGGING_FACE_TOKEN", label: "Hugging Face Token", required: false, secret: true, section: "LLM Provider" },
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

export default function ConfigPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ConfigTab>("config");
  const [mode, setMode] = useState<ConfigMode>("edit");
  const [values, setValues] = useState<ConfigValues>({} as ConfigValues);
  const [sourceInfo, setSourceInfo] = useState<Record<string, ConfigSourceInfo>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Agent config state ──
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null);
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
        OLLAMA_MODEL: cfg.OLLAMA_MODEL || "llama3.1:8b",
        HUGGING_FACE_TOKEN: cfg.HUGGING_FACE_TOKEN || "",
        GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID || "",
        GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET || "",
        GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN || "",
        GMAIL_USER: cfg.GMAIL_USER || "",
        TRELLO_KEY: cfg.TRELLO_KEY || "",
        TRELLO_TOKEN: cfg.TRELLO_TOKEN || "",
      });
    });
    window.electronAPI
      ?.getConfigWithSources()
      .then(setSourceInfo)
      .catch(() => {});
  }, []);

  // ── Load agent config + check active jobs when switching to agent tab ──
  useEffect(() => {
    if (activeTab !== "agent") return;
    setSaved(false);
    setRestartNeeded(false);

    // Check for active pipeline jobs — if any exist, editing is blocked
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
        {/* ── TAB 1: LLM & Delivery Config ── */}
        {activeTab === "config" && mode === "edit" && (
          <>
            <p className="config-hint">
              Enter your API keys and credentials. Required fields are marked with <span className="config-required">*</span>. Values are stored in
              your user data directory.
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
                          />
                          <span className="config-radio-label">Ollama (Local)</span>
                          <span className="config-radio-desc">Local LLM — no API key needed</span>
                        </label>
                      </div>
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
                            />
                          </div>
                        ))}

                    {values.LLM_PROVIDER === "ollama" &&
                      fields
                        .filter((f) => f.key !== "DEEPSEEK_API_KEY")
                        .map((field) => (
                          <div key={field.key} className="config-field">
                            <label className="config-label">{field.label}</label>
                            <input
                              className="config-input"
                              type="text"
                              value={values[field.key] || ""}
                              onChange={(e) => handleChange(field.key, e.target.value)}
                              placeholder="Optional"
                            />
                          </div>
                        ))}
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
                        />
                      ) : (
                        <input
                          className="config-input"
                          type="text"
                          value={values[field.key] || ""}
                          onChange={(e) => handleChange(field.key, e.target.value)}
                          placeholder={field.required ? "Required" : "Optional"}
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

            {Array.from(sections.entries()).map(([sectionName, fields]) => (
              <div key={sectionName} className="config-section">
                <h3 className="config-section-title">{sectionName}</h3>
                {fields.map((field) => {
                  const info = sourceInfo[field.key];
                  const masked = field.secret && info?.value ? info.value.slice(0, 8) + "…" + info.value.slice(-4) : info?.value || "(not set)";
                  return (
                    <div key={field.key} className="config-view-field">
                      <div className="config-view-label">
                        <span>{field.label}</span>
                        {info && <span className={`config-source-tag config-source-tag--${info.source}`}>{SOURCE_LABELS[info.source]}</span>}
                      </div>
                      <div className="config-view-value">{masked}</div>
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
            {/* ── Active jobs guard ── */}
            {activeJobs.length > 0 && (
              <div className="config-blocked-banner">
                <strong>⛔ Editing blocked</strong> — {activeJobs.length} pipeline job{activeJobs.length > 1 ? "s" : ""} currently running:
                <ul className="config-blocked-list">
                  {activeJobs.map((j) => (
                    <li key={j.job_id}>
                      "{j.title}" — {j.status} ({(j.progress * 100).toFixed(0)}%)
                    </li>
                  ))}
                </ul>
                <p>
                  Agent instructions cannot be modified while jobs are in progress. Switch to <strong>👁️ View Current</strong> mode to review, or wait
                  for jobs to complete then edit.
                </p>
              </div>
            )}

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
          <button className="config-save-btn" onClick={handleSave} disabled={saving || saved}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
          </button>
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
