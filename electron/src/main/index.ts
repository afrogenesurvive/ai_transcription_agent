/**
 * Electron Main Process
 *
 * Responsibilities:
 *   - Spawn Python backend + bridge server on startup
 *   - Create browser window with React renderer
 *   - System tray for background operation
 *   - Native notifications on job completion
 *   - File dialog IPC for audio selection
 */

import fs from "fs";
import { spawn, execSync } from "child_process";
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog, shell } from "electron";
import path from "path";
import pidusage from "pidusage";
import { registerExportHandlers } from "./exporter";

// Set app name before anything else — macOS menu bar and Windows taskbar
// use this instead of the default "Electron".
app.name = "Transcription Agent";

// ── Load .env into process.env ──
// Required so that child processes (Python backend, bridge, agent runner)
// inherit env vars like HUGGING_FACE_TOKEN that are set in the project .env file.
// This runs before any backend services are spawned.
//
// In dev mode: reads from the project root (alongside package.json).
// In packaged mode: reads from userData so users can place a .env file
// in a writable location outside the read-only app bundle.
(function loadDotEnv(): void {
  try {
    const rootDir = app.isPackaged ? app.getPath("userData") : path.join(app.getAppPath(), "..");
    const envPath = path.join(rootDir, ".env");
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // Only set if not already defined (process.env takes priority)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional — silently ignore if missing or unreadable
  }
})();
import {
  startAll,
  startPythonBackend,
  startBridgeServer,
  startAgentRunner,
  ensureOllamaRunning,
  ensureFfmpegAvailable,
  stopAll,
  stopAllSync,
  restartAll,
  restartPythonBackend,
  restartBridgeServer,
  restartAgentRunner,
  stopPythonBackend,
  stopBridgeServer,
  stopAgentRunner,
  isAgentRunning,
  startHealthMonitoring,
  stopHealthMonitoring,
  getChildPids,
  ollamaStartedByUs,
  stopOllamaServer,
  setOnJobStarted,
  initAgentConfigDir,
  getUserDataAgentConfigDir,
} from "./backend-manager";
import { subscribe, getLogs, clearLogs, addLog, setStorageBase, setCurrentJobId, listJobLogFiles, readLogFile } from "./logger";
import {
  getConfig,
  getChildEnv,
  saveConfig,
  checkConfig,
  getConfigWithSources,
  clearConfig,
  readUserConfigDefaults,
  restoreUserConfigDefaults,
  saveAgentConfigToDisk,
} from "./config";
import { startAutoUpdater, stopAutoUpdater, registerAutoUpdateIpc, getUpdateState, checkAndUpdate } from "./auto-updater";
import { uninstall } from "./cleanup";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ── Window ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    title: "Transcription Agent",
    fullscreen: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  // Maximize window on all platforms (avoiding fullscreen which hides the taskbar on Windows)
  mainWindow.maximize();

  // In development, load from Vite dev server.
  // In test mode (NODE_ENV=test), load from pre-built renderer files since
  // the Vite dev server isn't running during headless Playwright tests.
  const isProd = app.isPackaged || process.env.NODE_ENV === "test";
  if (isProd) {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Add right-click context menu (Copy, Select All, etc.)
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable } = params;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (isEditable) {
      template.push({ role: "undo", label: "Undo" }, { role: "redo", label: "Redo" }, { type: "separator" });
      template.push({ role: "cut", label: "Cut", enabled: editFlags.canCut });
      template.push({ role: "copy", label: "Copy", enabled: editFlags.canCopy });
      template.push({ role: "paste", label: "Paste", enabled: editFlags.canPaste });
    } else {
      template.push({ role: "copy", label: "Copy", enabled: editFlags.canCopy });
    }
    template.push({ type: "separator" }, { role: "selectAll", label: "Select All", enabled: editFlags.canSelectAll });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow! });
  });

  mainWindow.on("close", (event) => {
    // Minimize to tray instead of closing (unless we're actually quitting)
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      // Let the user know the app is still running in the background
      // (the Python backend and other services continue to use memory)
      sendNotification({
        title: "Transcription Agent",
        body: "Still running in the menu bar — quit from the tray menu to stop background services.",
      });
    }
  });
}

// ── System Tray ──

/** Generate a simple 16×16 microphone icon as a template image for the menu bar */
function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  buf.fill(0); // Start fully transparent

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let visible = false;

      // Microphone body — pill shape
      if (y >= 1 && y <= 9) {
        const inTopRounded = y <= 2 && x >= 5 && x <= 10;
        const inMid = y >= 3 && y <= 8 && x >= 4 && x <= 11;
        const inBottomRounded = y === 9 && x >= 5 && x <= 10;
        visible = inTopRounded || inMid || inBottomRounded;
      }

      // Stand — thin vertical bar below body
      if (x >= 7 && x <= 8 && y >= 10 && y <= 12) {
        visible = true;
      }

      // Base — wider horizontal bar at the bottom
      if (y >= 13 && y <= 14 && x >= 5 && x <= 10) {
        visible = true;
      }

      if (visible) {
        const idx = (y * size + x) * 4;
        buf[idx] = 255; // R
        buf[idx + 1] = 255; // G
        buf[idx + 2] = 255; // B
        buf[idx + 3] = 255; // A
      }
    }
  }

  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  return icon;
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Check for Updates",
      click: async () => {
        const result = await checkAndUpdate(true);
        const state = getUpdateState();
        const version = state.currentVersion || "unknown";
        if (result.updateAvailable && !result.error) {
          new Notification({ title: "Updating", body: `Update found: ${result.details} on ${version}. Restarting...` }).show();
        } else if (!result.updateAvailable && !result.error) {
          new Notification({ title: "Up to Date", body: `Already up to date on ${version}.` }).show();
        } else {
          new Notification({ title: "Update Check Failed", body: result.error || "Unknown error" }).show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        // Confirmation is handled in before-quit below
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Transcription Agent");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── Tray IPC ──

ipcMain.handle("tray:toggle", () => {
  if (tray) {
    tray.destroy();
    tray = null;
  } else {
    createTray();
  }
  return { visible: tray !== null };
});

ipcMain.handle("tray:status", () => {
  return { visible: tray !== null };
});

// ── Notifications ──

type NotificationType = "info" | "success" | "error" | "started" | "paused";

interface SendNotificationOptions {
  title: string;
  body: string;
  clickPayload?: Record<string, unknown>;
  type?: NotificationType;
  silent?: boolean;
  subtitle?: string;
  actions?: Electron.NotificationAction[];
}

/** Draw a small programmatic icon for notification types — no asset files needed */
function createNotificationIcon(type: NotificationType): Electron.NativeImage | undefined {
  // macOS doesn't show custom notification icons, skip on Darwin
  if (process.platform === "darwin") return undefined;

  const size = 48;
  const buf = Buffer.alloc(size * size * 4);
  buf.fill(0); // transparent background

  function setPixel(x: number, y: number, r: number, g: number, b: number, a = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
    buf[idx + 3] = a;
  }

  function drawCircle(cx: number, cy: number, radius: number, r: number, g: number, b: number) {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) {
          setPixel(x, y, r, g, b);
        }
      }
    }
  }

  switch (type) {
    case "success": {
      // Green circle with white checkmark
      drawCircle(24, 24, 20, 60, 200, 80);
      for (let i = 0; i <= 8; i++) {
        setPixel(16 + i, 24 + i, 255, 255, 255);
        setPixel(24 + i, 24 - i, 255, 255, 255);
      }
      break;
    }
    case "error": {
      // Red circle with white X
      drawCircle(24, 24, 20, 220, 60, 60);
      for (let i = -8; i <= 8; i++) {
        setPixel(24 + i, 24 + i, 255, 255, 255);
        setPixel(24 + i, 24 - i, 255, 255, 255);
      }
      break;
    }
    case "started": {
      // Blue circle with play triangle
      drawCircle(24, 24, 20, 60, 130, 220);
      for (let y = 16; y <= 32; y++) {
        for (let x = 18; x <= 30; x++) {
          const halfW = (y - 16) * 0.4 + 2;
          const cx = 18 + halfW;
          if (x >= 18 && x <= cx) setPixel(x, y, 255, 255, 255);
        }
      }
      break;
    }
    case "paused": {
      // Yellow/orange circle with two vertical bars
      drawCircle(24, 24, 20, 230, 180, 40);
      for (let y = 15; y <= 33; y++) {
        for (let x = 17; x <= 20; x++) setPixel(x, y, 255, 255, 255);
        for (let x = 27; x <= 30; x++) setPixel(x, y, 255, 255, 255);
      }
      break;
    }
    // "info" — no icon, fall back to default app icon
    default:
      return undefined;
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function sendNotification(opts: SendNotificationOptions) {
  const { title, body, clickPayload, type = "info", silent = false, subtitle, actions } = opts;

  const icon = createNotificationIcon(type);
  const notifOptions: Electron.NotificationConstructorOptions = { title, body, silent };
  if (icon) notifOptions.icon = icon;
  if (subtitle && process.platform === "darwin") (notifOptions as any).subtitle = subtitle;
  // Actions are only supported on Windows 10+
  if (actions && actions.length > 0 && process.platform === "win32") notifOptions.actions = actions;

  const notif = new Notification(notifOptions);
  if (clickPayload) {
    notif.on("click", () => {
      // When the user clicks the notification, forward the payload to the renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show(); // Bring window to front
        mainWindow.focus();
        mainWindow.webContents.send("notification-click", clickPayload);
      }
    });
  }
  notif.show();

  // macOS: when the app is frontmost, the OS suppresses the notification
  // because it assumes the user is already looking at the app. Bounce the
  // dock icon to draw attention instead, for important notification types.
  if (process.platform === "darwin" && mainWindow?.isFocused() && (type === "success" || type === "error" || type === "started")) {
    app.dock?.bounce?.("informational");
  }
}

// ── IPC Handlers ──

ipcMain.handle("notification:show", (_event, opts: SendNotificationOptions) => {
  sendNotification(opts);
});

ipcMain.handle("dialog:selectAudio", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openFile"],
    filters: [
      {
        name: "Audio Files",
        extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"],
      },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── File system helpers ──

ipcMain.handle("fs:fileExists", async (_event, filePath: string) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

ipcMain.handle("backend:status", async () => {
  // Check all three services with individual timeouts
  let python = false;
  let bridge = false;
  const agent = isAgentRunning();

  try {
    const pyRes = await fetch("http://127.0.0.1:5001/health", { signal: AbortSignal.timeout(2000) });
    python = pyRes.ok;
  } catch {
    // python not running
  }

  try {
    const brRes = await fetch("http://127.0.0.1:5010/health", { signal: AbortSignal.timeout(2000) });
    bridge = brRes.ok;
  } catch {
    // bridge not running
  }

  return { python, bridge, agent };
});

ipcMain.handle("app:version", () => {
  // Read version from generated version.json (branch name) in priority order:
  // 1. Packaged: extraResources/version.json
  // 2. Dev: electron/version.json (generated by write-version.sh)
  // 3. Fallback: package.json version
  const versionPaths = [
    path.join(process.resourcesPath || "", "version.json"),
    path.join(__dirname, "..", "..", "version.json"),
    path.join(app.getAppPath(), "version.json"),
  ];
  for (const vp of versionPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(vp, "utf8"));
      if (data.version) return data.version;
    } catch {
      // try next path
    }
  }
  return app.getVersion();
});

ipcMain.handle("app:name", () => {
  return app.getName();
});

ipcMain.handle("app:readme", () => {
  // Try several paths for the README file (dev vs packaged)
  const readmePath = (() => {
    const candidates = [path.join(__dirname, "..", "..", "..", "README.md"), path.join(app.getAppPath(), "..", "README.md")];
    if (app.isPackaged) {
      candidates.unshift(path.join(process.resourcesPath, "..", "README.md"));
    }
    return candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  })();
  if (readmePath) {
    try {
      return fs.readFileSync(readmePath, "utf8");
    } catch {
      return "";
    }
  }
  return "";
});

ipcMain.handle("app:guide", () => {
  // Load the end-user guide from docs/end_user_guide.md
  const guidePath = (() => {
    const candidates = [
      path.join(__dirname, "..", "..", "..", "docs", "end_user_guide.md"),
      path.join(app.getAppPath(), "..", "docs", "end_user_guide.md"),
    ];
    if (app.isPackaged) {
      candidates.unshift(path.join(process.resourcesPath, "..", "docs", "end_user_guide.md"));
    }
    return candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  })();
  if (guidePath) {
    try {
      return fs.readFileSync(guidePath, "utf8");
    } catch {
      return "";
    }
  }
  return "";
});

/** Load an arbitrary doc file from the docs/ directory. */
ipcMain.handle("app:doc", (_event, filename: string) => {
  const docPath = (() => {
    const candidates = [path.join(__dirname, "..", "..", "..", "docs", filename), path.join(app.getAppPath(), "..", "docs", filename)];
    if (app.isPackaged) {
      candidates.unshift(path.join(process.resourcesPath, "..", "docs", filename));
    }
    return candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  })();
  if (docPath) {
    try {
      return fs.readFileSync(docPath, "utf8");
    } catch {
      return "";
    }
  }
  return "";
});

/** ML pipeline statuses returned by Python /transcribe/active — jobs that are
 *  actively running in the ML pipeline (diarization, ASR, alignment). */
const ML_PIPELINE_STATUSES = new Set([
  "uploaded",
  "initializing",
  "processing_diarization",
  "matching_voiceprints",
  "processing_transcription",
  "aligning",
  "paused_for_labeling",
  "resuming",
]);

/** Terminal statuses — a job with one of these is definitely done. */
const TERMINAL_STATUSES = new Set(["complete", "delivered", "failed", "corrupted"]);

/** Scan the storage directory for jobs in agent-runner stages (transcribed,
 *  refined, summarized, analyzed, etc.) that the Python /transcribe/active
 *  endpoint (ML pipeline only) would miss. */
function scanAgentStageJobs(storageDir: string): Array<{ job_id: string; status: string; progress: number; title: string }> {
  const results: Array<{ job_id: string; status: string; progress: number; title: string }> = [];
  try {
    if (!fs.existsSync(storageDir)) return results;
    const entries = fs.readdirSync(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["chroma", "logs", "uploads"].includes(entry.name)) continue;
      const statusPath = path.join(storageDir, entry.name, "status.json");
      if (!fs.existsSync(statusPath)) continue;
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        const s = (status.status || "unknown") as string;
        // Skip ML pipeline statuses (handled by Python) and terminal statuses
        if (ML_PIPELINE_STATUSES.has(s) || TERMINAL_STATUSES.has(s)) continue;
        // Also skip if it's a bot-created error placeholder
        if (entry.name.startsWith("error-")) continue;
        const metaPath = path.join(storageDir, entry.name, "metadata.json");
        let title = "Untitled";
        try {
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            title = meta.title || title;
          }
        } catch {
          /* ignore */
        }
        results.push({
          job_id: status.job_id || entry.name,
          status: s,
          progress: status.progress || 0,
          title,
        });
      } catch {
        /* skip corrupt status files */
      }
    }
  } catch {
    /* storage dir not readable */
  }
  return results;
}

ipcMain.handle("jobs:getActive", async () => {
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  const active = new Map<string, { job_id: string; status: string; progress: number; title: string }>();

  // Source 1: Python /transcribe/active (ML pipeline statuses)
  try {
    const res = await fetch("http://127.0.0.1:5001/transcribe/active", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const job of data.active_jobs || []) {
        active.set(job.job_id, job);
      }
    }
  } catch {
    // Backend not running — fall through to disk scan
  }

  // Source 2: Disk scan for agent-runner stages (transcribed, refined, etc.)
  for (const job of scanAgentStageJobs(storageDir)) {
    if (!active.has(job.job_id)) {
      active.set(job.job_id, job);
    }
  }

  return Array.from(active.values());
});

ipcMain.handle("testbot:getRunningJobs", async () => {
  const primaryStorageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  // Try to also find the project-relative storage dir (for CLI-run bot scripts
  // that may not have TRANSCRIPTION_STORAGE set and default to cwd/storage/)
  const projectStorageDir = (() => {
    try {
      const projectRoot = app.isPackaged ? path.join(process.resourcesPath, "..") : path.join(app.getAppPath(), "..");
      const candidate = path.join(projectRoot, "storage");
      return fs.existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  })();

  // Try both paths for the log file, prefer the primary
  const logPaths = [path.join(primaryStorageDir, "test-bot-log.jsonl")];
  if (projectStorageDir && projectStorageDir !== primaryStorageDir) {
    logPaths.push(path.join(projectStorageDir, "test-bot-log.jsonl"));
  }

  // Read all discovered log files and merge job IDs
  const allJobIds = new Set<string>();
  for (const logPath of logPaths) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length === 0) continue;
      // Parse ALL entries (not just the last) to catch all bot runs
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const jobIds: string[] = entry.jobIds || [];
          for (const id of jobIds) allJobIds.add(id);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* skip unreadable */
    }
  }

  if (allJobIds.size === 0) return [];

  // Check status for each discovered job ID across both storage directories
  const statusDirs = [primaryStorageDir];
  if (projectStorageDir && projectStorageDir !== primaryStorageDir) {
    statusDirs.push(projectStorageDir);
  }

  const running: Array<{ job_id: string; status: string }> = [];
  for (const jobId of allJobIds) {
    // Skip error placeholders (e.g. "error-1")
    if (jobId.startsWith("error-")) continue;

    for (const dir of statusDirs) {
      const statusPath = path.join(dir, jobId, "status.json");
      if (!fs.existsSync(statusPath)) continue;
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        const s = (status.status || "unknown") as string;
        if (!TERMINAL_STATUSES.has(s)) {
          running.push({ job_id: jobId, status: s });
        }
        break; // found a status file in this dir — don't check others
      } catch {
        // Corrupted status.json — skip this dir
      }
    }
    // If no status.json was found on disk, the job was likely deleted/cleared
    // or the log entry is stale. Skip silently instead of returning with status
    // "unknown" which would cause the foreign jobs hook to query the backend
    // and get 404 "Job not found" errors.
  }
  return running;
});

// ── Combined service management ──

ipcMain.handle("services:stop", async () => {
  console.log("[ipc] Stopping all services...");
  await stopAll();
  return { success: true };
});

ipcMain.handle("services:restart", async () => {
  console.log("[ipc] Restarting all services...");
  await restartAll();
  return { success: true };
});

ipcMain.handle("app:close", async () => {
  console.log("[ipc] Closing app via user request...");
  app.quit();
  return { success: true };
});

// ── Per-service management ──

const stopFn: Record<string, () => Promise<void>> = {
  python: stopPythonBackend,
  bridge: stopBridgeServer,
  agent: stopAgentRunner,
};
const restartFn: Record<string, () => Promise<void>> = {
  python: restartPythonBackend,
  bridge: restartBridgeServer,
  agent: restartAgentRunner,
};

ipcMain.handle("service:stop", async (_event, service: string) => {
  console.log(`[ipc] Stopping ${service}...`);
  await stopFn[service]?.();
  return { success: true };
});

ipcMain.handle("service:restart", async (_event, service: string) => {
  console.log(`[ipc] Restarting ${service}...`);
  await restartFn[service]?.();
  return { success: true };
});

// ── Log IPC ──

ipcMain.handle("logs:get", () => {
  return getLogs(500);
});

ipcMain.handle("logs:clear", () => {
  clearLogs();
  return { success: true };
});

// ── Config IPC ──

ipcMain.handle("config:get", () => {
  const cfg = getConfig();
  addLog("main", "info", "[config] retrieved");
  return cfg;
});

ipcMain.handle("config:save", async (_event, values: Record<string, string>) => {
  addLog("main", "info", "[config] saving...");
  const updatedConfig = saveConfig(values);

  // Check what changed
  const cfg = checkConfig();
  if (cfg.ok) {
    addLog("main", "info", `Config OK — ${cfg.missing.length} missing values`);
  } else {
    addLog("main", "warn", `Config incomplete — missing: ${cfg.missing.join(", ")}`);
  }

  // If using Ollama, ensure the server is running before restarting the agent.
  // If switching away from Ollama, stop the server if we started it.
  if (updatedConfig.LLM_PROVIDER === "ollama") {
    try {
      const started = await ensureOllamaRunning();
      if (!started) {
        addLog("main", "warn", "[ollama] Server did not start — agent runner may fail to connect, check logs for details");
      }
    } catch (err: any) {
      addLog("main", "error", `[ollama] Unexpected error starting Ollama: ${err.message}`);
    }
  } else if (ollamaStartedByUs()) {
    addLog("main", "info", "[ollama] Provider switched away from Ollama — stopping server");
    stopOllamaServer();
  }

  // Restart agent runner so it picks up the new env vars (e.g. DEEPSEEK_API_KEY)
  // If it wasn't running (due to missing config), start it now.
  try {
    if (isAgentRunning()) {
      await restartAgentRunner();
      addLog("main", "info", "Agent runner restarted after config save");
    } else {
      await startAgentRunner();
      addLog("main", "info", "Agent runner started after config save");
    }
  } catch (err: any) {
    const msg = `Failed to restart agent runner: ${err.message}`;
    console.error(msg);
    addLog("main", "error", msg);
  }

  // ── Restart Python backend if gate configs changed ──
  // Gate 1 (GATE_RAW_REVIEW_ENABLED) is enforced inside the Python backend at
  // import time via os.getenv(). The agent runner restart above doesn't affect
  // the Python process, so we must restart it to pick up the new values.
  // Gate 2 (GATE_DELIVERY_REVIEW_ENABLED) is handled by the agent runner which
  // IS restarted above.
  const GATE_KEYS = new Set(["GATE_RAW_REVIEW_ENABLED", "GATE_DELIVERY_REVIEW_ENABLED"]);
  const hasGateChanges = Object.keys(values).some((k) => GATE_KEYS.has(k));
  if (hasGateChanges) {
    try {
      const activeRes = await fetch("http://127.0.0.1:5001/transcribe/active", {
        signal: AbortSignal.timeout(3000),
      });
      let hasActiveJobs = false;
      let activeData: any = null;
      if (activeRes.ok) {
        activeData = await activeRes.json();
        hasActiveJobs = (activeData.active_jobs || []).length > 0;
      }
      if (hasActiveJobs) {
        addLog(
          "main",
          "warn",
          `Gate config changed but ${(activeData.active_jobs || []).length} job(s) running — Python backend NOT restarted. Gates apply after next restart.`,
        );
      } else {
        await restartPythonBackend();
        addLog("main", "info", "Python backend restarted after gate config change");
      }
    } catch {
      // Backend unreachable — restart anyway to pick up env vars
      await restartPythonBackend();
      addLog("main", "info", "Python backend restarted after gate config change (backend was unreachable)");
    }
  }

  return getConfig();
});

ipcMain.handle("config:check", () => {
  const cfg = checkConfig();
  addLog("main", cfg.ok ? "info" : "warn", `Config check: ${cfg.ok ? "OK" : `missing ${cfg.missing.join(", ")}`}`);
  return cfg;
});

ipcMain.handle("config:getWithSources", () => {
  return getConfigWithSources();
});

// ── Aggregate Token Usage ──

ipcMain.handle("api:getAggregateUsage", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5010/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "transcribe_get_aggregate_usage", args: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      addLog("main", "info", `[USAGE] Aggregate token usage fetched: ${data.job_count} jobs, ${data.totals?.total_tokens || 0} total tokens`);
      return data;
    }
    addLog("main", "warn", `[USAGE] Aggregate token usage fetch failed: bridge returned ${res.status}`);
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    addLog("main", "warn", `[USAGE] Aggregate token usage fetch failed: ${err.message}`);
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

// ── DeepSeek API Credit / Balance ──

ipcMain.handle("api:checkDeepSeekBalance", async () => {
  const cfg = getConfig();
  const apiKey = cfg.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) {
    addLog("main", "warn", "[USAGE] Credit balance check skipped — no API key configured");
    return { available: false, balance: null, error: "No API key configured" };
  }
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown");
      addLog("main", "warn", `[USAGE] Credit balance check failed: API Error ${res.status}`);
      return { available: false, balance: null, error: `API Error ${res.status}: ${text}` };
    }
    const data = await res.json();
    // DeepSeek returns:
    //   { balance_infos: [{ total_balance: "12.34", topped_up_balance: "10.00", grant_balance: "2.34" }], is_available: true }
    // Extract total_balance from the first balance_info entry (fall back to flat `balance` for older API versions).
    const balance = data.balance_infos?.[0]?.total_balance ?? data.balance ?? null;
    addLog("main", "info", `[USAGE] Credit balance checked: $${balance || "0"} (available: ${data.is_available ?? true})`);
    return {
      available: data.is_available ?? true,
      balance,
      error: null,
    };
  } catch (err: any) {
    addLog("main", "warn", `[USAGE] Credit balance check failed: ${err.message}`);
    return { available: false, balance: null, error: err.message };
  }
});

// ── Config Export / Import / Clear IPC ──

ipcMain.handle("config:clear", async () => {
  addLog("main", "info", "[config] clear requested");
  try {
    // Check for active jobs before allowing clear
    let hasActiveJobs = false;
    try {
      const activeRes = await fetch("http://127.0.0.1:5001/transcribe/active", {
        signal: AbortSignal.timeout(3000),
      });
      if (activeRes.ok) {
        const activeData = await activeRes.json();
        hasActiveJobs = (activeData.active_jobs || []).length > 0;
      }
    } catch {
      // backend unreachable
    }

    if (hasActiveJobs) {
      addLog("main", "warn", "[config] clear blocked — active jobs running");
      return { success: false, blocked: true, error: "Cannot clear configuration while jobs are running. Wait for jobs to complete." };
    }

    clearConfig();
    addLog("main", "info", "User config cleared — all values reverted to defaults");

    // If Ollama was started by us, stop it
    if (ollamaStartedByUs()) {
      addLog("main", "info", "[ollama] Stopping server after config clear");
      stopOllamaServer();
    }

    // Restart agent runner so it picks up empty config
    try {
      if (isAgentRunning()) {
        await restartAgentRunner();
      } else {
        await startAgentRunner();
      }
      addLog("main", "info", "Agent runner restarted after config clear");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart agent runner after config clear: ${err.message}`);
    }

    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `Config clear failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("config:export", async () => {
  addLog("main", "info", "[config] export requested");
  try {
    // Read user config file
    const userDataPath = app.getPath("userData");
    const configPath = path.join(userDataPath, "config.json");
    let userConfig: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      userConfig = JSON.parse(raw);
    }

    // Read user config defaults snapshot
    const userDefaultsConfig = readUserConfigDefaults();

    // Try to read agent config from bridge
    let agentConfig: any = null;
    try {
      const res = await fetch("http://127.0.0.1:5010/agent/config", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) agentConfig = await res.json();
    } catch {
      addLog("main", "warn", "Agent config unavailable for export — bridge not reachable");
    }

    // Try to read shipped defaults from bridge
    let defaultsConfig: any = null;
    try {
      const res = await fetch("http://127.0.0.1:5010/agent/config/defaults", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) defaultsConfig = await res.json();
    } catch {
      addLog("main", "debug", "Defaults config unavailable for export — bridge not reachable");
    }

    const exportData = {
      version: 3,
      exportedAt: new Date().toISOString(),
      userConfig,
      userDefaultsConfig,
      agentConfig,
      defaultsConfig,
    };

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Export Configuration",
      defaultPath: path.join(app.getPath("documents"), `transcription-agent-config-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: "JSON Config", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) {
      addLog("main", "info", "[config] export cancelled by user");
      return { success: false, cancelled: true };
    }

    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), "utf8");
    addLog("main", "info", `Config exported to ${result.filePath}`);
    return { success: true, filePath: result.filePath };
  } catch (err: any) {
    addLog("main", "error", `Config export failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("config:import", async () => {
  addLog("main", "info", "[config] import requested");
  try {
    // Check for active jobs before allowing import
    let hasActiveJobs = false;
    try {
      const activeRes = await fetch("http://127.0.0.1:5001/transcribe/active", {
        signal: AbortSignal.timeout(3000),
      });
      if (activeRes.ok) {
        const activeData = await activeRes.json();
        const jobs = activeData.active_jobs || [];
        hasActiveJobs = jobs.length > 0;
        if (hasActiveJobs) {
          addLog("main", "warn", `Config import blocked — ${jobs.length} active job(s) running`);
          return {
            success: false,
            error: `Cannot import configuration while ${jobs.length} job(s) are running. Wait for jobs to complete or cancel them first.`,
            blocked: true,
          };
        }
      }
    } catch {
      // Backend not reachable — proceed (no active jobs to report)
      addLog("main", "debug", "Active job check skipped — backend not reachable");
    }

    // Show open dialog
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Import Configuration",
      filters: [{ name: "JSON Config", extensions: ["json"] }],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      addLog("main", "info", "[config] import cancelled by user");
      return { success: false, cancelled: true };
    }

    const filePath = result.filePaths[0];
    const raw = fs.readFileSync(filePath, "utf8");
    const importData = JSON.parse(raw);

    // Validate format
    if (!importData.version || !importData.userConfig) {
      return { success: false, error: "Invalid config file format — missing version or userConfig" };
    }

    // Import user config
    const updatedConfig = saveConfig(importData.userConfig);
    addLog("main", "info", "User config imported successfully");

    // Check config completeness
    const cfgCheck = checkConfig();
    if (cfgCheck.ok) {
      addLog("main", "info", `Config OK — ${cfgCheck.missing.length} missing values`);
    } else {
      addLog("main", "warn", `Config incomplete — missing: ${cfgCheck.missing.join(", ")}`);
    }

    // If using Ollama, ensure the server is running before restarting services
    if (updatedConfig.LLM_PROVIDER === "ollama") {
      try {
        const started = await ensureOllamaRunning();
        if (!started) {
          addLog("main", "warn", "[ollama] Server did not start — services may fail to connect, check logs for details");
        }
      } catch (err: any) {
        addLog("main", "error", `[ollama] Unexpected error starting Ollama: ${err.message}`);
      }
    } else if (ollamaStartedByUs()) {
      addLog("main", "info", "[ollama] Provider switched away from Ollama — stopping server");
      stopOllamaServer();
    }

    // Reset all services so they pick up the new config
    try {
      await restartAll();
      addLog("main", "info", "All services restarted after config import");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart all services: ${err.message}`);
      // Fall back to starting services individually
      try {
        await startAll();
        addLog("main", "info", "Services started after config import (fallback)");
      } catch (err2: any) {
        addLog("main", "error", `Failed to start services: ${err2.message}`);
      }
    }

    // Import agent config if present (agent-specific instructions like prompts & pipeline hints)
    let agentConfigImported = false;
    if (importData.agentConfig) {
      // Dual-path: try bridge first (live system), fall back to direct disk write (clean install)
      let agentPayload: any = {};
      if (importData.agentConfig.systemPrompt !== undefined) agentPayload.systemPrompt = importData.agentConfig.systemPrompt;
      if (importData.agentConfig.pipeline !== undefined) agentPayload.pipeline = importData.agentConfig.pipeline;
      if (importData.agentConfig.tools !== undefined) agentPayload.tools = importData.agentConfig.tools;

      let bridgeOk = false;
      try {
        const res = await fetch("http://127.0.0.1:5010/agent/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(agentPayload),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          bridgeOk = true;
          agentConfigImported = true;
          addLog("main", "info", "Agent config imported successfully via bridge");
        } else {
          addLog("main", "warn", `Agent config import via bridge returned status ${res.status} — falling back to direct write`);
        }
      } catch {
        addLog("main", "warn", "Bridge not reachable for agent config import — falling back to direct write");
      }

      if (!bridgeOk) {
        // Write directly to userData/agent-config/ (works on clean install, no bridge dependency)
        const result = saveAgentConfigToDisk({
          systemPrompt: importData.agentConfig.systemPrompt,
          pipeline: importData.agentConfig.pipeline,
          tools: importData.agentConfig.tools,
        });
        if (result.success) {
          agentConfigImported = true;
          addLog("main", "info", `Agent config imported directly to disk: ${result.written.join(", ")}`);
        } else {
          addLog("main", "error", `Agent config direct write failed: ${result.error}`);
        }
      }
    }

    // Import user config defaults if present (user defaults snapshot to config.defaults.json)
    let userDefaultsImported = false;
    if (importData.userDefaultsConfig) {
      try {
        const defaultsPath = path.join(app.getPath("userData"), "config.defaults.json");
        fs.writeFileSync(defaultsPath, JSON.stringify(importData.userDefaultsConfig, null, 2), "utf8");
        userDefaultsImported = true;
        addLog("main", "info", "User config defaults imported successfully to config.defaults.json");
      } catch (err: any) {
        addLog("main", "warn", `User config defaults import failed: ${err.message}`);
      }
    }

    // Import defaults config if present (shipped-defaults snapshot to .defaults/)
    let defaultsImported = false;
    if (importData.defaultsConfig) {
      // Dual-path: try bridge first, fall back to direct write
      let bridgeOk = false;
      try {
        const defaultsPayload: any = {};
        if (importData.defaultsConfig.systemPrompt !== undefined) defaultsPayload.systemPrompt = importData.defaultsConfig.systemPrompt;
        if (importData.defaultsConfig.pipeline !== undefined) defaultsPayload.pipeline = importData.defaultsConfig.pipeline;
        if (importData.defaultsConfig.tools !== undefined) defaultsPayload.tools = importData.defaultsConfig.tools;

        const res = await fetch("http://127.0.0.1:5010/agent/config/defaults", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(defaultsPayload),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          bridgeOk = true;
          defaultsImported = true;
          addLog("main", "info", "Defaults config imported successfully via bridge");
        } else {
          addLog("main", "warn", `Defaults config import via bridge returned status ${res.status} — falling back to direct write`);
        }
      } catch {
        addLog("main", "warn", "Bridge not reachable for defaults import — falling back to direct write");
      }

      if (!bridgeOk) {
        // Write directly to userData/agent-config/.defaults/
        try {
          const agentConfigDir = path.join(app.getPath("userData"), "agent-config", ".defaults");
          fs.mkdirSync(agentConfigDir, { recursive: true });
          const written: string[] = [];

          if (importData.defaultsConfig.systemPrompt !== undefined) {
            fs.writeFileSync(path.join(agentConfigDir, "system-prompt.md"), importData.defaultsConfig.systemPrompt, "utf8");
            written.push("system-prompt.md");
          }
          if (importData.defaultsConfig.pipeline !== undefined) {
            fs.writeFileSync(path.join(agentConfigDir, "pipeline.json"), JSON.stringify(importData.defaultsConfig.pipeline, null, 2), "utf8");
            written.push("pipeline.json");
          }
          if (importData.defaultsConfig.tools !== undefined) {
            fs.writeFileSync(path.join(agentConfigDir, "tools.json"), JSON.stringify(importData.defaultsConfig.tools, null, 2), "utf8");
            written.push("tools.json");
          }

          defaultsImported = true;
          addLog("main", "info", `Defaults config imported directly to disk: ${written.join(", ")}`);
        } catch (err: any) {
          addLog("main", "error", `Defaults config direct write failed: ${err.message}`);
        }
      }
    }

    return { success: true, agentConfigImported, defaultsImported, userDefaultsImported, filePath };
  } catch (err: any) {
    addLog("main", "error", `Config import failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── User Config Defaults IPC ──

ipcMain.handle("config:defaults", async () => {
  addLog("main", "info", "[config] defaults requested");
  try {
    const defaults = readUserConfigDefaults();
    return { success: true, defaults };
  } catch (err: any) {
    addLog("main", "error", `Failed to read user config defaults: ${err.message}`);
    return { success: false, error: err.message, defaults: {} };
  }
});

ipcMain.handle("config:restore-defaults", async () => {
  addLog("main", "info", "[config] restore-defaults requested");
  try {
    // Check for active jobs before allowing restore
    let hasActiveJobs = false;
    try {
      const activeRes = await fetch("http://127.0.0.1:5001/transcribe/active", {
        signal: AbortSignal.timeout(3000),
      });
      if (activeRes.ok) {
        const activeData = await activeRes.json();
        hasActiveJobs = (activeData.active_jobs || []).length > 0;
      }
    } catch {
      // backend unreachable
    }

    if (hasActiveJobs) {
      addLog("main", "warn", "[config] restore-defaults blocked — active jobs running");
      return { success: false, blocked: true, error: "Cannot restore defaults while jobs are running. Wait for jobs to complete." };
    }

    const config = restoreUserConfigDefaults();
    addLog("main", "info", "User config restored from defaults snapshot");

    // If Ollama was started by us, ensure it's still running
    if (config.LLM_PROVIDER === "ollama") {
      try {
        const started = await ensureOllamaRunning();
        if (!started) {
          addLog("main", "warn", "[ollama] Server did not start after restore");
        }
      } catch (err: any) {
        addLog("main", "error", `[ollama] Error starting Ollama: ${err.message}`);
      }
    } else if (ollamaStartedByUs()) {
      addLog("main", "info", "[ollama] Provider switched away from Ollama — stopping server");
      stopOllamaServer();
    }

    // Restart all services so they pick up the restored config
    try {
      if (isAgentRunning()) {
        await restartAgentRunner();
      } else {
        await startAgentRunner();
      }
      addLog("main", "info", "Agent runner restarted after user config restore");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart agent runner after user config restore: ${err.message}`);
    }

    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `User config restore failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── Agent Config IPC ──

ipcMain.handle("agent-config:get", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5010/agent/config", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return await res.json();
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

ipcMain.handle("agent-config:save", async (_event, config: { tools?: any; pipeline?: any; systemPrompt?: string }) => {
  addLog("main", "info", "Agent config saving...");

  // Dual-path: try bridge first (live system), fall back to direct disk write
  let bridgeOk = false;
  try {
    const res = await fetch("http://127.0.0.1:5010/agent/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const result = await res.json();
      addLog("main", "info", "Agent config saved via bridge");
      bridgeOk = true;
      return result;
    }
    const errText = await res.text();
    addLog("main", "warn", `Agent config save via bridge returned ${res.status}: ${errText} — falling back to direct write`);
  } catch (err: any) {
    addLog("main", "warn", `Agent config save via bridge failed: ${err.message} — falling back to direct write`);
  }

  if (!bridgeOk) {
    // Write directly to userData/agent-config/ (works even if bridge is restarting)
    const result = saveAgentConfigToDisk({
      systemPrompt: config.systemPrompt,
      pipeline: config.pipeline,
      tools: config.tools,
    });
    if (result.success) {
      addLog("main", "info", `Agent config saved directly to disk: ${result.written.join(", ")}`);
      return { success: true, written: result.written, direct: true };
    }
    addLog("main", "error", `Agent config direct write failed: ${result.error}`);
    return { error: `Direct write failed: ${result.error}` };
  }
});

ipcMain.handle("agent-config:defaults", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5010/agent/config/defaults", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return await res.json();
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

ipcMain.handle("agent-config:restore-defaults", async () => {
  addLog("main", "info", "Restoring default agent configs...");
  try {
    const res = await fetch("http://127.0.0.1:5010/agent/config/restore-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const result = await res.json();
      addLog("main", "info", `Default agent configs restored: ${result.restored?.join(", ")}`);
      return result;
    }
    const errText = await res.text();
    addLog("main", "error", `Restore defaults failed: ${errText}`);
    return { error: `Bridge returned ${res.status}: ${errText}` };
  } catch (err: any) {
    addLog("main", "error", `Restore defaults failed: ${err.message}`);
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

ipcMain.handle("agent-config:restart", async () => {
  addLog("main", "info", "Flagging agent runner restart...");
  try {
    // Touch the restart flag via the bridge
    const res = await fetch("http://127.0.0.1:5010/agent/config/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      addLog("main", "info", "Agent runner restart flagged via bridge");
      return { success: true };
    }
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    addLog("main", "error", `Failed to flag restart: ${err.message}`);
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

// ── Storage Usage ──

ipcMain.handle("storage:usage", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5010/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "storage_usage", args: {} }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return await res.json();
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

// ── Auto-Update IPC ──

registerAutoUpdateIpc();

// ── Performance Metrics IPC ──

/** In-memory buffer: jobId -> PerformanceSnapshot[] */
interface PerfSample {
  timestamp: number;
  cpu: number;
  memoryBytes: number;
  label: string;
  /** Pipeline stage key at time of sample (e.g. "transcription", "agent") */
  stage: string | null;
}

/** Map backend status values to pipeline stage keys (mirrors DevPanel) */
const STATUS_TO_STAGE: Record<string, string> = {
  uploaded: "uploaded",
  initializing: "initializing",
  processing_diarization: "diarization",
  matching_voiceprints: "voiceprints",
  processing_transcription: "transcription",
  aligning: "aligning",
  transcribed: "agent",
  ready_for_agent: "agent",
  labeling_needed: "agent",
  refined: "agent",
  summarized: "agent",
  analyzed: "memory",
  delivered: "delivery",
  complete: "delivery",
};

const jobPerfBuffers: Map<string, PerfSample[]> = new Map();
let perfSamplerInterval: ReturnType<typeof setInterval> | null = null;

/** Start/restart the periodic performance sampler that captures per-job data. */
function ensurePerfSampler() {
  if (perfSamplerInterval) return;
  perfSamplerInterval = setInterval(async () => {
    try {
      // Check for active jobs
      const res = await fetch("http://127.0.0.1:5001/transcribe/active", {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const jobs: Array<{ job_id: string; status: string; progress: number }> = data.active_jobs || [];

      if (jobs.length > 0) {
        setCurrentJobId(jobs[0].job_id);
      }
      // Don't clear _currentJobId here when no active ML jobs — the agent
      // runner sets it via [JOB_START] markers, and _detectPipelineEnd()
      // inside addLog() clears it when the job completes or fails.

      if (jobs.length === 0) return;

      // Capture pidusage for all child processes
      const childPids = getChildPids();
      const pidMap: Record<number, string> = {};
      const pids: number[] = [];
      for (const [service, pid] of Object.entries(childPids)) {
        if (pid) {
          pidMap[pid] = service;
          pids.push(pid);
        }
      }
      let childStats: Record<string, { cpu: number; memory: number }> = {};
      if (pids.length > 0) {
        try {
          const stats = await pidusage(pids);
          for (const [pidStr, stat] of Object.entries(stats)) {
            const service = pidMap[Number(pidStr)] || "unknown";
            childStats[service] = { cpu: stat.cpu, memory: stat.memory };
          }
        } catch {
          /* ignore */
        }
      }

      // Save snapshot for each active job
      const now = Date.now();
      for (const job of jobs) {
        const jobId = job.job_id;
        if (!jobId) continue;
        const stageKey = STATUS_TO_STAGE[job.status] || null;
        if (!jobPerfBuffers.has(jobId)) jobPerfBuffers.set(jobId, []);
        const buf = jobPerfBuffers.get(jobId)!;
        for (const [label, stats] of Object.entries(childStats)) {
          buf.push({ timestamp: now, cpu: stats.cpu, memoryBytes: stats.memory, label, stage: stageKey });
        }
        // Trim to last 500 samples per job
        if (buf.length > 500) jobPerfBuffers.set(jobId, buf.slice(-500));
      }
    } catch {
      /* backend not reachable */
    }
  }, 5000);
}

function stopPerfSampler() {
  if (perfSamplerInterval) {
    clearInterval(perfSamplerInterval);
    perfSamplerInterval = null;
  }
}

// Call ensurePerfSampler on startup
setTimeout(ensurePerfSampler, 10000);

ipcMain.handle("metrics:getPerJobPerformance", async (_event, jobId: string) => {
  // First try in-memory buffer
  const buf = jobPerfBuffers.get(jobId);
  if (buf && buf.length > 0) return buf;
  // Try reading from disk
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  const perfPath = path.join(storageDir, jobId, "performance.jsonl");
  try {
    if (fs.existsSync(perfPath)) {
      const lines = fs.readFileSync(perfPath, "utf8").split("\n").filter(Boolean);
      return lines.map((l) => JSON.parse(l));
    }
  } catch {
    /* ignore */
  }
  return [];
});

ipcMain.handle("metrics:getAggregatePerformance", async () => {
  // Collect all in-memory buffers
  const result: Array<{ jobId: string; samples: PerfSample[] }> = [];
  for (const [jobId, samples] of jobPerfBuffers) {
    if (samples.length > 0) result.push({ jobId, samples });
  }
  // Also scan storage dir for persisted performance data
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  try {
    if (fs.existsSync(storageDir)) {
      const dirs = fs.readdirSync(storageDir);
      for (const entry of dirs) {
        const perfPath = path.join(storageDir, entry, "performance.jsonl");
        if (fs.existsSync(perfPath)) {
          // If not already in-memory, read from disk
          if (!jobPerfBuffers.has(entry)) {
            try {
              const lines = fs.readFileSync(perfPath, "utf8").split("\n").filter(Boolean);
              const samples = lines.map((l) => JSON.parse(l));
              if (samples.length > 0) result.push({ jobId: entry, samples });
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return result;
});

ipcMain.handle("metrics:getAll", async () => {
  // 1. Electron app metrics (main, renderer, GPU, utility processes)
  let electronMetrics: any[] = [];
  try {
    electronMetrics = app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: m.cpu?.percentCPUUsage ?? null,
      memory: m.memory?.workingSetSize ?? null,
      peakMemory: m.memory?.peakWorkingSetSize ?? null,
    }));
  } catch {
    // app.getAppMetrics is available from Electron 5+
  }

  // 2. Child process metrics via pidusage
  const childPids = getChildPids();
  const pidMap: Record<number, { service: string }> = {};
  const pids: number[] = [];
  for (const [service, pid] of Object.entries(childPids)) {
    if (pid) {
      pidMap[pid] = { service };
      pids.push(pid);
    }
  }

  let childMetrics: any[] = [];
  if (pids.length > 0) {
    try {
      const stats = await pidusage(pids);
      for (const [pidStr, stat] of Object.entries(stats)) {
        const pid = Number(pidStr);
        childMetrics.push({
          service: pidMap[pid]?.service ?? "unknown",
          pid,
          cpu: stat.cpu,
          memory: stat.memory,
          elapsed: stat.elapsed,
        });
      }
    } catch {
      // pidusage may fail if a process exited between the check
    }
  }

  return { electron: electronMetrics, children: childMetrics };
});

// ── Job log file browsing ──

ipcMain.handle("logs:listJobLogFiles", () => {
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  return listJobLogFiles(storageDir);
});

ipcMain.handle("logs:readJobLogFile", async (_event, jobId: string, maxLines?: number) => {
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  const logPath = path.join(storageDir, jobId, "pipeline.log");
  if (!fs.existsSync(logPath)) return [];
  return readLogFile(logPath, maxLines ?? 0);
});

// ── Shell (open folder in file manager) ──

ipcMain.handle("shell:openPath", async (_event, filePath: string) => {
  addLog("main", "info", `[shell] Opening path in file manager: ${filePath}`);
  const error = await shell.openPath(filePath);
  if (error) {
    addLog("main", "error", `[shell] Failed to open path: ${error}`);
    return { success: false, error };
  }
  return { success: true };
});

// ── Run command in new Terminal window ──

ipcMain.handle("shell:runInTerminal", async (_event, params: { command: string; cwd?: string }) => {
  const projectRoot = app.isPackaged ? path.join(process.resourcesPath, "..") : path.join(app.getAppPath(), "..");
  const cwd = params.cwd || projectRoot;
  const script = `tell application "Terminal" to do script "cd ${cwd.replace(/"/g, '\\"')} && ${params.command.replace(/"/g, '\\"')}"`;
  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\\\''")}'`, { timeout: 5000 });
    addLog("main", "info", `[shell] Opened Terminal: ${params.command}`);
    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `[shell] Failed to open Terminal: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── Cloudflare Tunnel Process Manager ──

let tunnelProcess: import("child_process").ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelError: string | null = null;
const CLOUDFLARED_URL_FILE = path.join(app.isPackaged ? app.getPath("userData") : path.join(app.getAppPath(), ".."), ".cloudflared-url");

ipcMain.handle("tunnel:start", async () => {
  if (tunnelProcess) {
    return { success: false, error: "Tunnel is already running", running: true, url: tunnelUrl };
  }
  tunnelUrl = null;
  tunnelError = null;
  addLog("main", "info", "[tunnel] Starting cloudflared tunnel on port 18888");
  return new Promise<{ success: boolean; error?: string; url?: string }>((resolve) => {
    try {
      const proc = spawn("cloudflared", ["tunnel", "--url", "http://localhost:18888"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      tunnelProcess = proc;
      let resolved = false;
      proc.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        addLog("main", "debug", `[tunnel] ${text.trim()}`);
        // Parse the cloudflared URL from stdout: "https://xxxx.trycloudflare.com"
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          tunnelUrl = match[0];
          // Write URL to file for gist updater script
          try {
            fs.writeFileSync(CLOUDFLARED_URL_FILE, tunnelUrl + "\n", "utf8");
          } catch {}
          addLog("main", "info", `[tunnel] Cloudflare tunnel URL: ${tunnelUrl}`);
          resolve({ success: true, url: tunnelUrl });
        }
      });
      proc.stderr?.on("data", (d: Buffer) => {
        const text = d.toString();
        addLog("main", "debug", `[tunnel:stderr] ${text.trim()}`);
        // Cloudflared sometimes emits warnings to stderr — don't treat as fatal
        const errMatch = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (errMatch && !resolved) {
          resolved = true;
          tunnelUrl = errMatch[0];
          try {
            fs.writeFileSync(CLOUDFLARED_URL_FILE, tunnelUrl + "\n", "utf8");
          } catch {}
          addLog("main", "info", `[tunnel] Cloudflare tunnel URL (from stderr): ${tunnelUrl}`);
          resolve({ success: true, url: tunnelUrl });
        }
      });
      proc.on("close", (code) => {
        tunnelProcess = null;
        addLog("main", "info", `[tunnel] Process exited with code ${code}`);
        if (!resolved) {
          resolved = true;
          tunnelError = `cloudflared exited with code ${code}`;
          resolve({ success: false, error: tunnelError });
        }
      });
      proc.on("error", (err) => {
        tunnelProcess = null;
        addLog("main", "error", `[tunnel] Failed to start: ${err.message}`);
        if (!resolved) {
          resolved = true;
          tunnelError = err.message;
          resolve({ success: false, error: err.message });
        }
      });
      // Timeout: if cloudflared doesn't produce a URL within 30s, fail
      setTimeout(() => {
        if (!resolved && tunnelProcess) {
          resolved = true;
          tunnelError = "Timed out waiting for tunnel URL (30s)";
          addLog("main", "error", `[tunnel] ${tunnelError}`);
          resolve({ success: false, error: tunnelError });
        }
      }, 30000);
    } catch (err: any) {
      tunnelError = err.message;
      addLog("main", "error", `[tunnel] Spawn error: ${err.message}`);
      resolve({ success: false, error: err.message });
    }
  });
});

ipcMain.handle("tunnel:stop", async () => {
  if (!tunnelProcess) {
    return { success: false, error: "Tunnel is not running" };
  }
  addLog("main", "info", "[tunnel] Stopping cloudflared tunnel");
  tunnelProcess.kill("SIGTERM");
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelError = null;
  // Remove URL file
  try { fs.unlinkSync(CLOUDFLARED_URL_FILE); } catch {}
  return { success: true };
});

ipcMain.handle("tunnel:status", async () => {
  return {
    running: tunnelProcess !== null,
    url: tunnelUrl,
    error: tunnelError,
  };
});

// ── Gist Updater Process Manager ──

let gistProcess: import("child_process").ChildProcess | null = null;
let gistLastOutput: string | null = null;
let gistLastUpdate: string | null = null;
let gistError: string | null = null;

function getProjectRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "..") : path.join(app.getAppPath(), "..");
}

ipcMain.handle("gist:start", async () => {
  if (gistProcess) {
    return { success: false, error: "Gist updater is already running", running: true };
  }
  gistLastOutput = null;
  gistLastUpdate = null;
  gistError = null;
  addLog("main", "info", "[gist] Starting gist updater (watch -n 30)");
  const projectRoot = getProjectRoot();
  const scriptPath = path.join(projectRoot, "scripts", "update-dsmon-gist.sh");
  try {
    const proc = spawn("watch", ["-n", "30", scriptPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    gistProcess = proc;
    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (text.trim()) {
        gistLastOutput = text.trim();
        gistLastUpdate = new Date().toISOString();
        addLog("main", "debug", `[gist] ${text.trim()}`);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (text.trim()) {
        gistError = text.trim();
        addLog("main", "warn", `[gist:stderr] ${text.trim()}`);
      }
    });
    proc.on("close", (code) => {
      gistProcess = null;
      addLog("main", "info", `[gist] Process exited with code ${code}`);
    });
    proc.on("error", (err) => {
      gistProcess = null;
      gistError = err.message;
      addLog("main", "error", `[gist] Failed to start: ${err.message}`);
    });
    return { success: true };
  } catch (err: any) {
    gistError = err.message;
    addLog("main", "error", `[gist] Spawn error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("gist:stop", async () => {
  if (!gistProcess) {
    return { success: false, error: "Gist updater is not running" };
  }
  addLog("main", "info", "[gist] Stopping gist updater");
  gistProcess.kill("SIGTERM");
  gistProcess = null;
  return { success: true };
});

ipcMain.handle("gist:status", async () => {
  return {
    running: gistProcess !== null,
    lastUpdate: gistLastUpdate,
    lastOutput: gistLastOutput,
    error: gistError,
  };
});

ipcMain.handle("gist:runOnce", async () => {
  addLog("main", "info", "[gist] Running one-shot gist update");
  const projectRoot = getProjectRoot();
  const scriptPath = path.join(projectRoot, "scripts", "update-dsmon-gist.sh");
  try {
    const result = execSync(`bash "${scriptPath}"`, {
      cwd: projectRoot,
      timeout: 30000,
      env: { ...process.env },
      encoding: "utf8",
    });
    addLog("main", "info", `[gist] One-shot result: ${result.trim()}`);
    gistLastUpdate = new Date().toISOString();
    gistLastOutput = result.trim();
    return { success: true, output: result.trim() };
  } catch (err: any) {
    const msg = err.stderr?.toString() || err.message || "Unknown error";
    addLog("main", "error", `[gist] One-shot failed: ${msg}`);
    return { success: false, error: msg };
  }
});

// ── Voiceprint conflict checking ──

ipcMain.handle("voiceprints:check-conflicts", async (_event, attendees: Array<{ name: string; email?: string }>) => {
  try {
    const res = await fetch("http://127.0.0.1:5010/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "voiceprint_check_conflicts", args: { attendees } }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return await res.json();
    return { conflicts: [] };
  } catch {
    return { conflicts: [] };
  }
});

// ── Label verification (Mitigation 1: voiceprint-backed label verification) ──

ipcMain.handle("labels:verify", async (_event, payload: { jobId: string; labels: Array<{ speaker_id: string; name: string; email?: string }> }) => {
  try {
    const res = await fetch("http://127.0.0.1:5010/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "transcribe_verify_labels", args: { jobId: payload.jobId, labels: payload.labels } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return await res.json();
    return { verifications: [], unregistered_names: [], registered_attendees: [] };
  } catch {
    return { verifications: [], unregistered_names: [], registered_attendees: [] };
  }
});

// ── Playwright Testing IPC ──

ipcMain.handle("testing:checkDevMode", async () => {
  return { devMode: !app.isPackaged };
});

ipcMain.handle("testing:run", async (_event, vars: Record<string, string>) => {
  addLog("main", "info", "[testing] Starting Playwright screenshot tests");
  try {
    // 1. Save any test variable overrides to config
    if (vars && Object.keys(vars).length > 0) {
      saveConfig(vars);
    }

    // 2. Resolve the electron directory for the playwright project
    const appPath = app.getAppPath();
    const electronDir = app.isPackaged ? path.join(process.resourcesPath, "..", "electron") : appPath; // In dev, appPath is electron/

    // 3. Set the env vars from config so playwright reads them
    const cfg = getConfig();
    const testEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Pass ts-node config so TypeScript test files can use import statements
      TS_NODE_PROJECT: "tsconfig.playwright.json",
      NODE_OPTIONS: "--require ts-node/register",
      PLAYWRIGHT_AUDIO_FILE_PATH: cfg.PLAYWRIGHT_AUDIO_FILE_PATH || "",
      PLAYWRIGHT_TITLE_TEMPLATE: cfg.PLAYWRIGHT_TITLE_TEMPLATE || "test {autoNum}",
      PLAYWRIGHT_GENERIC_NAMES:
        cfg.PLAYWRIGHT_GENERIC_NAMES ||
        "Alex,Blake,Casey,Drew,Ellis,Finley,Gray,Harper,Indigo,Jade,Kai,Logan,Morgan,Nico,Oakley,Parker,Quinn,Reese,Skyler,Taylor",
    };

    // 4. Spawn Playwright in the electron directory
    // On Windows, npx is npx.cmd which requires a shell to resolve
    const child = spawn("npx", ["playwright", "test", "tests/screenshots/", "--headed"], {
      cwd: electronDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: testEnv,
      shell: process.platform === "win32",
    });

    let output = "";
    const onData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("testing:output", text);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    return await new Promise<{ exitCode: number; output: string }>((resolve) => {
      child.on("close", (code) => {
        addLog("main", "info", `[testing] Playwright exited with code ${code}`);
        resolve({ exitCode: code ?? -1, output });
      });
      child.on("error", (err) => {
        addLog("main", "error", `[testing] Failed to spawn Playwright: ${err.message}`);
        resolve({ exitCode: -1, output: `Failed to spawn: ${err.message}` });
      });
    });
  } catch (err: any) {
    addLog("main", "error", `[testing] Unexpected error: ${err.message}`);
    return { exitCode: -1, output: `Unexpected error: ${err.message}` };
  }
});

// ── Playwright Build Check IPC ──

ipcMain.handle("testing:checkBuild", async () => {
  // Check if the built Electron main process exists — required by Playwright
  const appPath = app.getAppPath();
  const buildPath = path.join(appPath, "dist", "main", "index.js");
  try {
    const exists = fs.existsSync(buildPath);
    let builtAt: string | null = null;
    if (exists) {
      const stat = fs.statSync(buildPath);
      builtAt = stat.mtime.toISOString();
    }
    addLog("main", "debug", `[testing] Build check: ${buildPath} ${exists ? "found (" + builtAt + ")" : "missing"}`);
    return { exists, builtAt };
  } catch {
    return { exists: false, builtAt: null };
  }
});

// ── Bot Testing IPC ──
// Tracks the active bot child process so it can be stopped

let botProcess: import("child_process").ChildProcess | null = null;

/** Resolve the directory where the bot test script is stored.
 *  In packaged mode, uses userData (writable); in dev, uses the project scripts/ dir. */
function getBotScriptDir(): string {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "scripts");
  }
  return path.join(app.getAppPath(), "..", "scripts");
}

/** Resolve the bundled Node.js binary path, or null if not found. */
function getBundledNodePath(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "node-bin", process.platform === "win32" ? "node.exe" : "node");
    return fs.existsSync(bundled) ? bundled : null;
  }
  // Dev: check dist-resources/node-bin/
  const devPath = path.join(app.getAppPath(), "..", "dist-resources", "node-bin", process.platform === "win32" ? "node.exe" : "node");
  return fs.existsSync(devPath) ? devPath : null;
}

ipcMain.handle("testing:bot:read", async () => {
  const scriptPath = path.join(getBotScriptDir(), "test-bot.mjs");
  try {
    if (!fs.existsSync(scriptPath)) return "";
    return fs.readFileSync(scriptPath, "utf-8");
  } catch (err: any) {
    addLog("main", "error", `[bot] Failed to read script: ${err.message}`);
    return "";
  }
});

ipcMain.handle("testing:bot:save", async (_event, content: string) => {
  const scriptDir = getBotScriptDir();
  const scriptPath = path.join(scriptDir, "test-bot.mjs");
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(scriptPath + ".tmp", content, "utf-8");
    fs.renameSync(scriptPath + ".tmp", scriptPath);
    addLog("main", "info", `[bot] Script saved (${content.length} chars)`);
    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `[bot] Failed to save script: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("testing:bot:run", async () => {
  const scriptDir = getBotScriptDir();
  const scriptPath = path.join(scriptDir, "test-bot.mjs");
  const cwd = app.isPackaged ? path.join(app.getPath("userData"), "scripts") : path.join(app.getAppPath(), "..");

  if (!fs.existsSync(scriptPath)) {
    return { exitCode: -1, output: "Script not found — save it first" };
  }

  addLog("main", "info", "[bot] Starting test bot script");

  // Resolve node binary — prefer the bundled one, fall back to PATH
  let nodeBin = "node";
  try {
    const bundledNode = getBundledNodePath();
    if (bundledNode) nodeBin = bundledNode;
  } catch {}

  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    botProcess = spawn(nodeBin, [scriptPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        TRANSCRIPTION_STORAGE: process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage"),
      },
    });

    let output = "";

    const onData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("testing:bot:output", text);
      }
    };

    botProcess.stdout?.on("data", onData);
    botProcess.stderr?.on("data", onData);

    botProcess.on("close", (code) => {
      botProcess = null;
      addLog("main", "info", `[bot] Script exited with code ${code}`);
      resolve({ exitCode: code ?? -1, output });
    });

    botProcess.on("error", (err) => {
      botProcess = null;
      addLog("main", "error", `[bot] Failed to spawn script: ${err.message}`);
      resolve({ exitCode: -1, output: `Failed to spawn: ${err.message}` });
    });
  });
});

ipcMain.handle("testing:bot:stop", async () => {
  const pid = botProcess!.pid;
  if (pid === undefined) {
    return { success: false, message: "No bot script running" };
  }
  addLog("main", "info", `[bot] Stopping bot script (PID ${pid})`);

  if (process.platform === "win32") {
    // Windows: use taskkill to terminate the entire process tree
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // process already gone
    }
  } else {
    // Unix: SIGTERM first, then SIGKILL after timeout
    botProcess!.kill("SIGTERM");
    setTimeout(() => {
      if (botProcess) {
        try {
          process.kill(pid, 0); // check if still alive
          botProcess.kill("SIGKILL");
        } catch {
          // process already exited
        }
      }
    }, 3000);
  }

  botProcess = null;
  return { success: true };
});

ipcMain.handle("testing:bot:checkNode", async () => {
  // 1. Check bundled Node.js binary first (packaged or dev)
  const bundled = getBundledNodePath();
  if (bundled) {
    return { available: true, path: bundled };
  }

  // 2. Fall back to system PATH
  try {
    execSync("node --version", { stdio: "pipe" });
    return { available: true, path: "node" };
  } catch {
    return { available: false, path: null };
  }
});

ipcMain.handle("testing:bot:readLog", async () => {
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  const logPath = path.join(storageDir, "test-bot-log.jsonl");
  try {
    if (!fs.existsSync(logPath)) return "";
    return fs.readFileSync(logPath, "utf-8");
  } catch (err: any) {
    addLog("main", "error", `[bot] Failed to read test log: ${err.message}`);
    return "";
  }
});

// ── Uninstall / Cleanup IPC ──

ipcMain.handle("app:uninstall", async () => {
  addLog("main", "info", "[ipc] Uninstall requested from UI");
  const result = await uninstall();
  if (result.success) {
    addLog("main", "info", "[ipc] Uninstall completed successfully");
  } else {
    addLog("main", "error", `[ipc] Uninstall completed with errors: ${result.errors.join("; ")}`);
  }
  return result;
});

ipcMain.handle("app:uninstallStatus", () => {
  // Returns info about what would be cleaned up (for UI confirmation dialogs)
  const ollamaDir = require("path").join(require("os").homedir(), ".ollama");
  return {
    userDataPath: app.getPath("userData"),
    appPath: app.getPath("exe"),
    ollamaAutoInstalled: require("fs").existsSync(require("path").join(app.getPath("userData"), ".ollama-auto-installed")),
    ollamaModelsExist: require("fs").existsSync(ollamaDir),
    ollamaModelsPath: ollamaDir,
  };
});

// ── Ollama Model Management IPC ──

ipcMain.handle("ollama:listModels", async () => {
  addLog("main", "info", "[ollama] Listing available models via CLI: ollama list");

  const listModels = (): { models: any[]; error: string | null } => {
    try {
      const output = execSync("ollama list", {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();
      const lines = output.split("\n").filter((l) => l.trim());
      // Header: NAME  ID  SIZE  MODIFIED
      const models = lines
        .slice(1)
        .map((line) => {
          const parts = line.trim().split(/\s{2,}/);
          return {
            name: parts[0] || "",
            size: parseSizeToBytes(parts[2] || "0"),
            modified_at: parts.slice(3).join(" ") || "",
          };
        })
        .filter((m) => m.name);
      if (models.length > 0) {
        const details = models.map((m) => `${m.name} (${(m.size / (1024 * 1024 * 1024)).toFixed(2)} GB)`).join(", ");
        addLog("main", "info", `[ollama] Found ${models.length} model(s): ${details}`);
      } else {
        addLog("main", "info", "[ollama] No models pulled yet");
      }
      return { models, error: null };
    } catch (err: any) {
      return { models: [], error: `Cannot reach Ollama: ${err.message}` };
    }
  };

  // Attempt the initial list
  let result = listModels();

  // If it failed, try starting Ollama and retry once — but only if the
  // configured LLM provider is Ollama, to avoid starting it unnecessarily.
  if (result.error) {
    const env = getChildEnv();
    if (env.LLM_PROVIDER === "ollama") {
      addLog("main", "info", `[ollama] ollama list failed — trying to start Ollama server...`);
      const started = await ensureOllamaRunning(true);
      if (started) {
        addLog("main", "info", "[ollama] Ollama started — retrying model list");
        result = listModels();
      }
    } else {
      addLog("main", "debug", "[ollama] Not starting Ollama — LLM provider is not set to ollama");
    }
  }

  return { models: result.models, error: result.error, wasStarted: ollamaStartedByUs() };

  /** Parse a human-readable size string (e.g. "17 GB", "500 MB") to bytes. */
  function parseSizeToBytes(sizeStr: string): number {
    const match = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(num * (units[unit] || 1));
  }
});

ipcMain.handle("ollama:checkHealth", async () => {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    const healthy = res.ok;
    addLog("main", "debug", `[ollama] Health check: ${healthy ? "UP" : "DOWN"}`);
    return { healthy, error: null };
  } catch (err: any) {
    addLog("main", "debug", `[ollama] Health check failed: ${err.message}`);
    return { healthy: false, error: err.message };
  }
});

ipcMain.handle("ollama:startServer", async () => {
  addLog("main", "info", "[ollama] Starting server per user request");
  const started = await ensureOllamaRunning(true);
  return { success: started, error: started ? null : "Failed to start Ollama server" };
});

ipcMain.handle("ollama:stopServer", async () => {
  addLog("main", "info", "[ollama] Stopping server per user request (provider switched away)");
  stopOllamaServer();
  return { success: true };
});

ipcMain.handle("ollama:pullModel", async (_event, modelName: string) => {
  addLog("main", "info", `[ollama] Pulling model via CLI: ollama pull ${modelName}`);
  return new Promise<{ success: boolean; error: string | null }>((resolve) => {
    const startTime = Date.now();
    const proc = spawn("ollama", ["pull", modelName], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      // Log progress lines from the pull output
      for (const line of text.trim().split("\n")) {
        if (line) addLog("main", "info", `[ollama:pull] ${line}`);
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      for (const line of text.trim().split("\n")) {
        if (line) addLog("main", "warn", `[ollama:pull:err] ${line}`);
      }
    });

    proc.on("error", (err) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      addLog("main", "error", `[ollama] Pull ${modelName} failed after ${elapsed}s: ${err.message}`);
      resolve({ success: false, error: `Pull failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        addLog("main", "info", `[ollama] Successfully pulled model "${modelName}" in ${elapsed}s`);
        resolve({ success: true, error: null });
      } else {
        const errMsg = stderr.trim() || `ollama pull exited with code ${code}`;
        addLog("main", "error", `[ollama] Pull ${modelName} failed after ${elapsed}s (exit ${code}): ${errMsg}`);
        resolve({ success: false, error: errMsg });
      }
    });
  });
});

// ── Export IPC handlers (PDF / Word) ──

registerExportHandlers(() => mainWindow);

// ── App Lifecycle ──

const unsubscribeLogs = subscribe((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", entry);
  }
});

app.whenReady().then(async () => {
  // ── Notification platform setup ──
  // Windows: bind AppUserModelId so toast notifications appear correctly
  // in the Action Center with the proper app name and icon.
  if (process.platform === "win32") {
    app.setAppUserModelId("com.transcription.agent");
  }

  // Create window first (so user sees something while backend starts)
  createWindow();
  createTray();

  // macOS 10.14+: trigger the system's one-time notification permission dialog.
  // Without this, the user must manually enable notifications in System Settings.
  // We fire a silent dummy notification that immediately closes — this is enough
  // to prompt the OS permission dialog on first launch.
  if (process.platform === "darwin") {
    try {
      const permNotif = new Notification({ title: "", body: "", silent: true });
      permNotif.show();
      setTimeout(() => permNotif.close(), 100);
    } catch {
      // Non-fatal — user can enable notifications in System Settings manually
    }
  }

  // Initialize per-job logging — all log entries will be written to
  // <storage>/<job_id>/pipeline.log while the job is active.
  const storageBase = process.env.TRANSCRIPTION_STORAGE || path.join(app.getPath("userData"), "storage");
  setStorageBase(storageBase);
  addLog("main", "info", `App started — per-job logs: ${storageBase}/<job_id>/pipeline.log`);

  // Start periodic health monitoring
  startHealthMonitoring();

  // ── Initialize writable agent-config in userData ──
  // Copies bundled agent-config (read-only in production) to userData so the
  // bridge can write edits and config import can restore saved values.
  const initResult = initAgentConfigDir();
  const userDataAgentConfigDir = initResult.path;

  // Notify the user if agent config was initialized from templates (fresh clone)
  if (initResult.created && initResult.fromTemplates) {
    addLog("main", "info", "Agent config initialized from templates — customize via ConfigPanel > Agent tab");
    mainWindow?.webContents.send("notification", "Agent pipeline initialized with default settings. Customize in Settings > Agent tab.");
  }

  // ── Watch agent-config restart flag ──
  // When the bridge touches agent-config/.restart-flag (via POST /agent/config/restart),
  // restart the agent runner so it picks up new tool/pipeline config.
  // Watches the writable userData copy (bundled path is read-only in production).
  const restartFlagPath = path.join(userDataAgentConfigDir, ".restart-flag");
  if (fs.existsSync(userDataAgentConfigDir)) {
    try {
      fs.watch(restartFlagPath, (_eventType) => {
        addLog("main", "info", "Agent restart flag detected — restarting runner");
        // Debounce: remove the flag immediately so repeated firings don't loop
        try {
          fs.unlinkSync(restartFlagPath);
        } catch {
          /* ok */
        }
        restartAgentRunner().catch((err: any) => {
          addLog("main", "error", `Agent restart failed: ${err.message}`);
        });
      });
      addLog("main", "info", `Watching restart flag: ${restartFlagPath}`);
    } catch {
      addLog("main", "warn", "Could not watch restart flag (non-fatal)");
    }
  } else {
    addLog("main", "debug", `agent-config dir not found at ${userDataAgentConfigDir} (restart watcher deferred)`);
  }

  // Then start backend services (skipped in test mode — run externally)
  if (process.env.NODE_ENV !== "test") {
    try {
      // Ensure ffmpeg is available for audio standardization
      await ensureFfmpegAvailable();

      // Python and Bridge don't need API keys — always safe to start
      await startPythonBackend();
      await startBridgeServer();

      // Start Ollama eagerly only if it's the configured LLM provider
      // (ensureOllamaRunning checks the config internally, but be explicit here too)
      addLog("main", "debug", `[ollama] LLM_PROVIDER=${getConfig().LLM_PROVIDER} — will start Ollama only if set to "ollama"`);
      await ensureOllamaRunning();

      // Agent runner needs DEEPSEEK_API_KEY (or Ollama) — skip if missing
      const cfg = checkConfig();

      // Log whether Ollama is reachable, regardless of provider (for diagnostics)
      try {
        execSync("ollama list", { encoding: "utf8", stdio: "pipe", timeout: 3000 });
        addLog("main", "info", "[ollama] Ollama server is reachable on this system");
      } catch {
        addLog("main", "debug", "[ollama] Ollama server is not reachable (not installed or not running)");
      }

      if (cfg.ok) {
        addLog("main", "info", `Config OK — starting agent runner`);
        // Wire up job-started notification: forward agent [JOB_START] events
        // to OS notification + renderer (in-app toast via App.tsx)
        setOnJobStarted((jobId: string) => {
          addLog("main", "info", `Job started: ${jobId.slice(0, 8)}`, "job-start");
          sendNotification({ title: "Transcription Started", body: `Job ${jobId.slice(0, 8)} is processing`, type: "started" });
          mainWindow?.webContents.send("job-started", { jobId });
        });
        await startAgentRunner();
        sendNotification({ title: "Ready", body: "Transcription backend is running", type: "info" });
        mainWindow?.webContents.send("notification", "Backend ready");
      } else {
        const msg = `Config incomplete — agent runner deferred. Missing: ${cfg.missing.join(", ")}`;
        console.log(`[startup] ${msg}`);
        addLog("main", "warn", msg);
        mainWindow?.webContents.send("notification", "[config] needed — enter API key to start agent");
      }
    } catch (err: any) {
      const msg = `Failed to start backend: ${err.message}`;
      console.error(msg);
      addLog("main", "error", msg);

      // Write startup error to a persistent log file for post-mortem diagnostics
      const logDir = path.join(app.getPath("userData"), "logs");
      const errorLogPath = path.join(logDir, "startup-error.log");
      try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(errorLogPath, `${new Date().toISOString()} ERROR ${msg}\n`, "utf8");
      } catch {
        // non-critical — logging to in-memory buffer is sufficient
      }

      dialog.showErrorBox(
        "Backend Error",
        `Could not start the transcription backend.\n\n` +
          `Details: ${err.message}\n\n` +
          `If you're running a development build, make sure Python 3 and Node.js are installed. ` +
          `Packaged builds bundle all dependencies automatically.\n\n` +
          `A startup log was saved to:\n${errorLogPath}`,
      );
    }
  }

  // Start auto-updater (checks for repo updates every 12 hours)
  startAutoUpdater();
});

app.on("before-quit", (event) => {
  // Prevent re-entrance — once confirmed, skip the dialog
  if (isQuitting) return;

  // Show confirmation dialog synchronously (blocks until user responds)
  event.preventDefault();

  const result = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Cancel", "Quit"],
    defaultId: 0,
    cancelId: 0,
    title: "Quit Transcription Agent",
    message: "Are you sure you want to quit?",
  });

  if (result !== 1) return; // user clicked Cancel

  // User confirmed — clean up and quit
  isQuitting = true;
  tray = null;
  unsubscribeLogs();
  stopHealthMonitoring();
  stopAutoUpdater();
  // Use synchronous kill — stopAll() is async and won't complete before
  // app.exit(0) terminates the process. stopAllSync() sends SIGKILL
  // immediately on Unix (taskkill /F on Windows) so children can't survive.
  stopAllSync();
  // Use exit() to force termination — quit() re-fires before-quit and
  // on macOS window-all-closed won't terminate the app.
  app.exit(0);
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
