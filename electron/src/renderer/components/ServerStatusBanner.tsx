/**
 * ServerStatusBanner — popover/dialog overlay shown when backend services
 * are not all running. Displays over the current view with a 20-second
 * countdown timer before auto-checking servers. Shows a spinner whose
 * progress is tied to the countdown, and a collapsible "Developer" details
 * section with the full service list and restart controls.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useServiceStatus, SERVICES, SERVICE_LABELS, type ServiceName } from "../hooks/serviceStatusContext";
import type { ConfigIntegrity } from "../types";
import Icon from "./Icon";

const SERVICE_ICONS: Record<string, string> = {
  python: "code",
  bridge: "link",
  agent: "smart_toy",
  diarization: "badge",
};

const COUNTDOWN_SECONDS = 25;

export default function ServerStatusBanner({
  onConfigImported,
  onLicenseActivated,
}: {
  onConfigImported?: () => void;
  onLicenseActivated?: () => void;
}) {
  const {
    services,
    diarizationOk,
    diarizationError,
    diarizationModel,
    diarizationStatus,
    diarizationProgress,
    ollamaOk,
    ollamaProvider,
    checking,
    allReady,
    checkServers: onCheckServers,
    restartService: onRestartService,
    restartAll: onRestartAll,
    startOllama: onStartOllama,
  } = useServiceStatus();
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [countdownActive, setCountdownActive] = useState(true);
  const [visible, setVisible] = useState(true);
  const [configMissing, setConfigMissing] = useState(false);
  // License state: on a fresh/unlicensed run the user cannot import config
  // (import is licensed-only), so the banner must guide them to Activate License.
  const [licensed, setLicensed] = useState<boolean | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // Inline license key entry (the banner overlay blocks About → License).
  const [licenseInput, setLicenseInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [licenseSuccess, setLicenseSuccess] = useState<string | null>(null);
  const [configIntegrity, setConfigIntegrity] = useState<ConfigIntegrity | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasTriggeredCheck = useRef(false);
  const initialMount = useRef(true);

  // Show "Import Config" only when the config is absent / malformed / invalid
  // (i.e. a first-run or broken-config situation), not on every setup screen.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.checkConfig().then((r) => {
      if (!cancelled) setConfigMissing(!r.ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load license state and re-poll while the banner is up, so activating a
  // license in About → License updates the banner without a restart. Stops
  // polling once a license is active.
  const licensedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      window.electronAPI?.getLicenseStatus().then((p) => {
        const isLicensed = p?.status?.status === "active";
        licensedRef.current = isLicensed;
        if (!cancelled) {
          setLicensed(isLicensed);
          setConfigIntegrity(p?.configIntegrity ?? null);
        }
      });
    };
    check();
    const id = setInterval(() => {
      if (licensedRef.current) {
        clearInterval(id);
        return;
      }
      check();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // When a license becomes active (user just activated in About → License),
  // re-check config + servers so the banner can clear without waiting for the
  // 25s countdown.
  const wasLicensedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (licensed === true && wasLicensedRef.current === false) {
      window.electronAPI?.checkConfig().then((r) => setConfigMissing(!r.ok));
      onCheckServers();
    }
    wasLicensedRef.current = licensed;
  }, [licensed, onCheckServers]);

  // Countdown timer: 25 → 0, then trigger auto-check.
  // The interval updater must be PURE — React invokes updater functions during
  // render, so no setState/side effects are allowed inside setCountdown(fn).
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
      setCountdown((prev) => Math.max(0, prev - 1)); // pure — just decrement
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [countdownActive, allReady, onCheckServers]);

  // When the countdown reaches 0, stop the timer and auto-check servers once.
  // Side effects live here (in an effect), never inside a state updater.
  useEffect(() => {
    if (countdown !== 0 || !countdownActive) return;
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdownActive(false);
    if (!hasTriggeredCheck.current) {
      hasTriggeredCheck.current = true;
      onCheckServers();
      window.electronAPI?.checkConfig().then((r) => setConfigMissing(!r.ok));
    }
  }, [countdown, countdownActive, onCheckServers]);

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

  // First-time setup: let the user pick an exported config file, which the
  // main process imports and then restarts all services (config:import).
  const handleImportConfig = useCallback(async () => {
    setRestarting((prev) => ({ ...prev, _import: true }));
    setBannerError(null);
    const result = await window.electronAPI?.importConfig();
    setRestarting((prev) => ({ ...prev, _import: false }));
    if (result?.success) {
      const cfg = await window.electronAPI?.checkConfig();
      setConfigMissing(!cfg?.ok);
      onCheckServers();
      onConfigImported?.();
    } else if (result?.error) {
      // Surface the failure (e.g. import blocked without a license) instead of
      // failing silently.
      setBannerError(result.error);
    }
  }, [onCheckServers, onConfigImported]);

  // Inline license activation (the banner overlay blocks About → License, so
  // the key entry lives here). Wired to the same license:activate IPC the
  // About → License tab uses.
  const handleActivateLicense = useCallback(async () => {
    const key = licenseInput.trim();
    if (!key || activating) return;
    setActivating(true);
    setBannerError(null);
    const res = await window.electronAPI?.activateLicense(key);
    setActivating(false);
    if (res?.success) {
      setLicenseInput("");
      setBannerError(null);
      setLicenseSuccess("License activated — services starting…");
      window.setTimeout(() => setLicenseSuccess(null), 4000);
      // Tell App to refresh its license state so the UI unlocks immediately
      // (gating is driven by App, not this banner).
      onLicenseActivated?.();
      // licensed state flips via the polling effect; refresh config + services
      // so the banner can clear.
      window.electronAPI?.checkConfig().then((r) => setConfigMissing(!r.ok));
      onCheckServers();
      onConfigImported?.();
    } else {
      setBannerError(licenseReasonText(res?.reason));
    }
  }, [licenseInput, activating, onLicenseActivated, onCheckServers, onConfigImported]);

  function licenseReasonText(reason?: string): string {
    const map: Record<string, string> = {
      malformed: "That doesn't look like a valid license key.",
      malformed_cert: "The key payload is unreadable.",
      app_mismatch: "This key was not issued for this application.",
      unknown_kid: "This key was signed by an unknown issuer.",
      revoked_kid: "This key's issuer has been revoked.",
      revoked_seat: "This license key has been revoked.",
      retired_kid: "This key's issuer has been retired — request a new key.",
      bad_signature: "The key signature is invalid.",
      bad_seat_key: "The key's seat key is unreadable.",
      key_mismatch: "The key doesn't match its seat certificate.",
      expired: "This license has expired — enter a new key.",
    };
    return reason ? map[reason] || `Invalid key (${reason}).` : "Unknown error.";
  }

  const handleCloseApp = useCallback(async () => {
    await window.electronAPI?.closeApp();
  }, []);

  // Dismiss the overlay so the user can reach the underlying UI (e.g. Config to
  // fix missing keys) even while services are down. Re-shows on next check/start.
  const handleDismiss = useCallback(() => setVisible(false), []);

  type ItemInfo = { name: string; label: string; icon: string; status: boolean | null };
  const allItems: ItemInfo[] = [];
  for (const svc of SERVICES) {
    allItems.push({ name: svc, label: SERVICE_LABELS[svc], icon: SERVICE_ICONS[svc], status: services[svc] });
  }
  allItems.push({
    name: "diarization",
    label: "Diarization Model",
    icon: SERVICE_ICONS.diarization,
    status: diarizationOk,
  });
  if (ollamaProvider) {
    allItems.push({
      name: "ollama",
      label: "Ollama Server",
      icon: "psychology",
      status: ollamaOk,
    });
  }

  const onlineCount = allItems.filter((it) => it.status === true).length;
  const offlineCount = allItems.length - onlineCount;

  const anyBusy = Object.values(restarting).some(Boolean) || checking;
  const countdownDone = countdown === 0 && !countdownActive && !allReady;

  if (!visible) return null;

  const progressPct = Math.round(((COUNTDOWN_SECONDS - countdown) / COUNTDOWN_SECONDS) * 100);
  // SVG circular progress: circumference = 2 * pi * r
  const r = 20;
  const circ = 2 * Math.PI * r;
  const offset = circ - (progressPct / 100) * circ;

  return (
    <div className="ssb-overlay">
      <div className="ssb-card ssb-card--popover">
        <button className="ssb-dismiss-btn" onClick={handleDismiss} title="Dismiss — continue using the app">
          <Icon name="close" size="14" />
        </button>
        {/* Spinner header with circular progress tied to countdown */}
        <div className="ssb-header ssb-header--center">
          <div className="ssb-spinner-wrap">
            <svg className={`ssb-spinner-ring ${countdownDone ? "ssb-spinner-ring--done" : ""}`} width="56" height="56" viewBox="0 0 56 56">
              <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
              {countdownDone ? (
                <circle
                  cx="28"
                  cy="28"
                  r={r}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={`${circ * 0.75} ${circ * 0.25}`}
                  style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
                />
              ) : (
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
              )}
            </svg>
            {!countdownDone && <span className="ssb-spinner-label">{progressPct}%</span>}
          </div>
          <div className="ssb-header-text">
            <h2 className="ssb-title">Setting Up&hellip;</h2>
            {configMissing && configIntegrity?.configGpg === "missing" && licensed === true && (
              <button
                className="ssb-import-config-btn"
                onClick={handleImportConfig}
                disabled={restarting._import}
                title="First install? Select a config file, then services restart automatically">
                <Icon name="download" size="14" /> Import Config
              </button>
            )}
            {configMissing && configIntegrity?.configGpg === "corrupt" && licensed === true && (
              <p className="ssb-license-hint">
                <Icon name="restore" size="12" /> A config file exists but can't be decrypted with this license — re-import it (Config &rarr; Import) or restore the backup (About &rarr; License).
              </p>
            )}
            {licensed === false && (
              <div className="ssb-license-entry">
                <input
                  className="ssb-license-input"
                  type="text"
                  placeholder="Paste your license key (TA1.…)"
                  value={licenseInput}
                  onChange={(e) => setLicenseInput(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button className="ssb-license-activate-btn" onClick={handleActivateLicense} disabled={activating || !licenseInput.trim()}>
                  <Icon name="key" size="14" /> {activating ? "Activating…" : "Activate"}
                </button>
              </div>
            )}
            {licensed === false && configIntegrity?.configGpg === "missing" && configIntegrity.backupExists && (
              <p className="ssb-license-hint">
                <Icon name="restore" size="12" /> A config backup was found — it will be restored after activation.
              </p>
            )}
            {licenseSuccess && <p className="ssb-license-success">{licenseSuccess}</p>}
            {bannerError && <p className="ssb-import-error">{bannerError}</p>}
            {countdownDone && (
              <div className="ssb-retry-actions">
                <button className="ssb-retry-btn" onClick={handleRestartAll} disabled={anyBusy}>
                  <Icon name="refresh" size="14" /> Retry
                </button>
                <button className="ssb-close-btn" onClick={handleCloseApp}>
                  <Icon name="close" size="14" /> Close App
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Collapsible details — service list, actions, status summary */}
        <details className="ssb-details">
          <summary className="ssb-details-summary">
            <Icon name="build" size="14" color="muted" />
            <span>Details</span>
            <span className="ssb-summary-dots">
              <span className="ssb-mini-dot ssb-mini-dot--on" /> {onlineCount} online
              <span className="ssb-mini-dot ssb-mini-dot--off" /> {offlineCount} offline
            </span>
          </summary>

          {/* All services list with status */}
          <div className="ssb-services">
            {allItems.map((item) => {
              const isDiarization = item.name === "diarization";
              const isOllama = item.name === "ollama";
              const isOnline = item.status === true;
              const isChecking = item.status === null;
              // First-run model fetch feedback: the backend reports a non-blocking
              // diarization status so the user sees the download (with % when known)
              // under the Diarization Model badge.
              const isDownloading = isDiarization && diarizationStatus === "downloading";
              const isLoading = isDiarization && diarizationStatus === "loading";
              const hasProgress = isDownloading && diarizationProgress != null;
              // When diarization fails due to HF auth/gating, link to the HF page so
              // the user can accept the model terms / grab a token. The fallback URL is
              // built from the actual model in use (diarizationModel), not hardcoded.
              // Only shown on a genuine error — never while downloading/loading.
              const fallbackHfUrl = `https://hf.co/${diarizationModel || "pyannote/speaker-diarization-3.1"}`;
              const gatedHfUrl =
                isDiarization && !isOnline && !isDownloading && !isLoading && diarizationError && /gated|access|token|terms/i.test(diarizationError)
                  ? (diarizationError.match(/https:\/\/hf\.co\/[^\s]+/) || [])[0] || fallbackHfUrl
                  : null;
              const statusText = isOnline
                ? "running"
                : isDiarization
                  ? isDownloading
                    ? hasProgress
                      ? `Downloading model… ${Math.round(diarizationProgress!)}%`
                      : "Downloading model… (first run, ~1.5 GB, may take a few minutes)"
                    : isLoading
                      ? "Loading model…"
                      : diarizationStatus === "checking" || diarizationStatus === "idle"
                        ? "checking…"
                        : diarizationError
                          ? `unavailable — ${diarizationError.slice(0, 80)}`
                          : "unavailable"
                  : isChecking
                    ? "checking…"
                    : isOllama
                      ? "not running"
                      : "offline";
              return (
                <div
                  key={item.name}
                  className={`ssb-service ${isOnline ? "ssb-service--online" : isChecking ? "ssb-service--unknown" : "ssb-service--offline"}`}>
                  <div className="ssb-service-info">
                    <span className="ssb-service-icon">
                      <Icon name={item.icon} size="18" color="accent" />
                    </span>
                    <div>
                      <span className="ssb-service-name">{item.label}</span>
                      <span className="ssb-service-status">{statusText}</span>
                      {isDiarization && isDownloading && hasProgress && (
                        <div className="ssb-dl-progress-wrap">
                          <div className="ssb-dl-progress" style={{ width: `${Math.min(100, Math.max(0, diarizationProgress!))}%` }} />
                        </div>
                      )}
                      {isDiarization && gatedHfUrl && (
                        <button
                          className="ssb-hf-link"
                          onClick={() => window.electronAPI?.openExternal(gatedHfUrl!)}
                          title="Open Hugging Face to accept the model terms / get a token">
                          <Icon name="open_in_new" size="13" /> Accept terms on Hugging Face
                        </button>
                      )}
                    </div>
                  </div>
                  {!isOnline && (
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
                      disabled={countdownActive || anyBusy || isChecking}
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
                  )}
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
                <span className={`ssb-mini-dot ${services[svc] === true ? "ssb-mini-dot--on" : "ssb-mini-dot--off"}`} /> {SERVICE_LABELS[svc]}
              </span>
            ))}
            <span className="ssb-footer-dot">
              <span className={`ssb-mini-dot ${diarizationOk === true ? "ssb-mini-dot--on" : "ssb-mini-dot--off"}`} /> Diarization
            </span>
            <span className="ssb-footer-dot">
              <span className={`ssb-mini-dot ${ollamaOk === true ? "ssb-mini-dot--on" : "ssb-mini-dot--off"}`} /> Ollama
            </span>
          </div>
        </details>
      </div>
    </div>
  );
}
