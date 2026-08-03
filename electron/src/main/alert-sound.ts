/**
 * Alert sound on job state changes.
 *
 * Plays a user-provided WAV (default name: `alert.wav`) whenever a job alert
 * notification fires — failed / cancelled / paused for labelling or review
 * gates / completed — regardless of whether the app window is focused.
 *
 * Why an explicit sound: macOS suppresses the native notification sound when
 * the app is the frontmost app, and Windows has no guaranteed sound either.
 * Playing it here from the main process (an OS-level child process) makes it
 * work regardless of window focus. Falls back to a short system beep when no
 * audio file is found.
 *
 * File lookup order (first existing wins):
 *   1. $ALERT_SOUND_PATH             — explicit override
 *   2. <repo root>/sounds/alert.wav  — dev  (app.getAppPath()/..)
 *   3. <resources>/sounds/alert.wav  — packaged (bundled via extraResources)
 *   4. <userData>/sounds/alert.wav   — writable override (no rebuild needed)
 *   5. none                          → system beep fallback
 */
import { app } from "electron";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { addLog } from "./logger";

export const ALERT_SOUND_FILENAME = "alert.wav";

/** Ignore repeat plays within this window so simultaneous job alerts don't stack/overlap. */
const PLAY_DEBOUNCE_MS = 1000;

let lastPlayedAt = 0;

/** Resolve the first existing alert sound file path, or null if none. */
export function alertSoundPath(): string | null {
  const override = process.env.ALERT_SOUND_PATH;
  if (override && fs.existsSync(override)) return override;

  const candidates: string[] = [];
  if (app.isPackaged) {
    // Bundled via electron-builder extraResources → resources/sounds/
    candidates.push(path.join(process.resourcesPath, "sounds", ALERT_SOUND_FILENAME));
  } else {
    // Dev: repo root /sounds (app.getAppPath() is the electron/ dir in dev)
    candidates.push(path.join(app.getAppPath(), "..", "sounds", ALERT_SOUND_FILENAME));
  }
  // Writable override so packaged users can swap the sound without rebuilding.
  candidates.push(path.join(app.getPath("userData"), "sounds", ALERT_SOUND_FILENAME));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Play the alert sound (or a system beep fallback). Never throws. */
export function playAlertSound(): void {
  const now = Date.now();
  if (now - lastPlayedAt < PLAY_DEBOUNCE_MS) return;
  lastPlayedAt = now;

  try {
    const filePath = alertSoundPath();
    if (filePath) {
      playFile(filePath);
    } else {
      playFallbackBeep();
    }
  } catch (err: any) {
    addLog("main", "warn", `[alert-sound] Failed to play alert sound: ${err?.message || err}`);
  }
}

function playFile(filePath: string): void {
  const cmd = platformCommand(filePath);
  if (!cmd) return;
  spawn(cmd.cmd, cmd.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  addLog("main", "debug", `[alert-sound] Playing ${filePath}`);
}

/** Native player per platform — WAV works on all of these with zero extra deps. */
function platformCommand(filePath: string): { cmd: string; args: string[] } | null {
  if (process.platform === "darwin") {
    return { cmd: "afplay", args: [filePath] };
  }
  if (process.platform === "win32") {
    // PowerShell SoundPlayer handles WAV natively. PlaySync keeps the child
    // process alive for the duration so the sound isn't cut off on exit.
    const safePath = filePath.replace(/'/g, "''");
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${safePath}').PlaySync()`],
    };
  }
  // Linux fallback: aplay if available.
  return { cmd: "aplay", args: [filePath] };
}

function playFallbackBeep(): void {
  if (process.platform === "darwin") {
    spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("powershell", ["-NoProfile", "-Command", "[console]::beep(1000,300)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else {
    spawn("aplay", ["/usr/share/sounds/alsa/Front_Center.wav"], { detached: true, stdio: "ignore" }).unref();
  }
  addLog("main", "debug", "[alert-sound] No alert.wav found — playing system beep fallback");
}
