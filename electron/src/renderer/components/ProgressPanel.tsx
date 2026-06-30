/**
 * PipelineProgress — visual pipeline progress tracker for non-technical users.
 *
 * Shows all stages of the transcription pipeline in a clear vertical stepper:
 *   ✅ Completed stages (green checkmark)
 *   🔄 Current active stage (spinning animation)
 *   ○ Upcoming stages (dimmed)
 *   ❌ Failed stage (red with error message)
 */

import React from "react";

interface Props {
  status: string;
  progress: number;
  error?: string;
}

/* ── Pipeline stages (non-technical friendly labels) ── */

interface StageDef {
  key: string;
  icon: string;
  label: string;
  description: string;
  /** One or more backend statuses that map to this stage */
  matches: string[];
}

const PIPELINE: StageDef[] = [
  {
    key: "uploaded",
    icon: "📤",
    label: "Uploading",
    description: "Receiving your audio file",
    matches: ["uploaded"],
  },
  {
    key: "initializing",
    icon: "🔧",
    label: "Getting Ready",
    description: "Preparing the transcription system",
    matches: ["initializing"],
  },
  {
    key: "diarization",
    icon: "🔬",
    label: "Identifying Speakers",
    description: "Detecting who speaks and when",
    matches: ["processing_diarization"],
  },
  {
    key: "voiceprints",
    icon: "🧬",
    label: "Matching Voices",
    description: "Matching voices to known attendees",
    matches: ["matching_voiceprints"],
  },
  {
    key: "transcription",
    icon: "🎤",
    label: "Transcribing Speech",
    description: "Converting speech to text",
    matches: ["processing_transcription"],
  },
  {
    key: "aligning",
    icon: "🔗",
    label: "Building Transcript",
    description: "Matching words to each speaker",
    matches: ["aligning"],
  },
  {
    key: "agent",
    icon: "🤖",
    label: "AI Processing",
    description: "Refining, summarizing & analyzing",
    matches: ["transcribed", "ready_for_agent", "labeling_needed", "refined", "summarized", "analyzed"],
  },
  {
    key: "delivery",
    icon: "📬",
    label: "Delivering Results",
    description: "Sending via email, Trello & Drive",
    matches: ["delivered"],
  },
];

/**
 * Determine the status of each pipeline stage based on the current backend status.
 * Returns: "done" | "active" | "pending" | "error"
 */
function getStageState(stage: StageDef, currentStatus: string, isFailed: boolean): "done" | "active" | "pending" | "error" {
  if (isFailed && stage.matches.includes(currentStatus)) return "error";
  if (isFailed) return "done"; // All previous stages succeeded
  if (stage.matches.includes(currentStatus)) return "active";
  // Check if this stage comes before or after the current one
  const currentIdx = PIPELINE.findIndex((s) => s.matches.includes(currentStatus));
  const stageIdx = PIPELINE.findIndex((s) => s.key === stage.key);
  if (stageIdx < currentIdx) return "done";
  return "pending";
}

export default function PipelineProgress({ status, progress, error }: Props) {
  const pct = Math.round(progress * 100);
  const isFailed = status === "failed";
  const isComplete = ["delivered", "refined", "summarized", "analyzed"].includes(status);

  const activeStage = PIPELINE.find((s) => s.matches.includes(status));
  const activeLabel = activeStage?.label || status;
  const friendlyMessage = isFailed ? "Something went wrong" : isComplete ? "All done!" : activeStage?.description || "Processing...";

  return (
    <div className={`pp-container ${isFailed ? "pp-container--error" : ""} ${isComplete ? "pp-container--done" : ""}`}>
      {/* ── Header ── */}
      <div className="pp-header">
        <div className="pp-header-left">
          <h2 className="pp-title">
            {isFailed ? "❌" : isComplete ? "✅" : "🔄"} {friendlyMessage}
          </h2>
          <span className="pp-stage-label">{activeLabel}</span>
        </div>
        <span className={`pp-pct ${isFailed ? "pp-pct--error" : ""}`}>{isFailed ? "Failed" : isComplete ? "100%" : `${pct}%`}</span>
      </div>

      {/* ── Progress bar ── */}
      <div className="pp-bar-track">
        <div
          className={`pp-bar-fill ${isFailed ? "pp-bar-fill--error" : ""} ${isComplete ? "pp-bar-fill--done" : ""}`}
          style={{ width: isComplete ? "100%" : `${pct}%` }}
        />
      </div>

      {/* ── Vertical pipeline stepper ── */}
      <div className="pp-stepper">
        {PIPELINE.map((stage) => {
          const state = getStageState(stage, status, isFailed);
          return (
            <div key={stage.key} className={`pp-step pp-step--${state}`}>
              {/* Connector line */}
              <div className="pp-step-line" />

              {/* Status dot / icon */}
              <div className="pp-step-dot">
                {state === "done" && <span className="pp-step-check">✓</span>}
                {state === "active" && <span className="pp-step-spinner" />}
                {state === "error" && <span className="pp-step-error-icon">✕</span>}
                {state === "pending" && <span className="pp-step-pending-dot" />}
              </div>

              {/* Content */}
              <div className="pp-step-content">
                <span className="pp-step-icon">{stage.icon}</span>
                <div className="pp-step-text">
                  <span className="pp-step-label">{stage.label}</span>
                  <span className="pp-step-desc">{stage.description}</span>
                </div>
                {state === "active" && <span className="pp-step-active-badge">In progress</span>}
                {state === "done" && <span className="pp-step-done-badge">Done</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Error message ── */}
      {isFailed && error && (
        <div className="pp-error-box">
          <div className="pp-error-header">❌ Something went wrong</div>
          <p className="pp-error-message">{error}</p>
          <p className="pp-error-hint">You can go back and try uploading again, or check the developer logs for details.</p>
        </div>
      )}

      {/* ── Complete message ── */}
      {isComplete && !isFailed && (
        <div className="pp-complete-box">
          <p>Your meeting has been fully processed! Use the tabs on the right to browse the results.</p>
        </div>
      )}
    </div>
  );
}
