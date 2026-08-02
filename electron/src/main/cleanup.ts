/**
 * Cleanup / Uninstall — removes user data and optionally auto-installed
 * dependencies (Ollama) when the user chooses to uninstall.
 *
 * Cross-platform: macOS, Windows, Linux.
 *
 * Usage (IPC):
 *   renderer  →  ipcMain.handle("app:uninstall", ...)  →  cleanup()
 *
 * On Windows, the NSIS uninstaller also handles this via
 * `deleteAppDataOnUninstall: true` + a custom NSIS script.
 */

import fs from "fs";
import path from "path";
import { app, Notification } from "electron";
import { execSync, exec } from "child_process";
import { addLog } from "./logger";
import { stopAll } from "./backend-manager";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const OLLAMA_SENTINEL = ".ollama-auto-installed";
const FFPEG_SENTINEL = ".ffmpeg-auto-installed";

// ── Paths ──

/** App user data directory (~/Library/Application Support/... or %APPDATA%/...) */
function userDataDir(): string {
  return app.getPath("userData");
}

/** Path to the sentinel file that tracks whether this app auto-installed Ollama. */
function ollamaSentinelPath(): string {
  return path.join(userDataDir(), OLLAMA_SENTINEL);
}

/** Mark Ollama as auto-installed by this app. Called after successful auto-install. */
export function markOllamaAutoInstalled(): void {
  try {
    fs.writeFileSync(ollamaSentinelPath(), new Date().toISOString(), "utf8");
    addLog("main", "info", "[cleanup] Marked Ollama as auto-installed");
  } catch (err: any) {
    addLog("main", "warn", `[cleanup] Could not write Ollama sentinel: ${err.message}`);
  }
}

/** Check whether Ollama was auto-installed by this app. */
function isOllamaAutoInstalled(): boolean {
  return fs.existsSync(ollamaSentinelPath());
}

// ── ffmpeg ──

/** Path to the sentinel file that tracks whether this app auto-installed ffmpeg. */
function ffmpegSentinelPath(): string {
  return path.join(userDataDir(), FFPEG_SENTINEL);
}

/** Path where the managed ffmpeg binary was placed. */
function ffmpegManagedPath(): string {
  return path.join(userDataDir(), "bin", IS_WIN ? "ffmpeg.exe" : "ffmpeg");
}

/** Remove ffmpeg if it was auto-installed by this app. */
function removeFfmpeg(): boolean {
  if (!fs.existsSync(ffmpegSentinelPath())) {
    addLog("main", "info", "[cleanup] ffmpeg was not auto-installed by this app — skipping");
    return false;
  }

  addLog("main", "info", "[cleanup] Removing auto-installed ffmpeg...");
  try {
    const binPath = ffmpegManagedPath();
    if (fs.existsSync(binPath)) {
      fs.rmSync(binPath, { force: true });
      addLog("main", "info", `[cleanup] Removed ffmpeg binary: ${binPath}`);
    }
    // Remove the bin directory if empty
    const binDir = path.dirname(binPath);
    if (fs.existsSync(binDir) && fs.readdirSync(binDir).length === 0) {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    // Remove sentinel
    fs.unlinkSync(ffmpegSentinelPath());
    addLog("main", "info", "[cleanup] ffmpeg removed");
    return true;
  } catch (err: any) {
    addLog("main", "error", `[cleanup] Failed to remove ffmpeg: ${err.message}`);
    return false;
  }
}

// ── Uninstall ──

export interface UninstallResult {
  success: boolean;
  userDataRemoved: boolean;
  ollamaRemoved: boolean;
  ollamaModelsRemoved: boolean;
  ffmpegRemoved: boolean;
  errors: string[];
}

/**
 * Remove all app user data (config, storage, queue, logs, voiceprints, vector DB).
 */
function removeUserData(): boolean {
  const dir = userDataDir();
  addLog("main", "info", `[cleanup] Removing user data: ${dir}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    addLog("main", "info", "[cleanup] User data removed");
    return true;
  } catch (err: any) {
    addLog("main", "error", `[cleanup] Failed to remove user data: ${err.message}`);
    return false;
  }
}

/**
 * Remove the ~/.ollama models directory on any platform.
 * Returns true if data was removed.
 */
function removeOllamaModels(): boolean {
  const ollamaDir = path.join(require("os").homedir(), ".ollama");
  if (!fs.existsSync(ollamaDir)) {
    addLog("main", "info", "[cleanup] No Ollama models directory found at ~/.ollama");
    return false;
  }
  try {
    addLog("main", "info", `[cleanup] Removing Ollama models: ${ollamaDir}`);
    fs.rmSync(ollamaDir, { recursive: true, force: true });
    addLog("main", "info", "[cleanup] Ollama models removed");
    return true;
  } catch (err: any) {
    addLog("main", "error", `[cleanup] Failed to remove Ollama models: ${err.message}`);
    return false;
  }
}

/**
 * Remove Ollama if it was auto-installed by this app.
 * Respects the sentinel file — will NOT touch a user-installed Ollama.
 * Always removes downloaded models when uninstalling.
 */
function removeOllama(): boolean {
  if (!isOllamaAutoInstalled()) {
    addLog("main", "info", "[cleanup] Ollama was not auto-installed by this app — skipping (leaving ~/.ollama models untouched)");
    // A user's own Ollama install/models must NOT be deleted — this app only
    // has permission to remove Ollama it installed itself (sentinel-gated).
    return false;
  }

  addLog("main", "info", "[cleanup] Removing auto-installed Ollama...");

  try {
    if (IS_WIN) {
      // Windows: run the Ollama uninstaller if it exists
      const uninstallPaths = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "uninstall.exe"),
        path.join(process.env.PROGRAMFILES || "", "Ollama", "uninstall.exe"),
      ];
      for (const uninstaller of uninstallPaths) {
        if (fs.existsSync(uninstaller)) {
          execSync(`"${uninstaller}" /S`, { stdio: "ignore", timeout: 30_000 });
          addLog("main", "info", `[cleanup] Ollama uninstaller executed: ${uninstaller}`);
          // Synchronously remove the directory after the uninstaller finishes.
          // execSync blocks until the uninstaller exits, so there's no race.
          const dir = path.dirname(uninstaller);
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ok */
          }
          break;
        }
      }
    } else if (IS_MAC) {
      // macOS: remove Ollama.app from /Applications
      const appPath = "/Applications/Ollama.app";
      if (fs.existsSync(appPath)) {
        fs.rmSync(appPath, { recursive: true, force: true });
        addLog("main", "info", "[cleanup] Removed /Applications/Ollama.app");
      }
    } else {
      // Linux: remove ollama binary via package manager or direct removal
      try {
        execSync("which ollama", { stdio: "pipe", timeout: 5000 });
        // Found on PATH — try package manager uninstall
        if (fs.existsSync("/usr/bin/apt")) {
          execSync("sudo apt remove -y ollama", { stdio: "ignore", timeout: 30_000 });
        } else {
          // Just remove the binary
          const ollamaPath = execSync("which ollama", { encoding: "utf8", timeout: 5000 }).trim();
          if (ollamaPath) fs.rmSync(ollamaPath, { force: true });
        }
      } catch {
        addLog("main", "warn", "[cleanup] Could not uninstall Ollama on Linux");
      }
    }

    // Remove downloaded models on all platforms
    removeOllamaModels();

    // Remove the sentinel file
    try {
      fs.unlinkSync(ollamaSentinelPath());
    } catch {
      /* ok */
    }

    addLog("main", "info", "[cleanup] Ollama removed");
    return true;
  } catch (err: any) {
    addLog("main", "error", `[cleanup] Failed to remove Ollama: ${err.message}`);
    return false;
  }
}

/**
 * Perform a full uninstall cleanup:
 *   1. Stop all backend services
 *   2. Remove user data directory
 *   3. Remove Ollama (if auto-installed by this app)
 *
 * On macOS, the user then drags the app to Trash.
 * On Windows, the NSIS uninstaller handles removing the app binaries.
 */
export async function uninstall(): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: true,
    userDataRemoved: false,
    ollamaRemoved: false,
    ollamaModelsRemoved: false,
    ffmpegRemoved: false,
    errors: [],
  };

  addLog("main", "info", "[cleanup] Starting uninstall...");

  // 1. Stop services
  try {
    await stopAll();
    addLog("main", "info", "[cleanup] Services stopped");
  } catch (err: any) {
    result.errors.push(`Failed to stop services: ${err.message}`);
    addLog("main", "error", `[cleanup] ${result.errors[result.errors.length - 1]}`);
  }

  // Small delay to let processes release file handles
  await new Promise((r) => setTimeout(r, 1000));

  // 2. Remove user data
  result.userDataRemoved = removeUserData();

  // 3. Remove Ollama if auto-installed (also removes models). A user's own
  //    Ollama / models (~/.ollama) are left untouched — see removeOllama().
  result.ollamaRemoved = removeOllama();
  // Track whether models were removed (only happens when we auto-installed Ollama)
  result.ollamaModelsRemoved = !fs.existsSync(path.join(require("os").homedir(), ".ollama"));

  // 4. Remove ffmpeg if auto-installed
  result.ffmpegRemoved = removeFfmpeg();

  result.success = result.errors.length === 0;

  // 5. On macOS, move app to Trash automatically
  if (IS_MAC && result.userDataRemoved) {
    try {
      const appPath = app.getPath("exe"); // e.g. /Applications/Transcription Agent.app/Contents/MacOS/Transcription Agent
      const appBundle = path.dirname(path.dirname(appPath)); // /Applications/Transcription Agent.app
      addLog("main", "info", `[cleanup] Moving app to Trash: ${appBundle}`);
      // Use Finder to move to Trash (reliable cross-version method)
      execSync(`osascript -e 'tell app "Finder" to delete POSIX file "${appBundle.replace(/"/g, '\\"')}"'`, { timeout: 10_000, stdio: "pipe" });
      addLog("main", "info", "[cleanup] App moved to Trash");
    } catch (err: any) {
      // Non-critical — user can manually trash it
      addLog("main", "warn", `[cleanup] Could not auto-trash app: ${err.message}`);
      result.errors.push(`Could not auto-trash app (please drag to Trash manually): ${err.message}`);
    }
  }

  return result;
}
