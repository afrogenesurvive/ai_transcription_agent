/**
 * ServerStatusBanner — full-page interstitial shown in Current/New views
 * when backend services are not all running.
 *
 * Renders a clear status card for each offline service with a restart button,
 * plus a "Restart All" shortcut. Only the Dev view remains interactive when
 * this is shown — all other sidebar views redirect here.
 */

import React, { useState, useCallback } from "react";
import type { ServiceName, ServiceStatus } from "../hooks/useServerStatus";
import { SERVICES, SERVICE_LABELS } from "../hooks/useServerStatus";

interface Props {
  services: Record<ServiceName, ServiceStatus>;
  diarizationOk: boolean | null;
  diarizationError: string | null;
  checking: boolean;
  onCheckServers: () => void;
  onRestartService: (name: ServiceName) => Promise<boolean>;
  onRestartAll: () => Promise<boolean>;
}

const SERVICE_ICONS: Record<ServiceName, string> = {
  python: "🐍",
  bridge: "🌉",
  agent: "🤖",
};

export default function ServerStatusBanner({
  services,
  diarizationOk,
  diarizationError,
  checking,
  onCheckServers,
  onRestartService,
  onRestartAll,
}: Props) {
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});

  const handleRestartService = useCallback(
    async (name: ServiceName) => {
      setRestarting((prev) => ({ ...prev, [name]: true }));
      await onRestartService(name);
      setRestarting((prev) => ({ ...prev, [name]: false }));
    },
    [onRestartService],
  );

  const handleRestartAll = useCallback(async () => {
    setRestarting((prev) => ({ ...prev, _all: true }));
    await onRestartAll();
    setRestarting((prev) => ({ ...prev, _all: false }));
  }, [onRestartAll]);

  const offlineItems: { name: ServiceName; label: string; icon: string }[] = [];
  for (const svc of SERVICES) {
    if (services[svc] !== true) {
      offlineItems.push({ name: svc, label: SERVICE_LABELS[svc], icon: SERVICE_ICONS[svc] });
    }
  }
  // Diarization is a model check, not a server — show separately
  const diarizationOffline = diarizationOk === false;

  const anyBusy = Object.values(restarting).some(Boolean) || checking;

  return (
    <div className="ssb-container">
      <div className="ssb-card">
        <div className="ssb-header">
          <span className="ssb-icon">⚠️</span>
          <div>
            <h2 className="ssb-title">Services Not Ready</h2>
            <p className="ssb-subtitle">
              Some backend services are offline. Start or restart them below, or switch to the <strong>🛠️ Dev</strong> panel to view logs while
              waiting.
            </p>
          </div>
        </div>

        {/* Offline services list */}
        <div className="ssb-services">
          {offlineItems.map(({ name, label, icon }) => (
            <div key={name} className={`ssb-service ${services[name] === false ? "ssb-service--offline" : "ssb-service--unknown"}`}>
              <div className="ssb-service-info">
                <span className="ssb-service-icon">{icon}</span>
                <div>
                  <span className="ssb-service-name">{label}</span>
                  <span className="ssb-service-status">{services[name] === null ? "checking…" : "offline"}</span>
                </div>
              </div>
              <button
                className="ssb-restart-btn"
                onClick={() => handleRestartService(name)}
                disabled={anyBusy || services[name] === null}
                title={`Start ${label}`}>
                {restarting[name] ? "⟳ Starting…" : "▶ Start"}
              </button>
            </div>
          ))}

          {diarizationOffline && (
            <div className="ssb-service ssb-service--offline">
              <div className="ssb-service-info">
                <span className="ssb-service-icon">🧬</span>
                <div>
                  <span className="ssb-service-name">Diarization Model</span>
                  <span className="ssb-service-status">{diarizationError ? `unavailable — ${diarizationError.slice(0, 80)}` : "unavailable"}</span>
                </div>
              </div>
              <button className="ssb-restart-btn ssb-restart-btn--config" onClick={() => {}} title="Configure HF token">
                ⚙ Config
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="ssb-actions">
          <button className="ssb-btn ssb-btn--primary" onClick={handleRestartAll} disabled={anyBusy}>
            {restarting._all ? "⟳ Restarting All…" : "🔄 Restart All Services"}
          </button>
          <button className="ssb-btn ssb-btn--secondary" onClick={onCheckServers} disabled={anyBusy}>
            {checking ? "⟳ Checking…" : "↻ Re-check"}
          </button>
        </div>

        {/* Status summary at bottom */}
        <div className="ssb-footer">
          {SERVICES.map((svc) => (
            <span key={svc} className="ssb-footer-dot">
              <span
                className={`ssb-mini-dot ${services[svc] === true ? "ssb-mini-dot--ok" : services[svc] === false ? "ssb-mini-dot--err" : "ssb-mini-dot--unk"}`}
              />{" "}
              {SERVICE_LABELS[svc]}
            </span>
          ))}
          <span className="ssb-footer-dot">
            <span
              className={`ssb-mini-dot ${diarizationOk === true ? "ssb-mini-dot--ok" : diarizationOk === false ? "ssb-mini-dot--err" : "ssb-mini-dot--unk"}`}
            />{" "}
            Diarization
          </span>
        </div>
      </div>
    </div>
  );
}
