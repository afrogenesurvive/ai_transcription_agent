/**
 * LoadingModal — full-viewport overlay with a centered loading spinner.
 *
 * Mimics the ServerStatusBanner overlay pattern (fixed, dark backdrop,
 * centered card) but stays compact at 20vw × 20vh with just a spinner
 * and contextual message.
 */

import React from "react";
import Icon from "./Icon";

interface Props {
  /** Show or hide the modal */
  visible: boolean;
  /** Short message displayed below the spinner (e.g. "Loading job history…") */
  message?: string;
  /** Optional progress 0–100. When set, a progress bar replaces the spinner. */
  progress?: number | null;
  /** Optional cancel button (shown when provided) — e.g. "Cancel" for a download. */
  onCancel?: () => void;
  /** Label for the cancel button (default "Cancel"). */
  cancelLabel?: string;
}

export default function LoadingModal({ visible, message, progress, onCancel, cancelLabel = "Cancel" }: Props) {
  if (!visible) return null;

  const hasProgress = typeof progress === "number" && progress >= 0;

  return (
    <div className="lm-overlay">
      <div className="lm-card">
        {hasProgress ? (
          <div className="lm-progress-wrap">
            <div className="lm-progress-track">
              <div className="lm-progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
            </div>
            <span className="lm-progress-pct">{Math.round(progress)}%</span>
          </div>
        ) : (
          <span className="lm-spinner">
            <Icon name="sync" size="24" color="accent" />
          </span>
        )}
        {message && <p className="lm-message">{message}</p>}
        {onCancel && (
          <button className="config-update-status-btn" onClick={onCancel} type="button">
            <Icon name="close" size="14" /> {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
