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

type Tab = "live" | "files" | "database" | "performance" | "updates";

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

/* ── LocalStorage keys for persisting log settings ── */

const LS_KEY_SOURCE = "devpanel:sourceFilter";
const LS_KEY_LEVEL = "devpanel:levelFilter";
const LS_KEY_SCROLL = "devpanel:autoScroll";

function loadPersisted(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePersisted(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage unavailable */
  }
}

/* ── Live Logs Tab ── */

function LiveLogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(loadPersisted(LS_KEY_SOURCE, "all") as SourceFilter);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>(loadPersisted(LS_KEY_LEVEL, "all") as LevelFilter);
  const [autoScroll, setAutoScroll] = useState(loadPersisted(LS_KEY_SCROLL, "true") === "true");
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Keep ref in sync with state so scroll logic can read the latest value
  // without being delayed by React batching
  const handleAutoScrollChange = useCallback((checked: boolean) => {
    setAutoScroll(checked);
    autoScrollRef.current = checked;
    savePersisted(LS_KEY_SCROLL, String(checked));
  }, []);

  // Persist filter changes
  const handleSourceFilterChange = useCallback((value: SourceFilter) => {
    setSourceFilter(value);
    savePersisted(LS_KEY_SOURCE, value);
  }, []);

  const handleLevelFilterChange = useCallback((value: LevelFilter) => {
    setLevelFilter(value);
    savePersisted(LS_KEY_LEVEL, value);
  }, []);

  // Sync autoScrollRef on mount and whenever autoScroll changes
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

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
          <select className="dev-panel-select" value={sourceFilter} onChange={(e) => handleSourceFilterChange(e.target.value as SourceFilter)}>
            <option value="all">All sources</option>
            <option value="python">Python</option>
            <option value="bridge">Bridge</option>
            <option value="agent">Agent</option>
            <option value="main">Main</option>
          </select>

          <select className="dev-panel-select" value={levelFilter} onChange={(e) => handleLevelFilterChange(e.target.value as LevelFilter)}>
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

/** Try to detect a source tag like [python], [bridge], [agent], [main] in a log line. */
function detectLogSource(line: string): string | null {
  const match = line.match(/\[(python|bridge|agent|main)\]/i);
  return match ? match[1].toLowerCase() : null;
}

/** Try to detect a log level like error, warn, info, debug in a log line. */
function detectLogLevel(line: string): string | null {
  const lower = line.toLowerCase();
  if (/\berror\b/.test(lower) || /\b❌\b/.test(line)) return "error";
  if (/\bwarn(ing)?\b/.test(lower) || /\b⚠️\b/.test(line)) return "warn";
  if (/\bdebug\b/.test(lower)) return "debug";
  if (/\binfo\b/.test(lower) || /\b✅\b/.test(line) || /\b📝\b/.test(line)) return "info";
  return null;
}

function LogFilesTab() {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string[]>([]);
  const [logPaths, setLogPaths] = useState<{ primary: string | null; mirror: string | null }>({ primary: null, mirror: null });
  const [logSourceFilter, setLogSourceFilter] = useState<string>("all");
  const [logLevelFilter, setLogLevelFilter] = useState<string>("all");
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

  // Filter file content by source and level
  const filteredContent = fileContent.filter((line) => {
    if (logSourceFilter !== "all") {
      const detected = detectLogSource(line);
      if (detected !== logSourceFilter) return false;
    }
    if (logLevelFilter !== "all") {
      const detected = detectLogLevel(line);
      if (detected !== logLevelFilter) return false;
    }
    return true;
  });

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

          {/* Filter toolbar — shown when a file is selected */}
          {selectedFile && fileContent.length > 0 && (
            <div className="dev-panel-file-filter-bar">
              <select className="dev-panel-file-filter-select" value={logSourceFilter} onChange={(e) => setLogSourceFilter(e.target.value)}>
                <option value="all">All sources</option>
                <option value="python">Python</option>
                <option value="bridge">Bridge</option>
                <option value="agent">Agent</option>
                <option value="main">Main</option>
              </select>
              <select className="dev-panel-file-filter-select" value={logLevelFilter} onChange={(e) => setLogLevelFilter(e.target.value)}>
                <option value="all">All levels</option>
                <option value="info">Info</option>
                <option value="warn">Warnings</option>
                <option value="error">Errors</option>
                <option value="debug">Debug</option>
              </select>
              <span className="dev-panel-file-filter-count">
                {filteredContent.length} / {fileContent.length} lines
              </span>
            </div>
          )}

          {selectedFile && filteredContent.length === 0 && fileContent.length > 0 && (
            <div className="dev-panel-empty">No lines match the current filters.</div>
          )}
          {selectedFile &&
            filteredContent.map((line, i) => (
              <div key={i} className="dev-panel-file-line">
                {line}
              </div>
            ))}
        </div>
      </div>

      {/* Footer with stats */}
      <div className="dev-panel-footer">
        <span>{files.length} file(s)</span>
        {selectedFile && (
          <span>
            {filteredContent.length} / {fileContent.length} lines
          </span>
        )}
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

interface SemanticStats {
  total_chunks: number;
  unique_meetings: number;
  chunks_by_type: Record<string, number>;
  embedding_dimension: number | null;
  collection_hnsw_space: string;
}

interface AttendeeOverlap {
  name: string;
  meeting_count: number;
  meetings: Array<{ job_id: string; title: string }>;
}

interface KeywordOverlap {
  word: string;
  meeting_count: number;
}

interface SemanticOverlap {
  common_attendees: AttendeeOverlap[];
  keyword_overlap: KeywordOverlap[];
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
  const [semanticStats, setSemanticStats] = useState<SemanticStats | null>(null);
  const [semanticOverlap, setSemanticOverlap] = useState<SemanticOverlap | null>(null);
  const [activeView, setActiveView] = useState<"ephemeral" | "semantic">("ephemeral");
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Search relevance state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    const result = await callBridge("memory_semantic_search", { query: query.trim(), n: 10 });
    if (result) {
      if (result.status === "ok") {
        setSearchResults(result.results || []);
      } else {
        setSearchError(result.error || "Search failed");
        setSearchResults(null);
      }
    } else {
      setSearchError("Bridge unreachable");
      setSearchResults(null);
    }
    setSearchLoading(false);
  }, []);

  const handleSearchInputChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => handleSearch(value), 400);
    },
    [handleSearch],
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
    setSearchError(null);
  }, []);

  const loadTables = useCallback(async () => {
    setLoading(true);
    const result = await callBridge("memory_ephemeral_tables");
    if (result?.tables) setTables(result.tables);
    setLoading(false);
  }, []);

  const loadMeetings = useCallback(async () => {
    setLoading(true);
    const [meetingsResult, statsResult, overlapResult] = await Promise.all([
      callBridge("memory_semantic_meetings"),
      callBridge("memory_semantic_stats"),
      callBridge("memory_semantic_overlap"),
    ]);
    if (meetingsResult?.meetings) setMeetings(meetingsResult.meetings);
    if (statsResult?.status === "ok") setSemanticStats(statsResult);
    if (overlapResult?.status === "ok") setSemanticOverlap(overlapResult);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTables();
    loadMeetings();
  }, [loadTables, loadMeetings]);

  const handleSelectTable = useCallback(async (tableName: string) => {
    setSelectedTable(tableName);
    setExpandedRows(new Set()); // Clear expanded state when switching tables
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

  // Render a cell value safely (truncated for table display)
  const renderCell = (val: any): string => {
    if (val === null || val === undefined) return "—";
    if (typeof val === "object") return JSON.stringify(val).slice(0, 80);
    return String(val);
  };

  // Render a cell value fully (for expanded detail view)
  const renderCellFull = (val: any): string => {
    if (val === null || val === undefined) return "—";
    if (typeof val === "object") return JSON.stringify(val, null, 2);
    return String(val);
  };

  // Track which rows are expanded (uses row index for ephemeral, meeting id for semantic)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleRow = (id: string | number) => {
    const key = String(id);
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
                <>
                  {expandedRows.size > 0 && (
                    <div className="dev-panel-db-collapse-bar">
                      <button className="dev-panel-db-collapse-btn" onClick={() => setExpandedRows(new Set())}>
                        ▲ Collapse all
                      </button>
                    </div>
                  )}
                  <table className="dev-panel-db-table">
                    <thead>
                      <tr>
                        <th className="dev-panel-db-cell-expand" />
                        {tableColumns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((row, i) => {
                        const rowKey = `ephemeral-${selectedTable}-${i}`;
                        const isExpanded = expandedRows.has(rowKey);
                        return (
                          <React.Fragment key={rowKey}>
                            <tr className={`dev-panel-db-row ${isExpanded ? "dev-panel-db-row--expanded" : ""}`} onClick={() => toggleRow(rowKey)}>
                              <td className="dev-panel-db-cell-expand">
                                <span className="dev-panel-db-expand-icon">{isExpanded ? "▼" : "▶"}</span>
                              </td>
                              {tableColumns.map((col) => (
                                <td key={col}>{renderCell(row[col])}</td>
                              ))}
                            </tr>
                            {isExpanded && (
                              <tr className="dev-panel-db-detail-row">
                                <td colSpan={tableColumns.length + 1}>
                                  <div className="dev-panel-db-detail">
                                    {tableColumns.map((col) => (
                                      <div key={col} className="dev-panel-db-detail-field">
                                        <span className="dev-panel-db-detail-label">{col}</span>
                                        <pre className="dev-panel-db-detail-value">{renderCellFull(row[col])}</pre>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </>
        )}

        {activeView === "semantic" && (
          <div className="dev-panel-db-content" ref={contentRef}>
            {loading && meetings.length === 0 && <div className="dev-panel-empty">Loading...</div>}
            {!loading && meetings.length === 0 && <div className="dev-panel-empty">No meetings stored in ChromaDB.</div>}

            {/* Stats bar */}
            {meetings.length > 0 && (
              <div className="dev-panel-db-stats">
                <span>{meetings.length} meeting(s) stored</span>
                <span className="dev-panel-db-stats-hint">Each meeting has summary + transcript chunks with embeddings</span>
              </div>
            )}

            {meetings.length > 0 && (
              <>
                {expandedRows.size > 0 && (
                  <div className="dev-panel-db-collapse-bar">
                    <button className="dev-panel-db-collapse-btn" onClick={() => setExpandedRows(new Set())}>
                      ▲ Collapse all
                    </button>
                  </div>
                )}
                <table className="dev-panel-db-table">
                  <thead>
                    <tr>
                      <th className="dev-panel-db-cell-expand" />
                      <th>Title</th>
                      <th>Job ID</th>
                      <th>Type</th>
                      <th>Attendees</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meetings.map((m) => {
                      const rowKey = `semantic-${m.id}`;
                      const isExpanded = expandedRows.has(rowKey);
                      return (
                        <React.Fragment key={m.id}>
                          <tr className={`dev-panel-db-row ${isExpanded ? "dev-panel-db-row--expanded" : ""}`} onClick={() => toggleRow(rowKey)}>
                            <td className="dev-panel-db-cell-expand">
                              <span className="dev-panel-db-expand-icon">{isExpanded ? "▼" : "▶"}</span>
                            </td>
                            <td>{m.title}</td>
                            <td className="dev-panel-db-cell-mono">{m.job_id?.slice(0, 12)}…</td>
                            <td>{m.type}</td>
                            <td>{m.attendees || "—"}</td>
                            <td>{m.timestamp || "—"}</td>
                          </tr>
                          {isExpanded && (
                            <tr className="dev-panel-db-detail-row">
                              <td colSpan={6}>
                                <div className="dev-panel-db-detail">
                                  <div className="dev-panel-db-detail-field">
                                    <span className="dev-panel-db-detail-label">Full Job ID</span>
                                    <pre className="dev-panel-db-detail-value">{m.job_id}</pre>
                                  </div>
                                  <div className="dev-panel-db-detail-field">
                                    <span className="dev-panel-db-detail-label">ChromaDB ID</span>
                                    <pre className="dev-panel-db-detail-value">{m.id}</pre>
                                  </div>
                                  <div className="dev-panel-db-detail-field">
                                    <span className="dev-panel-db-detail-label">Attendees (full)</span>
                                    <pre className="dev-panel-db-detail-value">{m.attendees || "—"}</pre>
                                  </div>
                                  <div className="dev-panel-db-detail-field">
                                    <span className="dev-panel-db-detail-label">Meeting Type</span>
                                    <pre className="dev-panel-db-detail-value">{m.type}</pre>
                                  </div>
                                  <div className="dev-panel-db-detail-field">
                                    <span className="dev-panel-db-detail-label">Timestamp</span>
                                    <pre className="dev-panel-db-detail-value">{m.timestamp || "—"}</pre>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            {/* ── Embedding Stats ── */}
            {semanticStats && (
              <div className="dev-panel-db-section">
                <h4 className="dev-panel-db-section-title">📊 Embedding Stats</h4>
                <div className="dev-panel-db-stat-cards">
                  <div className="dev-panel-db-stat-card">
                    <span className="dev-panel-db-stat-value">{semanticStats.unique_meetings}</span>
                    <span className="dev-panel-db-stat-label">Meetings</span>
                  </div>
                  <div className="dev-panel-db-stat-card">
                    <span className="dev-panel-db-stat-value">{semanticStats.total_chunks}</span>
                    <span className="dev-panel-db-stat-label">Total Chunks</span>
                  </div>
                  {semanticStats.embedding_dimension && (
                    <div className="dev-panel-db-stat-card">
                      <span className="dev-panel-db-stat-value">{semanticStats.embedding_dimension}</span>
                      <span className="dev-panel-db-stat-label">Vector Dims</span>
                    </div>
                  )}
                  <div className="dev-panel-db-stat-card">
                    <span className="dev-panel-db-stat-value">{semanticStats.collection_hnsw_space}</span>
                    <span className="dev-panel-db-stat-label">Distance Metric</span>
                  </div>
                </div>
                {/* Chunk type breakdown */}
                {Object.keys(semanticStats.chunks_by_type).length > 0 && (
                  <div className="dev-panel-db-chart">
                    {Object.entries(semanticStats.chunks_by_type).map(([type, count]) => (
                      <div key={type} className="dev-panel-db-chart-bar">
                        <span className="dev-panel-db-chart-label">{type}</span>
                        <div className="dev-panel-db-chart-track">
                          <div
                            className="dev-panel-db-chart-fill"
                            style={{
                              width: `${(count / semanticStats.total_chunks) * 100}%`,
                              background: type === "meeting_summary" ? "var(--accent)" : "var(--green)",
                            }}
                          />
                        </div>
                        <span className="dev-panel-db-chart-count">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Cross-Meeting Overlap ── */}
            {semanticOverlap && (
              <div className="dev-panel-db-section">
                <h4 className="dev-panel-db-section-title">🔄 Cross-Meeting Overlap</h4>

                {/* Common attendees */}
                {semanticOverlap.common_attendees.length > 0 && (
                  <div className="dev-panel-db-overlap-group">
                    <h5 className="dev-panel-db-overlap-title">👥 Common Attendees</h5>
                    {semanticOverlap.common_attendees.map((att) => (
                      <div key={att.name} className="dev-panel-db-overlap-item">
                        <div className="dev-panel-db-overlap-item-header">
                          <span className="dev-panel-db-overlap-name">{att.name}</span>
                          <span className="dev-panel-db-overlap-count">{att.meeting_count} meetings</span>
                        </div>
                        <div className="dev-panel-db-overlap-meetings">
                          {att.meetings.map((m) => (
                            <span key={m.job_id} className="dev-panel-db-overlap-tag" title={m.job_id}>
                              {m.title}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {semanticOverlap.common_attendees.length === 0 && (
                  <p className="dev-panel-db-empty-hint">No attendees appear in multiple meetings yet.</p>
                )}

                {/* Keyword overlap */}
                {semanticOverlap.keyword_overlap.length > 0 && (
                  <div className="dev-panel-db-overlap-group">
                    <h5 className="dev-panel-db-overlap-title">🏷️ Shared Keywords</h5>
                    <div className="dev-panel-db-tag-cloud">
                      {semanticOverlap.keyword_overlap.map((kw) => (
                        <span
                          key={kw.word}
                          className="dev-panel-db-tag"
                          style={{
                            opacity: Math.max(0.5, Math.min(1, kw.meeting_count / semanticOverlap.keyword_overlap[0].meeting_count)),
                          }}>
                          {kw.word}
                          <sup className="dev-panel-db-tag-count">{kw.meeting_count}</sup>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {semanticOverlap.keyword_overlap.length === 0 && (
                  <p className="dev-panel-db-empty-hint">No shared keywords found across meetings yet.</p>
                )}
              </div>
            )}

            {/* ── Search Relevance ── */}
            {meetings.length > 0 && (
              <div className="dev-panel-db-section">
                <h4 className="dev-panel-db-section-title">🔍 Search Relevance</h4>

                {/* Search input */}
                <div className="dev-panel-db-search-bar">
                  <span className="dev-panel-db-search-icon">🔍</span>
                  <input
                    className="dev-panel-db-search-input"
                    type="text"
                    placeholder="Search meetings by natural language query…"
                    value={searchQuery}
                    onChange={(e) => handleSearchInputChange(e.target.value)}
                  />
                  {searchQuery && (
                    <button className="dev-panel-db-search-clear" onClick={handleClearSearch} title="Clear search">
                      ✕
                    </button>
                  )}
                  {searchLoading && <span className="dev-panel-db-search-spinner" />}
                </div>

                {/* Error state */}
                {searchError && <div className="dev-panel-db-search-error">❌ {searchError}</div>}

                {/* Results */}
                {searchResults !== null && !searchLoading && (
                  <div className="dev-panel-db-search-results">
                    {searchResults.length === 0 ? (
                      <p className="dev-panel-db-empty-hint">No matching meetings found for &ldquo;{searchQuery}&rdquo;.</p>
                    ) : (
                      <>
                        <p className="dev-panel-db-search-count">
                          {searchResults.length} result(s) for &ldquo;{searchQuery}&rdquo;
                        </p>
                        {searchResults.map((r, i) => (
                          <div key={r.job_id || i} className="dev-panel-db-search-result">
                            <div className="dev-panel-db-search-result-header">
                              <span className="dev-panel-db-search-result-title">{r.title || "Untitled"}</span>
                              <span className="dev-panel-db-search-result-score">{(r.score !== undefined ? 1 - r.score : 0).toFixed(3)}</span>
                            </div>
                            <div className="dev-panel-db-search-result-meta">
                              <span className="dev-panel-db-cell-mono">{r.job_id?.slice(0, 12)}…</span>
                              <span className="dev-panel-db-search-result-divider">·</span>
                              <span>{r.metadata?.type || "—"}</span>
                            </div>
                            {r.document && <pre className="dev-panel-db-search-result-snippet">{r.document}</pre>}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {/* Initial state */}
                {searchResults === null && !searchLoading && (
                  <p className="dev-panel-db-empty-hint">
                    Type a natural-language query above to find relevant meetings. For example: <em>&ldquo;budget discussion&rdquo;</em> or{" "}
                    <em>&ldquo;Q4 planning&rdquo;</em>.
                  </p>
                )}
              </div>
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
  peakMemoryBytes: number | null;
  elapsedSec: number | null;
}

/** A single point in the rolling history buffer */
interface MetricSnapshot {
  timestamp: number;
  /** Keyed by "${label}::${pid}" */
  byKey: Record<string, { cpu: number | null; memoryBytes: number | null }>;
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

function formatElapsed(sec: number | null): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Inline SVG sparkline — renders a tiny line chart */
const SPARK_W = 80;
const SPARK_H = 24;
const SPARK_PAD = 2;

function Sparkline({ data, color }: { data: (number | null)[]; color: string }) {
  const valid = data.filter((v): v is number => v !== null && v !== undefined);
  if (valid.length < 2) return <span style={{ color: "var(--text-muted)", fontSize: 10, width: SPARK_W, display: "inline-block" }}>—</span>;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const w = SPARK_W - SPARK_PAD * 2;
  const h = SPARK_H - SPARK_PAD * 2;

  const points = valid
    .map((v, i) => {
      const x = SPARK_PAD + (i / (valid.length - 1)) * w;
      const y = SPARK_PAD + h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={SPARK_W} height={SPARK_H} style={{ verticalAlign: "middle" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const POLL_OPTIONS = [
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
];

const MAX_HISTORY = 30;

/**
 * Module-level shared history buffer — persists across component remounts
 * so switching sidebar views and back preserves the trend data.
 */
let sharedHistory: MetricSnapshot[] = [];
let sharedLoading = true;

function PerformanceTab() {
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(sharedLoading);
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);
  // Restore history from module-level buffer so trend survives remount
  const [history, setHistory] = useState<MetricSnapshot[]>(sharedHistory);

  // Core polling logic
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
          peakMemoryBytes: m.peakMemory,
          elapsedSec: null,
        }));
        const children: MetricRow[] = (data.children || []).map((m) => ({
          label: m.service.charAt(0).toUpperCase() + m.service.slice(1),
          pid: m.pid,
          cpu: m.cpu,
          memoryBytes: m.memory,
          peakMemoryBytes: null,
          elapsedSec: m.elapsed,
        }));

        const merged = [...children, ...electron];

        if (!cancelled) {
          setRows(merged);
          setLoading(false);
          sharedLoading = false;

          // Append to rolling history buffer (both state and module-level)
          const snap: MetricSnapshot = {
            timestamp: Date.now(),
            byKey: {},
          };
          for (const r of merged) {
            const key = `${r.label}::${r.pid}`;
            snap.byKey[key] = { cpu: r.cpu, memoryBytes: r.memoryBytes };
          }
          setHistory((prev) => {
            const next = [...prev, snap];
            const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            sharedHistory = trimmed; // sync module-level for remount survival
            return trimmed;
          });
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

  const handleRefresh = () => {
    setLoading(true);
    window.electronAPI?.getPerformanceMetrics().then((data) => {
      if (!data) return;
      const electron: MetricRow[] = (data.electron || []).map((m) => ({
        label: m.type === "Browser" ? "Main / Renderer" : m.type,
        pid: m.pid,
        cpu: m.cpu,
        memoryBytes: m.memory,
        peakMemoryBytes: m.peakMemory,
        elapsedSec: null,
      }));
      const children: MetricRow[] = (data.children || []).map((m) => ({
        label: m.service.charAt(0).toUpperCase() + m.service.slice(1),
        pid: m.pid,
        cpu: m.cpu,
        memoryBytes: m.memory,
        peakMemoryBytes: null,
        elapsedSec: m.elapsed,
      }));
      const merged = [...children, ...electron];
      setRows(merged);
      setLoading(false);
      sharedLoading = false;

      // Also append manual refresh to history
      const snap: MetricSnapshot = {
        timestamp: Date.now(),
        byKey: {},
      };
      for (const r of merged) {
        const key = `${r.label}::${r.pid}`;
        snap.byKey[key] = { cpu: r.cpu, memoryBytes: r.memoryBytes };
      }
      setHistory((prev) => {
        const next = [...prev, snap];
        const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        sharedHistory = trimmed;
        return trimmed;
      });
    });
  };

  const intervalSec = (pollIntervalMs / 1000).toFixed(0);

  return (
    <>
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">⚡ Live Monitoring</span>
        <div className="dev-panel-filters">
          <select
            className="dev-panel-select"
            value={pollIntervalMs}
            onChange={(e) => setPollIntervalMs(Number(e.target.value))}
            title="Polling interval">
            {POLL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                Every {opt.label}
              </option>
            ))}
          </select>
        </div>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {history.length}/{MAX_HISTORY} samples
        </span>
        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={handleRefresh} title="Refresh now">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-list">
        {loading && <div className="dev-panel-empty">Fetching metrics...</div>}

        {!loading && rows.length === 0 && <div className="dev-panel-empty">No process metrics available. Make sure services are running.</div>}

        {!loading && rows.length > 0 && (
          <table className="dev-panel-metrics-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10 }}>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Process</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>PID</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>CPU</th>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>CPU Trend</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Memory</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Peak</th>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Mem Trend</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Runtime</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = `${r.label}::${r.pid}`;
                const cpuHistory = history.map((s) => s.byKey[key]?.cpu ?? null);
                const memHistory = history.map((s) => s.byKey[key]?.memoryBytes ?? null);
                const cpuColor = r.cpu !== null ? (r.cpu > 50 ? "#f85149" : r.cpu > 20 ? "#d29922" : "#3fb950") : "#8b949e";
                return (
                  <tr key={key} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          marginRight: 6,
                          backgroundColor: cpuColor,
                        }}
                      />
                      {r.label}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>{r.pid ?? "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: cpuColor }}>{formatCpu(r.cpu)}</td>
                    <td style={{ padding: "2px 8px", textAlign: "left" }}>
                      <Sparkline data={cpuHistory} color={cpuColor} />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace" }}>{formatMem(r.memoryBytes)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>
                      {r.peakMemoryBytes ? formatMem(r.peakMemoryBytes) : "—"}
                    </td>
                    <td style={{ padding: "2px 8px", textAlign: "left" }}>
                      <Sparkline data={memHistory} color="#58a6ff" />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>
                      {formatElapsed(r.elapsedSec)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="dev-panel-footer">
        <span>
          {rows.length} process(es) · polled {history.length}x
        </span>
        <span>
          <span style={{ color: "#3fb950" }}>●</span> &lt;20% &nbsp;
          <span style={{ color: "#d29922" }}>●</span> 20–50% &nbsp;
          <span style={{ color: "#f85149" }}>●</span> &gt;50% CPU
        </span>
      </div>
    </>
  );
}

/* ── Updates Tab ── */

function UpdatesTab() {
  const [status, setStatus] = useState<any>(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    const s = await window.electronAPI?.getUpdateStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCheck = useCallback(async () => {
    setWorking(true);
    await window.electronAPI?.checkForUpdates();
    // Poll status until check completes
    const poll = setInterval(async () => {
      const s = await window.electronAPI?.getUpdateStatus();
      setStatus(s);
      if (!s?.checking) {
        clearInterval(poll);
        setWorking(false);
      }
    }, 1000);
  }, []);

  const handleDownload = useCallback(async () => {
    setWorking(true);
    await window.electronAPI?.downloadUpdate();
    const poll = setInterval(async () => {
      const s = await window.electronAPI?.getUpdateStatus();
      setStatus(s);
      if (s?.updateDownloaded || s?.error) {
        clearInterval(poll);
        setWorking(false);
      }
    }, 1000);
  }, []);

  const handleInstall = useCallback(async () => {
    await window.electronAPI?.installUpdate();
  }, []);

  if (!status) {
    return (
      <div className="dev-panel-empty" style={{ padding: 24 }}>
        Loading...
      </div>
    );
  }

  const modeLabel = status.mode === "packaged" ? "📦 Packaged App" : "🛠️ Development (git)";
  const statusIcon = status.checking ? "🔄" : status.updateDownloaded ? "✅" : status.updateAvailable ? "⬇️" : "✓";
  const versionLabel = status.mode === "packaged" ? `v${status.currentVersion}` : `branch: ${status.currentVersion}`;

  return (
    <div className="dev-panel-updates">
      {/* Header card */}
      <div className="config-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🔄 Auto-Update</h3>
          <span style={{ fontSize: 12, opacity: 0.7 }}>{modeLabel}</span>
        </div>

        <div className="config-field">
          <label className="config-label">Version</label>
          <div className="config-value-text">{versionLabel}</div>
        </div>

        <div className="config-field">
          <label className="config-label">Status</label>
          <div className="config-value-text">
            {statusIcon} {status.checking ? "Checking for updates..." : ""}
            {!status.checking && status.updateDownloaded ? "Update downloaded — ready to install" : ""}
            {!status.checking && !status.updateDownloaded && status.updateAvailable ? `Update available: ${status.updateAvailable}` : ""}
            {!status.checking && !status.updateDownloaded && !status.updateAvailable && !status.error ? "Up to date" : ""}
            {status.error ? `Error: ${status.error}` : ""}
          </div>
        </div>

        {status.lastCheck && (
          <div className="config-field">
            <label className="config-label">Last Check</label>
            <div className="config-value-text">{new Date(status.lastCheck).toLocaleString()}</div>
          </div>
        )}

        {status.lastUpdate && (
          <div className="config-field">
            <label className="config-label">Last Update</label>
            <div className="config-value-text">{new Date(status.lastUpdate).toLocaleString()}</div>
          </div>
        )}

        {status.downloadProgress !== null && (
          <div className="config-field">
            <label className="config-label">Download</label>
            <div className="config-value-text">
              <progress value={status.downloadProgress} max={100} style={{ width: 200, marginRight: 8 }} />
              {status.downloadProgress}%
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={handleCheck} disabled={working || status.checking}>
            {working && status.checking ? "Checking..." : "🔍 Check for Updates"}
          </button>

          {status.mode === "packaged" && status.updateAvailable && !status.updateDownloaded && (
            <button className="btn-primary" onClick={handleDownload} disabled={working}>
              {working ? "Downloading..." : "⬇️ Download Update"}
            </button>
          )}

          {status.updateDownloaded && (
            <button className="btn-primary" onClick={handleInstall} style={{ background: "#2ea043" }}>
              🔄 Restart &amp; Install
            </button>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={working}
              onChange={async (e) => {
                await window.electronAPI?.setAutoUpdateEnabled(e.target.checked);
                refresh();
              }}
            />
            Auto-check periodically
          </label>
        </div>

        {status.error && (
          <div className="error-box" style={{ marginTop: 12 }}>
            {status.error}
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="config-section" style={{ marginTop: 16 }}>
        <h4 style={{ margin: "0 0 8px" }}>How it works</h4>
        {status.mode === "dev" ? (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
            <li>Checks the Git repository every 12 hours for new commits</li>
            <li>On finding updates: pulls, installs deps, rebuilds, and restarts</li>
            <li>Only works in development mode (source code + git required)</li>
          </ul>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
            <li>Checks GitHub Releases every hour for new versions</li>
            <li>
              Click <strong>Download Update</strong> to download the new version
            </li>
            <li>
              Click <strong>Restart &amp; Install</strong> to apply the update
            </li>
            <li>
              Update source is configured in <code>electron/package.json → build.publish</code>
            </li>
          </ul>
        )}
      </div>
    </div>
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
        <button className={`dev-panel-tab ${activeTab === "updates" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("updates")}>
          🔄 Updates
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
      {activeTab === "updates" && <UpdatesTab />}
    </div>
  );
}
