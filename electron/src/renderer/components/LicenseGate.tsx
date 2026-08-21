/**
 * LicenseGate — obscures (rather than hides) a licensed-only panel when the
 * app is in locked mode.
 *
 * Replaces the old "License Required" swap-out (which fully hid the panel)
 * with the same spirit as the New Job panel's disabled state: the real panel
 * stays rendered underneath, dimmed + blurred, with a licensing overlay + an
 * "Open About → License" action on top. About remains the only always-open view.
 */

import React from "react";
import Icon from "./Icon";

interface LicenseGateProps {
  /** True = locked: obscure the panel and show the licensing overlay. */
  locked: boolean;
  /** Navigate to About → License (called by the overlay button). */
  onOpenLicense: () => void;
  title?: string;
  message?: string;
  children: React.ReactNode;
}

const DEFAULT_MESSAGE =
  "This area is locked until a license is activated. You can fill in the New Job form, but job submission and the rest of the app are disabled without an active license.";

export default function LicenseGate({ locked, onOpenLicense, title = "License Required", message = DEFAULT_MESSAGE, children }: LicenseGateProps) {
  return (
    <div className={`license-gate ${locked ? "license-gate--locked" : ""}`}>
      <div className="license-gate__content" aria-hidden={locked}>
        {children}
      </div>
      {locked && (
        <div className="license-gate__overlay">
          <div className="license-gate__card">
            <h2>
              <Icon name="lock" size="18" color="accent" /> {title}
            </h2>
            <p>{message}</p>
            <button className="license-required-btn" onClick={onOpenLicense}>
              <Icon name="key" size="14" /> Open About → License
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
