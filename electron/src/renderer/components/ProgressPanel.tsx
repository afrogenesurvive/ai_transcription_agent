/**
 * Progress Panel — shows pipeline stage progress and current status.
 */

import React from "react";

interface Props {
  status: string;
  progress: number;
  error?: string;
}

const STAGE_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  initializing: "Initializing",
  processing_diarization: "Speaker Diarization",
  matching_voiceprints: "Voiceprint Matching",
  processing_transcription: "Speech-to-Text",
  aligning: "Aligning Transcript",
  transcribed: "Transcription Complete",
  labeling_needed: "Speaker Labeling Needed",
  ready_for_agent: "Agent Processing",
  refined: "Refined",
  summarized: "Summarized",
  delivered: "Delivered",
  failed: "Failed",
};

export default function ProgressPanel({ status, progress, error }: Props) {
  const label = STAGE_LABELS[status] || status;
  const pct = Math.round(progress * 100);
  const isError = status === "failed";
  const isDone = ["delivered", "refined", "summarized"].includes(status);

  return (
    <div className={`panel progress-panel ${isError ? "error" : ""} ${isDone ? "done" : ""}`}>
      <h2>Processing Progress</h2>

      <div className="progress-bar-container">
        <div className={`progress-bar-fill ${isError ? "error" : ""}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="progress-info">
        <span className={`status-badge ${isError ? "error" : isDone ? "done" : "active"}`}>
          {isError ? "❌" : isDone ? "✅" : "🔄"} {label}
        </span>
        <span className="progress-pct">{pct}%</span>
      </div>

      {isError && error && (
        <div className="error-box">
          <strong>Error:</strong> {error}
        </div>
      )}
    </div>
  );
}
