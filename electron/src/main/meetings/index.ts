/**
 * IPC wiring for the meeting-ingestion layer (Teams / Zoom / system capture).
 *
 * Handlers are registered here and mounted from the main process entrypoint
 * (index.ts). Renderer calls go through preload.ts / types.d.ts.
 */

import { ipcMain } from "electron";
import { getConfig } from "../config";
import { addLog } from "../logger";
import * as teams from "./teams";
import * as zoom from "./zoom";
import * as capture from "./capture";

/** Register all meeting/capture IPC handlers. */
export function registerMeetingsIpc(): void {
  // ── Teams ──
  ipcMain.handle("meetings:teams:connect", async () => {
    const res = await teams.connectTeams();
    return { ...res, clientId: getConfig().MS_CLIENT_ID };
  });
  ipcMain.handle("meetings:teams:cancel", () => {
    teams.cancelTeams();
    return { ok: true };
  });
  ipcMain.handle("meetings:teams:validate", () => teams.validateTeams());
  ipcMain.handle("meetings:teams:list", () =>
    teams
      .listTeamsMeetings()
      .then((meetings) => ({ ok: true, meetings }))
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : "Failed to list Teams meetings" })),
  );
  ipcMain.handle("meetings:teams:recording", (_e, meetingId: string) =>
    teams
      .fetchTeamsRecording(meetingId)
      .then((res) => ({ ok: true, ...res }))
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : "Failed to fetch Teams recording" })),
  );

  // ── Zoom ──
  ipcMain.handle("meetings:zoom:connect", async () => {
    const res = await zoom.connectZoom();
    return { ...res, clientId: getConfig().ZOOM_CLIENT_ID, clientSecret: getConfig().ZOOM_CLIENT_SECRET };
  });
  ipcMain.handle("meetings:zoom:cancel", () => {
    zoom.cancelZoom();
    return { ok: true };
  });
  ipcMain.handle("meetings:zoom:validate", () => zoom.validateZoom());
  ipcMain.handle("meetings:zoom:list", () =>
    zoom
      .listZoomMeetings()
      .then((meetings) => ({ ok: true, meetings }))
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : "Failed to list Zoom meetings" })),
  );
  ipcMain.handle("meetings:zoom:recording", (_e, meetingId: string) =>
    zoom
      .fetchZoomRecording(meetingId)
      .then((res) => ({ ok: true, ...res }))
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : "Failed to fetch Zoom recording" })),
  );

  // ── Capture ──
  ipcMain.handle("capture:sources", () => capture.listCaptureSources());
  ipcMain.handle("capture:device", () => capture.detectCaptureDevice());
  ipcMain.handle("capture:start", (_e, deviceName?: string) => capture.startFfmpegCapture(deviceName));
  ipcMain.handle("capture:stop", () => capture.stopFfmpegCapture());
  ipcMain.handle("capture:save", (_e, data: Uint8Array | ArrayBuffer) => {
    if (data == null) {
      addLog("main", "warn", "[capture] save called with null payload");
      return { ok: false, error: "Invalid recording payload." };
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    return capture.saveCaptureRecording(bytes);
  });
}
