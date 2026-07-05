/**
 * AppearancePanel — theme, accent color, font size preset & sidebar width controls.
 *
 * All values are read from and saved to the Electron config (config.json).
 * Changes are applied and saved on every input — no separate save button needed.
 * The shared appearance utility in ../appearance.ts handles all CSS variable application.
 */

import React, { useState, useEffect, useCallback } from "react";
import { applyAppearance, saveAndApplyAppearance, readFontPreset, FONT_SIZE_PRESETS } from "../appearance";
import type { FontSizePreset, AppearanceConfig } from "../appearance";

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

export default function AppearancePanel({ onClose }: Props) {
  const [theme, setTheme] = useState("dark");
  const [accentColor, setAccentColor] = useState("#58a6ff");
  const [fontPreset, setFontPreset] = useState<FontSizePreset>("medium");
  const [sidebarWidth, setSidebarWidth] = useState(48);

  // Load current config on mount
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      setTheme(cfg.APPEARANCE_THEME || "dark");
      setAccentColor(cfg.APPEARANCE_ACCENT_COLOR || "#58a6ff");
      setFontPreset(readFontPreset(cfg));
      setSidebarWidth(Number(cfg.APPEARANCE_SIDEBAR_WIDTH) || 48);
    });
  }, []);

  // Debounced save — persists to config whenever any value changes
  const persistRef = React.useRef<ReturnType<typeof setTimeout>>();
  const persistAppearance = useCallback((config: AppearanceConfig) => {
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      saveAndApplyAppearance(config);
    }, 200);
  }, []);

  // Apply and persist on every state change
  useEffect(() => {
    const config: AppearanceConfig = { theme, accentColor, fontSize: fontPreset, sidebarWidth };
    applyAppearance(config);
    persistAppearance(config);
  }, [theme, accentColor, fontPreset, sidebarWidth, persistAppearance]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (persistRef.current) clearTimeout(persistRef.current);
    };
  }, []);

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
        <span className="appearance-hint">Changes are saved automatically</span>
      </div>
    </div>
  );
}
