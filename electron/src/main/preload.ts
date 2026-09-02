/**
 * Preload script — exposes safe IPC channels to the renderer via contextBridge.
 *
 * The renderer uses these for Electron-specific operations (file dialogs,
 * system tray, app info) while all API calls go directly to the bridge server.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LogEntry, LogFileInfo } from "./logger";
import type { GmailAuthResult } from "./gmailOAuth";
import type { MeetingInfo, MeetingAttendee, MeetingRecordingResult, MeetingAuthResult, CaptureSource, CaptureDeviceStatus } from "./meetings/types";
import type { DsmonAuthorityState } from "./dsmon";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── File dialogs ──
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectAudio"),

  // ── Backend status ──
  getBackendStatus: (): Promise<{
    python: boolean;
    bridge: boolean;
    agent: boolean;
    diarizationAvailable: boolean | null;
    diarizationError: string | null;
    diarizationModel: string | null;
    hfTokenConfigured: boolean | null;
    diarizationStatus: string | null;
    diarizationProgress: number | null;
  }> => ipcRenderer.invoke("backend:status"),

  // checkServers is intentionally aliased to getBackendStatus for API clarity
  checkServers: (): Promise<{
    python: boolean;
    bridge: boolean;
    agent: boolean;
    diarizationAvailable: boolean | null;
    diarizationError: string | null;
    diarizationModel: string | null;
    hfTokenConfigured: boolean | null;
    diarizationStatus: string | null;
    diarizationProgress: number | null;
  }> => ipcRenderer.invoke("backend:status"),

  // ── Service management ──
  stopServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:stop"),
  restartServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:restart"),

  // ── App lifecycle ──
  closeApp: (): Promise<{ success: boolean }> => ipcRenderer.invoke("app:close"),
  confirmQuit: (message: string): Promise<{ success: boolean }> => ipcRenderer.invoke("app:confirmQuit", { message }),
  quitApp: (): Promise<{ success: boolean }> => ipcRenderer.invoke("app:quitApp"),
  stopService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:stop", service),
  restartService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:restart", service),

  // ── App info ──
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getAppName: (): Promise<string> => ipcRenderer.invoke("app:name"),
  getReadme: (): Promise<string> => ipcRenderer.invoke("app:readme"),
  getGuide: (): Promise<string> => ipcRenderer.invoke("app:guide"),
  getDoc: (filename: string): Promise<string> => ipcRenderer.invoke("app:doc", filename),
  openExternal: (url: string): Promise<{ success: boolean }> => ipcRenderer.invoke("app:openExternal", url),

  // ── Gmail OAuth ("Connect with Google") ──
  startGmailOAuth: (clientId?: string, clientSecret?: string): Promise<GmailAuthResult> =>
    ipcRenderer.invoke("gmail:auth:start", { clientId, clientSecret }),
  cancelGmailOAuth: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("gmail:auth:cancel"),
  validateGmailOAuth: (): Promise<GmailAuthResult> => ipcRenderer.invoke("gmail:auth:validate"),

  // ── Microsoft Teams meetings ──
  teamsConnect: (): Promise<MeetingAuthResult> => ipcRenderer.invoke("meetings:teams:connect"),
  teamsCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("meetings:teams:cancel"),
  teamsValidate: (): Promise<{ ok: boolean; user?: string; error?: string }> => ipcRenderer.invoke("meetings:teams:validate"),
  teamsList: (): Promise<{ ok: boolean; meetings?: MeetingInfo[]; error?: string }> => ipcRenderer.invoke("meetings:teams:list"),
  teamsFetchRecording: (meetingId: string): Promise<MeetingRecordingResult & { ok: boolean; error?: string }> =>
    ipcRenderer.invoke("meetings:teams:recording", meetingId),

  // ── Zoom meetings ──
  zoomConnect: (): Promise<MeetingAuthResult> => ipcRenderer.invoke("meetings:zoom:connect"),
  zoomCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("meetings:zoom:cancel"),
  zoomValidate: (): Promise<{ ok: boolean; user?: string; error?: string }> => ipcRenderer.invoke("meetings:zoom:validate"),
  zoomList: (): Promise<{ ok: boolean; meetings?: MeetingInfo[]; error?: string }> => ipcRenderer.invoke("meetings:zoom:list"),
  zoomFetchRecording: (meetingId: string): Promise<MeetingRecordingResult & { ok: boolean; error?: string }> =>
    ipcRenderer.invoke("meetings:zoom:recording", meetingId),

  // ── System audio capture ──
  captureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke("capture:sources"),
  captureDevice: (): Promise<CaptureDeviceStatus> => ipcRenderer.invoke("capture:device"),
  captureStart: (deviceName?: string): Promise<{ ok: boolean; filePath?: string; error?: string }> => ipcRenderer.invoke("capture:start", deviceName),
  captureStop: (): Promise<{ ok: boolean; filePath?: string; error?: string }> => ipcRenderer.invoke("capture:stop"),
  captureSave: (data: Uint8Array): Promise<{ ok: boolean; filePath?: string; error?: string }> => ipcRenderer.invoke("capture:save", data),

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
  onJobStarted: (callback: (payload: { jobId: string; title?: string }) => void) => {
    ipcRenderer.on("job-started", (_event, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners("job-started");
  },

  // ── Developer logs ──
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke("logs:get"),
  clearLogs: (): Promise<{ success: boolean }> => ipcRenderer.invoke("logs:clear"),
  onLog: (callback: (entry: LogEntry) => void) => {
    ipcRenderer.on("log", (_event, entry) => callback(entry));
    return () => ipcRenderer.removeAllListeners("log");
  },
  onJobProgress: (callback: (payload: { jobId?: string; stage: "diarization" | "transcription"; percent: number; timestamp?: number }) => void) => {
    ipcRenderer.on("job-progress", (_event, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners("job-progress");
  },

  // ── Tray / Menu Bar ──
  toggleTray: (): Promise<{ visible: boolean }> => ipcRenderer.invoke("tray:toggle"),
  getTrayStatus: (): Promise<{ visible: boolean }> => ipcRenderer.invoke("tray:status"),

  // ── Voiceprint conflict checking ──
  checkVoiceprintConflicts: (attendees: Array<{ name: string; email?: string }>): Promise<{ conflicts: Array<any> }> =>
    ipcRenderer.invoke("voiceprints:check-conflicts", attendees),

  // ── Label verification (Mitigation 1: voiceprint-backed label verification) ──
  verifyLabels: (payload: {
    jobId: string;
    labels: Array<{ speaker_id: string; name: string; email?: string }>;
  }): Promise<{
    verifications: Array<any>;
    unregistered_names: Array<string>;
    registered_attendees: Array<string>;
  }> => ipcRenderer.invoke("labels:verify", payload),

  // ── Configuration ──
  getConfig: (): Promise<Record<string, string>> => ipcRenderer.invoke("config:get"),
  saveConfig: (values: Record<string, string>): Promise<Record<string, string>> => ipcRenderer.invoke("config:save", values),
  checkConfig: (): Promise<{ ok: boolean; missing: string[] }> => ipcRenderer.invoke("config:check"),
  getConfigWithSources: (): Promise<Record<string, { value: string; source: string }>> => ipcRenderer.invoke("config:getWithSources"),
  exportConfig: (options?: {
    mode?: "encrypted" | "plain";
  }): Promise<{
    success: boolean;
    filePath?: string;
    format?: "encrypted" | "plain";
    error?: string;
    cancelled?: boolean;
    warnings?: string[];
  }> => ipcRenderer.invoke("config:export", options),
  clearConfig: (): Promise<{ success: boolean; error?: string; blocked?: boolean }> => ipcRenderer.invoke("config:clear"),
  importConfig: (): Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    cancelled?: boolean;
    blocked?: boolean;
    agentConfigImported?: boolean;
    defaultsImported?: boolean;
    userDefaultsImported?: boolean;
  }> => ipcRenderer.invoke("config:import"),
  getDefaultUserConfig: (): Promise<{ success: boolean; defaults: Record<string, string>; error?: string }> => ipcRenderer.invoke("config:defaults"),
  restoreDefaultUserConfig: (): Promise<{ success: boolean; error?: string; blocked?: boolean }> => ipcRenderer.invoke("config:restore-defaults"),
  setDefaultConfig: (): Promise<{ success: boolean; agentDefaultsSaved?: boolean; error?: string; warnings?: string[] }> =>
    ipcRenderer.invoke("config:set-defaults"),

  // ── License (per-seat, offline verification + DS-mon authority) ──
  getLicenseStatus: (): Promise<{
    status:
      | { status: "unlicensed" }
      | { status: "active"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "expired"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "invalid"; reason: string };
    safeStorageAvailable: boolean;
    configIntegrity: { licenseKeyFile: "present" | "missing"; configGpg: "present" | "missing" | "corrupt"; backupExists: boolean };
    dsmon: DsmonAuthorityState;
  }> => ipcRenderer.invoke("license:get-status"),
  recheckDsmonLicense: (): Promise<DsmonAuthorityState> => ipcRenderer.invoke("dsmon:recheck"),
  // Pushed from main whenever the DS-mon authority verdict changes (revoked /
  // expired → panels re-obscure; valid → unlock) so the UI reloads its license
  // gating without a manual refresh or restart.
  onLicenseStatusChanged: (
    callback: (payload: {
      status:
        | { status: "unlicensed" }
        | { status: "active"; sub: string; kid: string; exp: number; installedAt?: number }
        | { status: "expired"; sub: string; kid: string; exp: number; installedAt?: number }
        | { status: "invalid"; reason: string };
      safeStorageAvailable: boolean;
      configIntegrity: { licenseKeyFile: "present" | "missing"; configGpg: "present" | "missing" | "corrupt"; backupExists: boolean };
      dsmon: DsmonAuthorityState;
    }) => void,
  ) => {
    ipcRenderer.on("license:status-changed", (_event, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners("license:status-changed");
  },
  activateLicense: (
    key: string,
  ): Promise<{
    success: boolean;
    reason?: string;
    migration?: { migrated: boolean; backupPath?: string };
    safeStorageAvailable?: boolean;
    status?:
      | { status: "unlicensed" }
      | { status: "active"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "expired"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "invalid"; reason: string };
  }> => ipcRenderer.invoke("license:activate", key),
  deactivateLicense: (): Promise<{
    success: boolean;
    safeStorageAvailable?: boolean;
    status?:
      | { status: "unlicensed" }
      | { status: "active"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "expired"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "invalid"; reason: string };
  }> => ipcRenderer.invoke("license:deactivate"),
  reKeyLicense: (
    newKey: string,
  ): Promise<{
    success: boolean;
    reason?: string;
    error?: string;
    safeStorageAvailable?: boolean;
    status?:
      | { status: "unlicensed" }
      | { status: "active"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "expired"; sub: string; kid: string; exp: number; installedAt?: number }
      | { status: "invalid"; reason: string };
  }> => ipcRenderer.invoke("license:re-key", newKey),
  getBridgeToken: (forceRefresh?: boolean): Promise<{ token: string } | { error: string }> =>
    ipcRenderer.invoke("license:get-bridge-token", forceRefresh),
  restoreConfigFromBackup: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("config:restore-backup"),

  // ── UI State (userData/ui-state.json — renderer is the single writer) ──
  getUiState: (): Promise<Record<string, any>> => ipcRenderer.invoke("ui-state:get"),
  saveUiState: (state: Record<string, any>): Promise<boolean> => ipcRenderer.invoke("ui-state:save", state),

  // ── File path (for persisting the New-form's selected audio file) ──
  // webUtils.getPathForFile() is synchronous and returns the absolute filesystem
  // path of a renderer File object (only meaningful for files from <input type=file>).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

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
  cancelUpdateDownload: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("auto-update:cancel"),
  installUpdate: (): Promise<{ success: boolean }> => ipcRenderer.invoke("auto-update:install"),

  // ── Native Notifications ──
  showNotification: (opts: {
    title: string;
    body: string;
    clickPayload?: Record<string, unknown>;
    type?: string;
    silent?: boolean;
    subtitle?: string;
  }): Promise<void> => ipcRenderer.invoke("notification:show", opts),

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
  readFileBytes: (filePath: string): Promise<{ ok: boolean; data?: Uint8Array; error?: string }> => ipcRenderer.invoke("fs:readFileBytes", filePath),
  runInTerminal: (params: { command: string; cwd?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("shell:runInTerminal", params),

  // ── Playwright Testing ──
  checkDevMode: (): Promise<{ devMode: boolean }> => ipcRenderer.invoke("testing:checkDevMode"),
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

  // ── Tunnel (Cloudflare) ──
  startTunnel: (): Promise<{ success: boolean; error?: string; url?: string }> => ipcRenderer.invoke("tunnel:start"),
  stopTunnel: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("tunnel:stop"),
  forceStopTunnel: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("tunnel:forceStop"),
  getTunnelStatus: (): Promise<{ running: boolean; connected: boolean; url: string | null; error: string | null }> =>
    ipcRenderer.invoke("tunnel:status"),

  // ── Platform ──
  platform: process.platform,
});
