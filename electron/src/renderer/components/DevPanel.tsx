/**
 * DevPanel — live log viewer overlay for the Electron app.
 *
 * Toggled from the StatusBar. Shows real-time logs from all three services
 * (Python, Bridge, Agent) plus main process logs. Supports filtering by
 * source and level, auto-scroll, and manual clear.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { LogEntry } from "../types";

interface Props {
  visible: boolean;
  onClose: () => void;
}

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

export default function DevPanel({ visible, onClose }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Load initial logs and subscribe to new ones
  useEffect(() => {
    if (!visible) return;

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
  }, [visible]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = useCallback(async () => {
    await window.electronAPI?.clearLogs();
    setLogs([]);
  }, []);

  // Apply filters
  const filtered = logs.filter((entry) => {
    if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
    if (levelFilter !== "all" && entry.level !== levelFilter) return false;
    return true;
  });

  if (!visible) return null;

  return (
    <div className="dev-panel">
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">📋 Dev Logs</span>

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
          <button className="dev-panel-btn dev-panel-btn-close" onClick={onClose} title="Close dev panel">
            ✕
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
    </div>
  );
}
