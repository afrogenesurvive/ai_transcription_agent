/**
 * UI State Manager — persists renderer UI preferences to disk.
 *
 * File: userData/ui-state.json
 *   → ~/Library/Application Support/Transcription Agent/ui-state.json on macOS
 *     (app.name = "Transcription Agent" is set in index.ts before userData resolves,
 *      so dev and packaged builds share this folder with config.json).
 *
 * Deliberately SEPARATE from config.ts:
 *   - config.json drives backend/agent/env configuration, and config:save restarts
 *     the agent runner — unacceptable for high-frequency UI state (tab switches,
 *     selection changes, form keystrokes).
 *   - UI state is arbitrary nested JSON (tabs, subtabs, filters, selections, form
 *     drafts), not the flat string-keyed AppConfig schema.
 *   - Config export/import/restore-defaults/clear must never clobber UI state.
 *
 * Write model: the RENDERER is the single writer. It loads the whole object once
 * (ui-state:get), mutates it in memory, and writes the full object back
 * (ui-state:save) on a debounce. There is deliberately NO main-process
 * clear/merge so a stale renderer copy can never resurrect a cleared scope.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

export type UiState = Record<string, any>;

let uiStatePath: string;

function ensureUiStateDir(): void {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  uiStatePath = path.join(dir, "ui-state.json");
}

/** Read the full UI state object. Returns {} on missing/unreadable file. */
export function getUiState(): UiState {
  if (!uiStatePath) ensureUiStateDir();
  try {
    if (!fs.existsSync(uiStatePath)) return {};
    const raw = fs.readFileSync(uiStatePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Corrupt/unreadable — start fresh rather than crash the app
    return {};
  }
}

/** Persist the full UI state object (atomic write via .tmp + rename). */
export function saveUiState(state: UiState): void {
  if (!uiStatePath) ensureUiStateDir();
  try {
    const tmp = uiStatePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, uiStatePath);
  } catch {
    // Non-fatal — UI state persistence is best-effort (like config.ts)
  }
}
