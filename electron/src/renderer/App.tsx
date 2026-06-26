/**
 * App Shell — main React application for the Transcription Agent UI.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ Upload Panel              │ Transcript View  │
 *   │ (drag-drop, title,        │ (segments +      │
 *   │  attendees, submit)       │  summary)        │
 *   ├───────────────────────────┤                  │
 *   │ Progress Panel            │                  │
 *   │ (stage, %, error)         │                  │
 *   ├───────────────────────────┴──────────────────┤
 *   │ Status Bar                                   │
 *   └──────────────────────────────────────────────┘
 */

import React, { useState, useCallback } from "react";
import UploadPanel from "./components/UploadPanel";
import ProgressPanel from "./components/ProgressPanel";
import TranscriptView from "./components/TranscriptView";
import StatusBar from "./components/StatusBar";
import { useApi } from "./hooks/useApi";
import { useJobStatus } from "./hooks/useJobStatus";
import type { JobStatus } from "./types";

type View = "upload" | "processing" | "results";

export default function App() {
  const api = useApi();
  const [view, setView] = useState<View>("upload");
  const [jobId, setJobId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  // Listen for Electron notifications
  React.useEffect(() => {
    const cleanup = window.electronAPI?.onNotification((msg) => {
      setNotification(msg);
      setTimeout(() => setNotification(null), 5000);
    });
    return () => cleanup?.();
  }, []);

  // Poll job status
  const statusHook = useJobStatus(
    jobId,
    useCallback((id: string) => api.getStatus(id), [api]),
  );

  // When polling completes, fetch transcript
  React.useEffect(() => {
    if (statusHook.state === "complete" && jobId) {
      Promise.all([api.getTranscript(jobId), api.getSummary(jobId).catch(() => null)])
        .then(([transcriptData, summaryData]) => {
          setTranscript({ ...transcriptData, summary: summaryData?.summary });
          setView("results");
        })
        .catch(console.error);
    }
  }, [statusHook.state, jobId, api]);

  // Handle upload submit
  const handleUpload = async (file: File, title: string, attendees: string[]) => {
    setUploading(true);
    try {
      const result = await api.uploadAudio(file, title, attendees);
      setJobId(result.job_id);
      setView("processing");
      statusHook.startPolling();
    } catch (err: any) {
      setNotification(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // Start a new upload (reset everything)
  const handleNew = () => {
    setView("upload");
    setJobId(null);
    setTranscript(null);
    statusHook.stopPolling();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎙️ Transcription Agent</h1>
        <nav>
          <button className={`nav-btn ${view === "upload" ? "active" : ""}`} onClick={handleNew}>
            New Upload
          </button>
          {view === "results" && (
            <button className="nav-btn" onClick={handleNew}>
              Upload Another
            </button>
          )}
        </nav>
      </header>

      {notification && (
        <div className="notification" onClick={() => setNotification(null)}>
          {notification}
        </div>
      )}

      <main className="app-main">
        <div className="left-col">
          {view === "upload" && <UploadPanel onUpload={handleUpload} uploading={uploading} />}

          {(view === "processing" || view === "results") && statusHook.data && (
            <ProgressPanel status={statusHook.data.status} progress={statusHook.data.progress} error={statusHook.data.error} />
          )}

          {view === "results" && (
            <div className="panel actions-panel">
              <h2>Actions</h2>
              <p>Processing complete. The agent will now refine, summarize, and deliver the results.</p>
              <button className="btn-primary" onClick={handleNew}>
                Upload Another Meeting
              </button>
            </div>
          )}
        </div>

        <div className="right-col">
          <TranscriptView segments={transcript?.transcript} summary={transcript?.summary} loading={view === "processing"} />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}
