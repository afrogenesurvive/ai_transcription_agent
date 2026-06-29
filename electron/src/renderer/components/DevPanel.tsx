/**
 * DevPanel — live log viewer overlay for the Electron app.
 *
 * Toggled from the StatusBar. Shows real-time logs from all three services
 * (Python, Bridge, Agent) plus main process logs. Supports filtering by
 * source and level, auto-scroll, and manual clear.
 *
 * Also has a "Log Files" tab that lists on-disk log files from both the
 * primary (userData) and mirror (dev storage) directories, letting you
 * view their contents.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { LogEntry, LogFileInfo } from "../types";

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Tab = "live" | "files";

type SourceFilter = "all" | LogEntry["source"];
type LevelFilter = "all" | LogEntry["level"];

const SOURCE_COLORS: Record<string, string> = {
  python: "#58a6ff",
  bridge: "#3fb950",
  agent: "#d29922",
  main: "#8b949e",
};

const LEVEL_PREFIX: Record<string, string> = {
  info: "",
  warn: "⚠️ ",
  error: "❌ ",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Live Logs Tab ── */

function LiveLogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI
      ?.getLogs()
      .then(setLogs)
      .catch(() => {});

    const unsub = window.electronAPI?.onLog((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    });

    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = useCallback(async () => {
    await window.electronAPI?.clearLogs();
    setLogs([]);
  }, []);

  const filtered = logs.filter((entry) => {
    if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
    if (levelFilter !== "all" && entry.level !== levelFilter) return false;
    return true;
  });

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">📋 Live Logs</span>

        <div className="dev-panel-filters">
          <select className="dev-panel-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}>
            <option value="all">All sources</option>
            <option value="python">Python</option>
            <option value="bridge">Bridge</option>
            <option value="agent">Agent</option>
            <option value="main">Main</option>
          </select>

          <select className="dev-panel-select" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}>
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </select>

          <label className="dev-panel-checkbox">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
        </div>

        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={handleClear} title="Clear logs">
            Clear
          </button>
        </div>
      </div>

      {/* Log list */}
      <div className="dev-panel-list" ref={listRef}>
        {filtered.length === 0 && <div className="dev-panel-empty">No logs match the current filters.</div>}
        {filtered.map((entry, i) => (
          <div key={i} className="dev-panel-entry">
            <span className="dev-panel-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span className="dev-panel-source" style={{ color: SOURCE_COLORS[entry.source] || "#8b949e" }}>
              [{entry.source}]
            </span>
            <span className={`dev-panel-level dev-panel-level--${entry.level}`}>{LEVEL_PREFIX[entry.level]}</span>
            <span className="dev-panel-message">{entry.message}</span>
          </div>
        ))}
      </div>

      {/* Footer with stats */}
      <div className="dev-panel-footer">
        <span>{filtered.length} entries</span>
        <span>{logs.length} total buffered</span>
      </div>
    </>
  );
}

/* ── Log Files Tab ── */

function LogFilesTab() {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string[]>([]);
  const [logPaths, setLogPaths] = useState<{ primary: string | null; mirror: string | null }>({ primary: null, mirror: null });
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI
      ?.listLogFiles()
      .then(setFiles)
      .catch(() => {});
    window.electronAPI
      ?.getLogPaths()
      .then(setLogPaths)
      .catch(() => {});
  }, []);

  const handleSelectFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    const lines = (await window.electronAPI?.readLogFile(filePath, 1000)) || [];
    setFileContent(lines);
  }, []);

  // Auto-scroll to bottom when file content loads
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [fileContent]);

  const handleRefresh = useCallback(async () => {
    const updatedFiles = (await window.electronAPI?.listLogFiles()) || [];
    setFiles(updatedFiles);
    if (selectedFile) {
      // Re-read currently selected file
      const lines = (await window.electronAPI?.readLogFile(selectedFile, 1000)) || [];
      setFileContent(lines);
    }
  }, [selectedFile]);

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">📁 Log Files</span>
        <span className="dev-panel-file-path-hint">
          {logPaths.primary && <span title={logPaths.primary}>Primary: {logPaths.primary.split("/").pop()}/…</span>}
          {logPaths.mirror && <span title={logPaths.mirror}>Mirror: {logPaths.mirror.split("/").pop()}/…</span>}
        </span>
        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={handleRefresh} title="Refresh file list">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-file-browser">
        {/* File list sidebar */}
        <div className="dev-panel-file-list">
          {files.length === 0 && (
            <div className="dev-panel-empty" style={{ padding: "12px" }}>
              No log files found.
            </div>
          )}
          {files.map((f) => (
            <div
              key={f.path}
              className={`dev-panel-file-item ${selectedFile === f.path ? "dev-panel-file-item--active" : ""}`}
              onClick={() => handleSelectFile(f.path)}>
              <span className="dev-panel-file-name">{f.name}</span>
              <span className="dev-panel-file-meta">
                {formatSize(f.size)} · {f.source === "primary" ? "📁" : "📂"} {f.source}
              </span>
              <span className="dev-panel-file-date">{new Date(f.mtime).toLocaleDateString()}</span>
            </div>
          ))}
        </div>

        {/* File content */}
        <div className="dev-panel-file-content" ref={contentRef}>
          {!selectedFile && <div className="dev-panel-empty">Select a log file to view its contents.</div>}
          {selectedFile && fileContent.length === 0 && <div className="dev-panel-empty">(empty file)</div>}
          {selectedFile &&
            fileContent.map((line, i) => (
              <div key={i} className="dev-panel-file-line">
                {line}
              </div>
            ))}
        </div>
      </div>

      {/* Footer with stats */}
      <div className="dev-panel-footer">
        <span>{files.length} file(s)</span>
        {selectedFile && <span>{fileContent.length} lines</span>}
      </div>
    </>
  );
}

/* ── DevPanel ── */

export default function DevPanel({ visible, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("live");

  if (!visible) return null;

  return (
    <div className="dev-panel">
      {/* Tab bar */}
      <div className="dev-panel-tabs">
        <button className={`dev-panel-tab ${activeTab === "live" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("live")}>
          📋 Live Logs
        </button>
        <button className={`dev-panel-tab ${activeTab === "files" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("files")}>
          📁 Log Files
        </button>
        <div className="dev-panel-tabs-spacer" />
        <button className="dev-panel-btn dev-panel-btn-close" onClick={onClose} title="Close dev panel">
          ✕
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "live" && <LiveLogsTab />}
      {activeTab === "files" && <LogFilesTab />}
    </div>
  );
}
