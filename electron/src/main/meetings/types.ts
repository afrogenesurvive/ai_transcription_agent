/** Shared types for the meeting-ingestion layer (Teams / Zoom / capture). */

export interface MeetingAttendee {
  name: string;
  email: string;
}

export interface MeetingInfo {
  id: string;
  title: string;
  /** ISO timestamp of the meeting start, if known. */
  startTime: string | null;
  /** True when a cloud recording exists for this meeting. */
  hasRecording: boolean;
  provider: "teams" | "zoom";
}

/** Result of fetching + downloading a meeting's cloud recording. */
export interface MeetingRecordingResult {
  /** Local path to the downloaded audio file (M4A / MP4 / WebM). */
  filePath: string;
  title: string;
  attendees: MeetingAttendee[];
}

/** Result of an ingest submission to the pipeline. */
export interface IngestDone {
  jobId: string;
  status: string;
}

/** Result of a meeting-provider OAuth flow (Teams / Zoom). */
export interface MeetingAuthResult {
  ok: boolean;
  refreshToken?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  user?: string;
  error?: string;
}

/** A capturable screen source (Windows loopback capture). */
export interface CaptureSource {
  id: string;
  name: string;
}

/** System-audio capture capability for the current platform. */
export interface CaptureDeviceStatus {
  platform: "win32" | "darwin" | "other";
  blackholeInstalled: boolean;
  ffmpegAvailable: boolean;
  windowsLoopbackAvailable: boolean;
  hint?: string;
}
