/**
 * Zoom meeting provider — Zoom Marketplace OAuth (PKCE public client) + Zoom REST API.
 *
 * Uses Zoom's PKCE public-client OAuth flow with a numeric loopback redirect
 * (http://127.0.0.1:<port>/), which is the supported pattern for desktop apps.
 * The client secret is optional: public-client (PKCE) setups leave it blank.
 *
 * - List the user's meetings that have cloud recordings (the recordings
 *   endpoint is the natural "meetings with audio" list).
 * - Download the audio-only M4A recording file.
 * - Extract attendees best-effort: registrants (when registration was enabled)
 *   and the participant report (requires admin scope — often unavailable, so
 *   swallowed). Zoom frequently hides external participant emails.
 */

import { app } from "electron";
import fs from "fs";
import path from "path";
import { getConfig, saveConfig } from "../config";
import { addLog } from "../logger";
import { runOAuthFlow, cancelOAuthFlow, type OAuthFlowResult } from "./oauth-common";
import type { MeetingInfo, MeetingAttendee, MeetingRecordingResult } from "./types";

const AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";
const API = "https://api.zoom.us/v2";

// Newly created Zoom apps use granular scopes configured in the Marketplace.
// We omit the `scope` parameter on authorize (Zoom's basic authorization query)
// so Zoom requests the app's default required scopes — sending classic scope
// strings here causes "Invalid scope" on granular-scope apps.
const SCOPES: string[] = [];

function clientId(): string {
  return getConfig().ZOOM_CLIENT_ID.trim();
}

function clientSecret(): string {
  return getConfig().ZOOM_CLIENT_SECRET.trim();
}

function refreshToken(): string {
  return getConfig().ZOOM_REFRESH_TOKEN.trim();
}

/** Start the Zoom consent flow; saves nothing (caller persists the result). */
export async function connectZoom(): Promise<OAuthFlowResult> {
  return runOAuthFlow({
    provider: "Zoom",
    clientId: clientId(),
    clientSecret: clientSecret(),
    // Zoom loopback redirects are only accepted for PKCE public-client flows.
    redirectHost: "127.0.0.1",
    usePkce: true,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    scopes: SCOPES,
    fetchUser: async (accessToken) => {
      const res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return "";
      const json = (await res.json()) as { email?: string; first_name?: string; last_name?: string; display_name?: string };
      return json.email || json.display_name || `${json.first_name || ""} ${json.last_name || ""}`.trim();
    },
  });
}

export function cancelZoom(): void {
  cancelOAuthFlow("zoom");
}

/** Verify connectivity with the saved token (used to fail fast on submit). */
export async function validateZoom(): Promise<{ ok: boolean; user?: string; error?: string }> {
  // Public-client (PKCE) setups have no client secret, so only the client ID
  // and refresh token are required to be able to call the API.
  if (!clientId() || !refreshToken()) {
    return { ok: false, error: "Zoom is not connected — connect your Zoom account first." };
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: `Zoom check failed (HTTP ${res.status})` };
    const json = (await res.json()) as { email?: string; display_name?: string };
    return { ok: true, user: json.email || json.display_name || "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Zoom check failed";
    return { ok: false, error: msg };
  }
}

/** Refresh the access token from the stored refresh token (silent). */
async function getAccessToken(): Promise<string> {
  const rt = refreshToken();
  if (!rt) throw new Error("Zoom is not connected.");
  // Public-client (PKCE) refresh uses just client_id + refresh_token; only
  // include the client secret when one is configured (confidential clients).
  const params: Record<string, string> = {
    client_id: clientId(),
    grant_type: "refresh_token",
    refresh_token: rt,
  };
  const secret = clientSecret();
  if (secret) params.client_secret = secret;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `Zoom token refresh failed (HTTP ${res.status})`);
  }
  if (json.refresh_token && json.refresh_token !== rt) {
    saveConfig({ ZOOM_REFRESH_TOKEN: json.refresh_token });
  }
  return json.access_token as string;
}

/** Authenticated Zoom API helper. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function zoom<T = any>(pathname: string, token: string): Promise<T> {
  const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoom ${pathname} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface ZoomRecordingFile {
  id: string;
  file_type: string;
  download_url?: string;
  status?: string;
}

interface ZoomRecordingMeeting {
  id: number;
  topic?: string;
  start_time?: string;
  recording_files?: ZoomRecordingFile[];
}

/** List meetings that have completed cloud recordings (audio present). */
export async function listZoomMeetings(): Promise<MeetingInfo[]> {
  const token = await getAccessToken();
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const data = await zoom<{ meetings?: ZoomRecordingMeeting[] }>(`/users/me/recordings?from=${fmt(from)}&to=${fmt(now)}&page_size=30`, token);
  const meetings = data.meetings || [];
  return meetings.map((m) => {
    const files = m.recording_files || [];
    const hasAudio = files.some((f) => f.file_type === "M4A" && (!f.status || f.status === "completed"));
    return {
      id: String(m.id),
      title: m.topic || "Untitled meeting",
      startTime: m.start_time || null,
      hasRecording: hasAudio || files.length > 0,
      provider: "zoom",
    };
  });
}

function zoomStorageDir(): string {
  const dir = path.join(app.getPath("userData"), "meetings", "zoom");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Download a meeting's M4A recording and return local metadata + attendees. */
export async function fetchZoomRecording(meetingId: string): Promise<MeetingRecordingResult> {
  const token = await getAccessToken();

  // 1. Meeting + recording files
  const recs = await zoom<{ recording_files?: ZoomRecordingFile[]; topic?: string }>(`/meetings/${meetingId}/recordings`, token);
  const m4a = (recs.recording_files || []).find((f) => f.file_type === "M4A");
  const fallback = (recs.recording_files || []).find((f) => f.file_type === "MP4");
  const file = m4a || fallback;
  if (!file?.download_url) {
    throw new Error("No cloud recording found for this meeting — cloud recording must be enabled.");
  }

  // 2. Attendees (best-effort — registrants when available; participant report is admin-gated)
  const attendees = await collectZoomAttendees(meetingId, token);

  // 3. Download the audio (M4A preferred; MP4 fallback gets normalized by ffmpeg later)
  const url = `${file.download_url}${file.download_url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`Could not download recording (HTTP ${fileRes.status})`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const topic = recs.topic || "Untitled meeting";
  const safeName = topic
    .replace(/[^\w\-. ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const ext = m4a ? ".m4a" : ".mp4";
  const filePath = path.join(zoomStorageDir(), `${safeName || meetingId}-${Date.now()}${ext}`);
  fs.writeFileSync(filePath, buf);
  addLog("main", "info", `[zoom] Downloaded recording (${buf.length} bytes, ${ext}) → ${filePath}`);
  return { filePath, title: topic, attendees };
}

/** Combine attendee names/emails from registrants + participant report (best-effort). */
async function collectZoomAttendees(meetingId: string, token: string): Promise<MeetingAttendee[]> {
  const map = new Map<string, MeetingAttendee>();
  const add = (name: string, email: string) => {
    const key = name.toLowerCase();
    if (!name) return;
    const existing = map.get(key);
    if (existing) {
      if (!existing.email && email) existing.email = email;
      return;
    }
    map.set(key, { name, email });
  };

  // Registrants (name + email) — only when registration was enabled.
  try {
    const regs = await zoom<{ registrants?: Array<{ first_name?: string; last_name?: string; email?: string }> }>(
      `/meetings/${meetingId}/registrants?page_size=300`,
      token,
    );
    for (const r of regs.registrants || []) {
      const name = `${r.first_name || ""} ${r.last_name || ""}`.trim();
      add(name || r.email || "", r.email || "");
    }
  } catch {
    /* admin scope not granted — skip */
  }

  // Participant report (names; emails often hidden for external users) — admin scope.
  try {
    const rep = await zoom<{ participants?: Array<{ name?: string; user_email?: string }> }>(
      `/report/meetings/${meetingId}/participants?page_size=300`,
      token,
    );
    for (const p of rep.participants || []) {
      add(p.name || "", p.user_email || "");
    }
  } catch {
    /* admin scope not granted — skip */
  }

  return Array.from(map.values());
}
