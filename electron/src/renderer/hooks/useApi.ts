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
    /** Upload an audio file */
    uploadAudio: async (file: File, title: string, attendees: string[]) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("attendees", JSON.stringify(attendees));
      formData.append("event_type", "internal");

      const res = await fetch(`http://127.0.0.1:5001/transcribe/upload`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(`Upload error: ${res.status}`);
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

    /** Search semantic memory */
    searchMemory: async (query: string, nResults = 5) => {
      return bridgeCall("transcribe_search_memory", { query, nResults }) as Promise<{
        results: any[];
      }>;
    },
  };
}
