/**
 * Icon — Material Symbols Outlined icon component.
 *
 * Renders a Google/Material Design icon whose color and size are determined
 * by the app's theme system.
 *
 * ## Dynamic sizing
 * 1. Explicit `size` prop (e.g. "16", "20") → uses `var(--fs-16, 16px)` which
 *    scales with the font-size preset (`--fs-scale`).
 * 2. No `size` prop → uses `var(--icon-size, 1em)`. Containers can set
 *    `--icon-size` on a parent to control all child icons at once.
 * 3. Falls back to `1em` (inherits the current font-size).
 *
 * ## Dynamic color
 * 1. Explicit `color` prop with a theme token ("accent", "muted", etc.) →
 *    maps to the corresponding CSS variable (`--accent`, etc.).
 * 2. Explicit `color` prop with a literal CSS value → used as-is.
 * 3. No `color` prop → uses `var(--icon-color, currentColor)`. Containers
 *    can set `--icon-color` on a parent to control all child icons.
 * 4. Falls back to `currentColor` (inherits the surrounding text color).
 *
 * ## Container-level control
 * Set `--icon-size` and/or `--icon-color` on any parent element to control
 * all descendant icons without passing props to each one.
 */

import React from "react";

interface IconProps {
  /** Material Symbol name (e.g. "home", "mic", "settings") */
  name: string;
  /**
   * Icon size as a numeric string representing an `--fs-*` token.
   * Examples: "12", "14", "16", "20", "24", "32", "40".
   * When omitted, uses `var(--icon-size, 1em)` so containers can control
   * sizing via the `--icon-size` CSS variable.
   */
  size?: string;
  /**
   * Icon color. Supports theme tokens and literal CSS values.
   *
   * Theme tokens (maps to CSS variable):
   *   - `"accent"`  → `var(--accent)`       (user's chosen accent)
   *   - `"muted"`   → `var(--text-muted)`   (muted text color)
   *   - `"green"`   → `var(--green)`        (success)
   *   - `"red"`     → `var(--red)`          (error/danger)
   *   - `"orange"`  → `var(--orange)`       (warning)
   *
   * When omitted, uses `var(--icon-color, currentColor)` so containers
   * can control color via the `--icon-color` CSS variable.
   */
  color?: string;
  /** Additional CSS class(es) */
  className?: string;
  /** ARIA label for accessibility */
  label?: string;
  /** Whether to fill the icon (default: false for outlined) */
  filled?: boolean;
}

const THEME_COLORS: Record<string, string> = {
  accent: "var(--accent)",
  muted: "var(--text-muted)",
  green: "var(--green)",
  red: "var(--red)",
  orange: "var(--orange)",
};

export default function Icon({ name, size, color, className = "", label, filled }: IconProps) {
  const style: React.CSSProperties = {};

  // Size: explicit prop → --fs-* variable; none → --icon-size var with 1em fallback
  if (size) {
    style.fontSize = `var(--fs-${size}, ${size}px)`;
  }
  // No size prop → defer to --icon-size container variable (falls back to 1em)

  // Color: explicit prop → theme token or literal; none → --icon-color var with currentColor fallback
  if (color) {
    style.color = THEME_COLORS[color] || color;
  }
  // No color prop → defer to --icon-color container variable (falls back to currentColor)

  const cls = `material-symbols-outlined${filled ? " material-symbols--filled" : ""} ${className}`.trim();

  return (
    <span className={cls} style={style} role="img" aria-label={label}>
      {name}
    </span>
  );
}
