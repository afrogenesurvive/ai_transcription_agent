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
import LoadingModal from "./components/LoadingModal";
import Tooltip from "./components/Tooltip";
import Icon from "./components/Icon";
import { useApi } from "./hooks/useApi";
import { useJobStatus } from "./hooks/useJobStatus";
import type { PollingState } from "./hooks/useJobStatus";
import { useServerStatus } from "./hooks/useServerStatus";
import { useForeignJobs } from "./hooks/useForeignJobs";
import { ServiceStatusProvider } from "./hooks/serviceStatusContext";
import { useUiState, useUiStateValue } from "./hooks/useUiState";
import { loadAndApplyAppearance } from "./appearance";
import { formatElapsedHMS } from "./utils/timeFormat";
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
  // Only mark the delivery stage as skipped when the primary email delivery
  // tool itself is skipped.  Auxiliary tools (Drive, Trello) being disabled
  // doesn't mean "no delivery at all" — email may still be active.
  if (skipSteps.includes("send_delivery_email")) {
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
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("current");
  const [devWarningModal, setDevWarningModal] = useState<SidebarView | null>(null);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [configOk, setConfigOk] = useState(true);
  const [showConfigOverlay, setShowConfigOverlay] = useState(false);
  const [ollamaRequired, setOllamaRequired] = useState(false);
  // Job-status polling safety cap (ms), driven by PIPELINE_TIMEOUT_MINUTES from
  // config so the UI never gives up before the backend's own pipeline timeout.
  const [pipelineTimeoutMs, setPipelineTimeoutMs] = useState<number>(60 * 60 * 1000);
  const [cancelling, setCancelling] = useState(false);
  const [cancellingForeign, setCancellingForeign] = useState(false);
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean | null>(null);
  // Persisted history selection (userData/ui-state.json) — restored on launch and
  // validated against the job list (see the history-selection validation effect).
  const [historyJobId, setHistoryJobId] = useUiStateValue<string | null>("history.selectedJobId", null);
  // Live per-stage progress (diarization / transcription %) pushed from the main
  // process logger via IPC — displayed on the pipeline stepper's active step.
  const [stageProgress, setStageProgress] = useState<{ diarization?: number; transcription?: number }>({});
  const [historyJobStatus, setHistoryJobStatus] = useState<{
    status: string;
    progress: number;
    error?: string | null;
    started_at?: number;
    finished_at?: number;
  } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [storageRefreshTrigger, setStorageRefreshTrigger] = useState(0);
  const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState(0);
  const [devAccessSignal, setDevAccessSignal] = useState(0);
  const [newJobCooldown, setNewJobCooldown] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  // Live File object for the New form — hoisted to App so it survives panel
  // switches (UploadPanel unmounts on view change; a browser File can't be
  // serialized). Cleared on new-job and after a successful submit.
  const [formFile, setFormFile] = useState<File | null>(null);
  // Left-column collapse state for history view — collapsed hides the job list so
  // the results viewer gets the full width. Persisted in userData/ui-state.json
  // (legacy localStorage key "historyLeftColCollapsed" is migrated by the provider).
  const [leftColCollapsed, setLeftColCollapsed] = useUiStateValue<boolean>("history.leftColCollapsed", false);

  // Stable ui-state callbacks (destructured so effects can depend on them safely)
  const { clearScope, set: setUiState, ready: uiStateReady } = useUiState();
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
  const [labelingError, setLabelingError] = useState<string | null>(null);
  const [labelingConflicts, setLabelingConflicts] = useState<any[] | null>(null);

  // Guard refs to prevent duplicate notifications on repeated poll cycles
  const labelingNotifiedRef = useRef(false);
  const gate1NotifiedRef = useRef(false);
  const gate2NotifiedRef = useRef(false);

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

  // ── Foreign job detection (bot-created jobs) ──
  const foreignJobs = useForeignJobs();

  // Keep diarizationAvailable in sync with server hook for downstream use
  useEffect(() => {
    setDiarizationAvailable(serverStatus.diarizationOk);
  }, [serverStatus.diarizationOk]);

  // Apply saved appearance settings on mount via shared utility
  useEffect(() => {
    loadAndApplyAppearance();
  }, []);

  // ── Reset rules for persisted UI state (userData/ui-state.json) ──
  // Rule (2b): no current job → reset the Current panel's persisted state so a
  // stale results tab / live-log collapse doesn't survive into the next session.
  // Gated on uiStateReady so a stale persisted "current" scope is cleared once
  // the store finishes loading on launch.
  useEffect(() => {
    if (uiStateReady && !jobId) clearScope("current");
  }, [jobId, clearScope, uiStateReady]);

  // Rule (3d): validate the persisted history selection — if the previously
  // selected job no longer exists, clear the selection AND reset the history
  // results tab/subtab so no stale job renders when History is reopened.
  useEffect(() => {
    if (!historyJobId) return;
    let cancelled = false;
    api
      .getHistory()
      .then((data: any) => {
        if (cancelled) return;
        const ids = new Set((data?.jobs || []).map((j: any) => j.job_id));
        if (!ids.has(historyJobId)) {
          setHistoryJobId(null);
          setUiState("history.resultsTab", "pipeline");
          setUiState("history.resultsDevSubTab", "tokens");
        }
      })
      .catch(() => {
        /* history unavailable — leave the selection as-is */
      });
    return () => {
      cancelled = true;
    };
  }, [historyJobId, api, setHistoryJobId, setUiState]);

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

  // ── Left-col drag-to-resize ──
  const leftColResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleLeftColMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const leftCol = document.getElementById("left-col");
    if (!leftCol) return;
    leftColResizeStartRef.current = {
      startX: e.clientX,
      startWidth: leftCol.offsetWidth,
    };
    document.body.classList.add("left-col-resizing");

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!leftColResizeStartRef.current) return;
      const { startX, startWidth } = leftColResizeStartRef.current;
      const newWidth = Math.max(280, Math.min(800, startWidth + (moveEvent.clientX - startX)));
      document.documentElement.style.setProperty("--left-col-width", `${newWidth}px`);
    };

    const handleMouseUp = () => {
      leftColResizeStartRef.current = null;
      document.body.classList.remove("left-col-resizing");
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

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
      const mins = Number(cfg?.PIPELINE_TIMEOUT_MINUTES);
      if (Number.isFinite(mins) && mins > 0) {
        setPipelineTimeoutMs(mins * 60 * 1000);
      }
    });
  }, []);

  // Show config overlay when config is missing and user is not on the config panel
  useEffect(() => {
    if (!configOk && sidebarView !== "config") {
      setShowConfigOverlay(true);
    } else {
      setShowConfigOverlay(false);
    }
  }, [configOk, sidebarView]);

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

  // Listen for job-started events from main process (agent runner / Python backend)
  React.useEffect(() => {
    const cleanup = window.electronAPI?.onJobStarted((payload) => {
      const shortId = payload.jobId ? payload.jobId.slice(0, 8) : "?";
      notify(`Job ${shortId} started — transcription processing`);
    });
    return () => cleanup?.();
  }, [notify]);

  // Live per-stage progress (Diarization / ASR %) from the logger — feeds the
  // pipeline stepper. Only applied when it belongs to the job currently shown.
  // Note: 0.6.9-5 made the History selection persist across new jobs, so a stale
  // historyJobId would otherwise shadow the current jobId and drop every
  // job-progress event for the new job. Scope to the History job only while
  // History is actually open (mirroring the render gating).
  React.useEffect(() => {
    const cleanup = window.electronAPI?.onJobProgress((payload) => {
      const activeJobId = (showHistory && historyJobId) || jobId;
      if (!activeJobId) return;
      if (payload.jobId && payload.jobId !== activeJobId) return;
      if (payload.stage !== "diarization" && payload.stage !== "transcription") return;
      if (typeof payload.percent !== "number" || !Number.isFinite(payload.percent)) return;
      setStageProgress((prev) => ({ ...prev, [payload.stage]: payload.percent }));
    });
    return () => cleanup?.();
  }, [jobId, historyJobId, showHistory]);

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
    pipelineTimeoutMs,
  );

  // Whether a job is currently running (processing).
  // Includes backend_down so the cancel button stays available when backend is unreachable.
  // Also includes foreign jobs (bot-created) so the UI guards controls when the bot is running.
  const isJobRunning =
    statusHook.state === "polling" ||
    statusHook.state === "paused" ||
    statusHook.state === "backend_down" ||
    view === "processing" ||
    foreignJobs.hasForeignRunningJobs ||
    newJobCooldown;

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

  // ── App header job indicator: live % complete + elapsed time ──
  const [headerNow, setHeaderNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isJobRunning || typeof statusData?.started_at !== "number" || !Number.isFinite(statusData.started_at)) return;
    setHeaderNow(Date.now());
    const id = setInterval(() => setHeaderNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isJobRunning, statusData?.started_at]);
  const headerElapsedMs =
    typeof statusData?.started_at === "number" && Number.isFinite(statusData.started_at) ? headerNow - statusData.started_at : 0;
  const headerPct = Math.round(Math.max(0, Math.min(1, statusData?.progress ?? 0)) * 100);

  // ── Clear stale job view when new foreign jobs appear after a completed job ──
  // Without this, the "Current" view keeps showing the old job's results while a
  // new bot-created job runs in the background.  By clearing jobId (it's already
  // terminal), the existing `{!jobId && foreignJobs.hasForeignRunningJobs && (...)}`
  // guard activates and shows the "Bot Job Running" panel instead.
  const prevForeignRunningRef = useRef(false);
  React.useEffect(() => {
    const wasRunning = prevForeignRunningRef.current;
    const nowRunning = foreignJobs.hasForeignRunningJobs;
    prevForeignRunningRef.current = nowRunning;

    // Only fire on the transition false → true, and only when the old job is done
    if (nowRunning && !wasRunning && (statusHook.state === "complete" || statusHook.state === "error")) {
      setJobId(null);
      setTranscript(null);
      setJobMetadata(null);
      setStatusData(null);
      setStageProgress({});
      setView("upload");
      statusHook.stopPolling();
    }
  }, [foreignJobs.hasForeignRunningJobs, statusHook.state, statusHook]);

  // ── Auto-switch to "Current" view when pipeline pauses for user input ──
  // Speaker labeling, raw transcript review (Gate 1), and delivery review (Gate 2)
  // all render modals that are only visible when sidebarView === "current" and
  // showHistory/showNewForm are false. This effect ensures the user sees the modal
  // regardless of which sidebar view they were browsing.
  React.useEffect(() => {
    const modalStatuses = new Set(["paused_for_labeling", "pending_raw_review", "pending_delivery_review"]);
    if (statusData?.status && modalStatuses.has(statusData.status)) {
      // Only switch if we're not already showing the "Current" view — avoid
      // unnecessary re-renders when the user is already looking at the pipeline.
      if (sidebarView !== "current" || showHistory || showNewForm) {
        setSidebarView("current");
        setShowHistory(false);
        setShowNewForm(false);
        // Clear history job state so the right column shows current job results
        // instead of leaving the stale history ResultsViewer visible behind the modal.
        setHistoryJobId(null);
        setHistoryTranscript(null);
        setHistoryJobStatus(null);
      }
    }
  }, [statusData?.status]);

  // When pipeline pauses for Gate 1 (raw transcript review), fire notification
  React.useEffect(() => {
    if (statusData?.status === "pending_raw_review" && jobId && !gate1NotifiedRef.current) {
      gate1NotifiedRef.current = true;
      const jobTitle = jobMetadata?.title || "Untitled Meeting";
      notify(`"${jobTitle}" — transcript approval needed`);
      window.electronAPI?.showNotification({
        title: "Transcript Approval Needed",
        body: `"${jobTitle}" — click to review and approve the transcript`,
        type: "paused",
        subtitle: jobTitle,
        clickPayload: { action: "view_results", jobId },
      });
    }
    if (statusData?.status === "pending_delivery_review" && jobId && !gate2NotifiedRef.current) {
      gate2NotifiedRef.current = true;
      const jobTitle = jobMetadata?.title || "Untitled Meeting";
      notify(`"${jobTitle}" — pre-delivery approval needed`);
      window.electronAPI?.showNotification({
        title: "Pre-Delivery Approval Needed",
        body: `"${jobTitle}" — click to review and approve delivery`,
        type: "paused",
        subtitle: jobTitle,
        clickPayload: { action: "view_results", jobId },
      });
    }
  }, [statusData?.status, jobId]);

  // When pipeline pauses for labeling, fetch speaker clips and show the modal
  React.useEffect(() => {
    if (statusHook.state === "paused" && jobId && !showSpeakerModal && !speakerClips) {
      console.log("[App] Pipeline paused for labeling — fetching speaker clips");

      // Fire in-app and system notification once when entering paused state
      if (!labelingNotifiedRef.current) {
        labelingNotifiedRef.current = true;
        const jobTitle = jobMetadata?.title || "Untitled Meeting";
        notify(`"${jobTitle}" — speaker identification needed`);
        window.electronAPI?.showNotification({
          title: "Speaker Labels Needed",
          body: `"${jobTitle}" — click to identify speakers`,
          type: "paused",
          subtitle: jobTitle,
          clickPayload: { action: "view_results", jobId },
        });
      }

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
    // Reset all notification guard refs when leaving paused state
    if (statusHook.state !== "paused") {
      labelingNotifiedRef.current = false;
      gate1NotifiedRef.current = false;
      gate2NotifiedRef.current = false;
    }
  }, [statusHook.state]);

  // Stable refs for API calls so the effect below doesn't re-run on every render
  const getTranscriptRef = useRef<(id: string) => Promise<any>>();
  const getSummaryRef = useRef<(id: string) => Promise<any>>();
  getTranscriptRef.current = (id: string) => api.getTranscript(id);
  getSummaryRef.current = (id: string) => api.getSummary(id);

  // When polling completes, switch to results view IMMEDIATELY (don't wait for
  // transcript/summary API calls — they can take seconds for large transcripts).
  // Then load transcript + summary asynchronously and update state as data arrives.
  React.useEffect(() => {
    if (statusHook.state === "complete" && jobId) {
      const jobTitle = jobMetadata?.title || "Untitled Meeting";

      // Show in-app toast and top-level OS notification
      notify(`"${jobTitle}" — transcription complete`);
      window.electronAPI?.showNotification({
        title: "Transcription Complete",
        body: `"${jobTitle}" — click to view results`,
        type: "success",
        subtitle: jobTitle,
        clickPayload: { action: "view_results", jobId },
      });

      // Switch to results view immediately — ResultsViewer shows loading states
      // for tabs whose data hasn't loaded yet.
      setView("results");

      // Load transcript and summary asynchronously (no longer blocking the view switch)
      getTranscriptRef
        .current?.(jobId)
        .then((transcriptData) => {
          if (transcriptData) {
            // Load summary separately (non-blocking)
            getSummaryRef
              .current?.(jobId)
              .then((summaryData) => {
                setTranscript({ ...transcriptData, summary: summaryData });
              })
              .catch(() => {
                // Summary is optional — set transcript without it
                setTranscript({ ...transcriptData, summary: null });
              });
          } else {
            notify("Transcription completed but transcript data unavailable");
          }
        })
        .catch((err) => {
          notify(`Failed to load transcript: ${err.message}`);
        });

      // Safe to start a new job — brief cooldown keeps the New button disabled
      // until the "safe to start" notification fires (2s delay).
      setNewJobCooldown(true);
      if (!foreignJobs.hasForeignRunningJobs) {
        setTimeout(() => {
          setNewJobCooldown(false);
          notify("✅ System ready — safe to start a new transcription job");
        }, 2000);
        console.log(`\n${"═".repeat(40)}`);
        console.log(`  🟢 SYSTEM IDLE — Safe to start a new job`);
        console.log(`${"═".repeat(40)}\n`);
      }
    }

    // When polling detects a failed status or network error — show notification
    if (statusHook.state === "error" && jobId) {
      // Use the backend's error message if available, otherwise the network/hook error
      const errMsg = statusHook.data?.error || statusHook.error || "Processing failed — check the Logs tab for details";
      const jobTitle = jobMetadata?.title || "Untitled Meeting";
      notify(errMsg);
      window.electronAPI?.showNotification({
        title: "Transcription Failed",
        body: `"${jobTitle}" — ${errMsg}`,
        type: "error",
        subtitle: jobTitle,
        clickPayload: { action: "view_results", jobId },
      });
      // Transition to results view so the user can see the error + logs
      setView("results");

      // If the backend status doesn't already reflect failure (e.g. a timeout
      // or network error where the backend status is still a non-terminal state
      // like "analyzed"), update statusData to show the error while preserving
      // the actual backend status so the cancel button remains available.
      if (statusData && statusData.status !== "failed") {
        setStatusData((prev: any) => (prev ? { ...prev, titleError: errMsg, progress: prev.progress ?? 0.0 } : prev));
      }

      // Safe to start a new job — brief cooldown keeps the New button disabled
      // until the "safe to start" notification fires (2s delay).
      setNewJobCooldown(true);
      if (!foreignJobs.hasForeignRunningJobs) {
        setTimeout(() => {
          setNewJobCooldown(false);
          notify("✅ System ready — safe to start a new transcription job");
        }, 2000);
        console.log(`\n${"═".repeat(40)}`);
        console.log(`  🟢 SYSTEM IDLE — Safe to start a new job`);
        console.log(`${"═".repeat(40)}\n`);
      }
    }
  }, [statusHook.state, jobId]);

  // Handle speaker label confirmation and pipeline resume
  const handleLabelConfirm = useCallback(
    async (
      labels: Array<{ speaker_id: string; name: string; email?: string }>,
      options?: { overwriteNames?: string[]; excludedNonSpeaking?: string[] },
    ) => {
      if (!jobId) return;
      setLabelingError(null);
      setLabelingConflicts(null);
      setLabelingSubmitting(true);
      try {
        const result = await api.labelAndResume(jobId, labels, options?.overwriteNames, options?.excludedNonSpeaking);
        console.log("Label & resume result", result);
        setShowSpeakerModal(false);
        setSpeakerClips(null);
        notify(`Speaker labels applied — pipeline resuming`);
      } catch (err: any) {
        if (err.name === "VoiceMatchConflictError") {
          // Pass conflicts back to the modal for inline resolution
          setLabelingConflicts(err.conflicts);
          notify("Voice match conflict detected — resolve inline and re-submit");
          return; // Don't close modal, let user resolve inline
        }
        const errMsg = err.message || "Unknown error applying labels";
        setLabelingError(errMsg);
        notify(`Failed to apply labels: ${errMsg}`);
      } finally {
        setLabelingSubmitting(false);
      }
    },
    [jobId, api],
  );

  const handleLabelCancel = useCallback(async () => {
    if (!jobId) return;
    setLabelingError(null);
    setLabelingConflicts(null);
    try {
      await api.cancelJob(jobId);
      statusHook.stopPolling();
      setView("results");
      setShowSpeakerModal(false);
      setSpeakerClips(null);
      setStatusData({ status: "failed", error: "Cancelled by user", progress: 0.0 });
      notify("Job cancelled");
      const cancelTitle = jobMetadata?.title || "Untitled Meeting";
      window.electronAPI?.showNotification({
        title: "Transcription Cancelled",
        body: `"${cancelTitle}" — speaker labelling cancelled`,
        type: "error",
        subtitle: cancelTitle,
        clickPayload: { action: "view_results", jobId },
      });
    } catch (err: any) {
      notify(`Cancel failed: ${err.message}`);
    }
  }, [jobId, api, statusHook, jobMetadata]);

  // ── Gate 1: Approve or reject raw transcript review ──
  const handleGate1Approve = useCallback(
    async (body: { action: string; editedTranscript?: any[] }) => {
      if (!jobId) return;
      console.log("[Gate1] 🚀 Submitted — approving raw transcript");
      try {
        const result = await api.approveGate1(jobId, body);
        console.log("[Gate1] ✅ Complete — enqueued for agent runner", result);
        notify("Raw transcript approved — agent pipeline starting");
      } catch (err: any) {
        const errMsg = err.message || "Failed to approve";
        notify(`Gate 1 approval failed: ${errMsg}`);
        throw err; // Re-throw so ProgressPanel can show the error
      }
    },
    [jobId, api],
  );

  const handleGate1Reject = useCallback(
    async (action: "cancel" | "retry") => {
      if (!jobId) return;
      const gate1RejectAction = action === "cancel" ? "🚫" : "🔄";
      console.log(`[Gate1] ${gate1RejectAction} Rejected — ${action === "cancel" ? "cancelling job" : "retrying pipeline"}`);
      try {
        await api.approveGate1(jobId, { action: action === "cancel" ? "reject_cancel" : "reject_retry" });
        if (action === "cancel") {
          console.log("[Gate1] ⛔ Job cancelled");
          statusHook.stopPolling();
          setView("results");
          setStatusData({ status: "failed", error: "Rejected at raw transcript review (Gate 1)", progress: 0.0 });
          notify("Transcript rejected — job cancelled");
          const gate1Title = jobMetadata?.title || "Untitled Meeting";
          window.electronAPI?.showNotification({
            title: "Transcription Cancelled",
            body: `"${gate1Title}" — rejected at raw transcript review`,
            type: "error",
            subtitle: gate1Title,
            clickPayload: { action: "view_results", jobId },
          });
        } else {
          notify("Transcript rejected — pipeline retrying");
        }
      } catch (err: any) {
        notify(`Gate 1 reject failed: ${err.message}`);
        throw err;
      }
    },
    [jobId, api, statusHook, jobMetadata],
  );

  // ── Gate 2: Approve or reject delivery review ──
  const handleGate2Approve = useCallback(
    async (body: {
      action: string;
      editedTranscript?: any[];
      editedSummary?: any;
      editedAnalysis?: any;
      deliveryOptions?: { recipients?: string[]; destinations?: string[] };
      feedback?: string;
    }) => {
      if (!jobId) return;
      console.log("[Gate2] 🚀 Submitted — approving delivery");
      try {
        const result = await api.approveGate2(jobId, body);
        console.log("[Gate2] ✅ Complete — saved to memory, delivering", result);
        notify("Delivery approved — saving to memory and delivering");
      } catch (err: any) {
        const errMsg = err.message || "Failed to approve delivery";
        notify(`Gate 2 approval failed: ${errMsg}`);
        throw err;
      }
    },
    [jobId, api],
  );

  const handleGate2Reject = useCallback(
    async (action: "cancel" | "retry", feedback?: string) => {
      if (!jobId) return;
      const gate2RejectAction = action === "cancel" ? "🚫" : "🔄";
      console.log(`[Gate2] ${gate2RejectAction} Rejected — ${action === "cancel" ? "cancelling job" : "retrying pipeline"}`);
      try {
        await api.approveGate2(jobId, {
          action: action === "cancel" ? "reject_cancel" : "reject_retry",
          feedback,
        });
        if (action === "cancel") {
          console.log("[Gate2] ⛔ Job cancelled");
          statusHook.stopPolling();
          setView("results");
          setStatusData({ status: "failed", error: "Rejected at delivery review (Gate 2)", progress: 0.0 });
          notify("Delivery rejected — job cancelled");
          const gate2Title = jobMetadata?.title || "Untitled Meeting";
          window.electronAPI?.showNotification({
            title: "Transcription Cancelled",
            body: `"${gate2Title}" — rejected at delivery review`,
            type: "error",
            subtitle: gate2Title,
            clickPayload: { action: "view_results", jobId },
          });
        } else {
          notify("Delivery rejected — agent pipeline retrying");
        }
      } catch (err: any) {
        notify(`Gate 2 reject failed: ${err.message}`);
        throw err;
      }
    },
    [jobId, api, statusHook],
  );

  // Handle upload submit
  const handleUpload = async (
    file: File,
    title: string,
    attendees: string[],
    emailRecipients: string[],
    skipSteps: string[],
    attendeeEmails?: string[],
  ) => {
    console.log("handleUpload", { skipSteps, emailRecipients, attendeeEmails });
    setUploading(true);
    setLoadingMessage("Uploading audio file…");
    try {
      const result: any = await api.uploadAudio(file, title, attendees, emailRecipients, skipSteps, attendeeEmails);
      console.log("Upload result", result);
      setJobId(result.job_id);
      setJobMetadata({ title, originalFilename: file.name, attendees, attendeeEmails: attendeeEmails || [] });
      setTranscript(null);
      setView("processing");
      setShowNewForm(false);
      setNewJobCooldown(false);
      setFormFile(null); // the live File was consumed by this upload
      clearScope("newForm"); // don't restore a draft for the next job (rule 8b)
      // Polling starts automatically via useJobStatus when jobId changes
      notify(`"${title}" — transcription started`);
      window.electronAPI?.showNotification({
        title: "Transcription Started",
        body: `"${title}"`,
        type: "started",
        subtitle: title,
        clickPayload: { action: "view_results", jobId: result.job_id },
      });
    } catch (err: any) {
      notify(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setLoadingMessage(null);
    }
  };

  // Upload from a persisted file path (New form "remembered file" — no re-pick)
  const handleUploadByPath = async (params: {
    filePath: string;
    title: string;
    attendees: string[];
    emailRecipients?: string[];
    skipSteps?: string[];
    attendeeEmails?: string[];
  }) => {
    setUploading(true);
    setLoadingMessage("Uploading audio file…");
    try {
      const result: any = await api.uploadAudioByPath(params);
      const fileName = params.filePath.split(/[\\/]/).pop() || params.filePath;
      setJobId(result.job_id);
      setJobMetadata({
        title: params.title,
        originalFilename: fileName,
        attendees: params.attendees,
        attendeeEmails: params.attendeeEmails || [],
      });
      setTranscript(null);
      setView("processing");
      setShowNewForm(false);
      setNewJobCooldown(false);
      setFormFile(null); // no live File in the by-path flow — clear defensively
      clearScope("newForm"); // don't restore a draft for the next job (rule 8b)
      notify(`"${params.title}" — transcription started`);
      window.electronAPI?.showNotification({
        title: "Transcription Started",
        body: `"${params.title}"`,
        type: "started",
        subtitle: params.title,
        clickPayload: { action: "view_results", jobId: result.job_id },
      });
    } catch (err: any) {
      notify(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setLoadingMessage(null);
    }
  };

  // Cancel a running job — the "Stop Processing" button in the current view.
  // Target the job actually being displayed (historyJobId wins when the user
  // opened a running job from the history view), so the current view is always
  // a valid, reliable first point of cancellation.
  const handleCancel = useCallback(async () => {
    const targetJobId = historyJobId || jobId;
    if (!targetJobId) return;
    setCancelling(true);
    try {
      await api.cancelJob(targetJobId);
      statusHook.stopPolling();
      setView("results");
      // Immediately update statusData so the UI reflects cancellation instead
      // of showing the stale pre-cancel status (e.g. "processing_diarization").
      setStatusData({ status: "failed", error: "Cancelled by user", progress: 0.0 });
      setStageProgress({});
      notify("Processing cancelled");
      const cancelTitle = jobMetadata?.title || "Untitled Meeting";
      window.electronAPI?.showNotification({
        title: "Transcription Cancelled",
        body: `"${cancelTitle}" — processing was cancelled`,
        type: "error",
        subtitle: cancelTitle,
        clickPayload: { action: "view_results", jobId: targetJobId },
      });
    } catch (err: any) {
      notify(`Cancel failed: ${err.message}`);
    } finally {
      setCancelling(false);
    }
  }, [jobId, historyJobId, api, statusHook, jobMetadata]);

  // Cancel all foreign (bot-created) jobs
  const handleCancelForeign = useCallback(async () => {
    const ids = Array.from(foreignJobs.foreignJobIds);
    if (ids.length === 0) return;
    setCancellingForeign(true);
    let cancelledCount = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        await api.cancelJob(id);
        cancelledCount++;
      } catch {
        failCount++;
      }
    }
    if (cancelledCount > 0) notify(`Cancelled ${cancelledCount} bot job(s)`);
    if (failCount > 0) notify(`${failCount} bot job(s) failed to cancel`);
    setCancellingForeign(false);
  }, [foreignJobs.foreignJobIds, api]);

  // Load a past job from history — keeps history panel visible and shows results in the right column
  const loadHistoryJob = useCallback(
    async (jobId: string) => {
      setHistoryJobId(jobId);
      setShowHistory(true);
      setLoadingMessage("Loading job data…");
      try {
        const [transcriptData, summaryData, statusData] = await Promise.all([
          api.getTranscript(jobId),
          api.getSummary(jobId).catch(() => null),
          api.getStatus(jobId).catch(() => null),
        ]);
        if (transcriptData) {
          setHistoryTranscript({ ...transcriptData, summary: summaryData });
          // Store metadata from status if available (title, attendees, etc.)
          // Remap snake_case keys from Python backend → camelCase expected by ResultsViewer
          if (statusData?.metadata) {
            const meta = { ...statusData.metadata };
            if (meta.original_filename !== undefined && meta.originalFilename === undefined) {
              meta.originalFilename = meta.original_filename;
            }
            setJobMetadata(meta);
          }
          // Store status info for the Pipeline tab
          setHistoryJobStatus(
            statusData
              ? {
                  status: statusData.status,
                  progress: statusData.progress,
                  error: statusData.error,
                  started_at: statusData.started_at,
                  finished_at: statusData.finished_at,
                }
              : null,
          );
          setView("results");
        } else {
          notify("Transcript data unavailable for this job");
          setView("results");
        }
      } catch (err: any) {
        notify(`Failed to load job: ${err.message}`);
        setView("results");
      } finally {
        setLoadingMessage(null);
      }
    },
    [api],
  );

  // Start a new upload (reset everything about the CURRENT job only).
  // The History panel UI state (selected job + loaded data) is intentionally
  // preserved across a new-job switch — it is separate from the current job.
  const handleNew = () => {
    setView("upload");
    setJobId(null);
    setTranscript(null);
    setJobMetadata(null);
    setStatusData(null);
    setStageProgress({});
    // NOTE: deliberately do NOT clear formFile here. The live File is hoisted to App
    // state so it survives view switches; every path back to the New form (sidebar
    // New button, PipelineProgress onNewJob) runs handleNew, so clearing it here would
    // destroy the user's selected file and force submit down the path-based
    // upload_by_path fallback (stale path → backend 404 "File not found"). The file is
    // cleared on successful submit (handleUpload / handleUploadByPath) and via the
    // form's Remove / clearForm, which is the correct lifecycle.
    setShowHistory(false); // New form is its own mode — don't leave History "open"/highlighted
    statusHook.stopPolling();
  };

  // When storage data is cleared (Clear All Data / Clear All Jobs), reset the
  // Current + History panels so no stale job data remains visible, and force the
  // History list to refetch (it should now be empty).
  const handleStorageCleared = async () => {
    setView("upload");
    setJobId(null);
    setTranscript(null);
    setJobMetadata(null);
    setStatusData(null);
    setStageProgress({});
    setHistoryJobId(null);
    setHistoryTranscript(null);
    setHistoryJobStatus(null);
    statusHook.stopPolling();
    setHistoryRefreshTrigger((n) => n + 1);
  };

  return (
    <ServiceStatusProvider ollamaRequired={ollamaRequired}>
      <div className="app">
        <header className="app-header">
          <Tooltip content="Home — Transcription Agent desktop app">
            <h1>
              <Icon name="mic" size="24" color="accent" /> Transcription Agent
            </h1>
          </Tooltip>
          {isJobRunning && jobId && (
            <Tooltip content={`Job running — click to copy job ID`}>
              <span
                className="app-header-job-indicator app-header-job-indicator--clickable"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(jobId);
                    notify(`Job ID copied: ${jobId.slice(0, 8)}`);
                  } catch {
                    notify("Failed to copy job ID");
                  }
                }}>
                <span className="app-header-job-indicator-dot" />
                <span className="app-header-job-indicator-text">
                  Job Running
                  <span className="app-header-job-indicator-sep">·</span>
                  <span className="app-header-job-indicator-pct">{headerPct}%</span>
                  <span className="app-header-job-indicator-sep">·</span>
                  <span className="app-header-job-indicator-time">{formatElapsedHMS(headerElapsedMs)}</span>
                  <span className="app-header-job-indicator-sep">·</span>
                  <span className="app-header-job-indicator-title">{jobMetadata?.title || "Untitled Meeting"}</span>
                  <span className="app-header-job-indicator-sep">·</span>
                  <span className="app-header-job-indicator-id">{jobId}</span>
                </span>
              </span>
            </Tooltip>
          )}
        </header>

        {notification && (
          <div className="notification" onClick={() => setNotification(null)}>
            <span className="notification-text">{notification}</span>
            <Tooltip content="Dismiss this notification">
              <button
                className="notification-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotification(null);
                }}
                title="Dismiss this notification">
                <Icon name="close" size="14" />
              </button>
            </Tooltip>
          </div>
        )}

        {/* Speaker labeling modal — shown when pipeline pauses after diarization */}
        {showSpeakerModal && speakerClips && speakerClips.speakers && (
          <SpeakerLabelModal
            jobId={jobId!}
            speakers={speakerClips.speakers}
            suggestedEmails={jobMetadata?.attendeeEmails || []}
            nonSpeakingAttendees={speakerClips.non_speaking_attendees || []}
            knownAttendees={speakerClips.known_attendees}
            onConfirm={handleLabelConfirm}
            onCancel={handleLabelCancel}
            submitting={labelingSubmitting}
            error={labelingError}
            onClearError={() => {
              setLabelingError(null);
              setLabelingConflicts(null);
            }}
            postSubmitConflicts={labelingConflicts}
          />
        )}

        {/* Dev/Config warning modal */}
        {devWarningModal && (
          <div className="lm-overlay">
            <div
              style={{
                background: "var(--surface)",
                borderRadius: "var(--radius)",
                padding: 24,
                maxWidth: 420,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              }}>
              <Icon name="warning" size="48" color="orange" />
              <h3 style={{ margin: 0, color: "var(--text)", fontSize: "var(--fs-16)" }}>Developer Section</h3>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-13)", lineHeight: 1.5 }}>
                This section is for developers. Proceed with caution. Do you want to proceed?
              </p>
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button
                  className="dev-panel-btn"
                  onClick={() => {
                    sessionStorage.setItem("dev_warning_accepted", "true");
                    if (sidebarView === "storage") {
                      setDevAccessSignal((v) => v + 1);
                    } else {
                      setSidebarView(devWarningModal);
                    }
                    setDevWarningModal(null);
                  }}
                  style={{ padding: "8px 24px", fontWeight: 600 }}
                  title="Proceed to this section">
                  <Icon name="check_circle" size="16" color="green" /> Proceed
                </button>
                <button
                  className="dev-panel-btn"
                  onClick={() => {
                    setDevWarningModal(null);
                    if (sidebarView !== "storage") {
                      setSidebarView("current");
                    }
                  }}
                  style={{ padding: "8px 24px", fontWeight: 600 }}
                  title="Go back to the current job view">
                  <Icon name="cancel" size="16" color="red" /> Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Missing-config overlay — blocks other views when no API keys are configured */}
        {showConfigOverlay && (
          <div className="lm-overlay" style={{ zIndex: 900 }}>
            <div
              style={{
                background: "var(--surface)",
                borderRadius: "var(--radius)",
                padding: 32,
                maxWidth: 440,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              }}>
              <Icon name="info" size="48" color="accent" />
              <h3 style={{ margin: 0, color: "var(--text)", fontSize: "var(--fs-16)" }}>Configuration Required</h3>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-13)", lineHeight: 1.5 }}>
                This app requires API keys to function. Please configure your settings or import a configuration file from a previous install.
              </p>
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button
                  className="dev-panel-btn"
                  onClick={() => {
                    setSidebarView("config");
                    setShowConfigOverlay(false);
                  }}
                  style={{ padding: "8px 24px", fontWeight: 600 }}
                  title="Open the configuration panel to enter API keys">
                  <Icon name="settings" size="16" /> Open Settings
                </button>
                <button
                  className="config-io-btn config-io-btn--import-highlight"
                  onClick={async () => {
                    const result = await window.electronAPI?.importConfig();
                    if (result?.success) {
                      setShowConfigOverlay(false);
                      setSidebarView("config");
                      window.electronAPI?.checkConfig().then((r) => setConfigOk(r.ok));
                    }
                  }}
                  style={{ padding: "8px 24px", fontWeight: 600 }}
                  title="Import configuration from a previously exported JSON file">
                  <Icon name="download" size="16" /> Import Config
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Quit confirmation dialog */}
        {showQuitConfirm && (
          <div className="confirm-overlay" onClick={() => setShowQuitConfirm(false)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <h3 className="confirm-dialog-title">
                <Icon name="power_settings_new" size="16" color="orange" /> Quit Transcription Agent
              </h3>
              <p className="confirm-dialog-text">
                {isJobRunning ? "A meeting is currently being processed. Are you sure you want to quit?" : "Are you sure you want to quit the app?"}
              </p>
              <div className="confirm-dialog-actions">
                <button className="btn-secondary" onClick={() => setShowQuitConfirm(false)}>
                  Cancel
                </button>
                <button
                  className="btn-danger"
                  onClick={async () => {
                    setShowQuitConfirm(false);
                    await window.electronAPI?.quitApp();
                  }}>
                  Quit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global loading modal — covers everything during data fetches */}
        <LoadingModal visible={!!loadingMessage} message={loadingMessage || undefined} />

        <div className="app-body">
          <nav className="sidebar" ref={sidebarRef}>
            <div className="sidebar-resize-handle" onMouseDown={handleSidebarMouseDown} />
            <Tooltip
              content={
                isJobRunning
                  ? "A transcription job is in progress — start a new one after it finishes"
                  : "Start a new transcription — upload audio and configure meeting details"
              }
              position="right">
              <button
                className={`sidebar-btn ${showNewForm ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  handleNew();
                  setShowNewForm(true);
                  setSidebarView("current");
                }}
                disabled={isJobRunning}
                title={
                  isJobRunning
                    ? "A job is currently running — wait for it to finish"
                    : "Start a new transcription — upload audio and configure meeting details"
                }>
                <span className="sidebar-btn-icon">
                  <Icon name="add_circle" size="16" />
                </span>
                <span className="sidebar-btn-label">New</span>
              </button>
            </Tooltip>
            <Tooltip
              content={
                foreignJobs.hasForeignRunningJobs
                  ? "A bot job is running — click to see status"
                  : "View active or most recent job — pipeline progress, transcript, and results"
              }
              position="right">
              <button
                className={`sidebar-btn ${sidebarView === "current" && !showHistory && !showNewForm ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  setSidebarView("current");
                  setShowNewForm(false);
                  setShowHistory(false);
                  // Keep historyJobId — the selected history job persists across
                  // panel switches (rule 3b); it only renders while History is open.
                }}
                title="View active or most recent job — pipeline progress, transcript, and results">
                <span className="sidebar-btn-icon">
                  <Icon name="home" size="16" />
                  {foreignJobs.hasForeignRunningJobs && <span className="sidebar-badge sidebar-badge--pulsing" />}
                </span>
                <span className="sidebar-btn-label">Current</span>
              </button>
            </Tooltip>
            <Tooltip content="Browse past transcription jobs — reload or delete previous sessions" position="right">
              <button
                className={`sidebar-btn ${showHistory && sidebarView === "current" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  // Toggling History closed keeps the selection (rule 3b) — it
                  // only renders while History is open.
                  setSidebarView("current");
                  setShowNewForm(false);
                  setShowHistory((v) => !v);
                }}
                title="Browse past transcription jobs — reload or delete previous sessions">
                <span className="sidebar-btn-icon">
                  <Icon name="history" size="16" />
                </span>
                <span className="sidebar-btn-label">History</span>
              </button>
            </Tooltip>
            <Tooltip content="View disk usage breakdown — jobs, logs, databases, and models" position="right">
              <button
                className={`sidebar-btn ${sidebarView === "storage" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  setSidebarView("storage");
                  setShowNewForm(false);
                  setShowHistory(false);
                }}
                title="View disk usage breakdown — jobs, logs, databases, and models">
                <span className="sidebar-btn-icon">
                  <Icon name="storage" size="16" />
                </span>
                <span className="sidebar-btn-label">Storage</span>
              </button>
            </Tooltip>
            <Tooltip content="Developer tools — live logs, database browser, performance metrics, and updates" position="right">
              <button
                className={`sidebar-btn ${sidebarView === "dev" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  if (sessionStorage.getItem("dev_warning_accepted")) {
                    setSidebarView("dev");
                  } else {
                    setDevWarningModal("dev");
                  }
                  setShowNewForm(false);
                  setShowHistory(false);
                }}
                title="Developer tools — live logs, database browser, performance metrics, and updates">
                <span className="sidebar-btn-icon">
                  <Icon name="build" size="16" />
                </span>
                <span className="sidebar-btn-label">Dev</span>
              </button>
            </Tooltip>
            <Tooltip content="Configure API keys, LLM provider, delivery services, and agent pipeline settings" position="right">
              <button
                className={`sidebar-btn ${sidebarView === "config" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  if (sessionStorage.getItem("dev_warning_accepted")) {
                    setSidebarView("config");
                  } else {
                    setDevWarningModal("config");
                  }
                  setShowNewForm(false);
                  setShowHistory(false);
                  window.electronAPI?.getConfigWithSources();
                }}
                title="Configure API keys, LLM provider, delivery services, and agent pipeline settings">
                <span className="sidebar-btn-icon">
                  <Icon name="settings" size="16" />
                </span>
                <span className="sidebar-btn-label">Config</span>
                {!configOk && <span className="sidebar-badge" />}
              </button>
            </Tooltip>
            <Tooltip content="Customize theme, accent color, font size, and sidebar width" position="right">
              <button
                className={`sidebar-btn ${sidebarView === "appearance" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  setSidebarView("appearance");
                  setShowNewForm(false);
                  setShowHistory(false);
                }}
                title="Customize theme, accent color, font size, and sidebar width">
                <span className="sidebar-btn-icon">
                  <Icon name="palette" size="16" />
                </span>
                <span className="sidebar-btn-label">Appearance</span>
              </button>
            </Tooltip>
            <Tooltip content="App version, name, and README — learn about the Transcription Agent" position="right">
              <button
                className={`sidebar-btn ${sidebarView === "about" ? "sidebar-btn--active" : ""}`}
                onClick={() => {
                  setSidebarView("about");
                  setShowNewForm(false);
                  setShowHistory(false);
                }}
                title="App version, name, and README — learn about the Transcription Agent">
                <span className="sidebar-btn-icon">
                  <Icon name="info" size="16" />
                </span>
                <span className="sidebar-btn-label">About</span>
              </button>
            </Tooltip>

            {/* Spacer to push Quit to the bottom */}
            <div style={{ flex: 1 }} />

            <div className="sidebar-separator" />

            <Tooltip content="Quit the application — stops all background services" position="right">
              <button
                className="sidebar-btn sidebar-btn--quit"
                onClick={() => setShowQuitConfirm(true)}
                title="Quit the application — stops all background services">
                <span className="sidebar-btn-icon">
                  <Icon name="power_settings_new" size="16" />
                </span>
                <span className="sidebar-btn-label">Quit</span>
              </button>
            </Tooltip>
          </nav>

          <main className="app-main">
            {/* ── Dev view: always interactive (logs help debug startup) ── */}
            {sidebarView === "dev" && <DevPanel onClose={() => setSidebarView("current")} />}

            {/* ── Server status popover overlay ── */}
            {sidebarView !== "dev" && <ServerStatusBanner />}

            {/* ── Normal content (always visible behind popover) ── */}
            {sidebarView !== "dev" && (
              <>
                {sidebarView === "current" && (
                  <>
                    {showNewForm ? (
                      <div className="upload-panel-full">
                        <UploadPanel
                          file={formFile}
                          onFileChange={setFormFile}
                          onUpload={handleUpload}
                          onUploadByPath={handleUploadByPath}
                          uploading={uploading}
                          disabled={isJobRunning}
                          initialSkipSteps={defaultSkipSteps}
                        />
                      </div>
                    ) : (
                      <>
                        <div className={"left-col" + (leftColCollapsed && showHistory ? " left-col--collapsed" : "")} id="left-col">
                          {showHistory ? (
                            <HistoryPanel
                              onSelectJob={(jobId) => {
                                loadHistoryJob(jobId);
                              }}
                              collapsed={leftColCollapsed}
                              currentJobId={historyJobId || jobId}
                              onNotify={notify}
                              onStorageChanged={onStorageChanged}
                              historyRefreshTrigger={historyRefreshTrigger}
                              onToggleCollapse={() => setLeftColCollapsed((v) => !v)}
                              onJobDeleted={(deletedJobId) => {
                                if (deletedJobId === historyJobId) {
                                  setHistoryJobId(null);
                                  setHistoryTranscript(null);
                                  setHistoryJobStatus(null);
                                }
                                // If the deleted job is the one the Current view is showing,
                                // reset to a neutral state so no stale cancelled/failed panel
                                // lingers (and stop polling the now-gone job).
                                if (deletedJobId === jobId) {
                                  setView("upload");
                                  setJobId(null);
                                  setTranscript(null);
                                  setJobMetadata(null);
                                  setStatusData(null);
                                  setHistoryJobId(null);
                                  setHistoryTranscript(null);
                                  setHistoryJobStatus(null);
                                  setStageProgress({});
                                  statusHook.stopPolling();
                                  notify("Current job was deleted");
                                }
                                // Re-sync the History list from disk so a late write from
                                // an orphaned thread can't make the job reappear.
                                setHistoryRefreshTrigger((n) => n + 1);
                              }}
                            />
                          ) : (
                            <>
                              {(view === "processing" || view === "results") &&
                                statusData &&
                                !(foreignJobs.hasForeignRunningJobs && (statusHook.state === "complete" || statusHook.state === "error")) && (
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
                                      handleNew();
                                      setShowNewForm(true);
                                      setSidebarView("current");
                                    }}
                                    jobId={(showHistory && historyJobId) || jobId || undefined}
                                    startedAtMs={statusData?.started_at}
                                    finishedAtMs={statusData?.finished_at}
                                    stageProgress={stageProgress}
                                    onApproveGate1={handleGate1Approve}
                                    onRejectGate1={handleGate1Reject}
                                    onApproveGate2={handleGate2Approve}
                                    onRejectGate2={handleGate2Reject}
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

                              {!jobId &&
                                foreignJobs.hasForeignRunningJobs &&
                                (() => {
                                  const firstEntry = Array.from(foreignJobs.foreignJobsStatus.entries())[0];
                                  const [foreignJobId, foreignInfo] = firstEntry || [];
                                  if (!foreignInfo) return null;
                                  return (
                                    <PipelineProgress
                                      status={foreignInfo.status}
                                      progress={foreignInfo.progress}
                                      onCancel={handleCancelForeign}
                                      cancelling={cancellingForeign}
                                      diarizationAvailable={diarizationAvailable}
                                      isForeignJob={true}
                                      onNewJob={() => {
                                        handleNew();
                                        setShowNewForm(true);
                                        setSidebarView("current");
                                      }}
                                      jobId={foreignJobId}
                                    />
                                  );
                                })()}
                              {!jobId && !foreignJobs.hasForeignRunningJobs && (
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

                        {/* ── Left-col resize handle ── */}
                        <div className="left-col-resize-handle" onMouseDown={handleLeftColMouseDown} />

                        <div className="right-col">
                          {/* Show results for a history job (history panel visible in left column) */}
                          {showHistory && historyJobId && (
                            <ResultsViewer
                              stateScope="history"
                              key={"history-" + historyJobId}
                              jobId={historyJobId}
                              segments={historyTranscript?.transcript}
                              summary={historyTranscript?.summary}
                              metadata={jobMetadata}
                              jobStatus={historyJobStatus?.status}
                              jobProgress={historyJobStatus?.progress}
                              jobError={historyJobStatus?.error}
                              startedAtMs={historyJobStatus?.started_at}
                              finishedAtMs={historyJobStatus?.finished_at}
                              onSummaryUpdate={(updated) => setHistoryTranscript((prev: any) => (prev ? { ...prev, summary: updated } : prev))}
                            />
                          )}
                          {/* Processing placeholder — hidden when viewing history */}
                          {!showHistory && view === "processing" && (
                            <div className="panel transcript-panel">
                              <h2>Transcript</h2>
                              <p className="placeholder">
                                Your results will appear here automatically once processing is complete. You&#39;ll be able to browse the full
                                transcript, summary, and audio recording.
                              </p>
                            </div>
                          )}
                          {/* Live results from current upload — hidden when viewing history */}
                          {!showHistory && view === "results" && jobId && (
                            <ResultsViewer
                              stateScope="live"
                              key={"live-" + jobId}
                              jobId={jobId}
                              segments={transcript?.transcript}
                              summary={transcript?.summary}
                              metadata={jobMetadata}
                              jobStatus={statusData?.status}
                              jobProgress={statusData?.progress}
                              jobError={statusData?.error}
                              startedAtMs={statusData?.started_at}
                              finishedAtMs={statusData?.finished_at}
                              onSummaryUpdate={(updated) => setTranscript((prev: any) => (prev ? { ...prev, summary: updated } : prev))}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {sidebarView === "storage" && (
                  <StoragePanel
                    onClose={() => setSidebarView("current")}
                    onNotify={notify}
                    refreshTrigger={storageRefreshTrigger}
                    onDevAccessRequest={() => setDevWarningModal("storage")}
                    devAccessSignal={devAccessSignal}
                    onStorageCleared={handleStorageCleared}
                  />
                )}

                {sidebarView === "config" && (
                  <ConfigPanel
                    key="config-panel"
                    configOk={configOk}
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

        <StatusBar configOk={configOk} onOpenConfig={() => setSidebarView("config")} />
      </div>
    </ServiceStatusProvider>
  );
}
