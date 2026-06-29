/**
 * Status Bar — shows individual Python, Bridge, and Agent status
 * with per-service stop/restart controls and a check-all button.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

type ServiceStatus = boolean | null; // null = unknown/checking
type FeedbackMsg = { text: string; type: "checking" | "success" | "error" } | null;
type BusyService = string | null; // which service is being acted on, or null

const SERVICES = ["python", "bridge", "agent"] as const;
type Service = (typeof SERVICES)[number];

const SERVICE_LABELS: Record<Service, string> = {
  python: "Python",
  bridge: "Bridge",
  agent: "Agent",
};

interface StatusBarProps {
  devPanelOpen: boolean;
  onToggleDevPanel: () => void;
  configOk: boolean;
  onOpenConfig: () => void;
}

export default function StatusBar({ devPanelOpen, onToggleDevPanel, configOk, onOpenConfig }: StatusBarProps) {
  const [status, setStatus] = useState<Record<Service, ServiceStatus>>({
    python: null,
    bridge: null,
    agent: null,
  });
  const [version, setVersion] = useState("1.0.0");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<BusyService>(null);
  const [feedback, setFeedback] = useState<FeedbackMsg>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allReady = SERVICES.every((s) => status[s]);
  const anyBusy = busy !== null;

  const showFeedback = (msg: FeedbackMsg, duration = 4000) => {
    setFeedback(msg);
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    if (msg) feedbackTimeoutRef.current = setTimeout(() => setFeedback(null), duration);
  };

  // Poll all services via IPC every 5 seconds
  const pollStatus = useCallback(async () => {
    if (window.electronAPI) {
      try {
        const s = await window.electronAPI.getBackendStatus();
        setStatus({ python: s.python, bridge: s.bridge, agent: s.agent });
      } catch {
        // IPC failed
      }
    } else {
      try {
        const res = await fetch("http://127.0.0.1:5010/health");
        setStatus((prev) => ({ ...prev, bridge: res.ok }));
      } catch {
        setStatus((prev) => ({ ...prev, bridge: false }));
      }
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  useEffect(() => {
    window.electronAPI
      ?.getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    };
  }, []);

  // ── Check all ──

  const handleCheckServers = useCallback(async () => {
    setChecking(true);
    setStatus({ python: null, bridge: null, agent: null });
    showFeedback({ text: "Checking…", type: "checking" });

    checkTimeoutRef.current = setTimeout(() => {
      setChecking(false);
      showFeedback({ text: "Check timed out — servers unreachable", type: "error" });
      pollStatus();
    }, 6000);

    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.checkServers();
        setStatus({ python: s.python, bridge: s.bridge, agent: s.agent });

        const parts: string[] = [];
        for (const svc of SERVICES) {
          parts.push(`${SERVICE_LABELS[svc]}: ${s[svc] ? "✓" : "✗"}`);
        }
        const ok = s.python && s.bridge && s.agent;
        showFeedback({ text: parts.join("  ·  "), type: ok ? "success" : "error" }, 5000);
      } else {
        try {
          const res = await fetch("http://127.0.0.1:5010/health");
          setStatus((prev) => ({ ...prev, bridge: res.ok }));
          showFeedback({ text: res.ok ? "Bridge: ✓" : "Bridge: ✗", type: res.ok ? "success" : "error" });
        } catch {
          setStatus((prev) => ({ ...prev, bridge: false }));
          showFeedback({ text: "Bridge: ✗ — unreachable", type: "error" });
        }
      }
    } catch {
      showFeedback({ text: "Check failed — unexpected error", type: "error" });
    } finally {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
        checkTimeoutRef.current = null;
      }
      setChecking(false);
    }
  }, [pollStatus]);

  // ── Per-service actions ──

  const handleStopService = useCallback(async (svc: Service) => {
    setBusy(svc);
    showFeedback({ text: `Stopping ${SERVICE_LABELS[svc]}…`, type: "checking" });
    try {
      if (window.electronAPI) {
        await window.electronAPI.stopService(svc);
        setStatus((prev) => ({ ...prev, [svc]: false }));
        showFeedback({ text: `${SERVICE_LABELS[svc]} stopped`, type: "error" });
      }
    } catch {
      showFeedback({ text: `Failed to stop ${SERVICE_LABELS[svc]}`, type: "error" });
    } finally {
      setBusy(null);
    }
  }, []);

  const handleRestartService = useCallback(
    async (svc: Service) => {
      setBusy(svc);
      showFeedback({ text: `Restarting ${SERVICE_LABELS[svc]}…`, type: "checking" });
      try {
        if (window.electronAPI) {
          await window.electronAPI.restartService(svc);
          showFeedback({ text: `${SERVICE_LABELS[svc]} restarted ✓`, type: "success" });
        }
      } catch {
        showFeedback({ text: `Failed to restart ${SERVICE_LABELS[svc]}`, type: "error" });
      } finally {
        setBusy(null);
        pollStatus();
      }
    },
    [pollStatus],
  );

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <div className="status-item-group">
          {SERVICES.map((svc) => (
            <span key={svc} className="status-item">
              <span className={`status-dot ${status[svc] === null ? "unknown" : status[svc] ? "online" : "offline"}`} />
              <span className="service-label">{SERVICE_LABELS[svc]}</span>
              <span className="service-actions">
                {status[svc] === true && (
                  <button
                    className="micro-btn stop-btn"
                    onClick={() => handleStopService(svc)}
                    disabled={anyBusy}
                    title={`Stop ${SERVICE_LABELS[svc]}`}>
                    ■
                  </button>
                )}
                {status[svc] === false && (
                  <button
                    className="micro-btn start-btn"
                    onClick={() => handleRestartService(svc)}
                    disabled={anyBusy}
                    title={`Start ${SERVICE_LABELS[svc]}`}>
                    ▶
                  </button>
                )}
                {status[svc] === true && (
                  <button
                    className="micro-btn restart-btn"
                    onClick={() => handleRestartService(svc)}
                    disabled={anyBusy}
                    title={`Restart ${SERVICE_LABELS[svc]}`}>
                    ↻
                  </button>
                )}
              </span>
            </span>
          ))}
        </div>

        {feedback && <span className={`status-feedback status-feedback--${feedback.type}`}>{feedback.text}</span>}

        <div className="status-actions">
          <button className="action-btn" onClick={handleCheckServers} disabled={checking || anyBusy} title="Check all servers">
            {checking ? "⟳ Checking…" : "↻ Check All"}
          </button>
          {!configOk && (
            <button className="action-btn config-warn-btn" onClick={onOpenConfig} title="API key required">
              ⚙️ Config
            </button>
          )}
          <button
            className={`action-btn dev-btn ${devPanelOpen ? "dev-btn--active" : ""}`}
            onClick={onToggleDevPanel}
            title="Toggle developer log panel">
            {devPanelOpen ? "Dev ✕" : "Dev"}
          </button>
        </div>
      </div>
      <span className="status-item version">v{version}</span>
    </div>
  );
}
