/**
 * PipelineProgress — visual pipeline progress tracker for non-technical users.
 *
 * Shows all stages of the transcription pipeline in a clear vertical stepper:
 *   check Completed stages (green checkmark)
 *   sync Current active stage (spinning animation)
 *   ○ Upcoming stages (dimmed)
 *   close Failed stage (red with error message)
 */

import React, { useState, useEffect } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import GateReviewModal from "./GateReviewModal";
import MiniLiveLog from "./MiniLiveLog";
import { formatElapsedHMS } from "../utils/timeFormat";
import {
  PIPELINE,
  findActiveStage,
  getStageState,
  getSubStepState,
  useMaxReachedStage,
  STATUS_FRIENDLY,
  WAITING_LABEL,
} from "./pipelineStages";

interface Props {
  status: string;
  progress: number;
  error?: string;
  /** Non-fatal error/titleError — shown as a warning banner while preserving the actual status for cancel button visibility */
  titleError?: string;
  /** Called when the user clicks "Stop Processing" */
  onCancel?: () => void;
  /** Whether a cancel is currently in progress */
  cancelling?: boolean;
  /** Whether the diarization model is available (for speaker labels) */
  diarizationAvailable?: boolean | null;
  /** Set of stage keys (e.g. "agent", "delivery") to show as skipped */
  skippedSteps?: Set<string>;
  /** Live per-stage % (diarization / transcription) from the logger — shown on the active step. */
  stageProgress?: { diarization?: number; transcription?: number };
  /** Called when the user clicks "New Job" after a failure */
  onNewJob?: () => void;
  /** Job ID — needed for gate panels to fetch transcript/summary/analysis data */
  jobId?: string;
  /** When true, shows a "Bot / Test Job" badge in the header */
  isForeignJob?: boolean;
  /** Job start time (epoch ms) — powers the cosmetic elapsed-time step. */
  startedAtMs?: number;
  /** Job end time (epoch ms) — present when the job reached a terminal state. */
  finishedAtMs?: number;
  /** Gate 1 (Raw Transcript Review) handlers */
  onApproveGate1?: (body: { action: string; editedTranscript?: any[] }) => Promise<void>;
  onRejectGate1?: (action: "cancel" | "retry") => Promise<void>;
  /** Gate 2 (Delivery Review) handlers */
  onApproveGate2?: (body: {
    action: string;
    editedTranscript?: any[];
    editedSummary?: any;
    editedAnalysis?: any;
    deliveryOptions?: { recipients?: string[]; destinations?: string[] };
    feedback?: string;
  }) => Promise<void>;
  onRejectGate2?: (action: "cancel" | "retry", feedback?: string) => Promise<void>;
}

export default function PipelineProgress({
  status,
  progress,
  error,
  titleError,
  onCancel,
  cancelling,
  diarizationAvailable,
  skippedSteps,
  stageProgress,
  onNewJob,
  jobId,
  onApproveGate1,
  onRejectGate1,
  onApproveGate2,
  onRejectGate2,
  isForeignJob,
  startedAtMs,
  finishedAtMs,
}: Props) {
  const [showConfirmCancel, setShowConfirmCancel] = useState(false);
  const pct = Math.round(progress * 100);
  const isFailed = status === "failed";
  const isComplete = ["delivered", "complete", "complete_with_warning"].includes(status);
  const isProcessing = !isFailed && !isComplete;

  const maxReached = useMaxReachedStage(status, isFailed, jobId);

  // ── Elapsed-time step (purely cosmetic — never affects status/progress) ──
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (typeof startedAtMs !== "number" || Number.isFinite(startedAtMs) === false) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);
  const hasTimeInfo = typeof startedAtMs === "number" && Number.isFinite(startedAtMs);
  const timeEndMs = typeof finishedAtMs === "number" && Number.isFinite(finishedAtMs) ? finishedAtMs : nowTick;
  const elapsedMs = hasTimeInfo ? timeEndMs - startedAtMs! : 0;
  const timeStepLive = hasTimeInfo && !isComplete && !isFailed;

  const active = findActiveStage(status);
  const activeLabel = active?.sub?.label ?? active?.stage?.label ?? STATUS_FRIENDLY[status] ?? status;
  const friendlyMessage = isFailed
    ? "Something went wrong"
    : status === "complete_with_warning"
      ? "Completed with warning"
      : isComplete
        ? "All done!"
        : active?.sub?.description ?? active?.stage?.description ?? STATUS_FRIENDLY[status] ?? "Processing...";

  return (
    <>
      <div className={`pp-container ${isFailed ? "pp-container--error" : ""} ${isComplete ? "pp-container--done" : ""}`}>
        {/* ── Header ── */}
        <div className="pp-header">
          <div className="pp-header-left">
            <h2 className="pp-title">
              <Icon
                name={isFailed ? "error" : isComplete ? "check_circle" : "sync"}
                color={isFailed ? "red" : isComplete ? "green" : "accent"}
                size="20"
              />{" "}
              {friendlyMessage}
              {isForeignJob && (
                <span className="pp-foreign-badge">
                  <Icon name="smart_toy" size="12" /> Bot / Test Job
                </span>
              )}
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
          {hasTimeInfo && (
            <>
              <div className="pp-step pp-step--time">
                <div className={`pp-step-dot pp-step-dot--time${timeStepLive ? " pp-step-dot--time-live" : ""}`}>
                  <Icon name="schedule" size="12" />
                </div>
                <div className="pp-step-content">
                  <span className="pp-step-icon">
                    <Icon name="schedule" size="14" />
                  </span>
                  <div className="pp-step-text">
                    <span className="pp-step-label">{timeStepLive ? "Elapsed Time" : "Total Time"}</span>
                    <span className="pp-step-desc">{timeStepLive ? "This job is still running" : "This job finished"}</span>
                  </div>
                  <span className="pp-time-value">{formatElapsedHMS(elapsedMs)}</span>
                </div>
              </div>
              <div className="pp-time-divider" />
            </>
          )}
          {PIPELINE.map((stage) => {
            const state = getStageState(stage, status, isFailed, isComplete, maxReached, skippedSteps);
            const waiting = state === "active" && WAITING_LABEL[status] != null;
            // Live per-stage % (diarization / transcription) from the logger, if any.
            const stagePct =
              stage.key === "diarization"
                ? stageProgress?.diarization
                : stage.key === "transcription"
                  ? stageProgress?.transcription
                  : undefined;
            return (
              <div key={stage.key} className={`pp-step pp-step--${state}${waiting ? " pp-step--waiting" : ""}`}>
                {/* Connector line */}
                <div className="pp-step-line" />

                {/* Status dot / icon */}
                <div className="pp-step-dot">
                  {state === "done" && (
                    <span className="pp-step-check">
                      <Icon name="check" size="12" />
                    </span>
                  )}
                  {state === "active" &&
                    (waiting ? <Icon name="schedule" size="12" /> : <span className="pp-step-spinner" />)}
                  {state === "error" && (
                    <span className="pp-step-error-icon">
                      <Icon name="close" size="12" />
                    </span>
                  )}
                  {state === "skipped" && (
                    <span className="pp-step-skipped-icon">
                      <Icon name="remove" size="12" />
                    </span>
                  )}
                  {state === "pending" && <span className="pp-step-pending-dot" />}
                </div>

                {/* Content */}
                <div className="pp-step-content">
                  <span className="pp-step-icon">
                    <Icon name={stage.icon} size="14" />
                  </span>
                  <div className="pp-step-text">
                    <span className="pp-step-label">{stage.label}</span>
                    <span className="pp-step-desc">{stage.description}</span>
                  </div>
                  {state === "active" && (
                    <span
                      className={`pp-step-active-badge${waiting ? " pp-step-active-badge--waiting" : ""}${
                        stagePct != null && !waiting ? " pp-step-active-badge--pct" : ""
                      }`}>
                      {stagePct != null && !waiting
                        ? `${stage.key === "diarization" && stagePct <= 1 ? stagePct.toFixed(2) : Math.round(stagePct)}%`
                        : WAITING_LABEL[status] ?? "In progress"}
                    </span>
                  )}
                  {state === "done" && <span className="pp-step-done-badge">Done</span>}
                  {state === "skipped" && <span className="pp-step-skipped-badge">Skipped</span>}
                </div>

                {/* Sub-steps (AI Processing phases) */}
                {stage.subSteps && (
                  <div className="pp-substeps">
                    {stage.subSteps.map((sub) => {
                      const subState = getSubStepState(stage, sub, status, isFailed, isComplete);
                      return (
                        <div key={sub.key} className={`pp-substep pp-substep--${subState}`}>
                          <div className="pp-substep-dot">
                            {subState === "done" && <Icon name="check" size="10" />}
                            {subState === "active" && <span className="pp-step-spinner" />}
                            {subState === "pending" && <span className="pp-step-pending-dot" />}
                          </div>
                          <div className="pp-substep-text">
                            <span className="pp-step-label">{sub.label}</span>
                            <span className="pp-step-desc">{sub.description}</span>
                          </div>
                          {subState === "active" && <span className="pp-step-active-badge">In progress</span>}
                          {subState === "done" && <span className="pp-step-done-badge">Done</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Gate Review Modal (overlay for Gate 1 & Gate 2) ── */}
        <GateReviewModal
          visible={status === "pending_raw_review" || status === "pending_delivery_review"}
          gate={status === "pending_raw_review" ? "gate1" : "gate2"}
          jobId={jobId}
          onApproveGate1={onApproveGate1}
          onRejectGate1={onRejectGate1}
          onApproveGate2={onApproveGate2}
          onRejectGate2={onRejectGate2}
        />

        {/* ── Diarization unavailable warning ── */}
        {diarizationAvailable === false && (
          <div className="pp-warning-box">
            <span className="pp-warning-icon">
              <Icon name="warning" color="orange" size="16" />
            </span>
            <div className="pp-warning-content">
              <strong>Speaker identification unavailable</strong>
              <p>
                Speech-to-text will still work, but the transcript won't have speaker names or labels. Set a <strong>Hugging Face Token</strong> in
                Config to enable speaker diarization.
              </p>
            </div>
          </div>
        )}

        {/* ── Non-fatal error banner (e.g. network timeout — backend may be down) ── */}
        {titleError && !isFailed && (
          <div className="pp-warning-box" style={{ borderColor: "var(--red)", marginBottom: 8 }}>
            <span className="pp-warning-icon">
              <Icon name="warning" color="red" size="16" />
            </span>
            <div className="pp-warning-content">
              <strong>Connection issue detected</strong>
              <p>{titleError}</p>
              <p style={{ fontSize: 12, marginTop: 4, color: "var(--text-muted)" }}>
                The backend may have gone down. You can try stopping this job and restarting services, or wait for automatic recovery.
              </p>
            </div>
          </div>
        )}

        {/* ── Stop button (during active processing) ── */}
        {isProcessing && onCancel && (
          <div className="pp-stop-row">
            <Tooltip content="Cancels the running job — partial results may still be available">
              <button
                className="pp-stop-btn"
                onClick={() => setShowConfirmCancel(true)}
                disabled={cancelling}
                title="Stop the current transcription job">
                {cancelling ? (
                  <>
                    <Icon name="hourglass_top" size="14" /> Stopping…
                  </>
                ) : (
                  <>
                    <Icon name="stop" size="14" /> Stop Processing
                  </>
                )}
              </button>
            </Tooltip>
            <span className="pp-stop-hint">Stops the pipeline and marks the job as cancelled.</span>
          </div>
        )}

        {/* ── Stop confirmation dialog ── */}
        {showConfirmCancel && (
          <div className="pp-confirm-overlay" onClick={() => setShowConfirmCancel(false)}>
            <div className="pp-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="pp-confirm-header">
                <Icon name="stop" size="16" color="red" /> Stop Processing?
              </div>
              <p className="pp-confirm-body">
                Are you sure you want to cancel this transcription job? The current progress will be lost and the job will be marked as cancelled.
                This cannot be undone.
              </p>
              <div className="pp-confirm-actions">
                <Tooltip content="Resume processing without cancelling">
                  <button className="pp-confirm-cancel-btn" onClick={() => setShowConfirmCancel(false)} title="Go back — do not cancel">
                    Continue Processing
                  </button>
                </Tooltip>
                <Tooltip content="Permanently cancel the transcription job">
                  <button
                    className="pp-confirm-stop-btn"
                    onClick={() => {
                      setShowConfirmCancel(false);
                      onCancel?.();
                    }}
                    title="Confirm — cancel this job permanently">
                    Yes, Stop It
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        )}

        {/* ── Error message ── */}
        {isFailed && error && (
          <div className="pp-error-box">
            <div className="pp-error-header">
              <Icon name="error" color="red" size="14" /> Something went wrong
            </div>
            <p className="pp-error-message">{error}</p>
            <p className="pp-error-hint">You can go back and try uploading again, or check the developer logs for details.</p>
            {onNewJob && (
              <Tooltip content="Clear the current failed job and start fresh">
                <button className="pp-new-job-btn" onClick={onNewJob} title="Start a new transcription job">
                  <Icon name="add_circle" size="14" /> New Job
                </button>
              </Tooltip>
            )}
          </div>
        )}

        {/* ── Complete message ── */}
        {isComplete && !isFailed && (
          <div className="pp-complete-box">
            <p>Your meeting has been fully processed! Use the tabs on the right to browse the results.</p>
          </div>
        )}
      </div>

      {/* ── Live logs ── */}
      <div className="pp-container pp-container--minilog">
        <MiniLiveLog />
      </div>
    </>
  );
}
