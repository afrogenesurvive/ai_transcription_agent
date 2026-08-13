/**
 * Microsoft Teams meeting provider — Entra ID OAuth (PKCE, public client) +
 * Microsoft Graph.
 *
 * - List the user's online meetings (upcoming + recent).
 * - Download a meeting's cloud recording (M4A/MP4 from the meeting's recordings
 *   list, falling back to the OneDrive Recordings folder).
 * - Extract attendees (names + emails) from the meeting object.
 *
 * Work/school (organizational) accounts only — Teams cloud recordings don't
 * exist for personal Microsoft accounts.
 */

import { app } from "electron";
import fs from "fs";
import path from "path";
import { getConfig, saveConfig } from "../config";
import { addLog } from "../logger";
import { runOAuthFlow, cancelOAuthFlow, type OAuthFlowResult } from "./oauth-common";
import type { MeetingInfo, MeetingAttendee, MeetingRecordingResult } from "./types";

const AUTHORIZE_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

const SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Calendars.Read", "OnlineMeetings.Read", "Files.Read.All"];

function clientId(): string {
  return getConfig().MS_CLIENT_ID.trim();
}

function refreshToken(): string {
  return getConfig().MS_REFRESH_TOKEN.trim();
}

/** Start the Entra ID consent flow; saves nothing (caller persists the result). */
export async function connectTeams(): Promise<OAuthFlowResult> {
  return runOAuthFlow({
    provider: "Microsoft Teams",
    clientId: clientId(),
    usePkce: true,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    scopes: SCOPES,
    extraAuthorizeParams: { prompt: "consent" },
    fetchUser: async (accessToken) => {
      const res = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return "";
      const json = (await res.json()) as { userPrincipalName?: string; mail?: string; displayName?: string };
      return json.userPrincipalName || json.mail || json.displayName || "";
    },
  });
}

export function cancelTeams(): void {
  cancelOAuthFlow("teams");
}

/** Verify connectivity with the saved token (used to fail fast on submit). */
export async function validateTeams(): Promise<{ ok: boolean; user?: string; error?: string }> {
  if (!clientId() || !refreshToken()) {
    return { ok: false, error: "Teams is not connected — connect your Microsoft account first." };
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: `Teams check failed (HTTP ${res.status})` };
    const json = (await res.json()) as { userPrincipalName?: string; mail?: string; displayName?: string };
    return { ok: true, user: json.userPrincipalName || json.mail || json.displayName || "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Teams check failed";
    return { ok: false, error: msg };
  }
}

/** Refresh the access token from the stored refresh token (silent). */
async function getAccessToken(): Promise<string> {
  const rt = refreshToken();
  if (!rt) throw new Error("Teams is not connected.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "refresh_token",
      refresh_token: rt,
      scope: SCOPES.join(" "),
    }).toString(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `Teams token refresh failed (HTTP ${res.status})`);
  }
  // Microsoft rotates refresh tokens — persist the new one if it changed.
  if (json.refresh_token && json.refresh_token !== rt) {
    saveConfig({ MS_REFRESH_TOKEN: json.refresh_token });
  }
  return json.access_token as string;
}

/** Authenticated Graph helper. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function graph<T = any>(pathname: string, token: string): Promise<T> {
  const res = await fetch(`${GRAPH}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph ${pathname} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface GraphMeeting {
  id: string;
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
  participants?: {
    attendees?: GraphAttendee[];
  };
}

interface GraphAttendee {
  upn?: string;
  emailAddress?: { address?: string; name?: string };
  identity?: { user?: { id?: string; displayName?: string }; guest?: { displayName?: string } };
}

interface GraphRecording {
  id: string;
  recordingDateTime?: string;
  contentBytes?: number;
  downloadUrl?: string;
}

function attendeeFromGraph(a: GraphAttendee): MeetingAttendee {
  const identity = a.identity || {};
  const name = a.emailAddress?.name || identity.user?.displayName || identity.guest?.displayName || a.upn?.split("@")[0] || "";
  const email = a.emailAddress?.address || a.upn || identity.user?.id || "";
  return { name: name || email || "Attendee", email };
}

/** List recent + upcoming Teams meetings (bounded; checks for recordings). */
export async function listTeamsMeetings(): Promise<MeetingInfo[]> {
  const token = await getAccessToken();
  const data = await graph<{ value?: GraphMeeting[] }>("/me/onlineMeetings?$top=40&$orderby=startDateTime desc", token);
  const meetings = (data.value || []).slice(0, 30);

  // Best-effort recording detection (bounded parallel) so the UI can show
  // which meetings are ready to transcribe. Failures mark hasRecording=false.
  const withRecording = await Promise.all(
    meetings.map(async (m): Promise<MeetingInfo> => {
      let hasRecording = false;
      try {
        const recs = await graph<{ value?: GraphRecording[] }>(`/me/onlineMeetings/${m.id}/recordings`, token);
        hasRecording = (recs.value || []).some((r) => !!r.downloadUrl);
      } catch {
        /* non-fatal */
      }
      return {
        id: m.id,
        title: m.subject || "Untitled meeting",
        startTime: m.startDateTime || null,
        hasRecording,
        provider: "teams",
      };
    }),
  );
  return withRecording;
}

function teamsStorageDir(): string {
  const dir = path.join(app.getPath("userData"), "meetings", "teams");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Download a meeting's cloud recording to disk and return local metadata. */
export async function fetchTeamsRecording(meetingId: string): Promise<MeetingRecordingResult> {
  const token = await getAccessToken();

  // 1. Meeting metadata + attendees
  const meeting = await graph<GraphMeeting>(`/me/onlineMeetings/${meetingId}`, token);
  const attendees: MeetingAttendee[] = (meeting.participants?.attendees || []).map(attendeeFromGraph);

  // 2. Recording download URL (from the meeting's recordings relation)
  const recs = await graph<{ value?: GraphRecording[] }>(`/me/onlineMeetings/${meetingId}/recordings`, token);
  const recording = (recs.value || []).find((r) => !!r.downloadUrl);
  if (!recording?.downloadUrl) {
    throw new Error("No cloud recording found for this meeting — the organizer must enable cloud recording.");
  }

  // 3. Download the recording blob
  const fileRes = await fetch(recording.downloadUrl);
  if (!fileRes.ok) throw new Error(`Could not download recording (HTTP ${fileRes.status})`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const safeName = (meeting.subject || meetingId)
    .replace(/[^\w\-. ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const ext = ".m4a"; // Teams recordings are m4a/mp4 containers; backend normalizes via ffmpeg
  const filePath = path.join(teamsStorageDir(), `${safeName || meetingId}-${Date.now()}${ext}`);
  fs.writeFileSync(filePath, buf);
  addLog("main", "info", `[teams] Downloaded recording (${buf.length} bytes) → ${filePath}`);
  return {
    filePath,
    title: meeting.subject || "Untitled meeting",
    attendees,
  };
}
