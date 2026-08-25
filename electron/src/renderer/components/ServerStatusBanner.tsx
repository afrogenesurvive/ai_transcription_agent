/**
 * ServerStatusBanner — popover/dialog overlay shown when backend services
 * are not all running. Displays over the current view with a 20-second
 * countdown timer before auto-checking servers. Shows a spinner whose
 * progress is tied to the countdown, and a collapsible "Developer" details
 * section with the full service list and restart controls.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useServiceStatus, SERVICES, SERVICE_LABELS, type ServiceName } from "../hooks/serviceStatusContext";
import type { ConfigIntegrity, LicenseStatus } from "../types";
import Icon from "./Icon";
import MiniLiveLog from "./MiniLiveLog";

const SERVICE_ICONS: Record<string, string> = {
  python: "code",
  bridge: "link",
  agent: "smart_toy",
  diarization: "badge",
};

const COUNTDOWN_SECONDS = 25;

// Loading shapes cycled the whole time the banner is loading — regardless of
// countdown percentage — one every shapeIntervalMs (default 5s), with the
// % counter overlaid in the center of the current shape.
const LOADING_SHAPES = ["diamond", "square", "triangle", "pentagon", "hexagon", "plus", "cross", "star"] as const;
type LoadingShape = (typeof LOADING_SHAPES)[number];
/** Default per-shape interval (ms) — overridable via LOADING_SHAPE_INTERVAL_MS. */
const DEFAULT_SHAPE_INTERVAL_MS = 5_000;

/** SVG points for a regular polygon with `sides` sides, centered at (cx, cy),
 *  radius r, first vertex at `startDeg` degrees (12 o'clock = -90). */
function polygonPoints(sides: number, cx: number, cy: number, r: number, startDeg = -90): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((startDeg + (i * 360) / sides) * Math.PI) / 180;
    points.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return points.join(" ");
}

/** Plus-sign outline: two crossing bars centered at (cx, cy), arm length r,
 *  bar thickness t. Traced as ONE concave polygon so it renders as a single
 *  <polygon> like every other shape (strokeLinejoin round keeps corners soft). */
function plusPoints(cx: number, cy: number, r: number, t: number): string {
  const h = t / 2;
  const pts: Array<[number, number]> = [
    [cx - h, cy - r],
    [cx + h, cy - r],
    [cx + h, cy - h],
    [cx + r, cy - h],
    [cx + r, cy + h],
    [cx + h, cy + h],
    [cx + h, cy + r],
    [cx - h, cy + r],
    [cx - h, cy + h],
    [cx - r, cy + h],
    [cx - r, cy - h],
    [cx - h, cy - h],
  ];
  return pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

/** Rotate a "x,y x,y …" point string by `deg` degrees about (cx, cy). */
function rotatePoints(points: string, cx: number, cy: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return points
    .split(" ")
    .map((p) => {
      const [xs, ys] = p.split(",");
      const x = parseFloat(xs) - cx;
      const y = parseFloat(ys) - cy;
      return `${(x * cos - y * sin + cx).toFixed(2)},${(x * sin + y * cos + cy).toFixed(2)}`;
    })
    .join(" ");
}

/** 5-pointed star outline centered at (cx, cy): outer radius r, inner radius r*innerRatio. */
function starPoints(cx: number, cy: number, r: number, innerRatio = 0.4): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * innerRatio;
    const a = ((-90 + (i * 360) / 10) * Math.PI) / 180;
    points.push(`${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`);
  }
  return points.join(" ");
}

/** Precomputed 56×56 SVG polygon points for each loading shape (center 28,28, r=22,
 *  sized to fill the ring area — larger, with the % counter overlaid in the center). */
const SHAPE_POINTS: Record<LoadingShape, string> = {
  diamond: polygonPoints(4, 28, 28, 22, -90), // pointy at N/E/S/W
  square: polygonPoints(4, 28, 28, 22, -45), // flat edges top/bottom
  triangle: polygonPoints(3, 28, 28, 22, -90), // point-up
  pentagon: polygonPoints(5, 28, 28, 22, -90),
  hexagon: polygonPoints(6, 28, 28, 22, -90),
  plus: plusPoints(28, 28, 22, 8), // two crossing bars
  cross: rotatePoints(plusPoints(28, 28, 22, 8), 28, 28, 45), // plus rotated 45° = X
  star: starPoints(28, 28, 22, 0.4), // 5-point star
};

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
    hfTokenConfigured,
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
  // Shape morphing: 0..n = which shape is showing; n+1 = sequence finished.
  // sequencePlaying is decoupled from the stuck state so the full shape run
  // plays out even if services come back up mid-way. Once services are ready
  // (allReady), the close effect stops the sequence early and dismisses.
  const [shapePhase, setShapePhase] = useState(0);
  const [sequencePlaying, setSequencePlaying] = useState(false);
  // Per-shape interval (ms) — from config LOADING_SHAPE_INTERVAL_MS, default 5s.
  const [shapeIntervalMs, setShapeIntervalMs] = useState(DEFAULT_SHAPE_INTERVAL_MS);
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
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasTriggeredCheck = useRef(false);
  const initialMount = useRef(true);

  // Setup is "incomplete" while unlicensed or config is blocking. While that
  // holds, the banner must NOT auto-close when services report all-ready (e.g.
  // mid key-switch) — it should stay open and return to step 1.
  const configBlocking = configMissing || hfTokenConfigured === false;
  const setupIncomplete = licensed === false || configBlocking;

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

  // Load the shape-switch interval from config (the main process folds in the
  // LOADING_SHAPE_INTERVAL_MS env var); falls back to the 5s default.
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      const v = Number.parseInt(cfg?.LOADING_SHAPE_INTERVAL_MS ?? "", 10);
      if (Number.isFinite(v) && v > 0) setShapeIntervalMs(v);
    });
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
          setLicenseStatus(p?.status ?? null);
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

  // When servers become all ready, close the popover promptly regardless of
  // whether the countdown is still active. BUT keep it open while setup is
  // incomplete (unlicensed or config blocking) — e.g. mid key-switch, so it
  // returns to step 1 (key entry) instead of closing. If services recover mid
  // shape-sequence, stop the loop early so the banner closes right away
  // instead of playing out the remaining shapes.
  useEffect(() => {
    if (allReady && !setupIncomplete) {
      if (sequencePlaying) {
        // Services are up — end the sequence now (the circle branch renders,
        // and the restart effect won't fire because countdownDone is false).
        setSequencePlaying(false);
        setShapePhase(LOADING_SHAPES.length);
        return;
      }
      // Small delay so the user sees the green state briefly
      const t = setTimeout(() => setVisible(false), 800);
      return () => clearTimeout(t);
    }
  }, [allReady, setupIncomplete, sequencePlaying]);

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
      // Step the banner forward immediately instead of waiting on the license
      // poll — the poll stops once a license is active, so in the switch-key
      // flow (deactivated + poll stopped) it would never advance past key entry.
      const p = await window.electronAPI?.getLicenseStatus();
      const isLicensed = p?.status?.status === "active";
      licensedRef.current = isLicensed;
      setLicensed(isLicensed);
      setLicenseStatus(p?.status ?? null);
      setConfigIntegrity(p?.configIntegrity ?? null);
      // Tell App to refresh its license state so the UI unlocks immediately
      // (gating is driven by App, not this banner).
      onLicenseActivated?.();
      // refresh config + services so the banner can clear.
      window.electronAPI?.checkConfig().then((r) => setConfigMissing(!r.ok));
      onCheckServers();
      onConfigImported?.();
      // No auto-open here — the Import Config button (step 2) is shown and the
      // user clicks it manually.
    } else {
      setBannerError(licenseReasonText(res?.reason));
    }
  }, [licenseInput, activating, onLicenseActivated, onCheckServers, onConfigImported]);

  // If the key activated in step 1 can't decrypt the imported config, let the
  // user drop back to key entry: deactivate the current key, clear banner
  // state, and re-show the license input so they can enter the matching key.
  // Deactivation is safe/reversible (the encrypted config stays readable on
  // reactivation). `licensed` flips back via the banner's license poll.
  const handleSwitchKey = useCallback(async () => {
    await window.electronAPI?.deactivateLicense();
    licensedRef.current = false;
    setLicenseInput("");
    setBannerError(null);
    setLicenseSuccess(null);
    // Stay on step 1 (key entry): keep the banner open, reset the countdown so
    // the auto-close/retry UI doesn't fire, and reflect the now-unlicensed state
    // immediately (the poll would otherwise lag ~3s).
    setVisible(true);
    setCountdownActive(true);
    setCountdown(COUNTDOWN_SECONDS);
    const p = await window.electronAPI?.getLicenseStatus();
    setLicensed(p?.status?.status === "active");
    setLicenseStatus(p?.status ?? null);
    setConfigIntegrity(p?.configIntegrity ?? null);
    onLicenseActivated?.();
    window.electronAPI?.checkConfig().then((r) => setConfigMissing(!r.ok));
    onCheckServers();
  }, [onLicenseActivated, onCheckServers]);

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
  // "Loading" = the banner can't close yet: services not all ready, or setup
  // still incomplete (unlicensed / config blocking). While loading, the shape
  // sequence runs — shapes change regardless of the countdown percentage.
  const loading = !allReady || setupIncomplete;

  // Keep the shape sequence playing for the whole time the banner is loading;
  // stop it once loading ends (the close effect then dismisses the banner).
  useEffect(() => {
    if (loading && !sequencePlaying) {
      setShapePhase(0);
      setSequencePlaying(true);
    } else if (!loading && sequencePlaying) {
      setSequencePlaying(false);
    }
  }, [loading, sequencePlaying]);

  // Advance one shape every shapeIntervalMs, wrapping around so the sequence
  // cycles continuously.
  useEffect(() => {
    if (!sequencePlaying) return;
    const id = setInterval(() => {
      setShapePhase((prev) => (prev + 1) % LOADING_SHAPES.length);
    }, shapeIntervalMs);
    return () => clearInterval(id);
  }, [sequencePlaying, shapeIntervalMs]);

  if (!visible) return null;

  const progressPct = Math.round(((COUNTDOWN_SECONDS - countdown) / COUNTDOWN_SECONDS) * 100);

  return (
    <div className="ssb-overlay">
      <div className="ssb-card ssb-card--popover">
        <button className="ssb-dismiss-btn" onClick={handleDismiss} title="Dismiss — continue using the app">
          <Icon name="close" size="14" />
        </button>
        {/* Spinner header with circular progress tied to countdown */}
        <div className="ssb-header ssb-header--center">
          <div className="ssb-spinner-wrap">
            <svg className="ssb-spinner-ring" width="56" height="56" viewBox="0 0 56 56">
              {/* Loading shape — cycles through every shapeIntervalMs regardless of
                  the countdown percentage. The <g> spins + glows; the polygon handles
                  the per-shape entry fade (remounted via the key on the <g>). */}
              <g key={LOADING_SHAPES[shapePhase % LOADING_SHAPES.length]} className="ssb-shape-spin">
                <polygon
                  className="ssb-shape"
                  points={SHAPE_POINTS[LOADING_SHAPES[shapePhase % LOADING_SHAPES.length]]}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="4"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            </svg>
            {loading && <span className="ssb-spinner-label">{progressPct}%</span>}
          </div>
          <div className="ssb-header-text">
            <h2 className="ssb-title">Setting Up&hellip;</h2>
            {(licensed !== true || configBlocking) && (
              <div className="ssb-steps" role="list" aria-label="Setup steps">
                <div className={`ssb-step ${licensed === true ? "ssb-step--done" : "ssb-step--active"}`} role="listitem">
                  <span className="ssb-step-dot">{licensed === true ? <Icon name="check" size="12" /> : "1"}</span>
                  <span className="ssb-step-label">Activate License</span>
                </div>
                <span className="ssb-step-connector" />
                <div className={`ssb-step ${!configBlocking ? "ssb-step--done" : licensed === true ? "ssb-step--active" : ""}`} role="listitem">
                  <span className="ssb-step-dot">{!configBlocking ? <Icon name="check" size="12" /> : "2"}</span>
                  <span className="ssb-step-label">Import Config</span>
                </div>
              </div>
            )}
            {licensed === true && configBlocking && configIntegrity?.configGpg === "corrupt" && (
              <div className="ssb-license-corrupt">
                <p className="ssb-license-hint">
                  <Icon name="restore" size="12" /> A config file exists but can't be decrypted with this license. Re-import a plaintext .json export
                  — a .gpg encrypted with a different license key won't decrypt here.
                </p>
                <button className="ssb-import-config-btn" onClick={handleImportConfig} disabled={restarting._import}>
                  <Icon name="download" size="14" /> Re-import Config
                </button>
              </div>
            )}
            {licensed === true && configBlocking && configIntegrity?.configGpg !== "corrupt" && (
              <div className="ssb-import-callout">
                <p className="ssb-license-hint">
                  <Icon name="info" size="12" />{" "}
                  {hfTokenConfigured === false && !configMissing
                    ? "A configuration file is needed to enable speaker diarization — a Hugging Face token is missing."
                    : "Import a configuration file to finish setup and start the model services."}
                </p>
                <button
                  className="ssb-import-config-btn ssb-import-config-btn--primary"
                  onClick={handleImportConfig}
                  disabled={restarting._import}
                  title="First install? Select a config file, then services restart automatically">
                  <Icon name="download" size="14" /> {restarting._import ? "Importing…" : "Import Config"}
                </button>
              </div>
            )}
            {licensed === true && configBlocking && (
              <button
                className="ssb-switch-key-btn"
                onClick={handleSwitchKey}
                title="Deactivate the current key and enter a different one that matches the config's encryption">
                Encrypted with a different key? Use a different license key
              </button>
            )}
            {licensed === false && (
              <>
                {(licenseStatus?.status === "invalid" || licenseStatus?.status === "expired") && (
                  <p className="ssb-license-hint">
                    <Icon name="warning" size="12" />{" "}
                    {licenseStatus.status === "expired"
                      ? "This license has expired — enter a new key."
                      : `${licenseReasonText(licenseStatus.reason)} — enter a new key.`}
                  </p>
                )}
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
              </>
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
              const isAgent = item.name === "agent";
              const isOnline = item.status === true;
              const isChecking = item.status === null;
              // First-run: don't paint the model services as "failed" while the
              // user still needs to import config — show a neutral pending state
              // instead of a red offline row (no dead-end impression).
              const waitingForConfig = isDiarization ? configBlocking : isAgent ? configMissing : false;
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
                : waitingForConfig
                  ? "waiting for configuration"
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
                  className={`ssb-service ${
                    waitingForConfig
                      ? "ssb-service--pending"
                      : isOnline
                        ? "ssb-service--online"
                        : isChecking
                          ? "ssb-service--unknown"
                          : "ssb-service--offline"
                  }`}>
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
                  {!isOnline && !waitingForConfig && (
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

          {/* Small collapsible live log, collapsed by default (mirrors the pipeline stepper's MiniLiveLog) */}
          <div className="ssb-mini-log">
            <MiniLiveLog maxLines={6} stateKey="serverStatus.liveLogExpanded" defaultCollapsed />
          </div>
        </details>
      </div>
    </div>
  );
}
