/**
 * Appearance utility — applies theme, accent color, font size, and sidebar width
 * via CSS custom properties on :root. Used by both App.tsx (on mount) and
 * AppearancePanel.tsx (on user interaction). All values come from the config file.
 */

export type FontSizePreset = "small" | "medium" | "large" | "x-large" | "xx-large";

export interface AppearanceConfig {
  theme: string;
  accentColor: string;
  fontSize: FontSizePreset;
  sidebarWidth: number;
}

export const FONT_SIZE_PRESETS: { label: string; value: FontSizePreset; scale: number; description: string }[] = [
  { label: "Small", value: "small", scale: 0.85, description: "Compact view" },
  { label: "Medium", value: "medium", scale: 1.0, description: "Default size" },
  { label: "Large", value: "large", scale: 1.15, description: "Easier reading" },
  { label: "X-L", value: "x-large", scale: 1.35, description: "Extra large" },
  { label: "XX-L", value: "xx-large", scale: 1.6, description: "Double extra large" },
];

/** Map an old numeric font-size (px) to the nearest preset for backward compat. */
export function numericToPreset(px: number): FontSizePreset {
  if (px <= 13) return "small";
  if (px >= 22) return "xx-large";
  if (px >= 18) return "x-large";
  if (px >= 16) return "large";
  return "medium";
}

/** Read the preset string from config, handling old numeric values. */
export function readFontPreset(cfg: Record<string, string>): FontSizePreset {
  const raw = cfg.APPEARANCE_FONT_SIZE;
  if (raw === "small" || raw === "medium" || raw === "large" || raw === "x-large" || raw === "xx-large") return raw;
  const num = Number(raw);
  if (!isNaN(num)) return numericToPreset(num);
  return "medium";
}

/**
 * Apply appearance settings to the document via CSS custom properties.
 * This function is idempotent and can be called multiple times.
 */
export function applyAppearance(config: AppearanceConfig): void {
  const root = document.documentElement;
  const body = document.body;

  // Theme: swap between dark and light variable sets
  if (config.theme === "light") {
    root.style.setProperty("--bg", "#ffffff");
    root.style.setProperty("--surface", "#f6f8fa");
    root.style.setProperty("--surface-hover", "#eaeef2");
    root.style.setProperty("--border", "#d0d7de");
    root.style.setProperty("--text", "#1f2328");
    root.style.setProperty("--text-muted", "#656d76");
    root.setAttribute("data-theme", "light");
  } else {
    root.style.setProperty("--bg", "#0d1117");
    root.style.setProperty("--surface", "#161b22");
    root.style.setProperty("--surface-hover", "#1c2333");
    root.style.setProperty("--border", "#30363d");
    root.style.setProperty("--text", "#e6edf3");
    root.style.setProperty("--text-muted", "#8b949e");
    root.removeAttribute("data-theme");
  }

  // Accent color — applies to buttons, highlights, and borders
  root.style.setProperty("--accent", config.accentColor);
  root.style.setProperty("--accent-hover", config.accentColor + "cc");
  root.style.setProperty("--accent-border", config.accentColor + "44");

  // Font size preset — set the scale factor; all --fs-* CSS variables cascade
  const preset = FONT_SIZE_PRESETS.find((p) => p.value === config.fontSize);
  const scale = preset?.scale ?? 1;
  root.style.setProperty("--fs-scale", String(scale));

  // Also set body font-size so base text immediately reflects the scale
  const basePx = 14 * scale;
  body.style.setProperty("font-size", `${basePx}px`);

  // Sidebar width
  root.style.setProperty("--sidebar-width", `${config.sidebarWidth}px`);
}

/**
 * Load appearance settings from electron config and apply them.
 * Returns the parsed config object for use in state initialization.
 */
export async function loadAndApplyAppearance(): Promise<AppearanceConfig> {
  const cfg = await window.electronAPI?.getConfig();
  const config: AppearanceConfig = {
    theme: cfg?.APPEARANCE_THEME || "dark",
    accentColor: cfg?.APPEARANCE_ACCENT_COLOR || "#58a6ff",
    fontSize: readFontPreset(cfg || {}),
    sidebarWidth: Number(cfg?.APPEARANCE_SIDEBAR_WIDTH) || 48,
  };
  applyAppearance(config);
  return config;
}

/**
 * Save appearance settings to the electron config and apply them immediately.
 */
export async function saveAndApplyAppearance(config: AppearanceConfig): Promise<void> {
  applyAppearance(config);
  await window.electronAPI?.saveConfig({
    APPEARANCE_THEME: config.theme,
    APPEARANCE_ACCENT_COLOR: config.accentColor,
    APPEARANCE_FONT_SIZE: config.fontSize,
    APPEARANCE_SIDEBAR_WIDTH: String(config.sidebarWidth),
  });
}
