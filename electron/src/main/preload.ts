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

  // ── Manual server check ──
  checkServers: (): Promise<{
    python: boolean;
    bridge: boolean;
    agent: boolean;
  }> => ipcRenderer.invoke("backend:status"),

  // ── Service management ──
  stopServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:stop"),
  restartServices: (): Promise<{ success: boolean }> => ipcRenderer.invoke("services:restart"),
  stopService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:stop", service),
  restartService: (service: string): Promise<{ success: boolean }> => ipcRenderer.invoke("service:restart", service),

  // ── App info ──
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

  // ── Job status ──
  getActiveJobs: (): Promise<Array<{ job_id: string; status: string; progress: number; title: string }>> => ipcRenderer.invoke("jobs:getActive"),

  // ── Notifications ──
  onNotification: (callback: (message: string) => void) => {
    ipcRenderer.on("notification", (_event, message) => callback(message));
    return () => ipcRenderer.removeAllListeners("notification");
  },

  // ── Developer logs ──
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke("logs:get"),
  clearLogs: (): Promise<{ success: boolean }> => ipcRenderer.invoke("logs:clear"),
  onLog: (callback: (entry: LogEntry) => void) => {
    ipcRenderer.on("log", (_event, entry) => callback(entry));
    return () => ipcRenderer.removeAllListeners("log");
  },

  // ── Configuration ──
  getConfig: (): Promise<Record<string, string>> => ipcRenderer.invoke("config:get"),
  saveConfig: (values: Record<string, string>): Promise<Record<string, string>> => ipcRenderer.invoke("config:save", values),
  checkConfig: (): Promise<{ ok: boolean; missing: string[] }> => ipcRenderer.invoke("config:check"),
  getConfigWithSources: (): Promise<Record<string, { value: string; source: string }>> => ipcRenderer.invoke("config:getWithSources"),

  // ── Agent Instructions Configuration ──
  getAgentConfig: (): Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }> => ipcRenderer.invoke("agent-config:get"),
  saveAgentConfig: (config: { tools?: any; pipeline?: any; systemPrompt?: string }): Promise<{ success?: boolean; error?: string }> =>
    ipcRenderer.invoke("agent-config:save", config),
  restartAgent: (): Promise<{ success?: boolean; error?: string }> => ipcRenderer.invoke("agent-config:restart"),

  // ── Log file browsing ──
  listLogFiles: (): Promise<LogFileInfo[]> => ipcRenderer.invoke("logs:listFiles"),
  readLogFile: (filePath: string, maxLines?: number): Promise<string[]> => ipcRenderer.invoke("logs:readFile", filePath, maxLines),
  getLogPaths: (): Promise<{ primary: string | null; mirror: string | null }> => ipcRenderer.invoke("logs:getPaths"),

  // ── Storage Usage ──
  getStorageUsage: () => ipcRenderer.invoke("storage:usage"),

  // ── Platform ──
  platform: process.platform,
});
