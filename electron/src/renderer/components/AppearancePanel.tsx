/**
 * AppearancePanel — theme, accent color, font size preset & sidebar width controls.
 *
 * Font size uses proportional presets (Small / Medium / Large) that scale all
 * text levels via the --fs-scale CSS custom property. The preset string is
 * persisted to the Electron config store (config.json).
 */

import React, { useState, useEffect, useCallback } from "react";

interface Props {
  onClose: () => void;
}

const ACCENT_PRESETS = [
  { label: "Blue", value: "#58a6ff" },
  { label: "Green", value: "#3fb950" },
  { label: "Purple", value: "#bc8cff" },
  { label: "Pink", value: "#f778ba" },
  { label: "Orange", value: "#d29922" },
  { label: "Red", value: "#f85149" },
  { label: "Teal", value: "#56d4dd" },
  { label: "Yellow", value: "#e3b341" },
];

type FontSizePreset = "small" | "medium" | "large";

interface FontPresetOption {
  label: string;
  value: FontSizePreset;
  scale: number;
  description: string;
}

const FONT_SIZE_PRESETS: FontPresetOption[] = [
  { label: "Small", value: "small", scale: 0.85, description: "Compact view" },
  { label: "Medium", value: "medium", scale: 1.0, description: "Default size" },
  { label: "Large", value: "large", scale: 1.15, description: "Easier reading" },
];

/** Map an old numeric font-size (px) to the nearest preset for backward compat. */
function numericToPreset(px: number): FontSizePreset {
  if (px <= 13) return "small";
  if (px >= 16) return "large";
  return "medium";
}

/** Read the preset string from config, handling old numeric values. */
function readFontPreset(cfg: any): FontSizePreset {
  const raw = cfg.APPEARANCE_FONT_SIZE;
  if (raw === "small" || raw === "medium" || raw === "large") return raw;
  const num = Number(raw);
  if (!isNaN(num)) return numericToPreset(num);
  return "medium";
}

export default function AppearancePanel({ onClose }: Props) {
  const [theme, setTheme] = useState("dark");
  const [accentColor, setAccentColor] = useState("#58a6ff");
  const [fontPreset, setFontPreset] = useState<FontSizePreset>("medium");
  const [sidebarWidth, setSidebarWidth] = useState(48);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load current config
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      setTheme(cfg.APPEARANCE_THEME || "dark");
      setAccentColor(cfg.APPEARANCE_ACCENT_COLOR || "#58a6ff");
      setFontPreset(readFontPreset(cfg));
      setSidebarWidth(Number(cfg.APPEARANCE_SIDEBAR_WIDTH) || 48);
    });
  }, []);

  // Apply theme + accent + font scale + sidebar width immediately via CSS custom properties
  const applyAppearance = useCallback((t: string, accent: string, preset: FontSizePreset, sw: number) => {
    const root = document.documentElement;
    const body = document.body;

    // Theme: swap between dark and light variable sets
    if (t === "light") {
      root.style.setProperty("--bg", "#ffffff");
      root.style.setProperty("--surface", "#f6f8fa");
      root.style.setProperty("--surface-hover", "#eaeef2");
      root.style.setProperty("--border", "#d0d7de");
      root.style.setProperty("--text", "#1f2328");
      root.style.setProperty("--text-muted", "#656d76");
    } else {
      root.style.setProperty("--bg", "#0d1117");
      root.style.setProperty("--surface", "#161b22");
      root.style.setProperty("--surface-hover", "#1c2333");
      root.style.setProperty("--border", "#30363d");
      root.style.setProperty("--text", "#e6edf3");
      root.style.setProperty("--text-muted", "#8b949e");
    }

    // Accent color — applies to buttons, highlights, and borders
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-hover", accent + "cc");
    root.style.setProperty("--accent-border", accent + "44");

    // Font size preset — set the scale factor; all --fs-* CSS variables cascade
    const scale = FONT_SIZE_PRESETS.find((p) => p.value === preset)?.scale ?? 1;
    root.style.setProperty("--fs-scale", String(scale));

    // Also set body font-size so base text immediately reflects the scale
    const basePx = 14 * scale;
    body.style.setProperty("font-size", `${basePx}px`);

    // Sidebar width
    root.style.setProperty("--sidebar-width", `${sw}px`);
  }, []);

  // Re-apply whenever local state changes (live preview)
  useEffect(() => {
    applyAppearance(theme, accentColor, fontPreset, sidebarWidth);
  }, [theme, accentColor, fontPreset, sidebarWidth, applyAppearance]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await window.electronAPI?.saveConfig({
        APPEARANCE_THEME: theme,
        APPEARANCE_ACCENT_COLOR: accentColor,
        APPEARANCE_FONT_SIZE: fontPreset,
        APPEARANCE_SIDEBAR_WIDTH: String(sidebarWidth),
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 1200);
    } catch {
      // fall through
    } finally {
      setSaving(false);
    }
  }, [theme, accentColor, fontPreset, sidebarWidth, onClose]);

  return (
    <div className="panel appearance-panel">
      <div className="appearance-header">
        <h2>🎨 Appearance</h2>
        <button className="appearance-close-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="appearance-body">
        {/* ── Theme ── */}
        <div className="appearance-section">
          <h3 className="appearance-section-title">Theme</h3>
          <div className="appearance-theme-options">
            <label className={`appearance-theme-card ${theme === "dark" ? "appearance-theme-card--selected" : ""}`}>
              <input type="radio" name="theme" value="dark" checked={theme === "dark"} onChange={() => setTheme("dark")} />
              <span className="appearance-theme-preview appearance-theme-preview--dark">
                <span className="appearance-theme-preview-dot" />
              </span>
              <span className="appearance-theme-card-label">Dark</span>
            </label>
            <label className={`appearance-theme-card ${theme === "light" ? "appearance-theme-card--selected" : ""}`}>
              <input type="radio" name="theme" value="light" checked={theme === "light"} onChange={() => setTheme("light")} />
              <span className="appearance-theme-preview appearance-theme-preview--light">
                <span className="appearance-theme-preview-dot" />
              </span>
              <span className="appearance-theme-card-label">Light</span>
            </label>
          </div>
        </div>

        {/* ── Accent Color ── */}
        <div className="appearance-section">
          <h3 className="appearance-section-title">Accent Color</h3>
          <div className="appearance-accent-grid">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c.value}
                className={`appearance-accent-swatch ${accentColor === c.value ? "appearance-accent-swatch--selected" : ""}`}
                style={{ background: c.value }}
                onClick={() => setAccentColor(c.value)}
                title={c.label}
                aria-label={c.label}
              />
            ))}
          </div>
          <div className="appearance-accent-custom">
            <label className="appearance-accent-custom-label">
              Custom
              <input type="color" className="appearance-accent-picker" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} />
            </label>
            <code className="appearance-accent-hex">{accentColor}</code>
          </div>
        </div>

        {/* ── Font Size Presets ── */}
        <div className="appearance-section">
          <h3 className="appearance-section-title">Font Size</h3>
          <div className="appearance-font-presets-grid">
            {FONT_SIZE_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`appearance-font-preset-card ${fontPreset === p.value ? "appearance-font-preset-card--selected" : ""}`}
                onClick={() => setFontPreset(p.value)}>
                <span className="appearance-font-preset-label">{p.label}</span>
                <span className="appearance-font-preset-desc">{p.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="appearance-footer">
        {saved && <span className="appearance-success">✅ Saved</span>}
        <button className="appearance-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save & Close"}
        </button>
      </div>
    </div>
  );
}
