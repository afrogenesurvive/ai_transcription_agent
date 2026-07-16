/**
 * Status Bar — shows individual Python, Bridge, and Agent status
 * with per-service stop/restart controls and a check-all button.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";

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
  configOk: boolean;
  onOpenConfig: () => void;
  onOpenDev: () => void;
}

export default function StatusBar({ configOk, onOpenConfig, onOpenDev }: StatusBarProps) {
  const [status, setStatus] = useState<Record<Service, ServiceStatus>>({
    python: null,
    bridge: null,
    agent: null,
  });
  const [diarizationOk, setDiarizationOk] = useState<boolean | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [ollamaProvider, setOllamaProvider] = useState(false);
  const [version, setVersion] = useState("1.0.0");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<BusyService>(null);
  const [feedback, setFeedback] = useState<FeedbackMsg>(null);
  const [ollamaStarting, setOllamaStarting] = useState(false);
  const [creditBalance, setCreditBalance] = useState<{ balance: string | null; error: string | null } | null>(null);
  const [creditPollInterval, setCreditPollInterval] = useState(60000);
  const [showCreditPopover, setShowCreditPopover] = useState(false);
  const creditBtnRef = useRef<HTMLButtonElement | null>(null);
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

  // Poll diarization model status
  const pollModels = useCallback(async () => {
    try {
      const res = await fetch("http://127.0.0.1:5010/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "transcribe_models_status", args: {} }),
      });
      if (res.ok) {
        const data = await res.json();
        setDiarizationOk(data.diarization_available);
        setDiarizationError(data.diarization_error);
      }
    } catch {
      // Backend not reachable
    }
  }, []);

  // Poll Ollama health
  const pollOllama = useCallback(async () => {
    try {
      const result = await window.electronAPI?.checkOllamaHealth();
      setOllamaOk(result?.healthy ?? false);
    } catch {
      setOllamaOk(false);
    }
  }, []);

  // Poll DeepSeek API credit balance
  const pollDeepSeekBalance = useCallback(async () => {
    try {
      const result = await window.electronAPI?.checkDeepSeekBalance();
      if (result) {
        setCreditBalance({ balance: result.balance, error: result.error });
      }
    } catch {
      // Silently ignore — the balance check is non-critical
    }
  }, []);

  // Check if LLM provider is Ollama
  const checkProvider = useCallback(async () => {
    try {
      const cfg = await window.electronAPI?.getConfig();
      setOllamaProvider(cfg?.LLM_PROVIDER === "ollama");
      // Also load credit poll interval from config
      const intervalVal = Number(cfg?.CREDIT_POLL_INTERVAL) || 60000;
      setCreditPollInterval(intervalVal);
    } catch {
      setOllamaProvider(false);
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  useEffect(() => {
    pollModels();
    const interval = setInterval(pollModels, 15000);
    return () => clearInterval(interval);
  }, [pollModels]);

  useEffect(() => {
    pollOllama();
    const interval = setInterval(pollOllama, 15000);
    return () => clearInterval(interval);
  }, [pollOllama]);

  useEffect(() => {
    pollDeepSeekBalance();
    const interval = setInterval(pollDeepSeekBalance, creditPollInterval);
    return () => clearInterval(interval);
  }, [pollDeepSeekBalance, creditPollInterval]);

  useEffect(() => {
    checkProvider();
    const interval = setInterval(checkProvider, 30000);
    return () => clearInterval(interval);
  }, [checkProvider]);

  useEffect(() => {
    window.electronAPI
      ?.getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Close credit popover on outside click
  useEffect(() => {
    if (!showCreditPopover) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (creditBtnRef.current && !creditBtnRef.current.contains(e.target as Node)) {
        setShowCreditPopover(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showCreditPopover]);

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
          parts.push(`${SERVICE_LABELS[svc]}: ${s[svc] ? "ok" : "err"}`);
        }
        const ok = s.python && s.bridge && s.agent;
        showFeedback({ text: parts.join("  ·  "), type: ok ? "success" : "error" }, 5000);
      } else {
        try {
          const res = await fetch("http://127.0.0.1:5010/health");
          setStatus((prev) => ({ ...prev, bridge: res.ok }));
          showFeedback({ text: res.ok ? "Bridge: ok" : "Bridge: err", type: res.ok ? "success" : "error" });
        } catch {
          setStatus((prev) => ({ ...prev, bridge: false }));
          showFeedback({ text: "Bridge: err — unreachable", type: "error" });
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

  // ── Force-start Ollama ──

  const handleStartOllama = useCallback(async () => {
    setOllamaStarting(true);
    showFeedback({ text: "Starting Ollama…", type: "checking" });
    try {
      const result = await window.electronAPI?.startOllamaServer();
      if (result?.success) {
        showFeedback({ text: "Ollama started ✓", type: "success" });
        await pollOllama();
      } else {
        showFeedback({ text: `Ollama start failed: ${result?.error || "unknown"}`, type: "error" });
      }
    } catch {
      showFeedback({ text: "Failed to start Ollama", type: "error" });
    } finally {
      setOllamaStarting(false);
    }
  }, [pollOllama]);

  // ── Force-stop Ollama ──

  const handleStopOllama = useCallback(async () => {
    setBusy("ollama");
    showFeedback({ text: "Stopping Ollama…", type: "checking" });
    try {
      const result = await window.electronAPI?.stopOllamaServer();
      if (result?.success) {
        setOllamaOk(false);
        showFeedback({ text: "Ollama stopped", type: "error" });
      } else {
        showFeedback({ text: "Ollama stop failed", type: "error" });
      }
    } catch {
      showFeedback({ text: "Failed to stop Ollama", type: "error" });
    } finally {
      setBusy(null);
    }
  }, []);

  // ── Restart Ollama ──

  const handleRestartOllama = useCallback(async () => {
    setBusy("ollama");
    showFeedback({ text: "Restarting Ollama…", type: "checking" });
    try {
      await window.electronAPI?.stopOllamaServer();
      setOllamaOk(false);
      const result = await window.electronAPI?.startOllamaServer();
      if (result?.success) {
        showFeedback({ text: "Ollama restarted ✓", type: "success" });
        await pollOllama();
      } else {
        showFeedback({ text: `Ollama restart failed: ${result?.error || "unknown"}`, type: "error" });
      }
    } catch {
      showFeedback({ text: "Failed to restart Ollama", type: "error" });
    } finally {
      setBusy(null);
    }
  }, [pollOllama]);

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
          {/* Config status */}
          <span className="status-item">
            <span className={`status-dot ${configOk ? "online" : "offline"}`} />
            <Tooltip content="Configuration status — whether API keys and LLM provider are set up">
              <span className="service-label">
                Config
              </span>
            </Tooltip>
            {!configOk ? (
              <>
                <button
                  className="micro-btn start-btn"
                  onClick={onOpenConfig}
                  disabled={anyBusy}
                  title="Open config to set up API key">
                  <Icon name="settings" size="12" />
                </button>
                <Tooltip content="LLM provider not configured — jobs will fail until you add your API key">
                  <span
                    className="config-warn-badge"
                    title="LLM provider not configured — jobs will fail">
                    <Icon name="warning" size="12" color="orange" />
                  </span>
                </Tooltip>
              </>
            ) : (
              <button
                className="micro-btn restart-btn"
                onClick={onOpenConfig}
                disabled={anyBusy}
                title="Open configuration settings">
                <Icon name="settings" size="12" />
              </button>
            )}
          </span>
          {/* Diarization model status */}
          <Tooltip content={diarizationError || "Status of the speaker diarization model — needed for speaker identification"}>
          <span
            className="status-item"
            title={diarizationError || "Speaker diarization model status"}>
            <span className={`status-dot ${diarizationOk === null ? "unknown" : diarizationOk ? "online" : "offline"}`} />
            <span className="service-label">Diarization</span>
            {diarizationOk === false && (
              <button
                className="micro-btn start-btn"
                onClick={onOpenConfig}
                disabled={anyBusy}
                title="Configure Hugging Face token for diarization">
                <Icon name="settings" size="12" />
              </button>
            )}
          </span>
          </Tooltip>
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
                    title={`Stop ${SERVICE_LABELS[svc]} backend service`}>
                    ■
                  </button>
                )}
                {status[svc] === false && (
                  <button
                    className="micro-btn start-btn"
                    onClick={() => handleRestartService(svc)}
                    disabled={anyBusy}
                    title={`Start ${SERVICE_LABELS[svc]} backend service`}>
                    <Icon name="play_arrow" size="12" />
                  </button>
                )}
                {status[svc] === true && (
                  <button
                    className="micro-btn restart-btn"
                    onClick={() => handleRestartService(svc)}
                    disabled={anyBusy}
                    title={`Restart ${SERVICE_LABELS[svc]} backend service`}>
                    <Icon name="refresh" size="12" />
                  </button>
                )}
              </span>
            </span>
          ))}
          {/* Ollama status — after agent */}
          <Tooltip content={ollamaProvider
                ? ollamaOk
                  ? "Ollama local LLM server is running"
                  : "Ollama server is offline — click ▶ to start"
                : "Ollama is not the active LLM provider — switch in Config"}>
          <span
            className="status-item"
            title={ollamaProvider ? (ollamaOk ? "Ollama server is running" : "Ollama server is offline") : "Ollama is not the active LLM provider"}
            style={{ opacity: ollamaProvider ? 1 : 0.4 }}>
            <span className={`status-dot ${ollamaOk === null ? "unknown" : ollamaOk ? "online" : "offline"}`} />
            <span className="service-label">Ollama</span>
            <span className="service-actions">
              {ollamaProvider && ollamaOk === true && (
                <button
                  className="micro-btn stop-btn"
                  onClick={handleStopOllama}
                  disabled={anyBusy}
                  title="Force-stop Ollama server">
                  <Icon name="stop" size="12" />
                </button>
              )}
              {ollamaProvider && ollamaOk === false && (
                <button
                  className="micro-btn start-btn"
                  onClick={handleStartOllama}
                  disabled={anyBusy || ollamaStarting}
                  title="Start Ollama server">
                  {ollamaStarting ? <Icon name="sync" size="12" /> : <Icon name="play_arrow" size="12" />}
                </button>
              )}
              {ollamaProvider && ollamaOk === true && (
                <button
                  className="micro-btn restart-btn"
                  onClick={handleRestartOllama}
                  disabled={anyBusy}
                  title="Restart Ollama server">
                  <Icon name="refresh" size="12" />
                </button>
              )}
            </span>
          </span>
          </Tooltip>
        </div>

        {feedback && <span className={`status-feedback status-feedback--${feedback.type}`}>{feedback.text}</span>}

        <div className="status-actions">
          <button
            className="action-btn"
            onClick={handleCheckServers}
            disabled={checking || anyBusy}
            title="Check all backend services">
            {checking ? (
              <>
                <Icon name="sync" size="12" /> Checking…
              </>
            ) : (
              <>
                <Icon name="refresh" size="12" /> Check All
              </>
            )}
          </button>
          {!configOk && (
            <button
              className="action-btn config-warn-btn"
              onClick={onOpenConfig}
              title="API key required — open config">
              <Icon name="settings" size="12" /> Config
            </button>
          )}
          <button
            className="action-btn dev-btn"
            onClick={onOpenDev}
            title="Open developer tools panel">
            <Icon name="build" size="12" /> Dev
          </button>
          <div className="credit-btn-wrapper">
            <button
              ref={creditBtnRef}
              className="action-btn credit-btn"
              onClick={() => {
                setShowCreditPopover((v) => !v);
                pollDeepSeekBalance();
              }}
              title="Check DeepSeek API credit balance">
              <Icon name="account_balance_wallet" size="14" color="accent" />
            </button>
            {showCreditPopover && (
              <div className="credit-popover">
                <div className="credit-popover-arrow" />
                {!creditBalance ? (
                  <span>Checking DeepSeek API credit…</span>
                ) : creditBalance.error ? (
                  <>
                    <span className="credit-popover-label">DeepSeek Credit</span>
                    <span className="credit-popover-error">{creditBalance.error}</span>
                  </>
                ) : (
                  <>
                    <span className="credit-popover-label">DeepSeek API Credit</span>
                    <span className="credit-popover-balance">${creditBalance.balance}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <span className="status-item version">v{version}</span>
    </div>
  );
}
