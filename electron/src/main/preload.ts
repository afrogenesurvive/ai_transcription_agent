/**
 * Preload script — exposes safe IPC channels to the renderer via contextBridge.
 *
 * The renderer uses these for Electron-specific operations (file dialogs,
 * system tray, app info) while all API calls go directly to the bridge server.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── File dialogs ──
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectAudio"),

  // ── Backend status ──
  getBackendStatus: (): Promise<{
    python: boolean;
    bridge: boolean;
  }> => ipcRenderer.invoke("backend:status"),

  // ── App info ──
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

  // ── Notifications ──
  onNotification: (callback: (message: string) => void) => {
    ipcRenderer.on("notification", (_event, message) => callback(message));
    return () => ipcRenderer.removeAllListeners("notification");
  },

  // ── Platform ──
  platform: process.platform,
});
