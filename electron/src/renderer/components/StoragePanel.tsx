/**
 * StoragePanel — disk usage breakdown view + developer data management section.
 *
 * Shows a visual breakdown of storage consumption across six categories.
 * Below the breakdown, a developer section allows clearing logs, job history,
 * semantic memory (ChromaDB), and ephemeral/voiceprint databases.
 */

import React, { useState, useEffect, useCallback } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import LoadingModal from "./LoadingModal";
import { useUiStateValue } from "../hooks/useUiState";
import type { StorageUsage } from "../types";

interface Props {
  onClose: () => void;
  onNotify?: (message: string) => void;
  refreshTrigger?: number;
  onDevAccessRequest?: () => void;
  devAccessSignal?: number;
  onStorageCleared?: () => void | Promise<void>;
}

const BRIDGE_URL = "http://127.0.0.1:5010";

const CATEGORY_COLORS: Record<string, string> = {
  history: "#58a6ff",
  logs: "#d29922",
  chroma: "#3fb950",
  databases: "#bc8cff",
  system: "#8b949e",
  ollama: "#ff6b6b",
};

const CATEGORY_LABELS: Record<string, string> = {
  history: "History (Job Storage)",
  logs: "Logs",
  chroma: "ChromaDB",
  databases: "Databases",
  system: "System (Code & Config)",
  ollama: "Ollama Models",
};

const CATEGORY_ITEMS: Array<{ key: string; icon: string; label: string }> = [
  { key: "history", icon: "history", label: "Transcription job data" },
  { key: "logs", icon: "terminal", label: "Application log files" },
  { key: "chroma", icon: "memory", label: "ChromaDB vector store (semantic memory)" },
  { key: "databases", icon: "database", label: "Ephemeral memory + voiceprint databases" },
  { key: "system", icon: "settings", label: "Source code, config, dependencies" },
  { key: "ollama", icon: "smart_toy", label: "Downloaded Ollama LLM models (~/.ollama)" },
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

export default function StoragePanel({ onClose, onNotify, refreshTrigger, onDevAccessRequest, devAccessSignal, onStorageCleared }: Props) {
  const [data, setData] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageTab, setStorageTab] = useUiStateValue<"usage" | "developer">("storage.tab", "usage");

  // Developer section — generic clear actions
  const [confirmAction, setConfirmAction] = useState<{
    type: string;
    label: string;
    description: string;
    bridgeTool: string;
    bridgeArgs?: Record<string, any>;
  } | null>(null);
  const [processingAction, setProcessingAction] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  // Full-screen loading overlay shown during a clear + the post-clear refresh
  const [clearing, setClearing] = useState(false);

  // Watch for dev access signal from parent (triggered after modal acceptance)
  useEffect(() => {
    if (devAccessSignal && devAccessSignal > 0) {
      setStorageTab("developer");
    }
  }, [devAccessSignal]);

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
  }, [fetchUsage, refreshTrigger]);

  // Active jobs guard — destructive clears are blocked while jobs run (Fix B).
  // Poll so the guard stays fresh while the panel is open.
  const [activeJobs, setActiveJobs] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const jobs = await window.electronAPI?.getActiveJobs();
        if (!cancelled) setActiveJobs(jobs || []);
      } catch {
        // ignore — backend may be unavailable
      }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const handleClearAction = useCallback(
    async (action: { type: string; label: string; description: string; bridgeTool: string; bridgeArgs?: Record<string, any> }) => {
      setConfirmAction(null);
      // Guard: destructive clears are blocked while pipeline jobs run.
      if (activeJobs.length > 0 && ["jobs", "all", "ephemeral", "semantic"].includes(action.type)) {
        setActionResult(`Blocked: ${activeJobs.length} job(s) still running — stop or wait for them first.`);
        onNotify?.(`${action.label} blocked — jobs still running`);
        setProcessingAction(null);
        return;
      }
      setProcessingAction(action.type);
      setActionResult(null);
      // Show a full-screen loading overlay for the whole clear + post-clear
      // refresh (storage usage refetch + current/history panel reset).
      setClearing(true);
      try {
        const result = await callBridge(action.bridgeTool, action.bridgeArgs || {});
        // For log clearing, also flush the in-memory live log buffer used by DevPanel
        if (action.type === "logs" && window.electronAPI?.clearLogs) {
          await window.electronAPI.clearLogs();
        }
        const msg = result.message || "Cleared successfully";
        setActionResult(msg);
        onNotify?.(`${action.label}: ${msg}`);
        // Refresh storage usage to reflect the change
        await fetchUsage();
        // Notify parent to reset cached view/history state when jobs are removed
        if (action.type === "jobs" || action.type === "all") {
          await onStorageCleared?.();
        }
      } catch (err: any) {
        setActionResult(`Error: ${err.message}`);
        onNotify?.(`${action.label} failed: ${err.message}`);
      } finally {
        setClearing(false);
        setProcessingAction(null);
      }
    },
    [fetchUsage, onNotify, activeJobs],
  );

  // Compute bar widths as percentage of total
  const totalBytes = data?.total?.bytes || 1;
  const categories = data
    ? (["history", "logs", "chroma", "databases", "system", "ollama"] as const).map((key) => ({
        key,
        bytes: data[key]?.bytes || 0,
        human: data[key]?.human || "0 B",
        pct: ((data[key]?.bytes || 0) / totalBytes) * 100,
      }))
    : [];

  return (
    <div className="config-panel--full" style={{ flex: 1, overflow: "auto" }}>
      <div className="config-header">
        <Tooltip content="Disk space usage breakdown by category">
          <h2>
            <Icon name="storage" size="18" color="accent" /> Storage Usage
          </h2>
        </Tooltip>
        <Tooltip content="Close the storage panel">
          <button className="config-close-btn" onClick={onClose} title="Close storage panel">
            <Icon name="close" size="16" />
          </button>
        </Tooltip>
      </div>

      <div className="config-body" style={{ padding: "16px 24px" }}>
        <LoadingModal visible={loading && !data} message="Fetching storage usage…" />
        <LoadingModal visible={clearing} message="Clearing data and refreshing views…" />

        {error && (
          <div className="error-box" style={{ marginBottom: 16 }}>
            <p>Failed to load storage data: {error}</p>
            <button className="btn-primary" onClick={fetchUsage} style={{ marginTop: 8 }}>
              Retry
            </button>
          </div>
        )}

        {/* ── Tab bar ── */}
        {data && (
          <div className="config-section-tabs" style={{ marginBottom: 16 }}>
            <button
              className={`config-section-tab ${storageTab === "usage" ? "config-section-tab--active" : ""}`}
              onClick={() => setStorageTab("usage")}>
              <Icon name="storage" size="14" /> Usage
            </button>
            <button
              className={`config-section-tab ${storageTab === "developer" ? "config-section-tab--active" : ""}`}
              onClick={() => {
                if (sessionStorage.getItem("dev_warning_accepted")) {
                  setStorageTab("developer");
                } else {
                  onDevAccessRequest?.();
                }
              }}>
              <Icon name="terminal" size="14" /> Developer
            </button>
          </div>
        )}

        {/* ── Usage Tab ── */}
        {data && storageTab === "usage" && (
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
                    {/* File path display — click to open in native file manager */}
                    {data[c.key]?.path && (
                      <div
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                          marginTop: 4,
                          fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
                          opacity: 0.7,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          cursor: "pointer",
                        }}
                        title={`Click to open in ${window.electronAPI?.platform === "darwin" ? "Finder" : "File Explorer"}`}
                        onClick={() => {
                          window.electronAPI?.openPath(data[c.key]!.path!).catch((err) => console.error("Failed to open path:", err));
                        }}>
                        <Icon name="folder" size="12" color="muted" /> {data[c.key].path}
                      </div>
                    )}
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
              <Tooltip content="Re-fetch disk usage information from the backend">
                <button className="btn-primary" onClick={fetchUsage} disabled={loading} title="Refresh storage usage data">
                  {loading ? (
                    "Refreshing…"
                  ) : (
                    <>
                      <Icon name="refresh" size="14" /> Refresh
                    </>
                  )}
                </button>
              </Tooltip>
            </div>
          </>
        )}

        {/* ── Developer Tab ── */}
        {storageTab === "developer" && (
          <div className="storage-dev-content">
            <p className="storage-dev-description">Destructive actions to clear stored data. These operations are irreversible.</p>

            {activeJobs.length > 0 && (
              <div className="storage-log-action" style={{ borderColor: "var(--danger, #f85149)", marginBottom: 12 }}>
                <div className="storage-log-action-info">
                  <strong>
                    <Icon name="warning" size="14" color="red" /> {activeJobs.length} job{activeJobs.length > 1 ? "s" : ""} still running
                  </strong>
                  <p>
                    Destructive clear actions are disabled while transcription jobs are running. Use <em>Stop Processing</em> on the current job or
                    wait for jobs to finish, then clear data.
                  </p>
                </div>
              </div>
            )}

            {/* Clear all logs */}
            <div className="storage-log-action">
              <div className="storage-log-action-info">
                <strong>
                  <Icon name="delete" size="14" color="red" /> Clear All Logs
                </strong>
                <p>
                  Delete all <code>.jsonl</code> and <code>.log</code> files from storage, including error logs.
                </p>
              </div>
              <button
                className="btn-warning"
                onClick={() =>
                  setConfirmAction({
                    type: "logs",
                    label: "Clear All Logs",
                    description: "This will permanently delete all log files including those with error events. This action cannot be undone.",
                    bridgeTool: "storage_clear_logs",
                    bridgeArgs: { logType: "all_including_errors" },
                  })
                }
                disabled={!!processingAction}>
                {processingAction === "logs" ? "Clearing…" : "Clear All Logs"}
              </button>
            </div>

            {/* Clear all job history */}
            <div className="storage-log-action">
              <div className="storage-log-action-info">
                <strong>
                  <Icon name="history" size="14" color="accent" /> Clear All Job History
                </strong>
                <p>Delete all transcription job directories and their associated data (transcripts, summaries, analyses, audio files).</p>
              </div>
              <button
                className="btn-warning"
                onClick={() =>
                  setConfirmAction({
                    type: "jobs",
                    label: "Clear All Job History",
                    description: "This will permanently delete all transcription jobs and their data. This action cannot be undone.",
                    bridgeTool: "storage_clear_jobs",
                  })
                }
                disabled={!!processingAction || activeJobs.length > 0}
                title={activeJobs.length > 0 ? "Disabled while transcription jobs are running" : undefined}>
                {processingAction === "jobs" ? "Clearing…" : "Clear All Jobs"}
              </button>
            </div>

            {/* Clear all semantic db data */}
            <div className="storage-log-action">
              <div className="storage-log-action-info">
                <strong>
                  <Icon name="memory" size="14" color="green" /> Clear Semantic DB Data
                </strong>
                <p>Delete the ChromaDB vector store containing semantic memory (meeting summaries and searchable transcript embeddings).</p>
              </div>
              <button
                className="btn-warning"
                onClick={() =>
                  setConfirmAction({
                    type: "semantic",
                    label: "Clear Semantic DB Data",
                    description:
                      "This will permanently delete the ChromaDB vector store and all semantic memory data. This action cannot be undone.",
                    bridgeTool: "storage_clear_semantic",
                  })
                }
                disabled={!!processingAction || activeJobs.length > 0}
                title={activeJobs.length > 0 ? "Disabled while transcription jobs are running" : undefined}>
                {processingAction === "semantic" ? "Clearing…" : "Clear Semantic DB"}
              </button>
            </div>

            {/* Clear all ephemeral / voiceprint data */}
            <div className="storage-log-action">
              <div className="storage-log-action-info">
                <strong>
                  <Icon name="database" size="14" color="purple" /> Clear Ephemeral / Voiceprint Data
                </strong>
                <p>
                  Delete the ephemeral memory database (action items, contacts, budgets, decisions) and voiceprint database (speaker embeddings).
                </p>
              </div>
              <button
                className="btn-warning"
                onClick={() =>
                  setConfirmAction({
                    type: "ephemeral",
                    label: "Clear Ephemeral / Voiceprint Data",
                    description:
                      "This will permanently delete both the ephemeral memory and voiceprint databases. This action cannot be undone.",
                    bridgeTool: "storage_clear_ephemeral",
                  })
                }
                disabled={!!processingAction || activeJobs.length > 0}
                title={activeJobs.length > 0 ? "Disabled while transcription jobs are running" : undefined}>
                {processingAction === "ephemeral" ? "Clearing…" : "Clear Ephemeral / Voiceprint"}
              </button>
            </div>

            {/* Clear all user data */}
            <div className="storage-log-action">
              <div className="storage-log-action-info">
                <strong>
                  <Icon name="delete_forever" size="14" color="red" /> Clear All User Data
                </strong>
                <p>
                  Destructive: clears job history, logs, semantic memory (ChromaDB), and ephemeral/voiceprint databases all at once. This action
                  cannot be undone.
                </p>
              </div>
              <button
                className="btn-danger"
                onClick={() =>
                  setConfirmAction({
                    type: "all",
                    label: "Clear All User Data",
                    description:
                      "This will delete ALL user data including job history, logs, ChromaDB semantic memory, ephemeral memory, " +
                      "and voiceprint databases. This action is irreversible.",
                    bridgeTool: "storage_clear_all",
                    bridgeArgs: { logType: "all_including_errors" },
                  })
                }
                disabled={!!processingAction || activeJobs.length > 0}
                title={activeJobs.length > 0 ? "Disabled while transcription jobs are running" : undefined}>
                {processingAction === "all" ? "Clearing…" : "Clear All Data"}
              </button>
            </div>

            {/* Result feedback */}
            {actionResult && (
              <div
                className={`storage-log-result ${actionResult.startsWith("Error") ? "storage-log-result--error" : "storage-log-result--ok"}`}>
                {actionResult}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Confirmation Dialog ── */}
      {confirmAction && (
        <div className="confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> {confirmAction.label}
            </h3>
            <p className="confirm-dialog-text">{confirmAction.description}</p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={() => handleClearAction(confirmAction)} disabled={!!processingAction}>
                {processingAction === confirmAction.type ? "Processing..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
