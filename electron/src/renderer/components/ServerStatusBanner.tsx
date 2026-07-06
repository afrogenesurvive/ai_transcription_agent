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
  python: "🐍",
  bridge: "🌉",
  agent: "🤖",
  diarization: "🧬",
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

  // Countdown timer: 15 → 0, then trigger auto-check
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
      icon: "🦙",
    });
  }

  const anyBusy = Object.values(restarting).some(Boolean) || checking;

  if (!visible) return null;

  return (
    <div className="ssb-overlay">
      <div className="ssb-card ssb-card--popover">
        <div className="ssb-header">
          <span className="ssb-icon">⚠️</span>
          <div>
            <h2 className="ssb-title">Starting Backend Services</h2>
            <p className="ssb-subtitle">
              Some backend services are offline. Auto-checking server status in <strong>{countdown}s</strong>
              {!countdownActive && checking && " — checking now…"}
              {!countdownActive && !checking && " — check complete"}
            </p>
          </div>
        </div>

        {/* Offline services list */}
        <div className="ssb-services">
          {offlineItems.map((item) => {
            const isDiarization = item.name === "diarization";
            const isOllama = item.name === "ollama";
            const svcStatus = isDiarization ? diarizationOk : isOllama ? ollamaOk : services[item.name as ServiceName];
            return (
              <div key={item.name} className={`ssb-service ${svcStatus === false ? "ssb-service--offline" : "ssb-service--unknown"}`}>
                <div className="ssb-service-info">
                  <span className="ssb-service-icon">{item.icon}</span>
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
                  title={countdownActive ? `Auto-checking in ${countdown}s…` : isDiarization ? "Configure HF token" : `Start ${item.label}`}>
                  {isDiarization ? "⚙ Config" : restarting[item.name] ? "⟳ Starting…" : "▶ Start"}
                </button>
              </div>
            );
          })}
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
          <span className="ssb-footer-dot">
            <span
              className={`ssb-mini-dot ${ollamaOk === true ? "ssb-mini-dot--ok" : ollamaOk === false ? "ssb-mini-dot--err" : "ssb-mini-dot--unk"}`}
            />{" "}
            Ollama
          </span>
        </div>
      </div>
    </div>
  );
}
