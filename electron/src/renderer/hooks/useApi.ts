/**
 * API hook — calls the bridge server for all transcription operations.
 */

const BRIDGE_URL = "http://127.0.0.1:5010";

async function bridgeCall(tool: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) throw new Error(`Bridge error: ${res.status}`);
  return res.json();
}

export function useApi() {
  return {
    /** Upload an audio file (via bridge server to avoid CORS issues) */
    uploadAudio: async (file: File, title: string, attendees: string[], skipSteps: string[] = []) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("attendees", JSON.stringify(attendees));
      formData.append("event_type", "internal");
      formData.append("skip_steps", JSON.stringify(skipSteps));

      const res = await fetch(`${BRIDGE_URL}/transcribe/upload`, { method: "POST", body: formData });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // Try to extract a clean detail message from Python's HTTPException JSON
        let cleanMsg = errBody;
        try {
          const parsed = JSON.parse(errBody);
          if (parsed.detail) cleanMsg = parsed.detail;
          else if (parsed.error) cleanMsg = parsed.error;
        } catch {
          /* not JSON — use raw text */
        }
        throw new Error(cleanMsg);
      }
      return res.json() as Promise<{ job_id: string; status: string }>;
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

    /** Get analysis */
    getAnalysis: async (jobId: string) => {
      return bridgeCall("transcribe_get_analysis", { jobId }) as Promise<any>;
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
  };
}
