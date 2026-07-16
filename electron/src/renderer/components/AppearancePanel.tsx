/**
 * AppearancePanel — theme, accent color, font size preset & sidebar width controls.
 *
 * All values are read from and saved to the Electron config (config.json).
 * Changes are applied and saved on every input — no separate save button needed.
 * The shared appearance utility in ../appearance.ts handles all CSS variable application.
 */

import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import { applyAppearance, saveAndApplyAppearance, readFontPreset, FONT_SIZE_PRESETS, watchSystemTheme, unwatchSystemTheme } from "../appearance";
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
  const [showTray, setShowTray] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Load current config on mount — only apply appearance AFTER config is loaded
  // to avoid flashing default values over the user's saved theme
  useEffect(() => {
    Promise.all([window.electronAPI?.getConfig(), window.electronAPI?.getTrayStatus()]).then(([cfg, trayStatus]) => {
      const t = cfg?.APPEARANCE_THEME || "dark";
      const a = cfg?.APPEARANCE_ACCENT_COLOR || "#58a6ff";
      const f = readFontPreset(cfg || {});
      const s = Number(cfg?.APPEARANCE_SIDEBAR_WIDTH) || 48;
      setTheme(t);
      setAccentColor(a);
      setFontPreset(f);
      setSidebarWidth(s);
      if (trayStatus) setShowTray(trayStatus.visible);
      // Apply now that all values are set from config
      const config: AppearanceConfig = { theme: t, accentColor: a, fontSize: f, sidebarWidth: s };
      applyAppearance(config);
      setLoaded(true);
    });
  }, []);

  // Debounced save — persists to config whenever any value changes (only after initial load)
  const persistRef = React.useRef<ReturnType<typeof setTimeout>>();
  const persistAppearance = useCallback((config: AppearanceConfig) => {
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      saveAndApplyAppearance(config);
    }, 200);
  }, []);

  // Apply and persist on user-driven state changes (not on initial mount)
  useEffect(() => {
    if (!loaded) return;
    const config: AppearanceConfig = { theme, accentColor, fontSize: fontPreset, sidebarWidth };
    applyAppearance(config);
    persistAppearance(config);
  }, [theme, accentColor, fontPreset, sidebarWidth, loaded, persistAppearance]);

  // Watch OS color scheme changes when theme is "system"
  useEffect(() => {
    if (theme !== "system") {
      unwatchSystemTheme();
      return;
    }
    const config: AppearanceConfig = { theme, accentColor, fontSize: fontPreset, sidebarWidth };
    watchSystemTheme(config, (effective) => {
      // Re-apply theme variables when OS preference flips
      applyAppearance({ ...config, theme: effective });
    });
    return () => {
      unwatchSystemTheme();
    };
  }, [theme, accentColor, fontPreset, sidebarWidth]);

  // Cleanup timeouts and listeners on unmount
  useEffect(() => {
    return () => {
      if (persistRef.current) clearTimeout(persistRef.current);
      unwatchSystemTheme();
    };
  }, []);

  return (
    <div className="panel appearance-panel">
      <div className="appearance-header">
        <h2>
          <Icon name="palette" size="18" color="accent" /> Appearance
        </h2>
        <Tooltip content="Close the Appearance settings panel">
          <button className="appearance-close-btn" onClick={onClose} title="Close the Appearance panel">
            <Icon name="close" size="16" />
          </button>
        </Tooltip>
      </div>

      <div className="appearance-body">
        {/* ── Theme ── */}
        <div className="appearance-section">
          <h3 className="appearance-section-title">Theme</h3>
          <div className="appearance-theme-options">
            <Tooltip content="Dark theme — easy on the eyes for low-light environments">
              <label
                className={`appearance-theme-card ${theme === "dark" ? "appearance-theme-card--selected" : ""}`}
                title="Dark theme — easy on the eyes for low-light environments">
                <input type="radio" name="theme" value="dark" checked={theme === "dark"} onChange={() => setTheme("dark")} />
                <span className="appearance-theme-preview appearance-theme-preview--dark">
                  <span className="appearance-theme-preview-dot" />
                </span>
                <span className="appearance-theme-card-label">Dark</span>
              </label>
            </Tooltip>
            <Tooltip content="Light theme — bright appearance for well-lit environments">
              <label
                className={`appearance-theme-card ${theme === "light" ? "appearance-theme-card--selected" : ""}`}
                title="Light theme — bright appearance for well-lit environments">
                <input type="radio" name="theme" value="light" checked={theme === "light"} onChange={() => setTheme("light")} />
                <span className="appearance-theme-preview appearance-theme-preview--light">
                  <span className="appearance-theme-preview-dot" />
                </span>
                <span className="appearance-theme-card-label">Light</span>
              </label>
            </Tooltip>
            <Tooltip content="System theme — automatically follows your OS dark/light preference">
              <label
                className={`appearance-theme-card ${theme === "system" ? "appearance-theme-card--selected" : ""}`}
                title="System theme — follows your operating system's dark/light setting">
                <input type="radio" name="theme" value="system" checked={theme === "system"} onChange={() => setTheme("system")} />
                <span className="appearance-theme-preview appearance-theme-preview--system">
                  <span className="appearance-theme-preview-dot" />
                  <span className="appearance-theme-preview-dot appearance-theme-preview-dot--alt" />
                </span>
                <span className="appearance-theme-card-label">System</span>
              </label>
            </Tooltip>
          </div>
        </div>

        {/* ── Accent Color ── */}
        <div className="appearance-section">
          <Tooltip content="Choose your preferred accent color for highlights and interactive elements">
            <h3 className="appearance-section-title">Accent Color</h3>
          </Tooltip>
          <div className="appearance-accent-grid">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c.value}
                className={`appearance-accent-swatch ${accentColor === c.value ? "appearance-accent-swatch--selected" : ""}`}
                style={{ background: c.value }}
                onClick={() => setAccentColor(c.value)}
                title={`Accent color: ${c.label}`}
                aria-label={c.label}
              />
            ))}
          </div>
          <div className="appearance-accent-custom">
            <Tooltip content="Pick any custom color using the color picker">
              <label className="appearance-accent-custom-label">
                Custom
                <input
                  type="color"
                  className="appearance-accent-picker"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  title="Pick a custom accent color"
                />
              </label>
            </Tooltip>
            <code className="appearance-accent-hex">{accentColor}</code>
          </div>
        </div>

        {/* ── Font Size Presets ── */}
        <div className="appearance-section">
          <Tooltip content="Adjust the overall font size of the application">
            <h3 className="appearance-section-title">Font Size</h3>
          </Tooltip>
          <div className="appearance-font-presets-grid">
            {FONT_SIZE_PRESETS.map((p) => (
              <Tooltip key={p.value} content={`Switch to ${p.label} font size — ${p.description}`}>
                <button
                  key={p.value}
                  className={`appearance-font-preset-card ${fontPreset === p.value ? "appearance-font-preset-card--selected" : ""}`}
                  onClick={() => setFontPreset(p.value)}
                  title={`Font size: ${p.label}`}>
                  <span className="appearance-font-preset-label">{p.label}</span>
                  <span className="appearance-font-preset-desc">{p.description}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>

        {/* ── Menu Bar Icon ── */}
        <div className="appearance-section">
          <Tooltip content="Show or hide the menu bar icon (top-right on macOS, system tray on Windows/Linux)">
            <h3 className="appearance-section-title">Menu Bar Icon</h3>
          </Tooltip>
          <label className="appearance-toggle-row" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showTray}
              onChange={async (e) => {
                const next = e.target.checked;
                setShowTray(next);
                const result = await window.electronAPI?.toggleTray();
                if (result) setShowTray(result.visible);
              }}
            />
            <Icon name="notifications" size="16" color={showTray ? "accent" : "muted"} />
            <span>Show menu bar icon</span>
          </label>
        </div>
      </div>

      <div className="appearance-footer">
        <Tooltip content="All appearance changes are saved to your config automatically — no save button needed">
          <span className="appearance-hint">Changes are saved automatically</span>
        </Tooltip>
      </div>
    </div>
  );
}
