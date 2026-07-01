/**
 * StoragePanel — disk usage breakdown view + developer log management section.
 *
 * Shows a visual breakdown of storage consumption across five categories.
 * Below the breakdown, a developer section allows wiping JSONL log files
 * in two flavors: all logs or error-only logs (with a prominent warning).
 */

import React, { useState, useEffect, useCallback } from "react";
import type { StorageUsage } from "../types";

interface Props {
  onClose: () => void;
}

const BRIDGE_URL = "http://127.0.0.1:5010";

const CATEGORY_COLORS: Record<string, string> = {
  history: "#58a6ff",
  logs: "#d29922",
  chroma: "#3fb950",
  databases: "#bc8cff",
  system: "#8b949e",
};

const CATEGORY_LABELS: Record<string, string> = {
  history: "📋 History (Job Storage)",
  logs: "🪵 Logs",
  chroma: "🧠 ChromaDB",
  databases: "🗄️ Databases",
  system: "⚙️ System (Code & Config)",
};

const CATEGORY_ITEMS: Array<{ key: string; icon: string; label: string }> = [
  { key: "history", icon: "📋", label: "Transcription job data" },
  { key: "logs", icon: "🪵", label: "Application log files" },
  { key: "chroma", icon: "🧠", label: "ChromaDB vector store (semantic memory)" },
  { key: "databases", icon: "🗄️", label: "Ephemeral memory + voiceprint databases" },
  { key: "system", icon: "⚙️", label: "Source code, config, dependencies" },
];

async function callBridge(tool: string, args: any = {}): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bridge error (${res.status}): ${err}`);
  }
  return res.json();
}

export default function StoragePanel({ onClose }: Props) {
  const [data, setData] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Log deletion state
  const [showDevSection, setShowDevSection] = useState(false);
  const [confirmLogAction, setConfirmLogAction] = useState<"all" | "error" | null>(null);
  const [deletingLogs, setDeletingLogs] = useState(false);
  const [logDeleteResult, setLogDeleteResult] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getStorageUsage();
      if (result?.error) {
        setError(result.error);
      } else if (result) {
        setData(result as StorageUsage);
      } else {
        setError("Storage API unavailable");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const handleDeleteLogs = useCallback(
    async (logType: "all" | "error") => {
      setConfirmLogAction(null);
      setDeletingLogs(true);
      setLogDeleteResult(null);
      try {
        const result = await callBridge("storage_clear_logs", { logType });
        setLogDeleteResult(result.message || `Deleted ${result.deleted} log file(s)${result.errors ? ` (${result.errors} error(s))` : ""}`);
        // Refresh storage usage to reflect the change
        fetchUsage();
      } catch (err: any) {
        setLogDeleteResult(`Error: ${err.message}`);
      } finally {
        setDeletingLogs(false);
      }
    },
    [fetchUsage],
  );

  // Compute bar widths as percentage of total
  const totalBytes = data?.total?.bytes || 1;
  const categories = data
    ? (["history", "logs", "chroma", "databases", "system"] as const).map((key) => ({
        key,
        bytes: data[key]?.bytes || 0,
        human: data[key]?.human || "0 B",
        pct: ((data[key]?.bytes || 0) / totalBytes) * 100,
      }))
    : [];

  return (
    <div className="config-panel" style={{ flex: 1, overflow: "auto" }}>
      <div className="config-header">
        <h2>💾 Storage Usage</h2>
        <button className="config-close-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="config-body" style={{ padding: "16px 24px" }}>
        {loading && !data && <p style={{ color: "var(--text-muted)" }}>Fetching storage usage…</p>}

        {error && (
          <div className="error-box" style={{ marginBottom: 16 }}>
            <p>Failed to load storage data: {error}</p>
            <button className="btn-primary" onClick={fetchUsage} style={{ marginTop: 8 }}>
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            {/* Total */}
            <div style={{ marginBottom: 24 }}>
              <span style={{ fontSize: 20, fontWeight: 600 }}>{data.total?.human}</span>
              <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>total</span>
            </div>

            {/* Visual bar chart */}
            <div
              style={{
                display: "flex",
                height: 32,
                borderRadius: 6,
                overflow: "hidden",
                marginBottom: 20,
              }}>
              {categories
                .filter((c) => c.bytes > 0)
                .map((c) => (
                  <div
                    key={c.key}
                    style={{
                      flex: c.bytes,
                      backgroundColor: CATEGORY_COLORS[c.key],
                      minWidth: c.pct > 0 ? 4 : 0,
                      position: "relative",
                      transition: "flex 0.3s ease",
                    }}
                    title={`${CATEGORY_LABELS[c.key]}: ${c.human} (${c.pct.toFixed(1)}%)`}
                  />
                ))}
              {categories.every((c) => c.bytes === 0) && (
                <div
                  style={{
                    flex: 1,
                    backgroundColor: "var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}>
                  No data
                </div>
              )}
            </div>

            {/* Legend/breakdown list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {categories.map((c) => (
                <div
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    backgroundColor: "var(--surface)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}>
                  {/* Color dot */}
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      backgroundColor: CATEGORY_COLORS[c.key],
                      flexShrink: 0,
                    }}
                  />
                  {/* Category info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{CATEGORY_LABELS[c.key]}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
                      {CATEGORY_ITEMS.find((i) => i.key === c.key)?.label}
                      {c.key === "history" && data.history?.job_count != null && (
                        <>
                          {" "}
                          · {data.history.job_count} job{data.history.job_count !== 1 ? "s" : ""}
                        </>
                      )}
                    </div>
                  </div>
                  {/* Size + percentage */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{c.human}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{c.pct.toFixed(1)}%</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Refresh button */}
            <div style={{ marginTop: 20, textAlign: "center" }}>
              <button className="btn-primary" onClick={fetchUsage} disabled={loading}>
                {loading ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>

            {/* ── Developer Section ── */}
            <hr className="storage-divider" />
            <div className="storage-dev-section">
              <button className="storage-dev-toggle" onClick={() => setShowDevSection((v) => !v)}>
                <span className="storage-dev-toggle-icon">{showDevSection ? "▼" : "▶"}</span>
                <span className="storage-dev-toggle-label">🧑‍💻 Developer: Log File Management</span>
              </button>

              {showDevSection && (
                <div className="storage-dev-content">
                  <p className="storage-dev-description">
                    Manage <code>.jsonl</code> log files from the agent runner. These files contain per-event traces of pipeline execution. Deleting
                    them is irreversible.
                  </p>

                  {/* Non-error log deletion */}
                  <div className="storage-log-action">
                    <div className="storage-log-action-info">
                      <strong>🗑️ Delete All Log Files</strong>
                      <p>
                        Removes every <code>.jsonl</code> log file from the <code>logs/</code> directory.
                      </p>
                    </div>
                    <button className="btn-warning" onClick={() => setConfirmLogAction("all")} disabled={deletingLogs}>
                      Delete All Logs
                    </button>
                  </div>

                  {/* Error-only log deletion — separate sub-section with bright warning */}
                  <div className="storage-log-error-section">
                    <div className="storage-log-action">
                      <div className="storage-log-action-info">
                        <strong className="storage-error-label">⚠️ DANGER ZONE ⚠️</strong>
                        <p className="storage-error-description">
                          Delete only log files that contain <strong>error</strong> events. Files without error entries will be preserved.
                        </p>
                      </div>
                      <button className="btn-danger" onClick={() => setConfirmLogAction("error")} disabled={deletingLogs}>
                        Delete Error Logs Only
                      </button>
                    </div>
                  </div>

                  {/* Result feedback */}
                  {logDeleteResult && (
                    <div
                      className={`storage-log-result ${logDeleteResult.startsWith("Error") ? "storage-log-result--error" : "storage-log-result--ok"}`}>
                      {logDeleteResult}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Confirmation Dialog ── */}
      {confirmLogAction && (
        <div className="confirm-overlay" onClick={() => setConfirmLogAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">{confirmLogAction === "error" ? "⚠️ Delete Error Logs" : "🗑️ Delete All Logs"}</h3>
            <p className="confirm-dialog-text">
              {confirmLogAction === "error" ? (
                <>
                  This will permanently delete all <code>.jsonl</code> log files that contain error events. Files without errors will be kept.
                </>
              ) : (
                <>
                  This will permanently delete <strong>all</strong> <code>.jsonl</code> log files. This action cannot be undone.
                </>
              )}
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setConfirmLogAction(null)}>
                Cancel
              </button>
              <button
                className={confirmLogAction === "error" ? "btn-danger" : "btn-warning"}
                onClick={() => handleDeleteLogs(confirmLogAction!)}
                disabled={deletingLogs}>
                {deletingLogs ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
