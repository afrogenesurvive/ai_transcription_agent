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
  onClose: () => void;
}

type Tab = "live" | "files" | "database" | "performance";

const BRIDGE_URL = "http://127.0.0.1:5010";

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
  const autoScrollRef = useRef(true);

  // Keep ref in sync with state so scroll logic can read the latest value
  // without being delayed by React batching
  const handleAutoScrollChange = useCallback((checked: boolean) => {
    setAutoScroll(checked);
    autoScrollRef.current = checked;
  }, []);

  // Scroll to bottom when new logs arrive, but only if auto-scroll is enabled
  const scrollToBottom = useCallback(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, []);

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
      // Schedule scroll immediately after state update
      requestAnimationFrame(scrollToBottom);
    });

    return () => unsub?.();
  }, [scrollToBottom]);

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
            <input type="checkbox" checked={autoScroll} onChange={(e) => handleAutoScrollChange(e.target.checked)} />
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

/* ── Database Tab ── */

interface TableInfo {
  name: string;
  label: string;
  columns: string[];
  row_count: number;
}

interface MeetingInfo {
  id: string;
  job_id: string;
  title: string;
  type: string;
  attendees: string;
  timestamp: string;
}

async function callBridge(tool: string, args: any = {}): Promise<any> {
  try {
    const res = await fetch(`${BRIDGE_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    return await res.json();
  } catch {
    return null;
  }
}

function DatabaseTab() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRows, setTableRows] = useState<any[]>([]);
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [activeView, setActiveView] = useState<"ephemeral" | "semantic">("ephemeral");
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const loadTables = useCallback(async () => {
    setLoading(true);
    const result = await callBridge("memory_ephemeral_tables");
    if (result?.tables) setTables(result.tables);
    setLoading(false);
  }, []);

  const loadMeetings = useCallback(async () => {
    setLoading(true);
    const result = await callBridge("memory_semantic_meetings");
    if (result?.meetings) setMeetings(result.meetings);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTables();
    loadMeetings();
  }, [loadTables, loadMeetings]);

  const handleSelectTable = useCallback(async (tableName: string) => {
    setSelectedTable(tableName);
    setLoading(true);
    const result = await callBridge("memory_ephemeral_table", { tableName, limit: 100, offset: 0 });
    if (result) {
      setTableRows(result.rows || []);
      setTableColumns(result.columns || []);
      setTableTotal(result.total || 0);
    }
    setLoading(false);
  }, []);

  const handleRefresh = useCallback(() => {
    loadTables();
    loadMeetings();
    if (selectedTable) handleSelectTable(selectedTable);
  }, [loadTables, loadMeetings, handleSelectTable, selectedTable]);

  // Render a cell value safely
  const renderCell = (val: any): string => {
    if (val === null || val === undefined) return "—";
    if (typeof val === "object") return JSON.stringify(val).slice(0, 80);
    return String(val);
  };

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">🗄️ Database</span>
        <div className="dev-panel-filters">
          <div className="dev-panel-view-toggle">
            <button
              className={`dev-panel-view-btn ${activeView === "ephemeral" ? "dev-panel-view-btn--active" : ""}`}
              onClick={() => setActiveView("ephemeral")}>
              💾 Ephemeral
            </button>
            <button
              className={`dev-panel-view-btn ${activeView === "semantic" ? "dev-panel-view-btn--active" : ""}`}
              onClick={() => setActiveView("semantic")}>
              🧠 Semantic
            </button>
          </div>
        </div>
        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={handleRefresh} title="Refresh database">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-db">
        {activeView === "ephemeral" && (
          <>
            {/* Table list sidebar */}
            <div className="dev-panel-db-sidebar">
              {loading && tables.length === 0 && (
                <div className="dev-panel-empty" style={{ padding: "12px" }}>
                  Loading...
                </div>
              )}
              {!loading && tables.length === 0 && (
                <div className="dev-panel-empty" style={{ padding: "12px" }}>
                  No tables found.
                </div>
              )}
              {tables.map((t) => (
                <div
                  key={t.name}
                  className={`dev-panel-db-item ${selectedTable === t.name ? "dev-panel-db-item--active" : ""}`}
                  onClick={() => handleSelectTable(t.name)}>
                  <span className="dev-panel-db-item-name">{t.label}</span>
                  <span className="dev-panel-db-item-count">{t.row_count} rows</span>
                </div>
              ))}
            </div>

            {/* Table content */}
            <div className="dev-panel-db-content" ref={contentRef}>
              {!selectedTable && <div className="dev-panel-empty">Select a table to view its rows.</div>}
              {selectedTable && tableRows.length === 0 && <div className="dev-panel-empty">(empty table)</div>}
              {selectedTable && tableRows.length > 0 && (
                <table className="dev-panel-db-table">
                  <thead>
                    <tr>
                      {tableColumns.map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row, i) => (
                      <tr key={i}>
                        {tableColumns.map((col) => (
                          <td key={col}>{renderCell(row[col])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {activeView === "semantic" && (
          <div className="dev-panel-db-content" ref={contentRef}>
            {loading && meetings.length === 0 && <div className="dev-panel-empty">Loading...</div>}
            {!loading && meetings.length === 0 && <div className="dev-panel-empty">No meetings stored in ChromaDB.</div>}
            {meetings.length > 0 && (
              <table className="dev-panel-db-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Job ID</th>
                    <th>Type</th>
                    <th>Attendees</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id}>
                      <td>{m.title}</td>
                      <td className="dev-panel-db-cell-mono">{m.job_id?.slice(0, 12)}…</td>
                      <td>{m.type}</td>
                      <td>{m.attendees || "—"}</td>
                      <td>{m.timestamp || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Footer with stats */}
      <div className="dev-panel-footer">
        {activeView === "ephemeral" && (
          <span>
            {tables.length} table(s), {tables.reduce((s, t) => s + t.row_count, 0)} total rows
          </span>
        )}
        {activeView === "semantic" && <span>{meetings.length} meeting(s)</span>}
        {selectedTable && <span>{tableTotal} row(s) in table</span>}
      </div>
    </>
  );
}

/* ── Performance Tab ── */

interface MetricRow {
  label: string;
  pid: number | null;
  cpu: number | null;
  memoryBytes: number | null;
}

function formatMem(bytes: number | null): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatCpu(val: number | null): string {
  if (val === null || val === undefined) return "—";
  return `${val.toFixed(1)}%`;
}

function PerformanceTab() {
  const [electronRows, setElectronRows] = useState<MetricRow[]>([]);
  const [childRows, setChildRows] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);

  // Read polling interval from config on mount
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      const val = parseInt(cfg.PERF_METRICS_POLL_INTERVAL || "10000", 10);
      if (val > 0) setPollIntervalMs(val);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await window.electronAPI?.getPerformanceMetrics();
        if (!data || cancelled) return;

        const electron: MetricRow[] = (data.electron || []).map((m) => ({
          label: m.type === "Browser" ? "Main / Renderer" : m.type,
          pid: m.pid,
          cpu: m.cpu,
          memoryBytes: m.memory,
        }));
        const children: MetricRow[] = (data.children || []).map((m) => ({
          label: m.service.charAt(0).toUpperCase() + m.service.slice(1),
          pid: m.pid,
          cpu: m.cpu,
          memoryBytes: m.memory,
        }));

        if (!cancelled) {
          setElectronRows(electron);
          setChildRows(children);
          setLoading(false);
        }
      } catch {
        // backend not reachable
      }
    };

    poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  const allRows = [...childRows, ...electronRows];
  const intervalSec = (pollIntervalMs / 1000).toFixed(0);

  return (
    <>
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">⚡ Performance</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Auto-refreshes every {intervalSec}s</span>
        <div className="dev-panel-actions">
          <button
            className="dev-panel-btn"
            onClick={() => {
              setLoading(true);
              window.electronAPI?.getPerformanceMetrics().then((data) => {
                if (!data) return;
                setElectronRows(
                  (data.electron || []).map((m) => ({
                    label: m.type === "Browser" ? "Main / Renderer" : m.type,
                    pid: m.pid,
                    cpu: m.cpu,
                    memoryBytes: m.memory,
                  })),
                );
                setChildRows(
                  (data.children || []).map((m) => ({
                    label: m.service.charAt(0).toUpperCase() + m.service.slice(1),
                    pid: m.pid,
                    cpu: m.cpu,
                    memoryBytes: m.memory,
                  })),
                );
                setLoading(false);
              });
            }}
            title="Refresh now">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-list">
        {loading && <div className="dev-panel-empty">Fetching metrics...</div>}

        {!loading && allRows.length === 0 && <div className="dev-panel-empty">No process metrics available. Make sure services are running.</div>}

        {!loading && allRows.length > 0 && (
          <table className="dev-panel-metrics-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
                <th style={{ padding: "6px 12px", textAlign: "left" }}>Service</th>
                <th style={{ padding: "6px 12px", textAlign: "right" }}>PID</th>
                <th style={{ padding: "6px 12px", textAlign: "right" }}>CPU</th>
                <th style={{ padding: "6px 12px", textAlign: "right" }}>Memory</th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((r) => (
                <tr key={`${r.label}-${r.pid}`} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 12px" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        marginRight: 8,
                        backgroundColor: r.cpu !== null && r.cpu > 50 ? "#f85149" : r.cpu !== null && r.cpu > 20 ? "#d29922" : "#3fb950",
                      }}
                    />
                    {r.label}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>{r.pid ?? "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace" }}>{formatCpu(r.cpu)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace" }}>{formatMem(r.memoryBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dev-panel-footer">
        <span>{allRows.length} process(es)</span>
        <span>
          <span style={{ color: "#3fb950" }}>●</span> &lt;20% &nbsp;
          <span style={{ color: "#d29922" }}>●</span> 20–50% &nbsp;
          <span style={{ color: "#f85149" }}>●</span> &gt;50% CPU
        </span>
      </div>
    </>
  );
}

/* ── DevPanel ── */

export default function DevPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("live");

  return (
    <div className="dev-panel dev-panel--full">
      {/* Tab bar */}
      <div className="dev-panel-tabs">
        <button className={`dev-panel-tab ${activeTab === "live" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("live")}>
          📋 Live Logs
        </button>
        <button className={`dev-panel-tab ${activeTab === "files" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("files")}>
          📁 Log Files
        </button>
        <button className={`dev-panel-tab ${activeTab === "database" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("database")}>
          🗄️ Database
        </button>
        <button className={`dev-panel-tab ${activeTab === "performance" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("performance")}>
          ⚡ Performance
        </button>
        <div className="dev-panel-tabs-spacer" />
        <button className="dev-panel-btn dev-panel-btn-close" onClick={onClose} title="Close dev panel">
          ✕
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "live" && <LiveLogsTab />}
      {activeTab === "files" && <LogFilesTab />}
      {activeTab === "database" && <DatabaseTab />}
      {activeTab === "performance" && <PerformanceTab />}
    </div>
  );
}
