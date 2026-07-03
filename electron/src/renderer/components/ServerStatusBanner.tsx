/**
 * ServerStatusBanner — popover/dialog overlay shown when backend services
 * are not all running. Displays over the current view with a 15-second
 * countdown timer before auto-checking servers. Shows restart buttons
 * only after the countdown completes.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ServiceName, ServiceStatus } from "../hooks/useServerStatus";
import { SERVICES, SERVICE_LABELS } from "../hooks/useServerStatus";

interface Props {
  services: Record<ServiceName, ServiceStatus>;
  diarizationOk: boolean | null;
  diarizationError: string | null;
  checking: boolean;
  allReady: boolean;
  onCheckServers: () => void;
  onRestartService: (name: ServiceName) => Promise<boolean>;
  onRestartAll: () => Promise<boolean>;
}

const SERVICE_ICONS: Record<ServiceName, string> = {
  python: "🐍",
  bridge: "🌉",
  agent: "🤖",
};

const COUNTDOWN_SECONDS = 15;

export default function ServerStatusBanner({
  services,
  diarizationOk,
  diarizationError,
  checking,
  allReady,
  onCheckServers,
  onRestartService,
  onRestartAll,
}: Props) {
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [countdownActive, setCountdownActive] = useState(true);
  const [visible, setVisible] = useState(true);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasTriggeredCheck = useRef(false);

  // Countdown timer: 15 → 0, then trigger auto-check
  useEffect(() => {
    if (!countdownActive) return;
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          countdownRef.current = null;
          setCountdownActive(false);
          // Trigger auto-check once
          if (!hasTriggeredCheck.current) {
            hasTriggeredCheck.current = true;
            onCheckServers();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [countdownActive, onCheckServers]);

  // When servers become all ready, close the popover
  useEffect(() => {
    if (allReady && !countdownActive) {
      // Small delay so the user sees the green state briefly
      const t = setTimeout(() => setVisible(false), 800);
      return () => clearTimeout(t);
    }
  }, [allReady, countdownActive]);

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
  const diarizationOffline = diarizationOk === false;

  const anyBusy = Object.values(restarting).some(Boolean) || checking;

  if (!visible) return null;

  return (
    <div className="ssb-overlay">
      <div className="ssb-card ssb-card--popover">
        <div className="ssb-header">
          <span className="ssb-icon">⚠️</span>
          <div>
            <h2 className="ssb-title">Services Not Ready</h2>
            <p className="ssb-subtitle">
              Some backend services are offline. Auto-checking server status in <strong>{countdown}s</strong>
              {!countdownActive && checking && " — checking now…"}
              {!countdownActive && !checking && " — check complete"}
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
                disabled={countdownActive || anyBusy || services[name] === null}
                title={countdownActive ? `Auto-checking in ${countdown}s…` : `Start ${label}`}>
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
              <button className="ssb-restart-btn ssb-restart-btn--config" disabled={countdownActive} onClick={() => {}} title="Configure HF token">
                ⚙ Config
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="ssb-actions">
          <button className="ssb-btn ssb-btn--primary" onClick={handleRestartAll} disabled={countdownActive || anyBusy}>
            {countdownActive ? `⏳ Wait ${countdown}s…` : restarting._all ? "⟳ Restarting All…" : "🔄 Restart All Services"}
          </button>
          <button className="ssb-btn ssb-btn--secondary" onClick={onCheckServers} disabled={countdownActive || anyBusy}>
            {countdownActive ? `⏳ ${countdown}s` : checking ? "⟳ Checking…" : "↻ Re-check"}
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
