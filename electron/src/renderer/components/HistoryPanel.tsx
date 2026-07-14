/**
 * HistoryPanel — lists all past transcription jobs for browsing and re-loading.
 */

import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon";
import LoadingModal from "./LoadingModal";

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

interface Props {
  onSelectJob: (jobId: string) => void;
  currentJobId: string | null;
  onNotify?: (message: string) => void;
  onStorageChanged?: () => void;
}

const STATUS_ICON: Record<string, string> = {
  uploaded: "upload_file",
  initializing: "build",
  processing_diarization: "group",
  matching_voiceprints: "badge",
  processing_transcription: "mic",
  aligning: "link",
  transcribed: "smart_toy",
  ready_for_agent: "smart_toy",
  labeling_needed: "label",
  refined: "check_circle",
  summarized: "check_circle",
  analyzed: "check_circle",
  delivered: "mail",
  failed: "error",
  corrupted: "warning",
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
        onNotify?.(`Job deleted`);
        onStorageChanged?.();
      } catch (err: any) {
        setError(`Failed to delete job: ${err.message}`);
        onNotify?.(`Failed to delete job: ${err.message}`);
      } finally {
        setDeleting(null);
      }
    },
    [onNotify, onStorageChanged],
  );

  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <h2 className="history-panel-title">
          <Icon name="history" size="16" color="accent" /> History
        </h2>
        <div className="history-panel-tabs">
          <span className="history-panel-tab history-panel-tab--active">Jobs</span>
        </div>
        <button
          className="history-panel-refresh"
          onClick={loadHistory}
          title="Refresh the job history list"
          data-tooltip="Refresh the job history list — check for newly completed jobs">
          <Icon name="refresh" size="14" />
        </button>
      </div>

      <LoadingModal visible={loading} message="Loading job history…" />
      {error && <div className="history-panel-status history-panel-status--error">Error: {error}</div>}

      {!loading && !error && jobs.length === 0 && <div className="history-panel-status">No jobs yet. Upload an audio file to get started.</div>}

      <div className="history-panel-list">
        {jobs.map((job) => {
          return (
            <div key={job.job_id} className="history-panel-item-wrapper">
              <div
                className={`history-panel-item ${currentJobId === job.job_id ? "history-panel-item--active" : ""}`}
                onClick={() => {
                  onSelectJob(job.job_id);
                }}>
                <div className="history-panel-item-top">
                  <span className="history-panel-item-icon">
                    <Icon name={STATUS_ICON[job.status] || "description"} size="14" />
                  </span>
                  <span className="history-panel-item-title">{job.title}</span>
                </div>
                <div className="history-panel-item-meta">
                  <span className="history-panel-item-status">{STATUS_LABEL[job.status] || job.status}</span>
                  <span className="history-panel-item-date">{formatDate(job.mtime)}</span>
                </div>
                {job.attendees && job.attendees.length > 0 && <div className="history-panel-item-attendees">{job.attendees.join(", ")}</div>}
                {!job.has_transcript && job.status !== "failed" && <div className="history-panel-item-warning">No transcript data</div>}
              </div>
              <button
                className="history-panel-delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(job.job_id);
                }}
                disabled={deleting === job.job_id}
                title="Permanently delete this job and all its data"
                data-tooltip="Permanently delete this job — transcript, summary, audio, and all associated data">
                {deleting === job.job_id ? <Icon name="hourglass_top" size="14" color="accent" /> : <Icon name="delete" size="14" color="red" />}
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
                      <button
                        className="btn-secondary"
                        onClick={() => setConfirmDelete(null)}
                        title="Keep this job — do not delete"
                        data-tooltip="Cancel deletion and keep the job">
                        Cancel
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleDelete(job.job_id)}
                        disabled={deleting === job.job_id}
                        title="Confirm permanent deletion"
                        data-tooltip="Permanently delete this job — this cannot be undone">
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
