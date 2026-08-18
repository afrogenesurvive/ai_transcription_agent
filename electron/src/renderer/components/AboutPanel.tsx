/**
 * About Panel — tabbed view with About info, a searchable End User Guide,
 * and a License tab (activate / deactivate / re-key a per-seat license).
 *
 * Tabs:
 *   "about"   — app name, version, and README content
 *   "guide"   — formatted end-user guide with search and section navigation
 *   "license" — license key entry + status
 */

import React, { useEffect, useState, useMemo, useCallback } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import DocViewer from "./DocViewer";
import { useUiStateValue } from "../hooks/useUiState";
import { renderMarkdown } from "../utils/markdown";
import type { LicenseStatus, ConfigIntegrity } from "../types";

type AboutTab = "about" | "guide" | "license";

export default function AboutPanel({ onClose, onLicensedChange }: { onClose: () => void; onLicensedChange?: () => void }) {
  // Persisted About tab selection (rule 7a)
  const [activeTab, setActiveTab] = useUiStateValue<AboutTab>("about.tab", "about");
  const [appName, setAppName] = useState("Transcription Agent");
  const [version, setVersion] = useState("");
  const [readme, setReadme] = useState("");
  const [guideMd, setGuideMd] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.getAppVersion().catch(() => "1.0.0"),
      window.electronAPI?.getAppName().catch(() => "Transcription Agent"),
      window.electronAPI?.getReadme().catch(() => ""),
      window.electronAPI?.getGuide().catch(() => ""),
    ])
      .then(([v, name, content, guide]) => {
        setVersion(v || "");
        setAppName(name || "Transcription Agent");
        setReadme(content || "");
        setGuideMd(guide || "");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="about-panel">
      {/* ── Header ── */}
      <div className="about-header">
        <h2>
          <Icon name="mic" size="18" color="accent" /> {appName}
        </h2>
        <Tooltip content="Close">
          <button className="about-close-btn" onClick={onClose} title="Close the About panel">
            <Icon name="close" size="16" />
          </button>
        </Tooltip>
      </div>

      {/* ── Tab bar ── */}
      <div className="about-tab-bar">
        <button className={`about-tab ${activeTab === "about" ? "about-tab--active" : ""}`} onClick={() => setActiveTab("about")}>
          <Icon name="info" size="14" /> About
        </button>
        <button className={`about-tab ${activeTab === "guide" ? "about-tab--active" : ""}`} onClick={() => setActiveTab("guide")}>
          <Icon name="book" size="14" /> Guide
        </button>
        <button className={`about-tab ${activeTab === "license" ? "about-tab--active" : ""}`} onClick={() => setActiveTab("license")}>
          <Icon name="key" size="14" /> License
        </button>
      </div>

      {/* ── Tab content ── */}
      {loading ? (
        <p className="about-loading">Loading…</p>
      ) : activeTab === "about" ? (
        <AboutTab version={version} readme={readme} />
      ) : activeTab === "guide" ? (
        <GuideTab markdown={guideMd} />
      ) : (
        <LicenseTab onLicensedChange={onLicensedChange} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   About Tab — renders the README with full markdown formatting
   ═══════════════════════════════════════════════════════════ */

function AboutTab({ version, readme }: { version: string; readme: string }) {
  const renderedHtml = useMemo(() => (readme ? renderMarkdown(readme) : ""), [readme]);

  return (
    <>
      <div className="about-version">
        <span className="about-version-label">Version</span>
        <span className="about-version-value">{version || "1.0.0"}</span>
      </div>

      <div className="about-divider" />

      {renderedHtml ? (
        <div className="about-md-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      ) : (
        <p className="about-md-content about-md-content--empty">
          <strong>Transcription Agent</strong> is a desktop application that transcribes, diarizes, and summarizes meeting audio using AI. It supports
          speaker identification, action item extraction, semantic memory, and integrates with Gmail, Google Drive, and Trello.
        </p>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   Guide Tab — rendered markdown with search & TOC nav
   ═══════════════════════════════════════════════════════════ */

function GuideTab({ markdown }: { markdown: string }) {
  // Persisted guide TOC page selection (rule 7b)
  const [tocIndex, setTocIndex] = useUiStateValue<number>("about.guideTocIndex", 0);
  return (
    <DocViewer
      markdown={markdown}
      initialIndex={tocIndex}
      onIndexChange={setTocIndex}
      emptyMessage={"The user guide is not available. Make sure <code>docs/end_user_guide.md</code> exists in the application directory."}
    />
  );
}

/* ═══════════════════════════════════════════════════════════
   License Tab — per-seat key entry, status, activation, re-key
   ═══════════════════════════════════════════════════════════ */

function humanizeLicenseReason(reason?: string): string {
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

function formatExpiry(exp: number): string {
  if (exp === 0) return "Unlimited";
  return new Date(exp * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function LicenseTab({ onLicensedChange }: { onLicensedChange?: () => void }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [safeStorageAvailable, setSafeStorageAvailable] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [integrity, setIntegrity] = useState<ConfigIntegrity | null>(null);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);

  const refresh = useCallback(() => {
    window.electronAPI?.getLicenseStatus().then((p) => {
      setStatus(p.status);
      setSafeStorageAvailable(p.safeStorageAvailable);
      setIntegrity(p.configIntegrity ?? null);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = async () => {
    const key = keyInput.trim();
    if (!key || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await window.electronAPI?.activateLicense(key);
      if (res?.success) {
        setMessage({
          kind: "ok",
          text: res.migration?.migrated
            ? "License activated. Your existing config was migrated to encrypted storage."
            : res.restoredFromBackup
              ? "License activated. Your config was restored from backup and re-encrypted."
              : "License activated.",
        });
        setKeyInput("");
        refresh();
        onLicensedChange?.();
      } else {
        setMessage({ kind: "err", text: humanizeLicenseReason(res?.reason) });
      }
    } catch (err: any) {
      setMessage({ kind: "err", text: `Activation error: ${err?.message || err}` });
    }
    setBusy(false);
  };

  const deactivate = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await window.electronAPI?.deactivateLicense();
      setMessage({ kind: "ok", text: "License deactivated." });
      refresh();
      onLicensedChange?.();
    } catch (err: any) {
      setMessage({ kind: "err", text: `Deactivation error: ${err?.message || err}` });
    }
    setBusy(false);
  };

  const restoreBackup = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await window.electronAPI?.restoreConfigFromBackup();
      if (res?.ok) {
        setMessage({ kind: "ok", text: "Config restored from backup and re-encrypted." });
        refresh();
      } else {
        setMessage({ kind: "err", text: res?.error || "Could not restore the config backup." });
      }
    } catch (err: any) {
      setMessage({ kind: "err", text: `Restore error: ${err?.message || err}` });
    }
    setBusy(false);
  };

  const reimport = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await window.electronAPI?.importConfig({ preferJson: true });
      if (res?.success) {
        setMessage({ kind: "ok", text: "Config imported and re-encrypted under the active license." });
        refresh();
        onLicensedChange?.();
      } else if (res?.cancelled) {
        setMessage(null);
      } else {
        setMessage({ kind: "err", text: res?.error || "Import failed." });
      }
    } catch (err: any) {
      setMessage({ kind: "err", text: `Import error: ${err?.message || err}` });
    }
    setBusy(false);
  };

  const statusKind = status?.status ?? "unlicensed";
  const active = statusKind === "active";

  return (
    <div className="about-license">
      <p className="about-license-desc">
        Transcription Agent requires an active per-seat license. Without one, you can fill in the New Job form but cannot submit, and the rest of the
        app stays locked. The license key also decrypts your configuration at rest.
      </p>

      {!safeStorageAvailable && (
        <p className="about-license-warn">
          <Icon name="warning" size="14" /> Secure key storage is unavailable on this system — the license key will be stored in plaintext.
        </p>
      )}

      {/* Status */}
      <div className={`about-license-status about-license-status--${statusKind}`}>
        <Icon name={active ? "verified" : statusKind === "expired" ? "schedule" : "lock"} size="16" />
        <span>
          {status?.status === "unlicensed" && "No active license"}
          {status?.status === "active" && (
            <>
              Active — seat <strong>{status.sub}</strong> · expires <strong>{formatExpiry(status.exp)}</strong>
            </>
          )}
          {status?.status === "expired" && (
            <>
              Expired (was seat <strong>{status.sub}</strong>, {formatExpiry(status.exp)}) — enter a new key
            </>
          )}
          {status?.status === "invalid" && (
            <>
              Stored key is invalid — {humanizeLicenseReason(status.reason)}. Enter a valid key below.
            </>
          )}
        </span>
      </div>

      {/* Activation input */}
      {!active && (
        <div className="about-license-entry">
          <textarea
            className="about-license-input"
            rows={3}
            placeholder="Paste your license key (TA1.…)"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button className="about-license-btn" onClick={activate} disabled={busy || !keyInput.trim()}>
            <Icon name="key" size="14" /> {busy ? "Activating…" : "Activate License"}
          </button>
        </div>
      )}

      {message && (
        <p className={`about-license-msg about-license-msg--${message.kind}`}>
          <Icon name={message.kind === "ok" ? "check_circle" : "error"} size="14" /> {message.text}
        </p>
      )}

      {/* Config recovery — accidental deletion / wrong-key protection */}
      {integrity?.configGpg === "missing" && integrity.backupExists && (
        <div className="about-license-recovery">
          <p className="about-license-recovery-msg">
            <Icon name="restore" size="14" /> Your config file is missing, but a backup was found.
          </p>
          <button className="about-license-btn" onClick={restoreBackup} disabled={busy}>
            <Icon name="restore" size="14" /> Restore Config from Backup
          </button>
        </div>
      )}
      {integrity?.configGpg === "corrupt" && (
        <div className="about-license-recovery">
          <p className="about-license-recovery-msg">
            <Icon name="warning" size="14" /> Your config file was encrypted with a different license key — enter that key to restore access, or re-import a plaintext .json export under this key.
          </p>
          <button className="about-license-btn" onClick={reimport} disabled={busy}>
            <Icon name="download" size="14" /> Re-import Config
          </button>
        </div>
      )}

      {active && (
        <div className="about-license-actions">
          <button className="about-license-btn about-license-btn--danger" onClick={() => setShowDeactivateConfirm(true)} disabled={busy}>
            <Icon name="logout" size="14" /> Deactivate
          </button>
          <p className="about-license-hint">Deactivating keeps your encrypted config; you'll need the same key to re-open it.</p>
        </div>
      )}

      {showDeactivateConfirm && (
        <div className="confirm-overlay" onClick={() => setShowDeactivateConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> Deactivate license?
            </h3>
            <p className="confirm-dialog-text">
              Deactivating removes this key from the app and locks it until another key is activated. Your encrypted config becomes
              unreadable — you'll need to re-enter <strong>this same key</strong> to open it again, or re-import a config after activating a
              new key.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setShowDeactivateConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setShowDeactivateConfirm(false);
                  deactivate();
                }}
                disabled={busy}>
                Yes, Deactivate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
