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
import AboutPanel from "./components/AboutPanel";
import AppearancePanel from "./components/AppearancePanel";
import ServerStatusBanner from "./components/ServerStatusBanner";
import SpeakerLabelModal from "./components/SpeakerLabelModal";
import { useApi } from "./hooks/useApi";
import { useJobStatus } from "./hooks/useJobStatus";
import type { PollingState } from "./hooks/useJobStatus";
import { useServerStatus } from "./hooks/useServerStatus";
import { loadAndApplyAppearance } from "./appearance";
import type { JobStatus } from "./types";

const BRIDGE_URL = "http://127.0.0.1:5010";

type View = "upload" | "processing" | "results";
type SidebarView = "current" | "dev" | "config" | "storage" | "about" | "appearance";

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
  const [ollamaRequired, setOllamaRequired] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean | null>(null);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyJobStatus, setHistoryJobStatus] = useState<{ status: string; progress: number; error?: string | null } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [storageRefreshTrigger, setStorageRefreshTrigger] = useState(0);
  const [showNewForm, setShowNewForm] = useState(false);

  // ── Speaker labeling modal ──
  const [speakerClips, setSpeakerClips] = useState<any>(null);
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [labelingSubmitting, setLabelingSubmitting] = useState(false);

  // Whether a job is currently running (processing)
  const isJobRunning = view === "processing";

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
  const serverStatus = useServerStatus(ollamaRequired);

  // Keep diarizationAvailable in sync with server hook for downstream use
  useEffect(() => {
    setDiarizationAvailable(serverStatus.diarizationOk);
  }, [serverStatus.diarizationOk]);

  // Apply saved appearance settings on mount via shared utility
  useEffect(() => {
    loadAndApplyAppearance();
  }, []);

  // ── Sidebar drag-to-resize ──
  const sidebarRef = useRef<HTMLElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    resizeStartRef.current = {
      startX: e.clientX,
      startWidth: sidebar.offsetWidth,
    };
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const { startX, startWidth } = resizeStartRef.current;
      const newWidth = Math.max(68, Math.min(200, startWidth + (e.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-width", `${newWidth}px`);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
      document.body.classList.remove("sidebar-resizing");
    };
    document.body.classList.add("sidebar-resizing");
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("sidebar-resizing");
    };
  }, [isResizing]);

  // Check config on mount — detect whether Ollama is the provider
  useEffect(() => {
    window.electronAPI?.checkConfig().then((result: { ok: boolean; missing: string[] }) => {
      setConfigOk(result.ok);
      if (!result.ok) {
        const items = result.missing?.length ? result.missing.join(", ") : "DEEPSEEK_API_KEY or Ollama";
        setNotification(`Config incomplete: missing ${items}`);
        setTimeout(() => setNotification(null), 8000);
      }
    });
    window.electronAPI?.getConfig().then((cfg) => {
      setOllamaRequired(cfg?.LLM_PROVIDER === "ollama");
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

  // When pipeline pauses for labeling, fetch speaker clips and show the modal
  React.useEffect(() => {
    if (statusHook.state === "paused" && jobId && !showSpeakerModal && !speakerClips) {
      console.log("[App] Pipeline paused for labeling — fetching speaker clips");
      api
        .getSpeakerClips(jobId)
        .then((clips) => {
          setSpeakerClips(clips);
          setShowSpeakerModal(true);
        })
        .catch((err) => {
          console.error("[App] Failed to fetch speaker clips:", err);
          setNotification("Speaker identification paused but clips unavailable — check backend logs");
        });
    }
  }, [statusHook.state, jobId]);

  // When status changes away from paused, reset the speaker modal state
  React.useEffect(() => {
    if (statusHook.state !== "paused" && statusHook.state !== "polling") {
      setShowSpeakerModal(false);
      setSpeakerClips(null);
    }
  }, [statusHook.state]);

  // Stable refs for API calls so the effect below doesn't re-run on every render
  const getTranscriptRef = useRef<(id: string) => Promise<any>>();
  const getSummaryRef = useRef<(id: string) => Promise<any>>();
  getTranscriptRef.current = (id: string) => api.getTranscript(id);
  getSummaryRef.current = (id: string) => api.getSummary(id);

  // When polling completes, fetch transcript + summary + metadata
  React.useEffect(() => {
    if (statusHook.state === "complete" && jobId) {
      const stateSnapshot = statusHook.state;
      const jobTitle = jobMetadata?.title || "Untitled Meeting";

      // Show top-level OS notification (macOS / Windows)
      window.electronAPI?.showNotification("✅ Transcription Complete", `"${jobTitle}" — your transcript and summary are ready.`);

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
      const jobTitle = jobMetadata?.title || "Untitled Meeting";
      setNotification(errMsg);
      window.electronAPI?.showNotification("❌ Transcription Failed", `"${jobTitle}" — ${errMsg}`);
      setTimeout(() => setNotification(null), 10000);
      // Transition to results view so the user can see the error + logs
      setView("results");
    }
  }, [statusHook.state, jobId]);

  // Handle speaker label confirmation and pipeline resume
  const handleLabelConfirm = useCallback(
    async (labels: Array<{ speaker_id: string; name: string; email?: string }>) => {
      if (!jobId) return;
      setLabelingSubmitting(true);
      try {
        const result = await api.labelAndResume(jobId, labels);
        console.log("Label & resume result", result);
        setShowSpeakerModal(false);
        setNotification(`Speaker labels applied — pipeline resuming`);
      } catch (err: any) {
        setNotification(`Failed to apply labels: ${err.message}`);
      } finally {
        setLabelingSubmitting(false);
      }
    },
    [jobId, api],
  );

  const handleLabelCancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await api.cancelJob(jobId);
      statusHook.stopPolling();
      setShowSpeakerModal(false);
      setNotification("Job cancelled");
    } catch (err: any) {
      setNotification(`Cancel failed: ${err.message}`);
    }
  }, [jobId, api, statusHook]);

  // Handle upload submit
  const handleUpload = async (file: File, title: string, attendees: string[], emailRecipients: string[], skipSteps: string[]) => {
    console.log("handleUpload", { skipSteps, emailRecipients });
    setUploading(true);
    try {
      const result: any = await api.uploadAudio(file, title, attendees, emailRecipients, skipSteps);
      console.log("Upload result", result);
      setJobId(result.job_id);
      setJobMetadata({ title, attendees });
      setView("processing");
      setShowNewForm(false);
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

      {/* Speaker labeling modal — shown when pipeline pauses after diarization */}
      {showSpeakerModal && speakerClips && speakerClips.speakers && (
        <SpeakerLabelModal
          jobId={jobId!}
          speakers={speakerClips.speakers}
          onConfirm={handleLabelConfirm}
          onCancel={handleLabelCancel}
          submitting={labelingSubmitting}
        />
      )}

      <div className="app-body">
        <nav className="sidebar" ref={sidebarRef}>
          <div className="sidebar-resize-handle" onMouseDown={handleSidebarMouseDown} />
          <button
            className={`sidebar-btn ${showNewForm ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setShowNewForm(true);
              setSidebarView("current");
              setShowHistory(false);
            }}
            title="Start a new transcription">
            <span className="sidebar-btn-icon">➕</span>
            <span className="sidebar-btn-label">New</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "current" && !showHistory && !showNewForm ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("current");
              setShowNewForm(false);
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
              if (showHistory) {
                setHistoryJobId(null);
              }
              setSidebarView("current");
              setShowNewForm(false);
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
              setShowNewForm(false);
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
              setShowNewForm(false);
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
              setShowNewForm(false);
              setShowHistory(false);
              window.electronAPI?.getConfigWithSources();
            }}
            title="Configuration">
            <span className="sidebar-btn-icon">⚙️</span>
            <span className="sidebar-btn-label">Config</span>
            {!configOk && <span className="sidebar-badge" />}
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "appearance" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("appearance");
              setShowNewForm(false);
              setShowHistory(false);
            }}
            title="Appearance settings">
            <span className="sidebar-btn-icon">🎨</span>
            <span className="sidebar-btn-label">Appearance</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "about" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("about");
              setShowNewForm(false);
              setShowHistory(false);
            }}
            title="About Transcription Agent">
            <span className="sidebar-btn-icon">ℹ️</span>
            <span className="sidebar-btn-label">About</span>
          </button>
        </nav>

        <main className="app-main">
          {/* ── Dev view: always interactive (logs help debug startup) ── */}
          {sidebarView === "dev" && <DevPanel onClose={() => setSidebarView("current")} />}

          {/* ── Server status popover overlay ── */}
          {sidebarView !== "dev" && (
            <ServerStatusBanner
              services={serverStatus.services}
              diarizationOk={serverStatus.diarizationOk}
              diarizationError={serverStatus.diarizationError}
              ollamaOk={serverStatus.ollamaOk}
              ollamaRequired={ollamaRequired}
              checking={serverStatus.checking}
              allReady={serverStatus.allReady}
              onCheckServers={serverStatus.checkServers}
              onRestartService={serverStatus.restartService}
              onRestartAll={serverStatus.restartAll}
              onStartOllama={serverStatus.startOllama}
            />
          )}

          {/* ── Normal content (always visible behind popover) ── */}
          {sidebarView !== "dev" && (
            <>
              {sidebarView === "current" && (
                <>
                  <div className={`left-col ${showNewForm ? "left-col--new" : ""}`} id="left-col">
                    {showNewForm ? (
                      <UploadPanel onUpload={handleUpload} uploading={uploading} disabled={isJobRunning} />
                    ) : showHistory ? (
                      <HistoryPanel
                        onSelectJob={loadHistoryJob}
                        currentJobId={historyJobId || jobId}
                        onNotify={notify}
                        onStorageChanged={onStorageChanged}
                      />
                    ) : (
                      <>
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

                        {view === "results" && statusHook.state === "error" && !statusData && (
                          <div className="panel">
                            <h2>❌ Processing Failed</h2>
                            <p className="error-box" style={{ marginBottom: 12 }}>
                              {statusHook.error || "Unknown error"}
                            </p>
                          </div>
                        )}

                        {!jobId && (
                          <div className="panel">
                            <h2>No Active Job</h2>
                            <p className="placeholder" style={{ color: "var(--text-muted)" }}>
                              Click <strong>➕ New</strong> to start a new transcription.
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

              {sidebarView === "about" && <AboutPanel onClose={() => setSidebarView("current")} />}

              {sidebarView === "appearance" && <AppearancePanel onClose={() => setSidebarView("current")} />}
            </>
          )}
        </main>
      </div>

      <StatusBar configOk={configOk} onOpenConfig={() => setSidebarView("config")} onOpenDev={() => setSidebarView("dev")} />
    </div>
  );
}
