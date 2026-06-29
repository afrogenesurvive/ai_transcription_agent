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

import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog } from "electron";
import path from "path";
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
} from "./backend-manager";
import { subscribe, getLogs, clearLogs, addLog, initFileLogging, listLogFiles, readLogFile, getLogDir, getMirrorDir } from "./logger";
import { getConfig, saveConfig, checkConfig, getConfigWithSources } from "./config";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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
    // Minimize to tray instead of closing
    if (tray) {
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
      label: "Quit",
      click: () => {
        tray = null;
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
  const devLogs = app.isPackaged ? undefined : path.join(app.getAppPath(), "..", "storage", "logs");
  initFileLogging(userDataLogs, devLogs);
  addLog("main", "info", `App started — logs: ${userDataLogs}`);

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  unsubscribeLogs();
  await stopAll();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
