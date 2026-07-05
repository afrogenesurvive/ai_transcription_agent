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
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog } from "electron";
import path from "path";
import pidusage from "pidusage";

// Set app name before anything else — macOS menu bar and Windows taskbar
// use this instead of the default "Electron".
app.name = "Transcription Agent";
import {
  startAll,
  startPythonBackend,
  startBridgeServer,
  startAgentRunner,
  ensureOllamaRunning,
  ensureFfmpegAvailable,
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
  ollamaStartedByUs,
  stopOllamaServer,
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
import { getConfig, getChildEnv, saveConfig, checkConfig, getConfigWithSources } from "./config";
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
  // Show a top-level OS notification regardless of window focus
  new Notification({ title, body }).show();
}

// ── IPC Handlers ──

ipcMain.handle("notification:show", (_event, title: string, body: string) => {
  sendNotification(title, body);
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
      addLog("main", "info", `💰 [USAGE] Aggregate token usage fetched: ${data.job_count} jobs, ${data.totals?.total_tokens || 0} total tokens`);
      return data;
    }
    addLog("main", "warn", `💰 [USAGE] Aggregate token usage fetch failed: bridge returned ${res.status}`);
    return { error: `Bridge returned ${res.status}` };
  } catch (err: any) {
    addLog("main", "warn", `💰 [USAGE] Aggregate token usage fetch failed: ${err.message}`);
    return { error: `Bridge unreachable: ${err.message}` };
  }
});

// ── DeepSeek API Credit / Balance ──

ipcMain.handle("api:checkDeepSeekBalance", async () => {
  const cfg = getConfig();
  const apiKey = cfg.DEEPSEEK_API_KEY;
  if (!apiKey) {
    addLog("main", "warn", "💰 [USAGE] Credit balance check skipped — no API key configured");
    return { available: false, balance: null, error: "No API key configured" };
  }
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown");
      addLog("main", "warn", `💰 [USAGE] Credit balance check failed: API Error ${res.status}`);
      return { available: false, balance: null, error: `API Error ${res.status}: ${text}` };
    }
    const data = await res.json();
    // DeepSeek returns:
    //   { balance_infos: [{ total_balance: "12.34", topped_up_balance: "10.00", grant_balance: "2.34" }], is_available: true }
    // Extract total_balance from the first balance_info entry (fall back to flat `balance` for older API versions).
    const balance = data.balance_infos?.[0]?.total_balance ?? data.balance ?? null;
    addLog("main", "info", `💰 [USAGE] Credit balance checked: $${balance || "0"} (available: ${data.is_available ?? true})`);
    return {
      available: data.is_available ?? true,
      balance,
      error: null,
    };
  } catch (err: any) {
    addLog("main", "warn", `💰 [USAGE] Credit balance check failed: ${err.message}`);
    return { available: false, balance: null, error: err.message };
  }
});

// ── Config Export / Import IPC ──

ipcMain.handle("config:export", async () => {
  addLog("main", "info", "Config export requested");
  try {
    // Read user config file
    const userDataPath = app.getPath("userData");
    const configPath = path.join(userDataPath, "config.json");
    let userConfig: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      userConfig = JSON.parse(raw);
    }

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

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      userConfig,
      agentConfig,
    };

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Export Configuration",
      defaultPath: path.join(app.getPath("documents"), `transcription-agent-config-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: "JSON Config", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) {
      addLog("main", "info", "Config export cancelled by user");
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
  addLog("main", "info", "Config import requested");
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
      addLog("main", "info", "Config import cancelled by user");
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
    saveConfig(importData.userConfig);
    addLog("main", "info", "User config imported successfully");

    // Re-apply log filter so changes take effect immediately
    const updatedConfig = getConfig();
    configureLogFilter({
      enabledSources: updatedConfig.LOG_ENABLED_SOURCES,
      minLevel: updatedConfig.LOG_LEVEL,
      maxFileSizeMb: updatedConfig.LOG_MAX_FILE_SIZE_MB,
      maxFiles: updatedConfig.LOG_MAX_FILES,
    });
    addLog("main", "info", `Log filter updated: sources=${updatedConfig.LOG_ENABLED_SOURCES} level=${updatedConfig.LOG_LEVEL}`);

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
      try {
        const agentPayload: any = {};
        if (importData.agentConfig.systemPrompt) agentPayload.systemPrompt = importData.agentConfig.systemPrompt;
        if (importData.agentConfig.pipeline) agentPayload.pipeline = importData.agentConfig.pipeline;
        if (importData.agentConfig.tools) agentPayload.tools = importData.agentConfig.tools;

        const res = await fetch("http://127.0.0.1:5010/agent/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(agentPayload),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          agentConfigImported = true;
          addLog("main", "info", "Agent config imported successfully via bridge");
        } else {
          addLog("main", "warn", `Agent config import returned status ${res.status}`);
        }
      } catch {
        addLog("main", "warn", "Agent config import skipped — bridge not reachable");
      }
    }

    return { success: true, agentConfigImported, filePath };
  } catch (err: any) {
    addLog("main", "error", `Config import failed: ${err.message}`);
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
    dialog.showErrorBox(
      "Backend Error",
      "Could not start the transcription backend. If you're running a development build, make sure Python 3 and Node.js are installed. Packaged builds bundle all dependencies automatically.",
    );
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
  // Stop Ollama first (synchronously) — it uses execSync, so it must run
  // before the async stopAll() which gets suspended and may not complete
  // before app.exit(0) terminates the process.
  stopOllamaServer();
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
