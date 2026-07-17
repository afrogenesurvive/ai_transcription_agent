/**
 * Preload script — exposes safe IPC channels to the renderer via contextBridge.
 *
 * The renderer uses these for Electron-specific operations (file dialogs,
 * system tray, app info) while all API calls go directly to the bridge server.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { LogEntry, LogFileInfo } from "./logger";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── File dialogs ──
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectAudio"),

  // ── Backend status ──
  getBackendStatus: (): Promise<{
    python: boolean;
    bridge: boolean;
    agent: boolean;
  }> => ipcRenderer.invoke("backend:status"),

  // checkServers is intentionally aliased to getBackendStatus for API clarity
  checkServers: (): Promise<{
    python: boolean;
    bridge: boolean;
    agent: boolean;
  }> => ipcRenderer.invoke("backend:status"),

  // ── Service management ──
  stopServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:stop"),
  restartServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:restart"),

  // ── App lifecycle ──
  closeApp: (): Promise<{ success: boolean }> => ipcRenderer.invoke("app:close"),
  stopService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:stop", service),
  restartService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:restart", service),

  // ── App info ──
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getAppName: (): Promise<string> => ipcRenderer.invoke("app:name"),
  getReadme: (): Promise<string> => ipcRenderer.invoke("app:readme"),
  getGuide: (): Promise<string> => ipcRenderer.invoke("app:guide"),

  // ── Job status ──
  getActiveJobs: (): Promise<Array<{ job_id: string; status: string; progress: number; title: string }>> => ipcRenderer.invoke("jobs:getActive"),
  getRunningBotJobs: (): Promise<Array<{ job_id: string; status: string }>> => ipcRenderer.invoke("testbot:getRunningJobs"),

  // ── Notifications ──
  onNotification: (callback: (message: string) => void) => {
    ipcRenderer.on("notification", (_event, message) => callback(message));
    return () => ipcRenderer.removeAllListeners("notification");
  },
  onNotificationClick: (callback: (payload: Record<string, unknown>) => void) => {
    ipcRenderer.on("notification-click", (_event, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners("notification-click");
  },

  // ── Developer logs ──
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke("logs:get"),
  clearLogs: (): Promise<{ success: boolean }> => ipcRenderer.invoke("logs:clear"),
  onLog: (callback: (entry: LogEntry) => void) => {
    ipcRenderer.on("log", (_event, entry) => callback(entry));
    return () => ipcRenderer.removeAllListeners("log");
  },

  // ── Tray / Menu Bar ──
  toggleTray: (): Promise<{ visible: boolean }> => ipcRenderer.invoke("tray:toggle"),
  getTrayStatus: (): Promise<{ visible: boolean }> => ipcRenderer.invoke("tray:status"),

  // ── Voiceprint conflict checking ──
  checkVoiceprintConflicts: (attendees: Array<{ name: string; email?: string }>): Promise<{ conflicts: Array<any> }> =>
    ipcRenderer.invoke("voiceprints:check-conflicts", attendees),

  // ── Label verification (Mitigation 1: voiceprint-backed label verification) ──
  verifyLabels: (payload: { jobId: string; labels: Array<{ speaker_id: string; name: string; email?: string }> }): Promise<{
    verifications: Array<any>;
    unregistered_names: Array<string>;
    registered_attendees: Array<string>;
  }> => ipcRenderer.invoke("labels:verify", payload),

  // ── Configuration ──
  getConfig: (): Promise<Record<string, string>> => ipcRenderer.invoke("config:get"),
  saveConfig: (values: Record<string, string>): Promise<Record<string, string>> => ipcRenderer.invoke("config:save", values),
  checkConfig: (): Promise<{ ok: boolean; missing: string[] }> => ipcRenderer.invoke("config:check"),
  getConfigWithSources: (): Promise<Record<string, { value: string; source: string }>> => ipcRenderer.invoke("config:getWithSources"),
  exportConfig: (): Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }> => ipcRenderer.invoke("config:export"),
  importConfig: (): Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    cancelled?: boolean;
    blocked?: boolean;
    agentConfigImported?: boolean;
  }> => ipcRenderer.invoke("config:import"),

  // ── Agent Instructions Configuration ──
  getAgentConfig: (): Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }> => ipcRenderer.invoke("agent-config:get"),
  saveAgentConfig: (config: { tools?: any; pipeline?: any; systemPrompt?: string }): Promise<{ success?: boolean; error?: string }> =>
    ipcRenderer.invoke("agent-config:save", config),
  restartAgent: (): Promise<{ success?: boolean; error?: string }> => ipcRenderer.invoke("agent-config:restart"),
  getDefaultAgentConfig: (): Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }> =>
    ipcRenderer.invoke("agent-config:defaults"),
  restoreDefaultAgentConfig: (): Promise<{ success?: boolean; restored?: string[]; error?: string }> =>
    ipcRenderer.invoke("agent-config:restore-defaults"),

  // ── Job log file browsing ──
  listJobLogFiles: (): Promise<LogFileInfo[]> => ipcRenderer.invoke("logs:listJobLogFiles"),
  readJobLogFile: (jobId: string, maxLines?: number): Promise<string[]> => ipcRenderer.invoke("logs:readJobLogFile", jobId, maxLines),

  // ── Storage Usage ──
  getStorageUsage: () => ipcRenderer.invoke("storage:usage"),

  // ── Performance Metrics ──
  getPerformanceMetrics: (): Promise<{
    electron: Array<{ type: string; pid: number; cpu: number | null; memory: number | null; peakMemory: number | null }>;
    children: Array<{ service: string; pid: number; cpu: number; memory: number; elapsed: number }>;
  }> => ipcRenderer.invoke("metrics:getAll"),

  // ── Per-Job Performance Data ──
  getPerJobPerformance: (
    jobId: string,
  ): Promise<Array<{ timestamp: number; cpu: number; memoryBytes: number; label: string; stage: string | null }>> =>
    ipcRenderer.invoke("metrics:getPerJobPerformance", jobId),

  // ── Aggregate Performance Across Jobs ──
  getAggregatePerformance: (): Promise<
    Array<{ jobId: string; samples: Array<{ timestamp: number; cpu: number; memoryBytes: number; label: string; stage: string | null }> }>
  > => ipcRenderer.invoke("metrics:getAggregatePerformance"),

  // ── Auto-Update ──
  getUpdateStatus: (): Promise<{
    mode: string;
    enabled: boolean;
    lastCheck: string | null;
    lastUpdate: string | null;
    updateAvailable: string | null;
    checking: boolean;
    currentVersion: string;
    error: string | null;
    downloadProgress: number | null;
    updateDownloaded: boolean;
  }> => ipcRenderer.invoke("auto-update:status"),
  checkForUpdates: (): Promise<{ updateAvailable: boolean; details: string | null; error: string | null }> => ipcRenderer.invoke("auto-update:check"),
  setAutoUpdateEnabled: (enabled: boolean): Promise<{ success: boolean }> => ipcRenderer.invoke("auto-update:setEnabled", enabled),
  downloadUpdate: (): Promise<{ success: boolean; error: string | null }> => ipcRenderer.invoke("auto-update:download"),
  installUpdate: (): Promise<{ success: boolean }> => ipcRenderer.invoke("auto-update:install"),

  // ── Native Notifications ──
  showNotification: (title: string, body: string, clickPayload?: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke("notification:show", title, body, clickPayload),

  // ── Ollama Model Management ──
  listOllamaModels: (): Promise<{
    models: Array<{ name: string; size: number; modified_at: string }>;
    error: string | null;
    wasStarted?: boolean;
  }> => ipcRenderer.invoke("ollama:listModels"),
  pullOllamaModel: (modelName: string): Promise<{ success: boolean; error: string | null }> => ipcRenderer.invoke("ollama:pullModel", modelName),
  checkOllamaHealth: (): Promise<{ healthy: boolean; error: string | null }> => ipcRenderer.invoke("ollama:checkHealth"),
  startOllamaServer: (): Promise<{ success: boolean; error: string | null }> => ipcRenderer.invoke("ollama:startServer"),
  stopOllamaServer: (): Promise<{ success: boolean }> => ipcRenderer.invoke("ollama:stopServer"),

  // ── DeepSeek API Credit Balance ──
  checkDeepSeekBalance: (): Promise<{
    available: boolean;
    balance: string | null;
    error: string | null;
  }> => ipcRenderer.invoke("api:checkDeepSeekBalance"),

  // ── Aggregate Token Usage ──
  getAggregateUsage: (): Promise<{
    jobs: Array<{
      job_id: string;
      title: string;
      provider: string;
      model: string;
      step_count: number;
      totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      saved_at: string;
    }>;
    totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    job_count: number;
    error?: string;
  }> => ipcRenderer.invoke("api:getAggregateUsage"),

  // ── Export (PDF / Word) ──
  exportToPdf: (params: {
    html: string;
    defaultName?: string;
  }): Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }> => ipcRenderer.invoke("export:pdf", params),
  exportToWord: (params: {
    html: string;
    defaultName?: string;
  }): Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }> => ipcRenderer.invoke("export:word", params),

  // ── Shell & File system ──
  openPath: (filePath: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("shell:openPath", filePath),
  fileExists: (filePath: string): Promise<boolean> => ipcRenderer.invoke("fs:fileExists", filePath),

  // ── Playwright Testing ──
  runPlaywrightTests: (vars: Record<string, string>): Promise<{ exitCode: number; output: string }> => ipcRenderer.invoke("testing:run", vars),
  checkPlaywrightBuild: (): Promise<{ exists: boolean; builtAt: string | null }> => ipcRenderer.invoke("testing:checkBuild"),
  onPlaywrightOutput: (callback: (text: string) => void) => {
    ipcRenderer.on("testing:output", (_event, text) => callback(text));
    return () => ipcRenderer.removeAllListeners("testing:output");
  },

  // ── Bot Testing (Backend) ──
  readBotScript: (): Promise<string> => ipcRenderer.invoke("testing:bot:read"),
  saveBotScript: (content: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("testing:bot:save", content),
  runBotScript: (): Promise<{ exitCode: number; output: string }> => ipcRenderer.invoke("testing:bot:run"),
  stopBotScript: (): Promise<{ success: boolean; message?: string }> => ipcRenderer.invoke("testing:bot:stop"),
  onBotScriptOutput: (callback: (text: string) => void) => {
    ipcRenderer.on("testing:bot:output", (_event, text) => callback(text));
    return () => ipcRenderer.removeAllListeners("testing:bot:output");
  },
  checkNodeAvailable: (): Promise<{ available: boolean; path: string | null }> => ipcRenderer.invoke("testing:bot:checkNode"),
  readBotTestLog: (): Promise<string> => ipcRenderer.invoke("testing:bot:readLog"),

  // ── Platform ──
  platform: process.platform,
});
