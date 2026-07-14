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
}

export default function LoadingModal({ visible, message }: Props) {
  if (!visible) return null;

  return (
    <div className="lm-overlay">
      <div className="lm-card">
        <span className="lm-spinner">
          <Icon name="sync" size="24" color="accent" />
        </span>
        {message && <p className="lm-message">{message}</p>}
      </div>
    </div>
  );
}
