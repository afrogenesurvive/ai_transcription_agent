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
import Icon from "./components/Icon";
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
  // Isolated state for history job data — prevents overwriting when the current job's
  // polling updates the shared transcript/metadata state.
  const [historyTranscript, setHistoryTranscript] = useState<any>(null);

  // ── Pipeline-step-derived skip steps for new job form ──
  const [defaultSkipSteps, setDefaultSkipSteps] = useState<string[]>([]);

  // When the new job form opens, fetch agent config pipeline steps so the
  // UploadPanel checkboxes reflect which steps are disabled in the ConfigPanel.
  useEffect(() => {
    if (!showNewForm) return;
    let cancelled = false;
    window.electronAPI
      ?.getAgentConfig()
      .then((cfg) => {
        if (cancelled || !cfg || cfg.error) return;
        const steps = cfg.pipeline?.pipeline_steps;
        if (!steps || !Array.isArray(steps)) return;
        // Derive skip_steps from pipeline steps where enabled === false
        const disabled = steps.filter((s: any) => !s.enabled).map((s: any) => s.toolName);
        setDefaultSkipSteps(disabled);
      })
      .catch(() => {
        /* agent config unavailable — UploadPanel will use its own defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [showNewForm]);

  // ── Speaker labeling modal ──
  const [speakerClips, setSpeakerClips] = useState<any>(null);
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [labelingSubmitting, setLabelingSubmitting] = useState(false);

  // Ref to manage notification auto-dismiss timeout — prevents stale timeouts
  // from prematurely dismissing newer notifications.
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notification helper — shows a toast at the top-right, auto-dismissed after 10s
  const notify = useCallback((message: string) => {
    // Clear any existing timeout so a new notification isn't prematurely dismissed
    if (notificationTimerRef.current) {
      clearTimeout(notificationTimerRef.current);
    }
    setNotification(message);
    notificationTimerRef.current = setTimeout(() => {
      setNotification(null);
      notificationTimerRef.current = null;
    }, 10000);
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
        notify(`Config incomplete: missing ${items}`);
      }
    });
    window.electronAPI?.getConfig().then((cfg) => {
      setOllamaRequired(cfg?.LLM_PROVIDER === "ollama");
    });
  }, []);

  // Listen for Electron notifications
  React.useEffect(() => {
    const cleanup = window.electronAPI?.onNotification((msg) => {
      notify(msg);
    });
    return () => cleanup?.();
  }, [notify]);

  // Listen for notification clicks — switch to results view when user clicks a completion notification
  React.useEffect(() => {
    const cleanup = window.electronAPI?.onNotificationClick((payload) => {
      if (payload?.action === "view_results" && payload?.jobId) {
        const clickJobId = payload.jobId as string;
        // Only act if this matches the current job (or load from history if different)
        if (jobId === clickJobId) {
          setView("results");
        } else {
          // Load a different completed job
          loadHistoryJob(clickJobId);
        }
      }
    });
    return () => cleanup?.();
  }, [jobId]);

  // Cleanup notification timer on unmount
  React.useEffect(() => {
    return () => {
      if (notificationTimerRef.current) {
        clearTimeout(notificationTimerRef.current);
      }
    };
  }, []);

  // Poll job status — stabilize the fetcher ref to avoid restarting polling on re-render
  const fetcherRef = useRef<(id: string) => Promise<any>>();
  fetcherRef.current = (id: string) => api.getStatus(id);
  const statusHook = useJobStatus(
    jobId,
    useCallback((id: string) => fetcherRef.current?.(id) ?? Promise.reject(new Error("no fetcher")), []),
    serverStatus.allReady,
  );

  // Whether a job is currently running (processing).
  // Includes backend_down so the cancel button stays available when backend is unreachable.
  const isJobRunning =
    statusHook.state === "polling" || statusHook.state === "paused" || statusHook.state === "backend_down" || view === "processing";

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
          notify("Speaker identification paused but clips unavailable — check backend logs");
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
      // If the user clicks the notification, they'll be taken to the results view
      window.electronAPI?.showNotification("Transcription Complete", `"${jobTitle}" — click to view results`, { action: "view_results", jobId });

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
            notify("Transcription completed but transcript data unavailable");
            setView("results");
          }
        })
        .catch((err) => {
          notify(`Failed to load transcript: ${err.message}`);
          setView("results");
        });
    }

    // When polling detects a failed status or network error — show notification
    if (statusHook.state === "error" && jobId) {
      // Use the backend's error message if available, otherwise the network/hook error
      const errMsg = statusHook.data?.error || statusHook.error || "Processing failed — check the Logs tab for details";
      const jobTitle = jobMetadata?.title || "Untitled Meeting";
      notify(errMsg);
      window.electronAPI?.showNotification("Transcription Failed", `"${jobTitle}" — ${errMsg}`, { action: "view_results", jobId });
      // Transition to results view so the user can see the error + logs
      setView("results");

      // If the backend status doesn't already reflect failure (e.g. a timeout
      // or network error where the backend status is still a non-terminal state
      // like "analyzed"), update statusData to show the error while preserving
      // the actual backend status so the cancel button remains available.
      if (statusData && statusData.status !== "failed") {
        setStatusData((prev: any) => (prev ? { ...prev, titleError: errMsg, progress: prev.progress ?? 0.0 } : prev));
      }
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
        notify(`Speaker labels applied — pipeline resuming`);
      } catch (err: any) {
        notify(`Failed to apply labels: ${err.message}`);
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
      notify("Job cancelled");
    } catch (err: any) {
      notify(`Cancel failed: ${err.message}`);
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
      notify(`Upload failed: ${err.message}`);
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
      notify("Processing cancelled");
    } catch (err: any) {
      notify(`Cancel failed: ${err.message}`);
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
          setHistoryTranscript({ ...transcriptData, summary: summaryData });
          // Store metadata from status if available (title, attendees, etc.)
          if (statusData?.metadata) {
            setJobMetadata(statusData.metadata);
          }
          // Store status info for the Pipeline tab
          setHistoryJobStatus(statusData ? { status: statusData.status, progress: statusData.progress, error: statusData.error } : null);
          setView("results");
        } else {
          notify("Transcript data unavailable for this job");
          setView("results");
        }
      } catch (err: any) {
        notify(`Failed to load job: ${err.message}`);
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
    setHistoryTranscript(null);
    statusHook.stopPolling();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 data-tooltip="Home — Transcription Agent desktop app">
          <Icon name="mic" size="24" color="accent" /> Transcription Agent
        </h1>
        {isJobRunning && (
          <span className="app-header-job-indicator" data-tooltip="A transcription job is currently in progress">
            <span className="app-header-job-indicator-dot" />
            <span className="app-header-job-indicator-text">Job Running</span>
          </span>
        )}
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
            title="Dismiss this notification"
            data-tooltip="Dismiss this notification">
            <Icon name="close" size="14" />
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
            disabled={isJobRunning}
            title={
              isJobRunning
                ? "A job is currently running — wait for it to finish"
                : "Start a new transcription — upload audio and configure meeting details"
            }
            data-tooltip={
              isJobRunning
                ? "A transcription job is in progress — start a new one after it finishes"
                : "Start a new transcription — upload audio and configure meeting details"
            }>
            <span className="sidebar-btn-icon">
              <Icon name="add_circle" size="16" />
            </span>
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
            title="View active or most recent job — pipeline progress, transcript, and results"
            data-tooltip="View active or most recent job — pipeline progress, transcript, and results">
            <span className="sidebar-btn-icon">
              <Icon name="home" size="16" />
            </span>
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
            title="Browse past transcription jobs — reload or delete previous sessions"
            data-tooltip="Browse past transcription jobs — reload or delete previous sessions">
            <span className="sidebar-btn-icon">
              <Icon name="history" size="16" />
            </span>
            <span className="sidebar-btn-label">History</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "storage" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("storage");
              setShowNewForm(false);
              setShowHistory(false);
            }}
            title="View disk usage breakdown — jobs, logs, databases, and models"
            data-tooltip="View disk usage breakdown — jobs, logs, databases, and models">
            <span className="sidebar-btn-icon">
              <Icon name="storage" size="16" />
            </span>
            <span className="sidebar-btn-label">Storage</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "dev" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("dev");
              setShowNewForm(false);
              setShowHistory(false);
            }}
            title="Developer tools — live logs, database browser, performance metrics, and updates"
            data-tooltip="Developer tools — live logs, database browser, performance metrics, and updates">
            <span className="sidebar-btn-icon">
              <Icon name="build" size="16" />
            </span>
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
            title="Configure API keys, LLM provider, delivery services, and agent pipeline settings"
            data-tooltip="Configure API keys, LLM provider, delivery services, and agent pipeline settings">
            <span className="sidebar-btn-icon">
              <Icon name="settings" size="16" />
            </span>
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
            title="Customize theme, accent color, font size, and sidebar width"
            data-tooltip="Customize theme, accent color, font size, and sidebar width">
            <span className="sidebar-btn-icon">
              <Icon name="palette" size="16" />
            </span>
            <span className="sidebar-btn-label">Appearance</span>
          </button>
          <button
            className={`sidebar-btn ${sidebarView === "about" ? "sidebar-btn--active" : ""}`}
            onClick={() => {
              setSidebarView("about");
              setShowNewForm(false);
              setShowHistory(false);
            }}
            title="App version, name, and README — learn about the Transcription Agent"
            data-tooltip="App version, name, and README — learn about the Transcription Agent">
            <span className="sidebar-btn-icon">
              <Icon name="info" size="16" />
            </span>
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
                  {showNewForm ? (
                    <div className="upload-panel-full">
                      <UploadPanel onUpload={handleUpload} uploading={uploading} disabled={isJobRunning} initialSkipSteps={defaultSkipSteps} />
                    </div>
                  ) : (
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
                            {(view === "processing" || view === "results") && statusData && (
                              <PipelineProgress
                                status={statusData.status}
                                progress={statusData.progress}
                                error={statusData.error}
                                titleError={statusData.titleError}
                                onCancel={handleCancel}
                                cancelling={cancelling}
                                diarizationAvailable={diarizationAvailable}
                                skippedSteps={computeSkippedStages(statusData)}
                                onNewJob={() => {
                                  setShowNewForm(true);
                                  setSidebarView("current");
                                  setShowHistory(false);
                                }}
                              />
                            )}

                            {view === "results" && statusHook.state === "error" && !statusData && (
                              <div className="panel">
                                <h2>
                                  <Icon name="error" color="red" /> Processing Failed
                                </h2>
                                <p className="error-box" style={{ marginBottom: 12 }}>
                                  {statusHook.error || "Unknown error"}
                                </p>
                              </div>
                            )}

                            {!jobId && (
                              <div className="panel">
                                <h2>No Active Job</h2>
                                <p className="placeholder" style={{ color: "var(--text-muted)" }}>
                                  Click{" "}
                                  <strong>
                                    <Icon name="add_circle" size="14" /> New
                                  </strong>{" "}
                                  to start a new transcription.
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
                            key={"history-" + historyJobId}
                            jobId={historyJobId}
                            segments={historyTranscript?.transcript}
                            summary={historyTranscript?.summary}
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
                              Your results will appear here automatically once processing is complete. You&#39;ll be able to browse the full
                              transcript, summary, and audio recording.
                            </p>
                          </div>
                        )}
                        {/* Live results from current upload — hidden when viewing history */}
                        {!historyJobId && view === "results" && jobId && (
                          <ResultsViewer
                            key={"live-" + jobId}
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
