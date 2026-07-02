/**
 * HistoryPanel — lists all past transcription jobs for browsing and re-loading.
 */

import React, { useState, useEffect, useCallback } from "react";

interface JobSummary {
  job_id: string;
  status: string;
  progress: number;
  error?: string | null;
  title: string;
  event_type: string;
  attendees: string[];
  has_transcript: boolean;
  mtime: number;
}

/* ── Pipeline stage definitions (mirrors ProgressPanel) ── */

interface StageDef {
  key: string;
  icon: string;
  label: string;
  matches: string[];
}

const PIPELINE_STAGES: StageDef[] = [
  { key: "uploaded", icon: "📤", label: "Uploading", matches: ["uploaded"] },
  { key: "initializing", icon: "🔧", label: "Getting Ready", matches: ["initializing"] },
  { key: "diarization", icon: "🔬", label: "Identifying Speakers", matches: ["processing_diarization"] },
  { key: "voiceprints", icon: "🧬", label: "Matching Voices", matches: ["matching_voiceprints"] },
  { key: "transcription", icon: "🎤", label: "Transcribing Speech", matches: ["processing_transcription"] },
  { key: "aligning", icon: "🔗", label: "Building Transcript", matches: ["aligning"] },
  {
    key: "agent",
    icon: "🤖",
    label: "AI Processing",
    matches: ["transcribed", "ready_for_agent", "labeling_needed", "refined", "summarized", "analyzed"],
  },
  { key: "delivery", icon: "📬", label: "Delivering Results", matches: ["delivered"] },
];

const COMPLETE_STATUSES = new Set(["delivered", "refined", "summarized", "analyzed"]);

function getStageState(stage: StageDef, jobStatus: string, isFailed: boolean, isComplete: boolean): "done" | "active" | "pending" | "error" {
  if (isFailed && stage.matches.includes(jobStatus)) return "error";
  if (isFailed) return "done";
  if (isComplete) return "done";
  if (stage.matches.includes(jobStatus)) return "active";
  const currentIdx = PIPELINE_STAGES.findIndex((s) => s.matches.includes(jobStatus));
  const stageIdx = PIPELINE_STAGES.findIndex((s) => s.key === stage.key);
  if (stageIdx < currentIdx) return "done";
  return "pending";
}

interface Props {
  onSelectJob: (jobId: string) => void;
  currentJobId: string | null;
  onNotify?: (message: string) => void;
  onStorageChanged?: () => void;
}

const STATUS_ICON: Record<string, string> = {
  uploaded: "📤",
  initializing: "🔧",
  processing_diarization: "🔬",
  matching_voiceprints: "🧬",
  processing_transcription: "🎤",
  aligning: "🔗",
  transcribed: "🤖",
  ready_for_agent: "🤖",
  labeling_needed: "🏷️",
  refined: "✅",
  summarized: "✅",
  analyzed: "✅",
  delivered: "📬",
  failed: "❌",
  corrupted: "⚠️",
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  initializing: "Initializing",
  processing_diarization: "Diarization",
  matching_voiceprints: "Voiceprint matching",
  processing_transcription: "Transcribing",
  aligning: "Aligning",
  transcribed: "Transcribed",
  ready_for_agent: "AI Processing",
  labeling_needed: "Needs labeling",
  refined: "Refined",
  summarized: "Summarized",
  analyzed: "Analyzed",
  delivered: "Delivered",
  failed: "Failed",
  corrupted: "Corrupted data",
};

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const BRIDGE_URL = "http://127.0.0.1:5010";

async function callBridge(tool: string, args: any = {}): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bridge error (${res.status}): ${err}`);
  }
  return res.json();
}

export default function HistoryPanel({ onSelectJob, currentJobId, onNotify, onStorageChanged }: Props) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callBridge("transcribe_history");
      setJobs(data.jobs || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleDelete = useCallback(
    async (jobId: string) => {
      setConfirmDelete(null);
      setDeleting(jobId);
      try {
        await callBridge("transcribe_delete_job", { jobId });
        setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
        onNotify?.(`🗑️ Job deleted`);
        onStorageChanged?.();
      } catch (err: any) {
        setError(`Failed to delete job: ${err.message}`);
        onNotify?.(`❌ Failed to delete job: ${err.message}`);
      } finally {
        setDeleting(null);
      }
    },
    [onNotify, onStorageChanged],
  );

  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <h2 className="history-panel-title">📋 History</h2>
        <button className="history-panel-refresh" onClick={loadHistory} title="Refresh">
          ↻
        </button>
      </div>

      {loading && <div className="history-panel-status">Loading...</div>}
      {error && <div className="history-panel-status history-panel-status--error">Error: {error}</div>}

      {!loading && !error && jobs.length === 0 && <div className="history-panel-status">No jobs yet. Upload an audio file to get started.</div>}

      <div className="history-panel-list">
        {jobs.map((job) => {
          const isFailed = job.status === "failed";
          const isComplete = COMPLETE_STATUSES.has(job.status);
          const isExpanded = expandedJob === job.job_id;
          return (
            <div key={job.job_id} className="history-panel-item-wrapper">
              <div
                className={`history-panel-item ${currentJobId === job.job_id ? "history-panel-item--active" : ""}`}
                onClick={() => {
                  setExpandedJob(isExpanded ? null : job.job_id);
                  onSelectJob(job.job_id);
                }}>
                <div className="history-panel-item-top">
                  <span className="history-panel-item-icon">{STATUS_ICON[job.status] || "📄"}</span>
                  <span className="history-panel-item-title">{job.title}</span>
                  <span className="history-panel-expand-icon">{isExpanded ? "▲" : "▼"}</span>
                </div>
                <div className="history-panel-item-meta">
                  <span className="history-panel-item-status">{STATUS_LABEL[job.status] || job.status}</span>
                  <span className="history-panel-item-date">{formatDate(job.mtime)}</span>
                </div>
                {job.attendees && job.attendees.length > 0 && <div className="history-panel-item-attendees">{job.attendees.join(", ")}</div>}
                {!job.has_transcript && job.status !== "failed" && <div className="history-panel-item-warning">No transcript data</div>}
              </div>

              {/* ── Expandable pipeline stage detail ── */}
              {isExpanded && (
                <div className="history-pipeline-detail">
                  <div className="history-pipeline-stepper">
                    {PIPELINE_STAGES.map((stage) => {
                      const state = getStageState(stage, job.status, isFailed, isComplete);
                      return (
                        <div key={stage.key} className={`hp-step hp-step--${state}`}>
                          <div className="hp-step-line" />
                          <div className="hp-step-dot">
                            {state === "done" && <span className="hp-step-check">✓</span>}
                            {state === "active" && <span className="hp-step-active-icon">●</span>}
                            {state === "error" && <span className="hp-step-error-icon">✕</span>}
                            {state === "pending" && <span className="hp-step-pending-dot" />}
                          </div>
                          <div className="hp-step-content">
                            <span className="hp-step-icon">{stage.icon}</span>
                            <span className="hp-step-label">{stage.label}</span>
                            {state === "done" && <span className="hp-step-badge hp-step-badge--done">Done</span>}
                            {state === "active" && <span className="hp-step-badge hp-step-badge--active">Active</span>}
                            {state === "error" && <span className="hp-step-badge hp-step-badge--error">Error</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {isFailed && job.error && <div className="history-pipeline-error">❌ {job.error}</div>}
                </div>
              )}
              <button
                className="history-panel-delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(job.job_id);
                }}
                disabled={deleting === job.job_id}
                title="Delete this job">
                {deleting === job.job_id ? "⏳" : "🗑️"}
              </button>

              {/* Confirmation dialog */}
              {confirmDelete === job.job_id && (
                <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
                  <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
                    <h3 className="confirm-dialog-title">Delete Job</h3>
                    <p className="confirm-dialog-text">
                      Are you sure you want to delete "<strong>{job.title}</strong>"?
                      <br />
                      This will permanently remove all associated data including transcript, summary, and audio.
                    </p>
                    <div className="confirm-dialog-actions">
                      <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                      <button className="btn-danger" onClick={() => handleDelete(job.job_id)} disabled={deleting === job.job_id}>
                        {deleting === job.job_id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
