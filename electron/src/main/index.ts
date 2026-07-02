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
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog } from "electron";
import path from "path";
import pidusage from "pidusage";
import {
  startAll,
  startPythonBackend,
  startBridgeServer,
  startAgentRunner,
  ensureOllamaRunning,
  stopAll,
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
  killProcessOnPort,
  getChildPids,
} from "./backend-manager";
import {
  subscribe,
  getLogs,
  clearLogs,
  addLog,
  initFileLogging,
  configureLogFilter,
  listLogFiles,
  readLogFile,
  getLogDir,
  getMirrorDir,
} from "./logger";
import { getConfig, saveConfig, checkConfig, getConfigWithSources } from "./config";
import { startAutoUpdater, stopAutoUpdater, registerAutoUpdateIpc, getUpdateState, checkAndUpdate } from "./auto-updater";

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  // In development, load from Vite dev server
  const isProd = app.isPackaged;
  if (isProd) {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    // Minimize to tray instead of closing (unless we're actually quitting)
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

// ── System Tray ──

function createTray() {
  // Create a simple 16x16 tray icon (you can replace with an actual icon file)
  const icon = nativeImage.createEmpty();
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

// ── Notifications ──

function sendNotification(title: string, body: string) {
  if (mainWindow && !mainWindow.isFocused()) {
    new Notification({ title, body }).show();
  }
}

// ── IPC Handlers ──

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
  return app.getVersion();
});

ipcMain.handle("jobs:getActive", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5001/transcribe/active", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.active_jobs || [];
    }
  } catch {
    // Backend not running — no active jobs
  }
  return [];
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
  addLog("main", "info", "Config retrieved");
  return cfg;
});

ipcMain.handle("config:save", async (_event, values: Record<string, string>) => {
  addLog("main", "info", "Config saving...");
  saveConfig(values);

  // Re-apply log filter so changes take effect immediately (no restart needed)
  const updatedConfig = getConfig();
  configureLogFilter({
    enabledSources: updatedConfig.LOG_ENABLED_SOURCES,
    minLevel: updatedConfig.LOG_LEVEL,
    maxFileSizeMb: updatedConfig.LOG_MAX_FILE_SIZE_MB,
    maxFiles: updatedConfig.LOG_MAX_FILES,
  });
  addLog("main", "info", `Log filter updated: sources=${updatedConfig.LOG_ENABLED_SOURCES} level=${updatedConfig.LOG_LEVEL}`);

  // Check what changed
  const cfg = checkConfig();
  if (cfg.ok) {
    addLog("main", "info", `Config OK — ${cfg.missing.length} missing values`);
  } else {
    addLog("main", "warn", `Config incomplete — missing: ${cfg.missing.join(", ")}`);
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
  try {
    const res = await fetch("http://127.0.0.1:5010/agent/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const result = await res.json();
      addLog("main", "info", "Agent config saved");
      return result;
    }
    const errText = await res.text();
    addLog("main", "error", `Agent config save failed: ${errText}`);
    return { error: `Bridge returned ${res.status}: ${errText}` };
  } catch (err: any) {
    addLog("main", "error", `Agent config save failed: ${err.message}`);
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

// ── Log file browsing ──

ipcMain.handle("logs:listFiles", () => {
  return listLogFiles();
});

ipcMain.handle("logs:readFile", async (_event, filePath: string, maxLines?: number) => {
  return readLogFile(filePath, maxLines);
});

ipcMain.handle("logs:getPaths", () => {
  return { primary: getLogDir(), mirror: getMirrorDir() };
});

// ── App Lifecycle ──

const unsubscribeLogs = subscribe((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", entry);
  }
});

app.whenReady().then(async () => {
  // Create window first (so user sees something while backend starts)
  createWindow();
  createTray();

  // Initialize file logging
  const userDataLogs = path.join(app.getPath("userData"), "logs");
  initFileLogging(userDataLogs);

  // Apply log filter from config (controls which sources/levels write to disk)
  const startupConfig = getConfig();
  configureLogFilter({
    enabledSources: startupConfig.LOG_ENABLED_SOURCES,
    minLevel: startupConfig.LOG_LEVEL,
    maxFileSizeMb: startupConfig.LOG_MAX_FILE_SIZE_MB,
    maxFiles: startupConfig.LOG_MAX_FILES,
  });
  addLog(
    "main",
    "info",
    `App started — logs: ${userDataLogs} | filter: sources=${startupConfig.LOG_ENABLED_SOURCES} level=${startupConfig.LOG_LEVEL}`,
  );

  // Start periodic health monitoring
  startHealthMonitoring();

  // ── Watch agent-config restart flag ──
  // When the bridge touches agent-config/.restart-flag (via POST /agent/config/restart),
  // restart the agent runner so it picks up new tool/pipeline config.
  const agentConfigDir = (() => {
    const candidates = [path.join(app.getAppPath(), "..", "agent-config"), path.join(app.getAppPath(), "agent-config")];
    if (app.isPackaged) {
      candidates.unshift(path.join(process.resourcesPath, "agent-config"));
    }
    return candidates.find((d) => fs.existsSync(d)) || candidates[0];
  })();

  const restartFlagPath = path.join(agentConfigDir, ".restart-flag");
  if (fs.existsSync(agentConfigDir)) {
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
    addLog("main", "debug", `agent-config dir not found at ${agentConfigDir} (restart watcher deferred)`);
  }

  // Then start backend services
  try {
    // Python and Bridge don't need API keys — always safe to start
    await startPythonBackend();
    await startBridgeServer();

    // Agent runner needs DEEPSEEK_API_KEY (or Ollama) — skip if missing
    const cfg = checkConfig();
    if (cfg.ok) {
      addLog("main", "info", `Config OK — starting agent runner`);
      // If using Ollama, try to ensure the server is running first
      await ensureOllamaRunning();
      await startAgentRunner();
      sendNotification("Ready", "Transcription backend is running");
      mainWindow?.webContents.send("notification", "Backend ready");
    } else {
      const msg = `Config incomplete — agent runner deferred. Missing: ${cfg.missing.join(", ")}`;
      console.log(`[startup] ${msg}`);
      addLog("main", "warn", msg);
      mainWindow?.webContents.send("notification", "Config needed — enter API key to start agent");
    }
  } catch (err: any) {
    const msg = `Failed to start backend: ${err.message}`;
    console.error(msg);
    addLog("main", "error", msg);
    dialog.showErrorBox("Backend Error", "Could not start the transcription backend. Make sure Python 3 and Node.js are installed.");
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
  stopAll();
  // Kill any leftover processes on our ports (safety net)
  killProcessOnPort(5001);
  killProcessOnPort(5010);
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
