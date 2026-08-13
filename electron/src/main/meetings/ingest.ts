/**
 * Ingest client — submits an already-on-disk audio file to the transcription
 * pipeline via the bridge server's `transcribe_upload_by_path` tool.
 *
 * Used by the System Recording and Teams/Zoom meeting sources. The file path
 * lands on the EXISTING `POST /transcribe/upload_by_path` backend route, so
 * the same in-app pipeline (diarization -> ASR -> voiceprints -> agent) runs
 * unchanged.
 */

import { addLog } from "../logger";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:5010";

export interface IngestParams {
  filePath: string;
  title: string;
  attendees: string[];
  attendeeEmails?: string[];
  emailRecipients?: string[];
  skipSteps?: string[];
  eventType?: string;
  /** Provenance tag for logs + job metadata: "teams" | "zoom" | "capture" | "upload". */
  source?: string;
}

export interface IngestResult {
  jobId: string;
  status: string;
}

/** Submit an on-disk audio file to the pipeline via the bridge. */
export async function ingestAudio(params: IngestParams): Promise<IngestResult> {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "transcribe_upload_by_path",
      args: {
        filePath: params.filePath,
        title: params.title,
        attendees: params.attendees,
        attendeeEmails: params.attendeeEmails || [],
        eventType: params.eventType || "internal",
        source: params.source || "upload",
        skipSteps: params.skipSteps || [],
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let clean = errBody;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed.error) clean = parsed.error;
      else if (parsed.detail) clean = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
    } catch {
      /* not JSON — use raw text */
    }
    throw new Error(clean || `Bridge upload failed (HTTP ${res.status})`);
  }

  const json = (await res.json()) as { job_id?: string; jobId?: string; status?: string };
  const jobId = json.job_id || json.jobId || "";
  if (!jobId) throw new Error("Bridge upload returned no job id.");
  addLog("main", "info", `[ingest] ${params.source || "upload"} job ${jobId} started (${params.filePath})`);
  return { jobId, status: json.status || "uploaded" };
}
