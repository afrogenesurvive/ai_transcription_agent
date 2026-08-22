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
import crypto from "crypto";
import { spawn, execSync, execFile } from "child_process";
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog, shell, protocol } from "electron";
import path from "path";
import pidusage from "pidusage";
import { registerExportHandlers } from "./exporter";
import { registerGmailOAuthIpc } from "./gmailOAuth";
import { registerMeetingsIpc } from "./meetings/index";
import { stopAllCapture } from "./meetings/capture";
import { playAlertSound } from "./alert-sound";

// Set app name before anything else — macOS menu bar and Windows taskbar
// use this instead of the default "Electron".
app.name = "Transcription Agent";

// ── Disable GPU / force software compositing on Windows (CrossOver blank-window fix) ──
// When the packaged Windows build runs under Wine/CrossOver (or other emulators), the
// Chromium D3D11 GPU process crashes (0xC0000005) and — as verified on 0.6.10 — the
// compositor never presents frames even with disableHardwareAcceleration(): the renderer
// runs and React mounts (confirmed via --remote-debugging-port + curl :9222/json page
// target), but the window stays blank. Adding --disable-gpu + --in-process-gpu makes it
// paint. This app is a plain UI (no WebGL/video), so forcing software rendering is safe.
// Gated to win32 so the native macOS build keeps hardware acceleration.
if (process.platform === "win32") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
  // Chromium 146 (Electron 43) no longer has a working D3D11Warp fallback under
  // Wine/CrossOver ("No available renderers" → NOTREACHED → blank window). Forcing
  // the ANGLE SwiftShader (pure software) GL backend restores painting; the old
  // --disable-gpu --in-process-gpu combo alone is insufficient on Chromium 146.
  // Verified working under CrossOver 2026-08-09.
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

// ── Disable the Chromium sandbox on win32 (CrossOver blank-window fix) ──
// CrossOver presents itself as Windows to the app, so `process.platform ===
// "win32"` can't tell it apart from native Windows. Chromium's Windows sandbox
// relies on Win32 security primitives (job objects, integrity levels) that Wine
// doesn't implement, so under CrossOver the renderer process can fail to launch
// silently — main process + Python backend run fine, but the window stays blank
// while the renderer's HTML never executes.
//
// The original fix tried to detect Wine from bottle env vars (WINEPREFIX /
// WINELOADERNOEXEC / WINEDEBUG / WINEDLLOVERRIDES / WINEARCH), but CrossOver does
// not reliably export those into the launched exe's environment, so `isWine` was
// false and no-sandbox never fired (verified on 0.6.10: blank window; passing
// --no-sandbox on the launch command made the full UI render). This app loads
// only local file:// content, so disable the sandbox on ALL win32 builds; set
// ELECTRON_ENABLE_SANDBOX=1 to restore it on native Windows.
const keepSandbox = process.env.ELECTRON_ENABLE_SANDBOX === "1";
if (process.platform === "win32" && !keepSandbox) {
  app.commandLine.appendSwitch("no-sandbox");
}

// ── Ensure Chromium switches are on the REAL OS command line (CrossOver) ──
// Under Wine/CrossOver, Chromium only honors switches present on the OS command
// line at process start — app.commandLine.appendSwitch() is read too late for the
// renderer sandbox AND the GPU feature config, so the baked-in switches above do
// not take effect (verified on 0.6.10: blank window until --disable-gpu
// --in-process-gpu were passed on the launch command). Relaunch once with the
// required switches on the actual argv so Chromium honors them. The relaunched
// process inherits TRANS_AGENT_RELAUNCHED=1, preventing an infinite loop.
function ensureWinSwitchesOnCommandLine(): void {
  if (process.platform !== "win32") return;
  if (process.env.TRANS_AGENT_RELAUNCHED === "1") return;

  // Chromium 146 needs the SwiftShader (software) GL backend on Wine/CrossOver
  // (verified working 2026-08-09); the old disable-gpu+in-process-gpu combo is not
  // enough. Applied win32-wide — this app is a plain UI, software rendering is safe.
  const required = ["no-sandbox", "disable-gpu", "disable-gpu-compositing", "in-process-gpu", "use-angle=swiftshader", "enable-unsafe-swiftshader"];
  if (process.env.ELECTRON_ENABLE_SANDBOX === "1") {
    const i = required.indexOf("no-sandbox");
    if (i >= 0) required.splice(i, 1);
  }
  const missing = required.filter((s) => !process.argv.includes(`--${s}`));
  if (missing.length === 0) return;

  process.env.TRANS_AGENT_RELAUNCHED = "1";
  app.relaunch({ args: [...missing.map((s) => `--${s}`), ...process.argv.slice(1)] });
  app.exit(0);
}
ensureWinSwitchesOnCommandLine();

// ── Single-instance lock ──
// Request the lock BEFORE any startup work. Without this, a second launch on
// Windows (Start Menu, shortcut, installer "run after finish") would spawn
// duplicate Python/bridge/agent services that fight over ports 5001/5010 and
// kill the first instance's backend via killProcessOnPort().
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — exit and let it handle the request.
  // Log to the persistent update.log — a relaunched instance losing the lock would
  // start then immediately quit, which looks like the update "didn't restart".
  writeUpdateLog("warn", `Single-instance lock NOT acquired — quitting. argv=${JSON.stringify(process.argv)}`);
  app.quit();
}
app.on("second-instance", () => {
  // A second instance was launched — restore + focus our existing window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

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
      // Strip inline comments: a "#" at the start of the value or preceded by
      // whitespace begins a comment. (Full-line comments were skipped above.)
      // Without this, "KEY=32768          # comment" would load the whole string
      // including the comment, breaking strict config validation (e.g. the
      // OLLAMA_NUM_CTX enum check) and producing broken URLs (OLLAMA_BASE_URL).
      const commentIdx = value.search(/(?:^|\s)#/);
      const cleanValue = commentIdx === -1 ? value : value.slice(0, commentIdx).trim();
      // Only set if not already defined (process.env takes priority)
      if (!process.env[key]) {
        process.env[key] = cleanValue;
      }
    }
  } catch {
    // .env is optional — silently ignore if missing or unreadable
  }
})();

// ── Custom scheme for in-app docs (images in the User Guide / Dev Guide) ──
// Registers app-doc:// so <img src="app-doc://screenshots/user-guide/….png">
// resolves to a file under the docs directory in both dev and packaged mode.
protocol.registerSchemesAsPrivileged([{ scheme: "app-doc", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

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
  CONFIG_KEYS,
  getConfig,
  getChildEnv,
  saveConfig,
  replaceConfig,
  checkConfig,
  getConfigWithSources,
  clearConfig,
  readUserConfigDefaults,
  restoreUserConfigDefaults,
  setUserConfigDefaults,
  syncConfigToEnv,
  saveAgentConfigToDisk,
  migrateConfigToEncrypted,
  reKeyConfig,
  invalidateConfigCache,
  getConfigIntegrity,
  restoreConfigFromBackup,
  readUserConfigRaw,
} from "./config";
import { getUiState, saveUiState } from "./ui-state";
import {
  getLicenseStatusPayload,
  activateLicense,
  deactivateLicense,
  readStoredLicenseKey,
  verifyLicenseKey,
  LICENSE_KEY_RE,
  logLicenseFlow,
  logCurrentLicenseStatus,
  getLicenseKeyFileStatus,
} from "./license";
import { encryptOpenPgpText, decryptOpenPgpText } from "./config-encryption";
import { checkDsmonAuthority, getDsmonAuthorityState, startDsmonLicenseMonitor, dsmonEvents, DSMON_VERDICT_CHANGED } from "./dsmon";

// Ensure every known config key is represented in the .env file(s) so a fresh
// reader (or a subprocess that reads .env directly) sees the full configuration.
// Must run AFTER the imports above — TypeScript emits the CommonJS `require()`
// at the import's position, so calling it earlier would throw a TDZ
// ReferenceError ("Cannot access 'config_1' before initialization").
syncConfigToEnv();

// ── Enable Electron/Chromium logging (debug aid) ──
// When LOG_CHROMIUM is enabled (ConfigPanel > Logging, or LOG_CHROMIUM=1 via .env),
// route Chromium's renderer/GPU/console logging to stderr. This surfaces low-level
// errors (e.g. GPU/compositor failures) that would otherwise be invisible — such as
// the blank-window symptom when running under Wine/CrossOver. Must run before app is
// ready: Chromium reads these switches during its own initialization.
(function enableChromiumLogging(): void {
  let enabled = process.env.LOG_CHROMIUM === "1" || process.env.LOG_CHROMIUM?.toLowerCase() === "true";
  try {
    const v = getConfig().LOG_CHROMIUM; // getConfig() already folds in .env/host env
    enabled = enabled || v === "true" || v === "1";
  } catch {
    // Non-fatal — fall back to env-only detection above
  }
  if (enabled) {
    app.commandLine.appendSwitch("enable-logging");
    app.commandLine.appendSwitch("v", "1");
    // Also write Chromium's log to a file so we can tail it into the per-job
    // pipeline.log stream (tagged [chromium]) — otherwise it only goes to
    // stderr, which is invisible in the packaged app.
    const logsDir = path.join(app.getPath("userData"), "logs");
    const chromiumLogPath = path.join(logsDir, "chromium.log");
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      app.commandLine.appendSwitch("log-file", chromiumLogPath);
    } catch {
      // Non-fatal — fall back to stderr-only logging
    }
    // Inherited by renderer/GPU/utility child processes
    process.env.ELECTRON_ENABLE_LOGGING = "1";
    addLog("main", "info", `[chromium] Electron/Chromium logging enabled (enable-logging, v=1, file=${chromiumLogPath})`);
    startChromiumLogTailer(chromiumLogPath);
  }
})();

/**
 * Tail the Chromium log file written by `--enable-logging --log-file=...` and
 * forward each line into the unified logger with a "chromium" subSource.
 *
 * Because addLog() routes entries to the current job (setCurrentJobId), Chromium
 * lines emitted while a job is running land in that job's per-job pipeline.log
 * (formatted `[<time>] [main][chromium] [info] <line>`). Lines outside any job
 * still reach the in-memory live log / DevPanel.
 *
 * Uses polling rather than fs.watch, which is unreliable on some platforms for
 * append-only log files.
 */
function startChromiumLogTailer(logPath: string): void {
  let offset = 0;
  let stopped = false;
  const POLL_MS = 1500;
  const MAX_BYTES = 100 * 1024 * 1024; // stop tailing past 100MB to avoid unbounded reads

  const readNew = (): void => {
    if (stopped) return;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < offset) offset = 0; // file was truncated/rotated
      if (stat.size > MAX_BYTES) {
        addLog("main", "warn", "[chromium] Chromium log exceeded 100MB — tailing disabled", "chromium");
        stopped = true;
        return;
      }
      if (stat.size <= offset) return;
      let buf: Buffer;
      const fd = fs.openSync(logPath, "r");
      try {
        buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
      } finally {
        fs.closeSync(fd);
      }
      offset = stat.size;
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = raw.trim();
        if (line) {
          // Mirror to the terminal (dev) so [chromium] lines are visible where
          // the app was launched, not just in DevPanel / per-job pipeline.log.
          console.log(`[chromium] ${line}`);
          addLog("main", "info", line, "chromium");
        }
      }
    } catch {
      // File may not exist yet (Chromium hasn't opened it) — ignore.
    }
  };

  // Start after a short delay so Chromium has had time to create/open the file.
  const timer = setTimeout(() => {
    readNew();
    const interval = setInterval(readNew, POLL_MS);
    interval.unref();
  }, 3000);
  timer.unref();
}
import { startAutoUpdater, stopAutoUpdater, registerAutoUpdateIpc, getUpdateState, checkAndUpdate, writeUpdateLog } from "./auto-updater";
import { uninstall } from "./cleanup";
import { nodeSpawnSpec } from "./node-resolver";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
/** True when quit was initiated by the user (tray Quit / UI) rather than by the
 *  OS (shutdown/logoff) or the auto-updater (quitAndInstall). Controls whether
 *  before-quit shows the confirmation dialog. */
let quitRequestedByUser = false;
/** Guards the one-time cleanup in before-quit so it runs exactly once per app
 *  lifetime across every quit path. */
let quitCleanupDone = false;

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
      // Disable the renderer OS-level sandbox (CrossOver blank-window fix).
      // app.commandLine.appendSwitch("no-sandbox") is read too late for the
      // renderer sandbox — Chromium decides that flag at browser startup from
      // the OS command line, before this JS runs. The per-window webPreference
      // is applied at renderer creation, so it reliably disables the sandbox.
      // This app loads only local file:// content; contextIsolation stays on.
      sandbox: false,
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
        body:
          process.platform === "win32"
            ? "Still running in the system tray — quit from the tray menu to stop background services."
            : "Still running in the menu bar — quit from the tray menu to stop background services.",
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
        // Mark as user-initiated so before-quit shows the confirmation dialog
        quitRequestedByUser = true;
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
  /** Force (or suppress) the alert sound; defaults to job-alert types (error/success/paused). */
  playSound?: boolean;
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

  // Play an explicit alert sound regardless of window focus. macOS suppresses
  // the native notification sound when the app is frontmost, and Windows has
  // no guaranteed sound either — so we play it ourselves from the main process.
  // Defaults to job-alert types (failed / cancelled / paused / complete);
  // callers can force on/off via playSound.
  const shouldSound = opts.playSound ?? ["error", "success", "paused"].includes(type);
  if (shouldSound) playAlertSound();

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

ipcMain.handle("fs:readFileBytes", async (_event, filePath: string) => {
  try {
    const data = await fs.promises.readFile(filePath);
    return { ok: true, data: new Uint8Array(data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not read file." };
  }
});

ipcMain.handle("backend:status", async () => {
  // Check all three services with individual timeouts
  let python = false;
  let bridge = false;
  const agent = isAgentRunning();
  let diarizationAvailable: boolean | null = null;
  let diarizationError: string | null = null;
  let diarizationModel: string | null = null;
  let hfTokenConfigured: boolean | null = null;
  let diarizationStatus: string | null = null;
  let diarizationProgress: number | null = null;

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

  // Check diarization model status via bridge (backend returns instantly;
  // the model itself is loaded once in a background task)
  if (bridge) {
    try {
      const toolsRes = await fetch("http://127.0.0.1:5010/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "transcribe_models_status", args: {} }),
        signal: AbortSignal.timeout(5000),
      });
      if (toolsRes.ok) {
        const data = await toolsRes.json();
        diarizationAvailable = data.diarization_available;
        diarizationError = data.diarization_error;
        diarizationModel = data.diarization_model ?? null;
        hfTokenConfigured = data.hf_token_configured ?? null;
        diarizationStatus = data.diarization_status ?? null;
        diarizationProgress = typeof data.diarization_progress === "number" ? data.diarization_progress : null;
      }
    } catch {
      // diarization check failed
    }
  }

  return {
    python,
    bridge,
    agent,
    diarizationAvailable,
    diarizationError,
    diarizationModel,
    hfTokenConfigured,
    diarizationStatus,
    diarizationProgress,
  };
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
      // Bundled via extraResources → resources/README.md (keep legacy path too)
      candidates.unshift(path.join(process.resourcesPath, "..", "README.md"));
      candidates.unshift(path.join(process.resourcesPath, "README.md"));
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
      // Bundled via extraResources → resources/docs/end_user_guide.md
      candidates.unshift(path.join(process.resourcesPath, "..", "docs", "end_user_guide.md"));
      candidates.unshift(path.join(process.resourcesPath, "docs", "end_user_guide.md"));
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

/** Load an arbitrary doc file from the docs/safe/ (full) or docs/ (redacted) directory. */
ipcMain.handle("app:doc", (_event, filename: string) => {
  // Search docs/safe/ FIRST — it holds the full internal versions (the DevPanel
  // Guide tab serves these). docs/ holds redacted public versions and is the
  // fallback. Both are bundled via extraResources → resources/docs/ in packaged builds.
  const docRoots = ["docs/safe", "docs"];
  const docPath = (() => {
    const candidates: string[] = [];
    for (const root of docRoots) {
      candidates.push(path.join(__dirname, "..", "..", "..", root, filename));
      candidates.push(path.join(app.getAppPath(), "..", root, filename));
    }
    if (app.isPackaged) {
      // Bundled via extraResources → resources/docs/<filename> (+ docs/safe)
      for (const root of docRoots) {
        candidates.unshift(path.join(process.resourcesPath, "..", root, filename));
        candidates.unshift(path.join(process.resourcesPath, root, filename));
      }
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
  // User-initiated — before-quit will show the single confirmation dialog
  quitRequestedByUser = true;
  app.quit();
  return { success: true };
});

ipcMain.handle("app:confirmQuit", async (_event, opts: { message: string }) => {
  // Single confirmation is handled centrally in before-quit — this handler just
  // marks the quit as user-initiated so the dialog appears there exactly once.
  quitRequestedByUser = true;
  app.quit();
  return { success: true };
});

ipcMain.handle("app:quitApp", async () => {
  console.log("[ipc] User confirmed quit via UI dialog — skipping before-quit dialog");
  isQuitting = true;
  app.quit();
  return { success: true };
});

ipcMain.handle("app:openExternal", async (_event, url: unknown) => {
  // Only allow http(s) URLs — never hand arbitrary protocols to the OS shell.
  if (typeof url !== "string") return { success: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { success: false };
  await shell.openExternal(parsed.toString());
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

/**
 * AppConfig keys consumed by the Python backend (python-backend/config.py) at
 * process start via os.getenv(). Changing any of these requires a Python
 * backend restart to take effect.
 */
const PYTHON_CONFIG_KEYS = new Set<string>([
  "WHISPER_MODEL_SIZE",
  "WHISPER_INITIAL_PROMPT_ENABLED",
  "WHISPER_INITIAL_PROMPT",
  "EMBEDDING_PROVIDER",
  "HUGGING_FACE_TOKEN",
  "KEEP_TRANSCRIPT_TIMESTAMPS",
  "PIPELINE_TIMEOUT_MINUTES",
  "DELIVERY_RECIPIENT_EMAILS",
  "DELIVERY_EMAIL_SUBJECT",
  "DELIVERY_EMAIL_ADDITIONAL_CONTENT",
  "DELIVERY_DRIVE_FOLDER",
  "KEEP_MODELS_WARM",
  "GATE_RAW_REVIEW_ENABLED",
  "GATE_DELIVERY_REVIEW_ENABLED",
  "DIARIZATION_MIN_SPEAKER_DURATION",
  "DIARIZATION_MIN_SPEAKER_SEGMENTS",
  "DIARIZATION_MERGING_GAP",
  "DIARIZATION_CLUSTERING_THRESHOLD",
  "DIARIZATION_MAX_SPEAKERS",
  "DIARIZATION_TIMEOUT_MINUTES",
]);

ipcMain.handle("config:get", () => {
  const cfg = getConfig();
  addLog("main", "info", "[config] retrieved");
  return cfg;
});

// ── UI state persistence (userData/ui-state.json) ──
// Renderer is the single writer: it loads the whole object via ui-state:get,
// mutates in memory, and writes it back via ui-state:save (debounced). No
// merge/clear on the main side so a stale renderer copy can't resurrect a
// cleared scope.
ipcMain.handle("ui-state:get", () => {
  return getUiState();
});

ipcMain.handle("ui-state:save", (_event, state: Record<string, unknown>) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    addLog("main", "warn", "[ui-state] save ignored — payload is not an object");
    return false;
  }
  saveUiState(state);
  addLog("main", "info", `[ui-state] saved ${Object.keys(state).length} scope(s)`);
  return true;
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

  // ── Restart Python backend if any Python-consumed config changed ──
  // python-backend/config.py reads these at import time via os.getenv().
  // The agent runner restart above doesn't affect the Python process, so we
  // must restart it to pick up the new values.
  const hasPythonChanges = Object.keys(values).some((k) => PYTHON_CONFIG_KEYS.has(k));
  if (hasPythonChanges) {
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
          `Python config changed but ${(activeData.active_jobs || []).length} job(s) running — Python backend NOT restarted. Changes apply after next restart.`,
        );
      } else {
        await restartPythonBackend();
        addLog("main", "info", "Python backend restarted after config change");
      }
    } catch {
      // Backend unreachable — restart anyway to pick up env vars
      await restartPythonBackend();
      addLog("main", "info", "Python backend restarted after config change (backend was unreachable)");
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

// ── License IPC ──

/** Full license status payload for the renderer (get-status + DS-mon verdict). */
function licenseStatusResponse() {
  return {
    ...getLicenseStatusPayload(),
    configIntegrity: {
      ...getConfigIntegrity(),
      licenseKeyFile: getLicenseKeyFileStatus(),
    },
    dsmon: getDsmonAuthorityState(),
  };
}

ipcMain.handle("license:get-status", () => {
  // Opportunistic DS-mon re-check on the renderer's periodic status poll
  // (throttled to 60s), so a revocation/expiry is detected even if the DS-mon
  // tunnel came up after the startup retry window. The verdict arrives async
  // and is pushed to the renderer via DSMON_VERDICT_CHANGED.
  const lastCheck = getDsmonAuthorityState().checkedAt;
  if (!lastCheck || Date.now() - lastCheck >= 60_000) {
    checkDsmonAuthority().catch(() => {});
  }
  return licenseStatusResponse();
});

// Manual DS-mon license-authority re-check (e.g. from ConfigPanel after toggling
// DSMON_LICENSE_CHECK_ENABLED or updating the push URL/token).
ipcMain.handle("dsmon:recheck", () => checkDsmonAuthority());

/**
 * Push license-status changes to the renderer whenever the DS-mon authority
 * verdict transitions (revoked / expired → locked, or reachability change).
 * This makes a Config-panel recheck OR the periodic monitor reload the app's
 * license gating so the panels re-obscure (or unlock) without a restart.
 */
dsmonEvents.on(DSMON_VERDICT_CHANGED, () => {
  mainWindow?.webContents.send("license:status-changed", licenseStatusResponse());
});

ipcMain.handle("license:activate", (_event, key: string) => {
  // Capture the current key BEFORE activation overwrites it. If config.json.gpg
  // already exists (encrypted under the previous key), re-key it to the new
  // license — otherwise switching licenses makes the config unreadable and the
  // app reports "config missing" even though the file is present.
  const oldKey = readStoredLicenseKey();
  const res = activateLicense(key);
  if (res.ok) {
    // activateLicense() persisted the key first; now migrate any legacy
    // plaintext config.json → config.json.gpg under the newly stored key.
    const migration = migrateConfigToEncrypted();
    logLicenseFlow("info", "config.migrated", { migrated: migration.migrated });
    if (oldKey && oldKey !== key) {
      const rekey = reKeyConfig(key, oldKey);
      if (rekey.ok) {
        logLicenseFlow("info", "config.rekeyed", {});
      } else {
        logLicenseFlow("warn", "config.rekey.failed", { error: rekey.error });
      }
    }
    // If the stored config still can't be decrypted under the new key (e.g. the
    // previous key was deactivated, so no re-key was possible) and a plaintext
    // backup exists, restore it so the new key unlocks the config automatically.
    let restoredFromBackup = false;
    const integrity = getConfigIntegrity();
    if (integrity.configGpg === "corrupt" && integrity.backupExists) {
      const restored = restoreConfigFromBackup();
      if (restored.ok) {
        restoredFromBackup = true;
        logLicenseFlow("info", "config.restored_from_backup", {});
      } else {
        logLicenseFlow("warn", "config.restore_backup.failed", { error: restored.error });
      }
    }
    invalidateConfigCache(); // re-read (decrypted) config after unlock
    // Re-check the DS-mon authority now that a seat is installed (non-blocking).
    checkDsmonAuthority().catch(() => {});
    return { success: true, migration, restoredFromBackup, ...getLicenseStatusPayload() };
  }
  return { success: false, reason: res.reason };
});

ipcMain.handle("license:deactivate", () => {
  deactivateLicense();
  invalidateConfigCache();
  return { success: true, ...getLicenseStatusPayload() };
});

ipcMain.handle("license:re-key", (_event, newKey: string) => {
  const res = verifyLicenseKey(newKey);
  if (!res.ok) {
    logLicenseFlow("warn", "rekey.failed", { reason: res.reason });
    return { success: false, reason: res.reason };
  }
  const rekey = reKeyConfig(newKey);
  if (!rekey.ok) {
    logLicenseFlow("error", "rekey.failed", { error: rekey.error });
    return { success: false, error: rekey.error };
  }
  activateLicense(newKey);
  invalidateConfigCache();
  logLicenseFlow("info", "rekeyed", { sub: res.claims.sub, kid: res.claims.kid, exp: res.claims.exp });
  return { success: true, ...getLicenseStatusPayload() };
});

// ── Bridge license challenge/response (job submission enforcement) ──
// The renderer fetches a short-lived session token from the bridge via this
// IPC and attaches it as X-License-Token on job-creation requests. The seat
// private key never leaves the main process (signing happens here).

let bridgeTokenCache: { token: string; expiresAt: number } | null = null;
const BRIDGE_TOKEN_TTL_MS = 11 * 60 * 60 * 1000; // reuse a token until ~1h before expiry

async function getBridgeLicenseToken(): Promise<{ token: string } | { error: string }> {
  if (bridgeTokenCache && Date.now() < bridgeTokenCache.expiresAt) {
    return { token: bridgeTokenCache.token };
  }
  const key = readStoredLicenseKey();
  if (!key) return { error: "No active license." };
  const m = LICENSE_KEY_RE.exec(key);
  if (!m) return { error: "Invalid stored license key." };
  const [, certB64, sigB64, privB64] = m;
  try {
    logLicenseFlow("info", "bridge.challenge.requested");
    const challengeRes = await fetch("http://127.0.0.1:5010/license/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cert: certB64, sig: sigB64 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!challengeRes.ok) {
      logLicenseFlow("warn", "bridge.challenge.rejected", { status: challengeRes.status });
      return { error: `Bridge license challenge failed (${challengeRes.status}).` };
    }
    logLicenseFlow("info", "bridge.challenge.ok");
    const challenge = await challengeRes.json();
    const nonceBytes = Buffer.from(challenge.nonce, "base64url");
    const cert = JSON.parse(Buffer.from(certB64, "base64url").toString("utf8"));
    const seatPriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: cert.pub, d: privB64 }, format: "jwk" });
    const sig = crypto.sign(null, nonceBytes, seatPriv);

    const respondRes = await fetch("http://127.0.0.1:5010/license/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: challenge.challenge_id, sig: Buffer.from(sig).toString("base64url") }),
      signal: AbortSignal.timeout(5000),
    });
    if (!respondRes.ok) {
      logLicenseFlow("warn", "bridge.respond.rejected", { status: respondRes.status });
      return { error: `Bridge license response failed (${respondRes.status}).` };
    }
    const respond = await respondRes.json();
    bridgeTokenCache = { token: respond.token, expiresAt: Date.now() + BRIDGE_TOKEN_TTL_MS };
    logLicenseFlow("info", "bridge.token.issued", { sub: respond.sub, kid: respond.kid });
    return { token: respond.token };
  } catch (err: any) {
    logLicenseFlow("warn", "bridge.challenge.error", { error: err.message });
    return { error: `License challenge error: ${err.message}` };
  }
}

ipcMain.handle("license:get-bridge-token", async () => getBridgeLicenseToken());

ipcMain.handle("config:restore-backup", () => {
  addLog("main", "info", "[config] restore-from-backup requested");
  const res = restoreConfigFromBackup();
  if (res.ok) {
    logLicenseFlow("info", "config.restored_from_backup");
  } else {
    logLicenseFlow("warn", "config.restore_backup.failed", { error: res.error });
  }
  return res;
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

    // Restart Python backend so Python-consumed values revert to defaults too
    try {
      await restartPythonBackend();
      addLog("main", "info", "Python backend restarted after config clear");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart Python backend after config clear: ${err.message}`);
    }

    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `Config clear failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("config:export", async (_event, options?: { mode?: "encrypted" | "plain" }) => {
  const mode: "encrypted" | "plain" = options?.mode === "plain" ? "plain" : "encrypted";
  addLog("main", "info", `[config] export requested (mode=${mode})`);
  try {
    // Read the user config via the config manager (handles the encrypted at-rest
    // config.json.gpg when licensed). Directly reading the plaintext config.json
    // would export an EMPTY userConfig once the config is encrypted.
    let userConfig: Record<string, any> = {};
    try {
      const raw = readUserConfigRaw();
      if (raw) userConfig = JSON.parse(raw);
    } catch (err: any) {
      addLog("main", "warn", `[config] Failed to read user config for export: ${err.message}`);
    }

    // Read user config defaults snapshot
    const userDefaultsConfig = readUserConfigDefaults();

    // Collect non-fatal warnings so the UI can surface an incomplete export.
    const warnings: string[] = [];

    // Try to read agent config from bridge
    let agentConfig: any = null;
    try {
      const res = await fetch("http://127.0.0.1:5010/agent/config", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) agentConfig = await res.json();
    } catch {
      addLog("main", "warn", "Agent config unavailable for export — bridge not reachable");
      warnings.push("Agent instructions (tools/pipeline/system prompt) were not captured — bridge not reachable.");
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
      warnings.push("Agent defaults snapshot was not captured — bridge not reachable.");
    }

    const exportData = {
      version: 3,
      format: mode,
      exportedAt: new Date().toISOString(),
      userConfig,
      userDefaultsConfig,
      agentConfig,
      defaultsConfig,
    };

    // Licensed-only: the license key both unlocks the app and decrypts the config.
    const licenseKey = readStoredLicenseKey();
    if (!licenseKey) {
      return { success: false, error: "Exporting configuration requires an active license." };
    }

    // Show save dialog — filter defaults to the chosen mode's extension, but the
    // user can switch between .gpg and .json (the write follows the selected mode).
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: mode === "plain" ? "Export Configuration (Plain JSON)" : "Export Configuration (Encrypted)",
      defaultPath: path.join(app.getPath("documents"), `transcription-agent-config-${stamp}.${mode === "plain" ? "json" : "gpg"}`),
      filters: [
        { name: "Encrypted Config (.gpg)", extensions: ["gpg"] },
        { name: "Plain JSON (.json)", extensions: ["json"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      addLog("main", "info", "[config] export cancelled by user");
      return { success: false, cancelled: true };
    }

    const plaintext = JSON.stringify(exportData, null, 2);
    if (mode === "plain") {
      // Plain JSON — no encryption. Contains API keys in plaintext; the renderer
      // shows a "Security Risk" confirmation before this path is reached.
      fs.writeFileSync(result.filePath, plaintext, "utf8");
      addLog("main", "warn", `Config exported (plain JSON) to ${result.filePath} — contains secrets in plaintext`);
      logLicenseFlow("info", "config.export.plain", { filePath: result.filePath });
    } else {
      // Encrypt the whole bundle with OpenPGP (gpg-compatible), passphrase = license key.
      const armored = await encryptOpenPgpText(plaintext, licenseKey);
      fs.writeFileSync(result.filePath, armored, "utf8");
      addLog("main", "info", `Config exported (encrypted) to ${result.filePath}`);
      logLicenseFlow("info", "config.export.encrypted", { filePath: result.filePath });
    }
    return { success: true, filePath: result.filePath, format: mode, warnings };
  } catch (err: any) {
    addLog("main", "error", `Config export failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("config:import", async (_event) => {
  addLog("main", "info", "[config] import requested");
  try {
    // Licensed-only import: decrypting an exported config requires the license key.
    const licenseKey = readStoredLicenseKey();
    if (!licenseKey) {
      return { success: false, error: "Importing configuration requires an active license. Activate a license in About → License first." };
    }

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

    // Show open dialog — accept both encrypted .gpg (OpenPGP, the current export
    // format) and legacy plaintext .json. Shared by Config → Import and the
    // ServerStatusBanner's Import Config (both use config:import).
    // IMPORTANT: on macOS the FIRST filter group is the active default in the
    // open dialog, and any file that doesn't match it is greyed out. Keep
    // .gpg + .json together as the default so BOTH are selectable everywhere.
    const filters: Electron.FileFilter[] = [
      { name: "Config Files", extensions: ["gpg", "json"] },
      { name: "All Files", extensions: ["*"] },
    ];
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Import Configuration",
      filters,
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      addLog("main", "info", "[config] import cancelled by user");
      return { success: false, cancelled: true };
    }

    const filePath = result.filePaths[0];
    let raw = fs.readFileSync(filePath, "utf8");
    // Exported configs are OpenPGP-encrypted (.gpg); decrypt with the license key.
    if (raw.trim().startsWith("-----BEGIN PGP MESSAGE-----")) {
      try {
        raw = await decryptOpenPgpText(raw.trim(), licenseKey);
      } catch (err: any) {
        addLog("main", "error", `[config] import decrypt failed: ${err.message}`);
        return {
          success: false,
          error:
            "This .gpg config was encrypted with a different license key and can't be opened with the active one. Import a plaintext .json export instead, or activate the license key that created this file.",
        };
      }
    }
    const importData = JSON.parse(raw);
    logLicenseFlow("info", "config.import.decrypted");

    // Validate format
    if (!importData.version || !importData.userConfig) {
      return { success: false, error: "Invalid config file format — missing version or userConfig" };
    }

    // Best-effort versioning: warn on unknown/old formats but still attempt import.
    const exportVersion = typeof importData.version === "number" ? importData.version : NaN;
    if (!Number.isFinite(exportVersion) || exportVersion < 3) {
      addLog("main", "warn", `Config file version ${String(importData.version)} is older than the current format (3) — importing best-effort.`);
    }

    // Import user config — coerce values to strings and drop non-scalars so
    // config.json never ends up with numbers/booleans/objects/arrays.
    const coercedUserConfig: Record<string, string> = {};
    if (importData.userConfig && typeof importData.userConfig === "object") {
      for (const [key, value] of Object.entries(importData.userConfig)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "object") {
          addLog("main", "warn", `Config import: dropping non-scalar value for "${key}"`);
          continue;
        }
        coercedUserConfig[key] = String(value);
      }
    }
    const updatedConfig = replaceConfig(coercedUserConfig);
    addLog("main", "info", "User config imported successfully (replaced config.json)");

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
        // Keep only known config keys (strip stale/unknown keys) and re-stamp
        // __version to the current app version (see below).
        const defaultsPath = path.join(app.getPath("userData"), "config.defaults.json");
        // Re-stamp __version to the CURRENT app version. If we preserved the
        // imported (older) stamp, ensureUserConfigDefaults() would see a
        // version mismatch on next launch and regenerate the snapshot from
        // current DEFAULTS, silently discarding the imported defaults.
        const clean: Record<string, any> = { __version: app.getVersion() };
        for (const key of Object.keys(importData.userDefaultsConfig)) {
          if (key === "__version") continue;
          if ((CONFIG_KEYS as string[]).includes(key)) {
            clean[key] = importData.userDefaultsConfig[key];
          }
        }
        fs.writeFileSync(defaultsPath, JSON.stringify(clean, null, 2), "utf8");
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

    // Reset all services so they pick up the new config. Runs AFTER the user /
    // agent / defaults writes above so the restarted runner loads the imported
    // agent instructions (the bridge save path doesn't touch the restart flag).
    //
    // GUARD: don't force a restart while the backend is still cold-starting —
    // a restart mid-start races and can leave :5001 unready ("process exited
    // before becoming ready", see startup-error.log). Wait (bounded) for the
    // backend to become ready, then restart cleanly; if it never becomes ready,
    // skip the forced restart and let changes apply on the next app start.
    const waitForBackendReady = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch("http://127.0.0.1:5001/health", { signal: AbortSignal.timeout(2000) });
          if (res.ok) return true;
        } catch {
          // not ready yet — keep waiting
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    };

    let backendReady = false;
    try {
      const res = await fetch("http://127.0.0.1:5001/health", { signal: AbortSignal.timeout(2000) });
      backendReady = res.ok;
    } catch {
      backendReady = false;
    }

    if (!backendReady) {
      addLog("main", "warn", "[config] Backend not ready — waiting for it to finish starting before restarting the Python backend");
      backendReady = await waitForBackendReady(60_000);
    }

    // Always restart the Node services (agent runner + bridge) so they pick up
    // the imported config/env immediately. They don't conflict with a
    // cold-starting Python backend, and the agent may have crashed at launch
    // (e.g. missing API key) — it must not be left stale by a deferred restart.
    try {
      await restartAgentRunner();
      addLog("main", "info", "Agent runner restarted after config import");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart agent runner: ${err.message}`);
    }
    try {
      await restartBridgeServer();
      addLog("main", "info", "Bridge restarted after config import");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart bridge: ${err.message}`);
    }

    // Python backend: only restart once it's ready (bounded). If it never
    // becomes ready, skip its forced restart — backend-manager respawns it on
    // the next lifecycle with a fresh getChildEnv(), so it picks up config then.
    if (backendReady) {
      try {
        await restartPythonBackend();
        addLog("main", "info", "Python backend restarted after config import");
      } catch (err: any) {
        addLog("main", "error", `Failed to restart Python backend: ${err.message}`);
      }
    } else {
      addLog("main", "warn", "[config] Python backend not ready in time — skipping its forced restart; it will pick up config on its next start");
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

    // Restart Python backend so restored Python-consumed values take effect
    try {
      await restartPythonBackend();
      addLog("main", "info", "Python backend restarted after user config restore");
    } catch (err: any) {
      addLog("main", "error", `Failed to restart Python backend after user config restore: ${err.message}`);
    }

    return { success: true };
  } catch (err: any) {
    addLog("main", "error", `User config restore failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── Set Current Config as Defaults IPC ──
// Snapshots the CURRENT user config AND agent config as the "defaults", so a
// later "Restore Defaults" restores today's setup rather than the shipped one.

/** Write agent defaults files directly to userData/agent-config/.defaults/ (disk fallback). */
function writeAgentDefaultsToDisk(defaults: { systemPrompt?: string; pipeline?: any; tools?: any }): string[] {
  const written: string[] = [];
  try {
    const agentConfigDir = path.join(app.getPath("userData"), "agent-config", ".defaults");
    fs.mkdirSync(agentConfigDir, { recursive: true });
    if (defaults.systemPrompt !== undefined) {
      fs.writeFileSync(path.join(agentConfigDir, "system-prompt.md"), defaults.systemPrompt, "utf8");
      written.push("system-prompt.md");
    }
    if (defaults.pipeline !== undefined) {
      fs.writeFileSync(path.join(agentConfigDir, "pipeline.json"), JSON.stringify(defaults.pipeline, null, 2), "utf8");
      written.push("pipeline.json");
    }
    if (defaults.tools !== undefined) {
      fs.writeFileSync(path.join(agentConfigDir, "tools.json"), JSON.stringify(defaults.tools, null, 2), "utf8");
      written.push("tools.json");
    }
  } catch (err: any) {
    addLog("main", "error", `Agent defaults direct write failed: ${err.message}`);
  }
  return written;
}

ipcMain.handle("config:set-defaults", async () => {
  addLog("main", "info", "[config] set-defaults requested");
  // Check for active jobs before allowing the defaults snapshot to be overwritten
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
    addLog("main", "warn", "[config] set-defaults blocked — active jobs running");
    return { success: false, blocked: true, error: "Cannot save defaults while jobs are running. Wait for jobs to complete." };
  }

  const warnings: string[] = [];
  try {
    // 1) User config defaults — snapshot current config.json as the defaults
    setUserConfigDefaults();
    addLog("main", "info", "User config defaults updated to current values");

    // 2) Agent config defaults — read current agent config, write to .defaults/
    //    (dual-path: bridge first, direct disk fallback)
    let agentDefaultsSaved = false;
    try {
      const curRes = await fetch("http://127.0.0.1:5010/agent/config", {
        signal: AbortSignal.timeout(3000),
      });
      if (!curRes.ok) {
        addLog("main", "warn", `Could not read current agent config (bridge returned ${curRes.status})`);
        warnings.push(`Agent config defaults were not updated — bridge returned ${curRes.status}.`);
      } else {
        const current = await curRes.json();
        const payload: any = {};
        if (current.systemPrompt !== undefined) payload.systemPrompt = current.systemPrompt;
        if (current.pipeline !== undefined) payload.pipeline = current.pipeline;
        if (current.tools !== undefined) payload.tools = current.tools;

        let bridgeOk = false;
        try {
          const res = await fetch("http://127.0.0.1:5010/agent/config/defaults", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            bridgeOk = true;
            agentDefaultsSaved = true;
            addLog("main", "info", "Agent config defaults updated via bridge");
          } else {
            addLog("main", "warn", `Agent defaults write via bridge returned ${res.status} — falling back to direct write`);
          }
        } catch {
          addLog("main", "warn", "Bridge not reachable for agent defaults write — falling back to direct write");
        }

        if (!bridgeOk) {
          const written = writeAgentDefaultsToDisk(payload);
          if (written.length > 0) {
            agentDefaultsSaved = true;
            addLog("main", "info", `Agent config defaults written directly to disk: ${written.join(", ")}`);
          } else {
            addLog("main", "warn", "Agent defaults write: nothing to save");
            warnings.push("Agent config defaults were not updated — nothing to save.");
          }
        }
      }
    } catch (err: any) {
      addLog("main", "warn", `Could not read current agent config — ${err.message}`);
      warnings.push(`Agent config defaults were not updated — bridge unreachable: ${err.message}`);
    }

    return { success: true, agentDefaultsSaved, warnings };
  } catch (err: any) {
    addLog("main", "error", `Config set-defaults failed: ${err.message}`);
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
  // Check for active jobs before allowing agent defaults to be overwritten
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
    addLog("main", "warn", "[config] agent restore-defaults blocked — active jobs running");
    return { blocked: true, error: "Cannot restore agent defaults while jobs are running. Wait for jobs to complete." };
  }

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
let restartFlagPollTimer: ReturnType<typeof setInterval> | null = null;

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

/** Resolve the stable public URL for a named tunnel: https://<tunnel-id>.cfargotunnel.com */
function resolveNamedTunnelUrl(name: string): string | null {
  try {
    const out = execSync("cloudflared tunnel list --output json", { encoding: "utf8", timeout: 15000 });
    const list = JSON.parse(out);
    const entry = (Array.isArray(list) ? list : []).find((t: any) => t.name === name);
    if (entry && entry.id) return `https://${entry.id}.cfargotunnel.com`;
  } catch {
    // fall through to `cloudflared tunnel info`
  }
  try {
    const out = execSync(`cloudflared tunnel info ${JSON.stringify(name)} --output json`, { encoding: "utf8", timeout: 15000 });
    const info = JSON.parse(out);
    if (info && info.id) return `https://${info.id}.cfargotunnel.com`;
  } catch {
    // fall through
  }
  return null;
}

/** Name of the DS-mon tunnel used for connection checks (defaults to "dsmon"). */
function getDsmonTunnelName(): string {
  return (getConfig().CLOUDFLARED_TUNNEL_NAME || "dsmon").trim() || "dsmon";
}

/** True if the named tunnel currently has at least one active connection (i.e. it's running, possibly externally).
 *  Async (spawn-based) so an offline/hung cloudflared can never block the main process. */
function tunnelHasConnections(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: import("child_process").ChildProcess | null = null;
    try {
      proc = spawn("cloudflared", ["tunnel", "list", "--output", "json"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        proc?.kill("SIGKILL");
      } catch {}
      resolve(false);
    }, 10000);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const list = JSON.parse(out);
        const entry = (Array.isArray(list) ? list : []).find((t: any) => t.name === name);
        if (!entry) return resolve(false);
        // `cloudflared tunnel list` reports the CONNECTIONS column as an array of
        // connection IDs — non-empty means the tunnel is live (externally or via us).
        const conns = entry.connections ?? entry.conns;
        resolve(Array.isArray(conns) && conns.length > 0);
      } catch {
        resolve(false);
      }
    });
  });
}

/** Derive the public tunnel URL in token mode from the DSMON_PUSH_URL origin. */
function tokenModeUrlFromConfig(): string | null {
  try {
    return new URL((getConfig().DSMON_PUSH_URL || "").trim()).origin;
  } catch {
    return null;
  }
}

/** Route a tunnel event through the app logger (live log + per-job pipeline.log) AND the terminal. */
function tunnelLog(level: "debug" | "info" | "warn" | "error", message: string): void {
  addLog("main", level, message);
  console.log(`[main] ${message}`);
}

/** At startup: if usage tracking is enabled and a tunnel token is set, check the
 *  DS-mon tunnel and auto-start it when it isn't connected. */
async function ensureDsmonTunnelRunning(): Promise<void> {
  const cfg = getConfig();
  const token = (cfg.CLOUDFLARED_TUNNEL_TOKEN || "").trim();
  const enabled = (cfg.USAGE_TRACKING_ENABLED || "").trim() === "true";
  if (!token || !enabled) {
    tunnelLog("debug", "[tunnel] Auto-check skipped — usage tracking off or no tunnel token");
    return;
  }
  if (await tunnelHasConnections(getDsmonTunnelName())) {
    tunnelLog("info", "[tunnel] DS-mon tunnel already connected — no auto-start needed");
    return;
  }
  tunnelLog("info", "[tunnel] DS-mon tunnel not connected — auto-starting");
  const result = await startTunnelInternal();
  if (!result.success) {
    tunnelLog("warn", `[tunnel] Auto-start failed: ${result.error}`);
  }
}

async function startTunnelInternal(): Promise<{ success: boolean; error?: string; url?: string; running?: boolean }> {
  if (tunnelProcess) {
    return { success: false, error: "Tunnel is already running", running: true, url: tunnelUrl ?? undefined };
  }
  tunnelUrl = null;
  tunnelError = null;
  const cfg = getConfig();
  const tunnelToken = (cfg.CLOUDFLARED_TUNNEL_TOKEN || "").trim();
  const tunnelName = (cfg.CLOUDFLARED_TUNNEL_NAME || "").trim();
  // In token mode the public hostname is the DSMON_PUSH_URL origin
  // (that hostname routes to this tunnel → localhost:18888).
  const tokenModeUrl = tunnelToken ? tokenModeUrlFromConfig() : null;
  tunnelLog("info", `[tunnel] Starting cloudflared tunnel on port 18888 (${tunnelToken ? "token" : tunnelName ? `named: ${tunnelName}` : "quick"})`);
  return new Promise<{ success: boolean; error?: string; url?: string }>((resolve) => {
    try {
      // Token mode: `cloudflared tunnel run --token <TOKEN> --protocol http2`.
      // A named tunnel has a stable https://<tunnel-id>.cfargotunnel.com URL;
      // a quick tunnel prints a throwaway trycloudflare URL once connected.
      const namedUrl = tunnelName && !tunnelToken ? resolveNamedTunnelUrl(tunnelName) : null;
      if (tunnelName && !tunnelToken && !namedUrl) {
        tunnelError = `Named tunnel "${tunnelName}" not found — create it with: cloudflared tunnel create ${tunnelName}`;
        tunnelLog("error", `[tunnel] ${tunnelError}`);
        resolve({ success: false, error: tunnelError });
        return;
      }

      let args: string[];
      if (tunnelToken) {
        args = ["tunnel", "run", "--token", tunnelToken, "--protocol", "http2"];
      } else if (tunnelName) {
        args = ["tunnel", "run", tunnelName];
      } else {
        args = ["tunnel", "--url", "http://localhost:18888"];
      }
      const proc = spawn("cloudflared", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      tunnelProcess = proc;
      let resolved = false;

      const success = (url: string | null) => {
        if (resolved) return;
        resolved = true;
        tunnelUrl = url;
        // Write current URL to disk (.cloudflared-url) for reference
        if (url) {
          try {
            fs.writeFileSync(CLOUDFLARED_URL_FILE, url + "\n", "utf8");
          } catch {}
        }
        tunnelLog("info", `[tunnel] Cloudflare tunnel URL: ${url ?? "(unknown)"}`);
        resolve({ success: true, url: url ?? undefined });
      };

      const onData = (d: Buffer, source: string) => {
        const text = d.toString();
        tunnelLog("debug", `[tunnel${source}] ${text.trim()}`);
        if (tunnelToken) {
          // Token mode logs a "Registered tunnel connection" line once live.
          if (!resolved && /registered tunnel connection|connection established/i.test(text)) success(tokenModeUrl);
        } else if (tunnelName) {
          // Named tunnels log a "Registered tunnel connection" line once live.
          if (!resolved && /registered tunnel connection|connection established/i.test(text)) success(namedUrl!);
        } else {
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match && !resolved) success(match[0]);
        }
      };
      proc.stdout?.on("data", (d: Buffer) => onData(d, ""));
      proc.stderr?.on("data", (d: Buffer) => onData(d, ":stderr"));

      proc.on("close", (code) => {
        tunnelProcess = null;
        tunnelLog("info", `[tunnel] Process exited with code ${code}`);
        if (!resolved) {
          resolved = true;
          tunnelError = `cloudflared exited with code ${code}`;
          resolve({ success: false, error: tunnelError });
        }
      });
      proc.on("error", (err) => {
        tunnelProcess = null;
        tunnelLog("error", `[tunnel] Failed to start: ${err.message}`);
        if (!resolved) {
          resolved = true;
          tunnelError =
            (err as NodeJS.ErrnoException).code === "ENOENT" ? "cloudflared not found — install it with: brew install cloudflared" : err.message;
          resolve({ success: false, error: tunnelError });
        }
      });
      // Timeout: if the tunnel doesn't come up within 45s, fail and kill the
      // lingering process so it doesn't keep running in the background.
      setTimeout(() => {
        if (!resolved && tunnelProcess) {
          resolved = true;
          tunnelError = "Timed out waiting for tunnel (45s) — check your internet connection";
          tunnelLog("error", `[tunnel] ${tunnelError}`);
          tunnelProcess.kill("SIGTERM");
          tunnelProcess = null;
          resolve({ success: false, error: tunnelError });
        }
      }, 45000);
    } catch (err: any) {
      tunnelError = err.message;
      tunnelLog("error", `[tunnel] Spawn error: ${err.message}`);
      resolve({ success: false, error: err.message });
    }
  });
}

ipcMain.handle("tunnel:start", () => startTunnelInternal());

ipcMain.handle("tunnel:stop", async () => {
  if (!tunnelProcess) {
    return { success: false, error: "Tunnel is not running" };
  }
  tunnelLog("info", "[tunnel] Stopping cloudflared tunnel");
  tunnelProcess.kill("SIGTERM");
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelError = null;
  // Remove URL file
  try {
    fs.unlinkSync(CLOUDFLARED_URL_FILE);
  } catch {}
  return { success: true };
});

/** Force-stop any running cloudflared (external / root-owned) — equivalent to `sudo killall cloudflared`. */
ipcMain.handle("tunnel:forceStop", async () => {
  // 1) Kill any process we spawned.
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch {}
    tunnelProcess = null;
  }
  tunnelUrl = null;
  tunnelError = null;
  try {
    fs.unlinkSync(CLOUDFLARED_URL_FILE);
  } catch {}

  // 2) Kill any other cloudflared processes (external / root-owned).
  try {
    if (process.platform === "darwin") {
      // Native macOS admin prompt → runs `killall cloudflared` as root (== sudo).
      const script = 'do shell script "killall cloudflared" with administrator privileges';
      await new Promise<void>((resolve, reject) => {
        execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
      });
    } else if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile("taskkill", ["/IM", "cloudflared.exe", "/F"], (err) => (err ? reject(err) : resolve()));
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile("killall", ["cloudflared"], (err) => (err ? reject(err) : resolve()));
      });
    }
    tunnelLog("info", "[tunnel] Force-stopped cloudflared");
  } catch (err: any) {
    const msg = `Could not stop cloudflared automatically — run 'sudo killall cloudflared' in a terminal. (${err?.message || err})`;
    tunnelLog("warn", `[tunnel] ${msg}`);
    return { success: false, error: msg };
  }
  return { success: true };
});

ipcMain.handle("tunnel:status", async () => {
  const token = (getConfig().CLOUDFLARED_TUNNEL_TOKEN || "").trim();
  const running = tunnelProcess !== null;
  // "Connected" means the DS-mon tunnel has active connections — this also
  // catches tunnels managed externally (launchd / cloudflared service).
  const connected = token ? (running ? true : await tunnelHasConnections(getDsmonTunnelName())) : running;
  const url = tunnelUrl || (connected && token ? tokenModeUrlFromConfig() : null);
  return { running, connected, url, error: tunnelError };
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

  // Resolve node — packaged uses Electron's embedded Node (Wine-safe); dev uses system node
  let nodeSpec = { command: "node", args: [scriptPath], env: {} as Record<string, string> };
  try {
    nodeSpec = nodeSpawnSpec(scriptPath);
  } catch {}

  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    botProcess = spawn(nodeSpec.command, nodeSpec.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...nodeSpec.env,
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
  // Packaged: Node runs via Electron's embedded runtime (ELECTRON_RUN_AS_NODE) — always available.
  if (app.isPackaged) {
    return { available: true, path: `${process.execPath} (Electron embedded Node)` };
  }

  // Dev: system Node on PATH (no bundled node anymore)
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

// ── Gmail OAuth IPC handlers ("Connect with Google") ──

registerGmailOAuthIpc();
registerMeetingsIpc();

// ── App Lifecycle ──

const unsubscribeLogs = subscribe((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", entry);
    // Forward parsed per-stage progress (diarization / ASR %) to the renderer
    // pipeline stepper as a lightweight structured event.
    if (entry.stageProgress) {
      mainWindow.webContents.send("job-progress", {
        jobId: entry.stageProgress.jobId,
        stage: entry.stageProgress.stage,
        percent: entry.stageProgress.percent,
        timestamp: entry.timestamp,
      });
    }
  }
});

// ── app-doc:// protocol — serve files under the docs directory ──
// Used by the in-app User Guide / Dev Guide so their <img> tags resolve to the
// bundled (or repo) screenshots. Path traversal is blocked.

const DOC_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
};

/** Resolve the docs directory (dev: repo docs/; packaged: resources/docs). */
function resolveDocsRoot(): string {
  const candidates = [path.join(__dirname, "..", "..", "..", "docs"), path.join(app.getAppPath(), "..", "docs")];
  if (app.isPackaged) {
    candidates.unshift(path.join(process.resourcesPath, "..", "docs"));
    candidates.unshift(path.join(process.resourcesPath, "docs"));
  }
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch {
      // try next candidate
    }
  }
  return path.join(app.getAppPath(), "..", "docs");
}

/** Register the app-doc:// handler (must run inside app.whenReady). */
function registerDocsProtocol(): void {
  protocol.handle("app-doc", async (request) => {
    try {
      const url = new URL(request.url);
      // For a standard scheme, app-doc://screenshots/… parses with "screenshots"
      // as the host — reconstruct the relative path from host + pathname so both
      // that form and app-doc:///… work.
      const rel = decodeURIComponent((url.hostname ? url.hostname + url.pathname : url.pathname).replace(/^\/+/, ""));
      if (!rel) return new Response("Not found", { status: 404 });

      const docsRoot = path.resolve(resolveDocsRoot());
      const filePath = path.resolve(docsRoot, rel);
      if (!filePath.startsWith(docsRoot + path.sep)) {
        return new Response("Forbidden", { status: 403 });
      }

      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(data, { headers: { "Content-Type": DOC_MIME_TYPES[ext] || "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  // If this instance failed to acquire the single-instance lock, do nothing —
  // we've already called app.quit() above.
  if (!gotTheLock) return;

  // Serve docs images to the renderer (in-app User Guide / Dev Guide).
  registerDocsProtocol();

  // ── Notification platform setup ──
  // Windows: bind AppUserModelId so toast notifications appear correctly
  // in the Action Center with the proper app name and icon.
  if (process.platform === "win32") {
    app.setAppUserModelId("com.transcription.agent");
  }

  // Create window first (so user sees something while backend starts)
  createWindow();
  createTray();

  // Record the initial license state (censored) to the live log + license.log.
  logCurrentLicenseStatus();

  // Detect missing/corrupt config so the user is informed (never silent defaults).
  const integrity = getConfigIntegrity();
  if (integrity.configGpg === "missing") {
    logLicenseFlow("warn", "config.integrity.missing", { backup: integrity.backupExists });
  } else if (integrity.configGpg === "corrupt") {
    logLicenseFlow("warn", "config.integrity.undecryptable");
  }

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
  writeUpdateLog("info", `App started (lock acquired). execPath=${process.execPath} argv=${JSON.stringify(process.argv)}`);

  // Start periodic health monitoring
  startHealthMonitoring();

  // ── DS-mon tunnel: check connection state and auto-start if needed ──
  ensureDsmonTunnelRunning();

  // ── DS-mon license authority: startup check + periodic revocation re-check ──
  // (see electron/src/main/dsmon.ts). Non-blocking; no-op unless
  // DSMON_LICENSE_CHECK_ENABLED === "true" and a seat is installed.
  startDsmonLicenseMonitor();

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
  //
  // Uses polling rather than fs.watch: the flag file typically doesn't exist at
  // startup, and fs.watch on a non-existent file fails (ENOENT) so the watcher
  // never fires. Polling is also consistent with the chromium log tailer.
  const restartFlagPath = path.join(userDataAgentConfigDir, ".restart-flag");
  const RESTART_FLAG_POLL_MS = 2000;
  if (fs.existsSync(userDataAgentConfigDir)) {
    restartFlagPollTimer = setInterval(() => {
      if (!fs.existsSync(restartFlagPath)) return;
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
    }, RESTART_FLAG_POLL_MS);
    addLog("main", "info", `Polling restart flag: ${restartFlagPath} (every ${RESTART_FLAG_POLL_MS}ms)`);
  } else {
    addLog("main", "debug", `agent-config dir not found at ${userDataAgentConfigDir} (restart flag poller deferred)`);
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
  const isUpdating = getUpdateState().updateDownloaded;

  // Show the confirmation dialog ONLY for a user-initiated quit that hasn't
  // already been confirmed in the UI (quitApp sets isQuitting=true first).
  // OS-initiated shutdown/logoff and the auto-updater's quitAndInstall() must
  // NOT be blocked by a modal — it can stall Windows shutdown or abort the
  // update after the user already clicked "Restart & Install".
  if (!isQuitting && quitRequestedByUser && !isUpdating) {
    event.preventDefault();
    const result = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Cancel", "Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Quit Transcription Agent",
      message: "Are you sure you want to quit?",
    });
    if (result !== 1) return; // user clicked Cancel — stay running
    isQuitting = true;
  }

  // Run cleanup exactly once for EVERY quit path (tray/UI confirmed, OS
  // shutdown/logoff, and update installs). Previously the quitApp path skipped
  // this entirely, leaving the Python/bridge/agent children orphaned.
  if (!quitCleanupDone) {
    quitCleanupDone = true;
    isQuitting = true;
    tray = null;
    unsubscribeLogs();
    stopHealthMonitoring();
    stopAutoUpdater();
    if (restartFlagPollTimer) {
      clearInterval(restartFlagPollTimer);
      restartFlagPollTimer = null;
    }
    // Use synchronous kill — stopAll() is async and won't complete before
    // app.exit(0) terminates the process. stopAllSync() sends SIGKILL
    // immediately on Unix (taskkill /F on Windows) so children can't survive.
    stopAllSync();
    stopAllCapture();
  }

  // Only force-terminate when we preventDefault'd above (user-confirmed quit).
  // For OS shutdown, update installs, and UI-confirmed quits, let the normal
  // quit flow complete so the auto-updater can relaunch and Windows shutdown
  // is not blocked.
  if (event.defaultPrevented) {
    app.exit(0);
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// Re-check the DS-mon license authority whenever the app window regains focus,
// so a seat revoked mid-session is locked the moment the user returns to the
// app (throttled to once per minute — checkDsmonAuthority is a network call).
app.on("browser-window-focus", () => {
  const last = getDsmonAuthorityState().checkedAt;
  if (last && Date.now() - last < 60_000) return;
  checkDsmonAuthority().catch(() => {});
});
