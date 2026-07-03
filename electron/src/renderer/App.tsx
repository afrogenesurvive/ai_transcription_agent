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

import React, { useState, useCallback, useEffect, useRef } from "react";
import UploadPanel from "./components/UploadPanel";
import PipelineProgress from "./components/ProgressPanel";
import ResultsViewer from "./components/ResultsViewer";
import StatusBar from "./components/StatusBar";
import DevPanel from "./components/DevPanel";
import ConfigPanel from "./components/ConfigPanel";
import HistoryPanel from "./components/HistoryPanel";
import StoragePanel from "./components/StoragePanel";
import ServerStatusBanner from "./components/ServerStatusBanner";
import { useApi } from "./hooks/useApi";
import { useJobStatus } from "./hooks/useJobStatus";
import { useServerStatus } from "./hooks/useServerStatus";
import type { JobStatus } from "./types";

const BRIDGE_URL = "http://127.0.0.1:5010";

type View = "upload" | "processing" | "results";
type SidebarView = "current" | "dev" | "config" | "storage";

/**
 * Map tool-level skip_steps from job metadata to pipeline stage keys.
 * Stage keys in ProgressPanel: uploaded, initializing, diarization,
 * voiceprints, transcription, aligning, agent, delivery.
 */
function computeSkippedStages(statusData: any): Set<string> | undefined {
  const skipSteps: string[] | undefined = statusData?.metadata?.skip_steps;
  if (!skipSteps || skipSteps.length === 0) return undefined;
  const stages = new Set<string>();
  // Delivery tools being skipped → mark the "delivery" stage as skipped
  const deliveryTools = ["transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items"];
  if (deliveryTools.some((t) => skipSteps.includes(t))) {
    stages.add("delivery");
  }
  return stages.size > 0 ? stages : undefined;
}

export default function App() {
  const api = useApi();
  const [view, setView] = useState<View>("upload");
  const [jobId, setJobId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<any>(null);
  const [jobMetadata, setJobMetadata] = useState<any>(null);
  const [statusData, setStatusData] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("current");
  const [configOk, setConfigOk] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean | null>(null);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyJobStatus, setHistoryJobStatus] = useState<{ status: string; progress: number; error?: string | null } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [storageRefreshTrigger, setStorageRefreshTrigger] = useState(0);

  // Notification helper — shows a toast at the top-right, auto-dismissed after 4s
  const notify = useCallback((message: string) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // Callback for panels to signal that storage data changed (job/log deletion)
  const onStorageChanged = useCallback(() => {
    setStorageRefreshTrigger((n) => n + 1);
  }, []);

  // ── Server & diarization health ──
  const serverStatus = useServerStatus();

  // Keep diarizationAvailable in sync with server hook for downstream use
  useEffect(() => {
    setDiarizationAvailable(serverStatus.diarizationOk);
  }, [serverStatus.diarizationOk]);

  // Check config on mount
  useEffect(() => {
    window.electronAPI?.checkConfig().then((result: { ok: boolean; missing: string[] }) => {
      setConfigOk(result.ok);
      if (!result.ok) {
        const items = result.missing?.length ? result.missing.join(", ") : "DEEPSEEK_API_KEY or Ollama";
        setNotification(`Config incomplete: missing ${items}`);
        setTimeout(() => setNotification(null), 8000);
      }
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

  // Poll job status — stabilize the fetcher ref to avoid restarting polling on re-render
  const fetcherRef = useRef<(id: string) => Promise<any>>();
  fetcherRef.current = (id: string) => api.getStatus(id);
  const statusHook = useJobStatus(
    jobId,
    useCallback((id: string) => fetcherRef.current?.(id) ?? Promise.reject(new Error("no fetcher")), []),
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

  // Stable refs for API calls so the effect below doesn't re-run on every render
  const getTranscriptRef = useRef<(id: string) => Promise<any>>();
  const getSummaryRef = useRef<(id: string) => Promise<any>>();
  getTranscriptRef.current = (id: string) => api.getTranscript(id);
  getSummaryRef.current = (id: string) => api.getSummary(id);

  // When polling completes, fetch transcript + summary + metadata
  React.useEffect(() => {
    if (statusHook.state === "complete" && jobId) {
      const stateSnapshot = statusHook.state;
      Promise.all([
        getTranscriptRef.current?.(jobId) ?? Promise.reject(new Error("no fetcher")),
        (getSummaryRef.current?.(jobId) ?? Promise.reject(new Error("no fetcher"))).catch(() => null),
      ])
        .then(([transcriptData, summaryData]) => {
          // Guard: only process if state is still "complete" (avoid stale closure)
          if (stateSnapshot !== "complete") return;
          if (transcriptData) {
            setTranscript({ ...transcriptData, summary: summaryData });
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

    // When polling detects a failed status or network error — show notification
    if (statusHook.state === "error" && jobId) {
      // Use the backend's error message if available, otherwise the network error
      const errMsg = statusHook.data?.error || statusHook.error || "Processing failed — check the Logs tab for details";
      setNotification(errMsg);
      setTimeout(() => setNotification(null), 10000);
      // Transition to results view so the user can see the error + logs
      setView("results");
    }
  }, [statusHook.state, jobId]);

  // Handle upload submit
  const handleUpload = async (file: File, title: string, attendees: string[], skipSteps: string[]) => {
    console.log("handleUpload", { skipSteps });
    setUploading(true);
    try {
      const result: any = await api.uploadAudio(file, title, attendees, skipSteps);
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

  // Load a past job from history — keeps history panel visible and shows results in the right column
  const loadHistoryJob = useCallback(
    async (jobId: string) => {
      setHistoryJobId(jobId);
      setShowHistory(true);
      try {
        const [transcriptData, summaryData, statusData] = await Promise.all([
          api.getTranscript(jobId),
          api.getSummary(jobId).catch(() => null),
          api.getStatus(jobId).catch(() => null),
        ]);
        if (transcriptData) {
          setTranscript({ ...transcriptData, summary: summaryData });
          // Store metadata from status if available (title, attendees, etc.)
          if (statusData?.metadata) {
            setJobMetadata(statusData.metadata);
          }
          // Store status info for the Pipeline tab
          setHistoryJobStatus(statusData ? { status: statusData.status, progress: statusData.progress, error: statusData.error } : null);
          setView("results");
        } else {
          setNotification("Transcript data unavailable for this job");
          setView("results");
        }
      } catch (err: any) {
        setNotification(`Failed to load job: ${err.message}`);
        setView("results");
      }
    },
    [api],
  );

  // Start a new upload (reset everything)
  const handleNew = () => {
    setView("upload");
    setJobId(null);
    setTranscript(null);
    setJobMetadata(null);
    setStatusData(null);
    setHistoryJobId(null);
    statusHook.stopPolling();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎙️ Transcription Agent</h1>
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
            className="sidebar-btn"
            disabled={view === "processing" || uploading}
            onClick={() => {
              handleNew();
              setSidebarView("current");
            }}
            title={view === "processing" || uploading ? "Finish current run first" : "Start a new transcription"}>
            <span className="sidebar-btn-icon">➕</span>
            <span className="sidebar-btn-label">New</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "current" && !showHistory ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("current");
              setShowHistory(false);
              setHistoryJobId(null);
            }}
            title="Current job">
            <span className="sidebar-btn-icon">🏠</span>
            <span className="sidebar-btn-label">Current</span>
          </button>
          <button
            className={`sidebar-btn ${showHistory && sidebarView === "current" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("current");
              setShowHistory((v) => !v);
            }}
            title="Job history">
            <span className="sidebar-btn-icon">📋</span>
            <span className="sidebar-btn-label">History</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "storage" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("storage");
              setShowHistory(false);
            }}
            title="Storage usage">
            <span className="sidebar-btn-icon">💾</span>
            <span className="sidebar-btn-label">Storage</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "dev" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("dev");
              setShowHistory(false);
            }}
            title="Developer tools — always available">
            <span className="sidebar-btn-icon">🛠️</span>
            <span className="sidebar-btn-label">Dev</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "config" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("config");
              setShowHistory(false);
              window.electronAPI?.getConfigWithSources();
            }}
            title="Configuration">
            <span className="sidebar-btn-icon">⚙️</span>
            <span className="sidebar-btn-label">Config</span>
            {!configOk && <span className="sidebar-badge" />}
          </button>
        </nav>

        <main className="app-main">
          {/* ── Dev view: always interactive (logs help debug startup) ── */}
          {sidebarView === "dev" && <DevPanel onClose={() => setSidebarView("current")} />}

          {/* ── When servers aren't all ready, gate non-dev views ── */}
          {sidebarView !== "dev" && !serverStatus.allReady && (
            <ServerStatusBanner
              services={serverStatus.services}
              diarizationOk={serverStatus.diarizationOk}
              diarizationError={serverStatus.diarizationError}
              checking={serverStatus.checking}
              onCheckServers={serverStatus.checkServers}
              onRestartService={serverStatus.restartService}
              onRestartAll={serverStatus.restartAll}
            />
          )}

          {/* ── Normal content (all servers + diarization ready) ── */}
          {sidebarView !== "dev" && serverStatus.allReady && (
            <>
              {sidebarView === "current" && (
                <>
                  <div className="left-col" id="left-col">
                    {showHistory ? (
                      <HistoryPanel
                        onSelectJob={loadHistoryJob}
                        currentJobId={historyJobId || jobId}
                        onNotify={notify}
                        onStorageChanged={onStorageChanged}
                      />
                    ) : (
                      <>
                        {view === "upload" && <UploadPanel onUpload={handleUpload} uploading={uploading} />}

                        {(view === "processing" || view === "results") && statusData && (
                          <PipelineProgress
                            status={statusData.status}
                            progress={statusData.progress}
                            error={statusData.error}
                            onCancel={view === "processing" ? handleCancel : undefined}
                            cancelling={cancelling}
                            diarizationAvailable={diarizationAvailable}
                            skippedSteps={computeSkippedStages(statusData)}
                          />
                        )}

                        {/* Clear button when job is done or failed — moves job to history */}
                        {view === "results" &&
                          statusData &&
                          (statusData.status === "failed" || ["delivered", "refined", "summarized", "analyzed"].includes(statusData.status)) && (
                            <div style={{ display: "flex", gap: 8 }}>
                              <button className="btn-secondary" onClick={handleNew} style={{ flex: 1, marginTop: 0 }}>
                                ✕ Clear &amp; Close
                              </button>
                            </div>
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
                            <button className="btn-secondary" onClick={handleNew} style={{ marginTop: 8 }}>
                              Clear &amp; Close
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
                              <button className="btn-secondary" onClick={handleNew}>
                                Clear &amp; Close
                              </button>
                            </div>
                            <p className="config-hint" style={{ marginTop: 10, marginBottom: 0 }}>
                              The job is saved to history and can be reopened anytime from the <strong>📋 History</strong> panel.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="right-col">
                    {/* Show results for a history job (history panel visible in left column) */}
                    {historyJobId && (
                      <ResultsViewer
                        jobId={historyJobId}
                        segments={transcript?.transcript}
                        summary={transcript?.summary}
                        metadata={jobMetadata}
                        jobStatus={historyJobStatus?.status}
                        jobProgress={historyJobStatus?.progress}
                        jobError={historyJobStatus?.error}
                      />
                    )}
                    {/* Processing placeholder — hidden when viewing history */}
                    {!historyJobId && view === "processing" && (
                      <div className="panel transcript-panel">
                        <h2>Transcript</h2>
                        <p className="placeholder">
                          Your results will appear here automatically once processing is complete. You&#39;ll be able to browse the full transcript,
                          summary, and audio recording.
                        </p>
                      </div>
                    )}
                    {/* Live results from current upload — hidden when viewing history */}
                    {!historyJobId && view === "results" && jobId && (
                      <ResultsViewer
                        jobId={jobId}
                        segments={transcript?.transcript}
                        summary={transcript?.summary}
                        metadata={jobMetadata}
                        jobStatus={statusData?.status}
                        jobProgress={statusData?.progress}
                        jobError={statusData?.error}
                      />
                    )}
                  </div>
                </>
              )}

              {sidebarView === "storage" && (
                <StoragePanel onClose={() => setSidebarView("current")} onNotify={notify} refreshTrigger={storageRefreshTrigger} />
              )}

              {sidebarView === "config" && (
                <ConfigPanel
                  key="config-panel"
                  onClose={() => {
                    setSidebarView("current");
                    window.electronAPI?.checkConfig().then((r) => setConfigOk(r.ok));
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>

      <StatusBar configOk={configOk} onOpenConfig={() => setSidebarView("config")} onOpenDev={() => setSidebarView("dev")} />
    </div>
  );
}
