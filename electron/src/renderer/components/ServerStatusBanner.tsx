/**
 * ServerStatusBanner — popover/dialog overlay shown when backend services
 * are not all running. Displays over the current view with a 20-second
 * countdown timer before auto-checking servers. Shows a spinner whose
 * progress is tied to the countdown, and a collapsible "Developer" details
 * section with the full service list and restart controls.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ServiceName, ServiceStatus } from "../hooks/useServerStatus";
import { SERVICES, SERVICE_LABELS } from "../hooks/useServerStatus";
import Icon from "./Icon";

interface Props {
  services: Record<ServiceName, ServiceStatus>;
  diarizationOk: boolean | null;
  diarizationError: string | null;
  ollamaOk: boolean | null;
  ollamaRequired: boolean;
  checking: boolean;
  allReady: boolean;
  onCheckServers: () => void;
  onRestartService: (name: ServiceName) => Promise<boolean>;
  onRestartAll: () => Promise<boolean>;
  onStartOllama?: () => Promise<boolean>;
}

const SERVICE_ICONS: Record<string, string> = {
  python: "code",
  bridge: "link",
  agent: "smart_toy",
  diarization: "badge",
};

const COUNTDOWN_SECONDS = 20;

export default function ServerStatusBanner({
  services,
  diarizationOk,
  diarizationError,
  ollamaOk,
  ollamaRequired,
  checking,
  allReady,
  onCheckServers,
  onRestartService,
  onRestartAll,
  onStartOllama,
}: Props) {
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [countdownActive, setCountdownActive] = useState(true);
  const [visible, setVisible] = useState(true);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasTriggeredCheck = useRef(false);
  const initialMount = useRef(true);

  // Countdown timer: 20 → 0, then trigger auto-check
  // Skip the countdown entirely if everything is already ready on mount
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      if (allReady) {
        setVisible(false);
        setCountdownActive(false);
        return;
      }
    }
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

  // When servers become all ready, close the popover immediately
  // regardless of whether the countdown is still active
  useEffect(() => {
    if (allReady) {
      // Small delay so the user sees the green state briefly
      const t = setTimeout(() => setVisible(false), 800);
      return () => clearTimeout(t);
    }
  }, [allReady]);

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

  const offlineItems: { name: string; label: string; icon: string }[] = [];
  for (const svc of SERVICES) {
    if (services[svc] !== true) {
      offlineItems.push({ name: svc, label: SERVICE_LABELS[svc], icon: SERVICE_ICONS[svc] });
    }
  }
  if (diarizationOk !== true) {
    offlineItems.push({
      name: "diarization",
      label: "Diarization Model",
      icon: SERVICE_ICONS.diarization,
    });
  }
  if (ollamaRequired && ollamaOk !== true) {
    offlineItems.push({
      name: "ollama",
      label: "Ollama Server",
      icon: "psychology",
    });
  }

  const anyBusy = Object.values(restarting).some(Boolean) || checking;

  if (!visible) return null;

  const progressPct = Math.round(((COUNTDOWN_SECONDS - countdown) / COUNTDOWN_SECONDS) * 100);
  // SVG circular progress: circumference = 2 * pi * r
  const r = 20;
  const circ = 2 * Math.PI * r;
  const offset = circ - (progressPct / 100) * circ;

  return (
    <div className="ssb-overlay">
      <div className="ssb-card ssb-card--popover">
        {/* Spinner header with circular progress tied to countdown */}
        <div className="ssb-header ssb-header--center">
          <div className="ssb-spinner-wrap">
            <svg className="ssb-spinner-ring" width="56" height="56" viewBox="0 0 56 56">
              <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
              <circle
                cx="28"
                cy="28"
                r={r}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={offset}
                style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset 0.4s ease" }}
              />
            </svg>
            <span className="ssb-spinner-label">{progressPct}%</span>
          </div>
          <div>
            <h2 className="ssb-title">Setting Up&hellip;</h2>
          </div>
        </div>

        {/* Collapsible details — service list, actions, status summary */}
        <details className="ssb-details">
          <summary className="ssb-details-summary">
            <Icon name="build" size="14" color="muted" />
            <span>Details</span>
            <span className="ssb-details-count">{offlineItems.length} offline</span>
          </summary>

          {/* Offline services list */}
          <div className="ssb-services">
            {offlineItems.map((item) => {
              const isDiarization = item.name === "diarization";
              const isOllama = item.name === "ollama";
              const svcStatus = isDiarization ? diarizationOk : isOllama ? ollamaOk : services[item.name as ServiceName];
              return (
                <div key={item.name} className={`ssb-service ${svcStatus === false ? "ssb-service--offline" : "ssb-service--unknown"}`}>
                  <div className="ssb-service-info">
                    <span className="ssb-service-icon">
                      <Icon name={item.icon} size="18" color="accent" />
                    </span>
                    <div>
                      <span className="ssb-service-name">{item.label}</span>
                      <span className="ssb-service-status">
                        {svcStatus === null
                          ? "checking…"
                          : isDiarization
                            ? diarizationError
                              ? `unavailable — ${diarizationError.slice(0, 80)}`
                              : "unavailable"
                            : isOllama
                              ? "not running"
                              : "offline"}
                      </span>
                    </div>
                  </div>
                  <button
                    className={`ssb-restart-btn ${isDiarization ? "ssb-restart-btn--config" : isOllama ? "ssb-restart-btn--ollama" : ""}`}
                    onClick={() => {
                      if (isDiarization) {
                        window.electronAPI?.getConfigWithSources();
                      } else if (isOllama) {
                        onStartOllama?.();
                      } else {
                        handleRestartService(item.name as ServiceName);
                      }
                    }}
                    disabled={countdownActive || anyBusy || svcStatus === null}
                    title={
                      countdownActive
                        ? `Auto-checking in ${countdown}s…`
                        : isDiarization
                          ? "Open config to set Hugging Face token"
                          : `Start ${item.label}`
                    }
                    data-tooltip={
                      countdownActive
                        ? `Waiting ${countdown}s before auto-check`
                        : isDiarization
                          ? "Configure a Hugging Face token to enable speaker diarization"
                          : `Start the ${item.label} backend service`
                    }>
                    {isDiarization ? (
                      <>
                        <Icon name="settings" size="14" /> Config
                      </>
                    ) : restarting[item.name] ? (
                      <>
                        <Icon name="sync" size="14" /> Starting…
                      </>
                    ) : (
                      <>
                        <Icon name="play_arrow" size="14" /> Start
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <div className="ssb-actions">
            <button
              className="ssb-btn ssb-btn--primary"
              onClick={handleRestartAll}
              disabled={countdownActive || anyBusy}
              title="Restart all backend services"
              data-tooltip="Restart all backend services (Python, Bridge, Agent) at once">
              {countdownActive ? (
                <>
                  <Icon name="hourglass_top" size="14" /> Wait {countdown}s…
                </>
              ) : restarting._all ? (
                <>
                  <Icon name="sync" size="14" /> Restarting All…
                </>
              ) : (
                <>
                  <Icon name="refresh" size="14" /> Restart All Services
                </>
              )}
            </button>
            <button
              className="ssb-btn ssb-btn--secondary"
              onClick={onCheckServers}
              disabled={countdownActive || anyBusy}
              title="Check server status again"
              data-tooltip="Re-check the status of all backend services">
              {countdownActive ? (
                <>
                  <Icon name="hourglass_top" size="14" /> {countdown}s
                </>
              ) : checking ? (
                <>
                  <Icon name="sync" size="14" /> Checking…
                </>
              ) : (
                <>
                  <Icon name="refresh" size="14" /> Re-check
                </>
              )}
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
            <span className="ssb-footer-dot">
              <span
                className={`ssb-mini-dot ${ollamaOk === true ? "ssb-mini-dot--ok" : ollamaOk === false ? "ssb-mini-dot--err" : "ssb-mini-dot--unk"}`}
              />{" "}
              Ollama
            </span>
          </div>
        </details>
      </div>
    </div>
  );
}
