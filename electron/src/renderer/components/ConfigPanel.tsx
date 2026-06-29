/**
 * ConfigPanel — modal overlay for entering app configuration.
 *
 * Shows required fields (DeepSeek API key) and optional fields
 * (delivery credentials). Values are saved to app.getPath("userData")/config.json.
 */

import React, { useState, useEffect, useCallback } from "react";

interface Props {
  visible: boolean;
  onClose: () => void;
}

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
}

const FIELDS: { key: keyof ConfigValues; label: string; required: boolean; secret: boolean; section: string }[] = [
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key", required: true, secret: true, section: "LLM Provider" },
  { key: "LLM_PROVIDER", label: "LLM Provider (deepseek / ollama)", required: false, secret: false, section: "LLM Provider" },
  { key: "OLLAMA_BASE_URL", label: "Ollama Base URL", required: false, secret: false, section: "LLM Provider" },
  { key: "OLLAMA_MODEL", label: "Ollama Model", required: false, secret: false, section: "LLM Provider" },
  { key: "GMAIL_CLIENT_ID", label: "Gmail Client ID", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_CLIENT_SECRET", label: "Gmail Client Secret", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_REFRESH_TOKEN", label: "Gmail Refresh Token", required: false, secret: true, section: "Email Delivery" },
  { key: "GMAIL_USER", label: "Gmail User Email", required: false, secret: false, section: "Email Delivery" },
  { key: "TRELLO_KEY", label: "Trello API Key", required: false, secret: true, section: "Trello Delivery" },
  { key: "TRELLO_TOKEN", label: "Trello Token", required: false, secret: true, section: "Trello Delivery" },
];

export default function ConfigPanel({ visible, onClose }: Props) {
  const [values, setValues] = useState<ConfigValues>({} as ConfigValues);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load current config on open
  useEffect(() => {
    if (!visible) return;
    setSaved(false);
    setError(null);
    window.electronAPI?.getConfig().then((cfg) => {
      setValues({
        DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY || "",
        LLM_PROVIDER: cfg.LLM_PROVIDER || "deepseek",
        OLLAMA_BASE_URL: cfg.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        OLLAMA_MODEL: cfg.OLLAMA_MODEL || "llama3.1:8b",
        GMAIL_CLIENT_ID: cfg.GMAIL_CLIENT_ID || "",
        GMAIL_CLIENT_SECRET: cfg.GMAIL_CLIENT_SECRET || "",
        GMAIL_REFRESH_TOKEN: cfg.GMAIL_REFRESH_TOKEN || "",
        GMAIL_USER: cfg.GMAIL_USER || "",
        TRELLO_KEY: cfg.TRELLO_KEY || "",
        TRELLO_TOKEN: cfg.TRELLO_TOKEN || "",
      });
    });
  }, [visible]);

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

  if (!visible) return null;

  // Group fields by section
  const sections = new Map<string, typeof FIELDS>();
  for (const field of FIELDS) {
    if (!sections.has(field.section)) sections.set(field.section, []);
    sections.get(field.section)!.push(field);
  }

  return (
    <div className="config-overlay" onClick={onClose}>
      <div className="config-panel" onClick={(e) => e.stopPropagation()}>
        <div className="config-header">
          <h2>⚙️ Configuration</h2>
          <button className="config-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="config-body">
          <p className="config-hint">
            Enter your API keys and credentials. Required fields are marked with <span className="config-required">*</span>. Values are stored in your
            user data directory.
          </p>

          {Array.from(sections.entries()).map(([sectionName, fields]) => (
            <div key={sectionName} className="config-section">
              <h3 className="config-section-title">{sectionName}</h3>
              {fields.map((field) => (
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
        </div>

        <div className="config-footer">
          {error && <span className="config-error">{error}</span>}
          {saved && <span className="config-success">✓ Configuration saved</span>}
          <button className="config-save-btn" onClick={handleSave} disabled={saving || saved}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
