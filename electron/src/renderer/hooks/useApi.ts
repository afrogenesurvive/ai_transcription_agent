/**
 * API hook — calls the bridge server for all transcription operations.
 */

const BRIDGE_URL = "http://127.0.0.1:5010";

/** Error thrown when label submission detects voice match conflicts. */
export class VoiceMatchConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: Array<{
      speaker_id: string;
      assigned_name: string;
      assigned_email: string;
      matched_name: string;
      matched_email: string;
      similarity: number;
      matched_sample_job_id?: string;
    }>,
  ) {
    super(message);
    this.name = "VoiceMatchConflictError";
  }
}

async function bridgeCall(tool: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error || body.detail || "";
    } catch {
      /* ignore parse failures */
    }
    throw new Error(`Bridge error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

/**
 * POST a multipart audio upload to the bridge's /transcribe/upload proxy.
 * Streams the file bytes so the Python backend never needs to read a local
 * filesystem path (works on macOS, Windows, and packaged/remote backends).
 */
async function postAudioUpload(formData: FormData): Promise<{ job_id: string; status: string }> {
  // Attach the bridge license session token (job-creation endpoints are gated).
  const headers: Record<string, string> = {};
  try {
    const tok = await window.electronAPI?.getBridgeToken();
    if (tok && "token" in tok && tok.token) headers["X-License-Token"] = tok.token;
  } catch {
    // No token → the bridge will reject with 403 (defense in depth).
  }
  const res = await fetch(`${BRIDGE_URL}/transcribe/upload`, { method: "POST", body: formData, headers });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let cleanMsg = errBody;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed.detail) cleanMsg = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
      else if (parsed.error) cleanMsg = parsed.error;
    } catch {
      /* not JSON — use raw text */
    }
    throw new Error(cleanMsg);
  }
  return res.json() as Promise<{ job_id: string; status: string }>;
}

export function useApi() {
  return {
    /** Upload an audio file (via bridge server to avoid CORS issues) */
    uploadAudio: async (
      file: File,
      title: string,
      attendees: string[],
      emailRecipients: string[] = [],
      skipSteps: string[] = [],
      attendeeEmails?: string[],
    ) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("attendees", JSON.stringify(attendees));
      formData.append("attendee_emails", JSON.stringify(attendeeEmails || []));
      formData.append("email_recipients", JSON.stringify(emailRecipients));
      formData.append("event_type", "internal");
      formData.append("source", "upload");
      formData.append("skip_steps", JSON.stringify(skipSteps));
      return postAudioUpload(formData);
    },

    /**
     * Upload an on-disk audio file (System Recording captures, Teams/Zoom
     * downloads, persisted New-form files) by streaming its bytes as a multipart
     * upload. We deliberately do NOT reference the local filesystem path for the
     * backend: the Python process can't read the Electron app's private
     * Application Support/captures dir (macOS TCC), which made the old
     * /transcribe/upload_by_path approach fail with "File not found". Streaming
     * bytes works on macOS and Windows alike.
     */
    uploadAudioByPath: async (params: {
      filePath: string;
      title: string;
      attendees: string[];
      emailRecipients?: string[];
      skipSteps?: string[];
      attendeeEmails?: string[];
      source?: string;
    }) => {
      const read = await window.electronAPI?.readFileBytes(params.filePath);
      if (!read?.ok || !read.data) {
        throw new Error(read?.error || "Could not read the audio file.");
      }
      const fileName = params.filePath.split(/[\\/]/).pop() || "recording";
      const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
      const mime = ext === "webm" ? "audio/webm" : ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : "audio/mp4";
      // read.data is a Uint8Array crossing the IPC boundary; slice() returns a
      // Uint8Array<ArrayBuffer>, which TS accepts as a BlobPart for File/Blob.
      const file = new File([read.data.slice()], fileName, { type: mime });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", params.title);
      formData.append("attendees", JSON.stringify(params.attendees));
      formData.append("attendee_emails", JSON.stringify(params.attendeeEmails || []));
      formData.append("email_recipients", JSON.stringify(params.emailRecipients || []));
      formData.append("event_type", "internal");
      formData.append("source", params.source || "upload");
      formData.append("skip_steps", JSON.stringify(params.skipSteps || []));
      return postAudioUpload(formData);
    },

    /** Poll job status */
    getStatus: async (jobId: string) => {
      return bridgeCall("transcribe_status", { jobId }) as Promise<any>;
    },

    /** Get transcript */
    getTranscript: async (jobId: string, format = "json") => {
      return bridgeCall("transcribe_get_transcript", { jobId, format }) as Promise<any>;
    },

    /** Get summary */
    getSummary: async (jobId: string) => {
      return bridgeCall("transcribe_get_summary", { jobId }) as Promise<any>;
    },

    /** Get raw/unrefined transcript text */
    getRawTranscript: async (jobId: string) => {
      return bridgeCall("transcribe_get_raw_transcript", { jobId }) as Promise<{ text: string }>;
    },

    /** Get analysis */
    getAnalysis: async (jobId: string) => {
      return bridgeCall("transcribe_get_analysis", { jobId }) as Promise<any>;
    },

    /** Get speaker clips for manual labeling (paused_for_labeling state) */
    getSpeakerClips: async (jobId: string) => {
      return bridgeCall("transcribe_get_speaker_clips", { jobId }) as Promise<{
        job_id: string;
        speakers: Array<{
          speaker_id: string;
          segment_count: number;
          total_duration: number;
          sample_clip_url: string;
          sample_start: number;
          sample_end: number;
          suggested_name: string;
        }>;
        total_speakers: number;
        non_speaking_attendees?: Array<{ name: string; email?: string }>;
        known_attendees?: {
          with_voiceprint: Array<{
            name: string;
            email?: string;
            sample_job_id?: string;
            in_form?: boolean;
          }>;
          without_voiceprint: Array<{ name: string; email?: string; in_form?: boolean }>;
        };
      }>;
    },

    /** Submit speaker labels and resume the pipeline */
    labelAndResume: async (
      jobId: string,
      labels: Array<{ speaker_id: string; name: string; email?: string }>,
      overwriteNames?: string[],
      excludedNonSpeaking?: string[],
    ) => {
      const result = await bridgeCall("transcribe_label_and_resume", {
        jobId,
        labels,
        overwrite_names: overwriteNames || [],
        excluded_non_speaking: excludedNonSpeaking || [],
      });
      // Check for voice match conflict response from the bridge
      if (result && (result as any).conflict === true) {
        throw new VoiceMatchConflictError((result as any).message || "Voice match conflict detected", (result as any).conflicts || []);
      }
      return result as {
        job_id: string;
        status: string;
        applied_labels: number;
      };
    },

    /** Get audio stream URL */
    getAudioUrl: (jobId: string) => {
      return `http://127.0.0.1:5010/transcribe/audio/${jobId}`;
    },

    /** Get job-specific logs */
    getJobLogs: async (jobId: string, maxLines = 200) => {
      return bridgeCall("transcribe_get_job_logs", { jobId, maxLines }) as Promise<{
        logs: string[];
        job_logs: { file: string; content: string }[];
      }>;
    },

    /** Get job files listing */
    getJobFiles: async (jobId: string) => {
      return bridgeCall("transcribe_get_job_files", { jobId }) as Promise<{
        job_id: string;
        files: { name: string; size: number; mtime: number; type: string }[];
      }>;
    },

    /** Cancel a running job */
    cancelJob: async (jobId: string) => {
      return bridgeCall("transcribe_cancel", { jobId }) as Promise<{ job_id: string; status: string; cancelled: boolean }>;
    },

    /** Get job history (all jobs, including completed/failed) */
    getHistory: async () => {
      return bridgeCall("transcribe_history", {}) as Promise<{
        jobs: Array<{
          job_id: string;
          status: string;
          progress: number;
          title: string;
          event_type: string;
          attendees: string[];
          has_transcript: boolean;
          llm_provider?: string;
          llm_model?: string;
          mtime: number;
        }>;
      }>;
    },

    /** Check model availability (diarization, device, etc.) */
    getModelsStatus: async () => {
      return bridgeCall("transcribe_models_status", {}) as Promise<{
        device: string;
        whisper_model: string;
        diarization_model: string;
        diarization_available: boolean;
        diarization_error: string | null;
        hf_token_configured: boolean;
      }>;
    },

    /** Search semantic memory */
    searchMemory: async (query: string, nResults = 5) => {
      return bridgeCall("transcribe_search_memory", { query, nResults }) as Promise<{
        results: any[];
      }>;
    },

    /** Get token usage for a completed job */
    getTokenUsage: async (jobId: string) => {
      return bridgeCall("transcribe_get_token_usage", { jobId }) as Promise<{
        job_id: string;
        title: string;
        provider: string;
        model: string;
        steps: Array<{
          step: number;
          tool: string;
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        }>;
        totals: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
        saved_at: string;
      }>;
    },

    /** Get active ML pipeline jobs from the backend */
    getActiveJobs: async (): Promise<Array<{ job_id: string; status: string; progress: number; title: string }>> => {
      return window.electronAPI?.getActiveJobs() ?? Promise.resolve([]);
    },

    /** Poll any job's full status via the bridge (covers ML + agent-runner stages) */
    getJobStatus: async (jobId: string) => {
      return bridgeCall("transcribe_status", { jobId }) as Promise<{
        job_id: string;
        status: string;
        progress: number;
        error?: string;
        title?: string;
        metadata?: any;
      }>;
    },

    /** Approve or reject Gate 1 (raw transcript review) */
    approveGate1: async (jobId: string, body: { action: string; editedTranscript?: any[] }) => {
      return bridgeCall("transcribe_approve_gate1", { jobId, ...body }) as Promise<{
        job_id: string;
        status: string;
        action?: string;
        applied_labels?: number;
      }>;
    },

    /** Approve or reject Gate 2 (delivery review) */
    approveGate2: async (
      jobId: string,
      body: {
        action: string;
        editedTranscript?: any[];
        editedSummary?: any;
        editedAnalysis?: any;
        deliveryOptions?: { recipients?: string[]; destinations?: string[] };
        feedback?: string;
      },
    ) => {
      return bridgeCall("transcribe_approve_gate2", { jobId, ...body }) as Promise<{
        job_id: string;
        status: string;
        action?: string;
        edits_made?: string[];
      }>;
    },
  };
}
