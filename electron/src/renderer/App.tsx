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

import React, { useState, useCallback, useEffect } from "react";
import UploadPanel from "./components/UploadPanel";
import PipelineProgress from "./components/ProgressPanel";
import ResultsViewer from "./components/ResultsViewer";
import StatusBar from "./components/StatusBar";
import DevPanel from "./components/DevPanel";
import ConfigPanel from "./components/ConfigPanel";
import { useApi } from "./hooks/useApi";
import { useJobStatus } from "./hooks/useJobStatus";
import type { JobStatus } from "./types";

const BRIDGE_URL = "http://127.0.0.1:5010";

type View = "upload" | "processing" | "results";
type SidebarView = "main" | "dev" | "config";

export default function App() {
  const api = useApi();
  const [view, setView] = useState<View>("upload");
  const [jobId, setJobId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<any>(null);
  const [jobMetadata, setJobMetadata] = useState<any>(null);
  const [statusData, setStatusData] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("main");
  const [configOk, setConfigOk] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean | null>(null);

  // Fetch diarization model status on mount
  useEffect(() => {
    let cancelled = false;
    const checkModel = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_models_status", args: {} }),
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setDiarizationAvailable(data.diarization_available);
        }
      } catch {
        /* backend not reachable */
      }
    };
    checkModel();
    const interval = setInterval(checkModel, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Check config on mount
  useEffect(() => {
    window.electronAPI?.checkConfig().then((result) => {
      setConfigOk(result.ok);
    });
  }, []);

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

  // Track status data for progress display
  React.useEffect(() => {
    if (statusHook.data) {
      setStatusData(statusHook.data);
      // Store metadata from status once available
      if (statusHook.data.metadata) {
        setJobMetadata(statusHook.data.metadata);
      }
    }
  }, [statusHook.data]);

  // When polling completes, fetch transcript + summary + metadata
  React.useEffect(() => {
    if (statusHook.state === "complete" && jobId) {
      Promise.all([api.getTranscript(jobId), api.getSummary(jobId).catch(() => null)])
        .then(([transcriptData, summaryData]) => {
          if (transcriptData) {
            setTranscript({ ...transcriptData, summary: summaryData?.summary });
            setView("results");
          } else {
            setNotification("Transcription completed but transcript data unavailable");
            setView("results");
          }
        })
        .catch((err) => {
          setNotification(`Failed to load transcript: ${err.message}`);
          setView("results");
        });
    }
  }, [statusHook.state, jobId, api]);

  // Handle upload submit
  const handleUpload = async (file: File, title: string, attendees: string[]) => {
    console.log("handleUpload");
    setUploading(true);
    try {
      const result: any = await api.uploadAudio(file, title, attendees);
      console.log("Upload result", result);
      setJobId(result.job_id);
      setJobMetadata({ title, attendees });
      setView("processing");
      // Polling starts automatically via useJobStatus when jobId changes
    } catch (err: any) {
      setNotification(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // Cancel a running job
  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      await api.cancelJob(jobId);
      statusHook.stopPolling();
      setNotification("Processing cancelled");
    } catch (err: any) {
      setNotification(`Cancel failed: ${err.message}`);
    } finally {
      setCancelling(false);
    }
  }, [jobId, api, statusHook]);

  // Start a new upload (reset everything)
  const handleNew = () => {
    setView("upload");
    setJobId(null);
    setTranscript(null);
    setJobMetadata(null);
    setStatusData(null);
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
          <span className="notification-text">{notification}</span>
          <button
            className="notification-close"
            onClick={(e) => {
              e.stopPropagation();
              setNotification(null);
            }}
            title="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="app-body">
        <nav className="sidebar">
          <button
            className={`sidebar-btn ${sidebarView === "main" ? "sidebar-btn--active" : ""}`}
            onClick={() => setSidebarView("main")}
            title="Main view">
            <span className="sidebar-btn-icon">🏠</span>
            <span className="sidebar-btn-label">Main</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "dev" ? "sidebar-btn--active" : ""}`}
            onClick={() => setSidebarView("dev")}
            title="Developer tools">
            <span className="sidebar-btn-icon">🛠️</span>
            <span className="sidebar-btn-label">Dev</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "config" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("config");
              window.electronAPI?.getConfigWithSources();
            }}
            title="Configuration">
            <span className="sidebar-btn-icon">⚙️</span>
            <span className="sidebar-btn-label">Config</span>
            {!configOk && <span className="sidebar-badge" />}
          </button>
        </nav>

        <main className="app-main">
          {sidebarView === "main" && (
            <>
              <div className="left-col">
                {view === "upload" && <UploadPanel onUpload={handleUpload} uploading={uploading} />}

                {(view === "processing" || view === "results") && statusData && (
                  <PipelineProgress
                    status={statusData.status}
                    progress={statusData.progress}
                    error={statusData.error}
                    onCancel={view === "processing" ? handleCancel : undefined}
                    cancelling={cancelling}
                    diarizationAvailable={diarizationAvailable}
                  />
                )}

                {view === "results" && statusHook.state === "error" && !statusData && (
                  <div className="panel actions-panel">
                    <h2>❌ Processing Failed</h2>
                    <p className="error-box" style={{ marginBottom: 12 }}>
                      {statusHook.error || "Unknown error"}
                    </p>
                    <button className="btn-primary" onClick={handleNew}>
                      Try Again
                    </button>
                  </div>
                )}

                {view === "results" && statusHook.state !== "error" && statusData?.status !== "failed" && (
                  <div className="panel actions-panel">
                    <h2>What would you like to do next?</h2>
                    <div className="rv-actions-grid">
                      <button className="btn-primary" onClick={handleNew}>
                        Upload Another Meeting
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="right-col">
                {view === "processing" && (
                  <div className="panel transcript-panel">
                    <h2>Transcript</h2>
                    <p className="placeholder">
                      Your results will appear here automatically once processing is complete. You&#39;ll be able to browse the full transcript,
                      summary, and audio recording.
                    </p>
                  </div>
                )}
                {view === "results" && jobId && (
                  <ResultsViewer jobId={jobId} segments={transcript?.transcript} summary={transcript?.summary} metadata={jobMetadata} />
                )}
              </div>
            </>
          )}

          {sidebarView === "dev" && <DevPanel onClose={() => setSidebarView("main")} />}

          {sidebarView === "config" && (
            <ConfigPanel
              key="config-panel"
              onClose={() => {
                setSidebarView("main");
                window.electronAPI?.checkConfig().then((r) => setConfigOk(r.ok));
              }}
            />
          )}
        </main>
      </div>

      <StatusBar configOk={configOk} onOpenConfig={() => setSidebarView("config")} onOpenDev={() => setSidebarView("dev")} />
    </div>
  );
}
