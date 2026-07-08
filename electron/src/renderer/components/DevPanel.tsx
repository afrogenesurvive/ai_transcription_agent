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

type Tab = "live" | "files" | "database" | "performance" | "usage" | "updates";

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
  const fileListRef = useRef<HTMLDivElement>(null);
  const [fileListWidth, setFileListWidth] = useState(240);
  const fileListResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleFileListResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const list = fileListRef.current;
    if (!list) return;
    fileListResizeRef.current = { startX: e.clientX, startWidth: list.offsetWidth };
    const handleMouseMove = (me: MouseEvent) => {
      if (!fileListResizeRef.current) return;
      const diff = me.clientX - fileListResizeRef.current.startX;
      setFileListWidth(Math.max(140, Math.min(500, fileListResizeRef.current.startWidth + diff)));
    };
    const handleMouseUp = () => {
      fileListResizeRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("dev-panel-sidebar-resizing");
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.classList.add("dev-panel-sidebar-resizing");
  }, []);

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
        <div className="dev-panel-file-list" ref={fileListRef} style={{ width: fileListWidth }}>
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

        {/* Sidebar resize handle */}
        <div className="dev-panel-sidebar-resize-handle" onMouseDown={handleFileListResizeStart} />

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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [dbSidebarWidth, setDbSidebarWidth] = useState(200);
  const dbResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleDbSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    dbResizeRef.current = { startX: e.clientX, startWidth: sidebar.offsetWidth };
    const handleMouseMove = (me: MouseEvent) => {
      if (!dbResizeRef.current) return;
      const diff = me.clientX - dbResizeRef.current.startX;
      setDbSidebarWidth(Math.max(120, Math.min(400, dbResizeRef.current.startWidth + diff)));
    };
    const handleMouseUp = () => {
      dbResizeRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("dev-panel-sidebar-resizing");
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.classList.add("dev-panel-sidebar-resizing");
  }, []);

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

  // ── Column resizing (drag the right edge of any header cell) ──
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef<{ columnKey: string; startX: number; startWidth: number } | null>(null);

  const handleThMouseDown = useCallback((columnKey: string, e: React.MouseEvent) => {
    // Only activate resize when the mousedown is near the right edge of the header
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const rect = th.getBoundingClientRect();
    const xInCell = e.clientX - rect.left;
    // Wider activation zone (16px) for easier targeting
    if (xInCell < rect.width - 16) return;

    e.preventDefault();
    e.stopPropagation();
    const currentWidth = th.offsetWidth;
    resizingRef.current = { columnKey, startX: e.clientX, startWidth: currentWidth };

    const handleMouseMove = (me: MouseEvent) => {
      if (!resizingRef.current) return;
      const { columnKey, startX, startWidth } = resizingRef.current;
      const diff = me.clientX - startX;
      const newWidth = Math.max(60, startWidth + diff);
      setColumnWidths((prev) => ({ ...prev, [columnKey]: newWidth }));
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("dev-panel-db-resizing");
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.classList.add("dev-panel-db-resizing");
  }, []);

  // Clear column widths when switching tables/views
  useEffect(() => {
    setColumnWidths({});
  }, [selectedTable, activeView]);

  // Render a column header — drag the right border to resize
  const renderTh = (label: string, columnKey?: string) => {
    const key = columnKey || label;
    const width = columnWidths[key];
    return (
      <th
        key={key}
        className="dev-panel-db-th"
        style={width ? { width, minWidth: 60, maxWidth: 1200 } : {}}
        onMouseDown={(e) => handleThMouseDown(key, e)}>
        <span>{label}</span>
      </th>
    );
  };

  // Render a cell — always nowrap so collapsed rows determine column widths
  // Expanded rows (detail cells) wrap instead, increasing row height
  const renderTd = (content: React.ReactNode, key: string) => (
    <td key={key} className="dev-panel-db-cell-nowrap">
      {content}
    </td>
  );

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
          {expandedRows.size > 0 && (
            <button className="dev-panel-db-collapse-btn" onClick={() => setExpandedRows(new Set())}>
              ▲ Collapse all
            </button>
          )}
          <button className="dev-panel-btn" onClick={handleRefresh} title="Refresh database">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-db">
        {activeView === "ephemeral" && (
          <>
            {/* Table list sidebar */}
            <div className="dev-panel-db-sidebar" ref={sidebarRef} style={{ width: dbSidebarWidth }}>
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

            {/* Sidebar resize handle */}
            <div className="dev-panel-sidebar-resize-handle" onMouseDown={handleDbSidebarResizeStart} />

            {/* Table content */}
            <div className="dev-panel-db-content" ref={contentRef}>
              {!selectedTable && <div className="dev-panel-empty">Select a table to view its rows.</div>}
              {selectedTable && tableRows.length === 0 && <div className="dev-panel-empty">(empty table)</div>}
              {selectedTable && tableRows.length > 0 && (
                <>
                  <table className="dev-panel-db-table">
                    <thead>
                      <tr>
                        <th className="dev-panel-db-cell-expand" style={{ width: 28, minWidth: 28 }} />
                        {tableColumns.map((col) => renderTh(col))}
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
                              {isExpanded
                                ? tableColumns.map((col) => (
                                    <td key={col} className="dev-panel-db-detail-cell">
                                      {renderCellFull(row[col])}
                                    </td>
                                  ))
                                : tableColumns.map((col) => renderTd(renderCell(row[col]), col))}
                            </tr>
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
                <table className="dev-panel-db-table">
                  <thead>
                    <tr>
                      <th className="dev-panel-db-cell-expand" style={{ width: 28, minWidth: 28 }} />
                      {renderTh("Title", "semantic-title")}
                      {renderTh("Job ID", "semantic-job_id")}
                      {renderTh("Type", "semantic-type")}
                      {renderTh("Attendees", "semantic-attendees")}
                      {renderTh("Timestamp", "semantic-timestamp")}
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
                            {isExpanded ? (
                              <>
                                <td className="dev-panel-db-detail-cell">{m.title || "—"}</td>
                                <td className="dev-panel-db-detail-cell">{m.job_id}</td>
                                <td className="dev-panel-db-detail-cell">{m.type || "—"}</td>
                                <td className="dev-panel-db-detail-cell">{m.attendees || "—"}</td>
                                <td className="dev-panel-db-detail-cell">{m.timestamp || "—"}</td>
                              </>
                            ) : (
                              <>
                                {renderTd(m.title, "title")}
                                {renderTd(<span className="dev-panel-db-cell-mono">{m.job_id?.slice(0, 12)}…</span>, "job_id")}
                                {renderTd(m.type, "type")}
                                {renderTd(m.attendees || "—", "attendees")}
                                {renderTd(m.timestamp || "—", "timestamp")}
                              </>
                            )}
                          </tr>
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
  /** Active job ID at time of snapshot (null if no job running) */
  jobId: string | null;
  /** Pipeline stage key at time of snapshot */
  stage: string | null;
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

/** Inline SVG sparkline — renders a tiny line chart with optional vertical stage markers */
const SPARK_W = 80;
const SPARK_H = 24;
const SPARK_PAD = 2;

/** Stage marker colors for each pipeline stage */
const STAGE_MARKER_COLORS: Record<string, string> = {
  uploaded: "#8b949e",
  initializing: "#58a6ff",
  diarization: "#d29922",
  voiceprints: "#bc8cff",
  transcription: "#3fb950",
  aligning: "#79c0ff",
  agent: "#f0883e",
  memory: "#f85149",
  delivery: "#2ea043",
};

function Sparkline({ data, color, markers }: { data: (number | null)[]; color: string; markers?: { index: number; stage: string }[] }) {
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
      {/* Stage transition markers (vertical dashed lines) */}
      {markers?.map((m, i) => {
        // Map marker index to x position (only if within data length)
        if (m.index <= 0 || m.index >= valid.length) return null;
        const x = SPARK_PAD + (m.index / (valid.length - 1)) * w;
        const markerColor = STAGE_MARKER_COLORS[m.stage] || "#58a6ff";
        return (
          <g key={i}>
            <line x1={x} y1={SPARK_PAD} x2={x} y2={SPARK_PAD + h} stroke={markerColor} strokeWidth={1} strokeDasharray="2,2" opacity={0.6} />
          </g>
        );
      })}
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

/** Pipeline stage key → friendly label */
const STAGE_LABELS: Record<string, string> = {
  uploaded: "Uploading",
  initializing: "Getting Ready",
  diarization: "Identifying Speakers",
  voiceprints: "Matching Voices",
  transcription: "Transcribing Speech",
  aligning: "Building Transcript",
  agent: "AI Processing",
  memory: "Saving to Memory",
  delivery: "Delivering Results",
};

/** Map backend status values to pipeline stage keys */
const STATUS_TO_STAGE: Record<string, string> = {
  uploaded: "uploaded",
  initializing: "initializing",
  processing_diarization: "diarization",
  matching_voiceprints: "voiceprints",
  processing_transcription: "transcription",
  aligning: "aligning",
  transcribed: "agent",
  ready_for_agent: "agent",
  labeling_needed: "agent",
  refined: "agent",
  summarized: "agent",
  analyzed: "memory",
  delivered: "delivery",
  complete: "delivery",
};

/**
 * Module-level shared history buffer — persists across component remounts
 * so switching sidebar views and back preserves the trend data.
 */
let sharedHistory: MetricSnapshot[] = [];
let sharedLoading = true;
/** Module-level pipeline stage markers — positions + stage key for each transition */
let sharedStageMarkers: { index: number; stage: string; label: string }[] = [];
let lastKnownStage: string | null = null;

function PerformanceTab() {
  const [aggData, setAggData] = useState<
    Array<{
      jobId: string;
      samples: Array<{ timestamp: number; cpu: number; memoryBytes: number; label: string; stage: string | null }>;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await window.electronAPI?.getAggregatePerformance();
      if (data) setAggData(data);
      setLoading(false);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchData, pollIntervalMs]);

  // Flatten all samples across all jobs, sorted by timestamp, annotated with jobId
  const allSamples = aggData.flatMap((job) => job.samples.map((s) => ({ ...s, jobId: job.jobId }))).sort((a, b) => a.timestamp - b.timestamp);

  const cpuVals = allSamples.map((s) => s.cpu);
  const memVals = allSamples.map((s) => s.memoryBytes);
  const maxCpu = Math.max(...cpuVals, 1);
  const maxMem = Math.max(...memVals, 1);
  const startTime = allSamples.length > 0 ? allSamples[0].timestamp : Date.now();
  const duration = allSamples.length > 0 ? allSamples[allSamples.length - 1].timestamp - startTime : 1;

  // Build job transition boundaries
  const jobSegments: { jobId: string; startIdx: number; endIdx: number; color: string; samples: typeof allSamples }[] = [];
  const jobColors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#f0883e", "#79c0ff", "#2ea043"];
  const jobColorMap = new Map<string, string>();
  let colorIdx = 0;
  allSamples.forEach((s, i) => {
    if (!jobColorMap.has(s.jobId)) jobColorMap.set(s.jobId, jobColors[colorIdx++ % jobColors.length]);
    if (jobSegments.length === 0 || jobSegments[jobSegments.length - 1].jobId !== s.jobId) {
      jobSegments.push({ jobId: s.jobId, startIdx: i, endIdx: i, color: jobColorMap.get(s.jobId)!, samples: [] });
    }
    jobSegments[jobSegments.length - 1].endIdx = i;
    jobSegments[jobSegments.length - 1].samples.push(s);
  });

  // Build stage transition markers across all samples
  const stageMarkers: { index: number; stage: string; label: string }[] = [];
  let lastStage: string | null = null;
  allSamples.forEach((s, i) => {
    if (s.stage && s.stage !== lastStage && lastStage !== null) {
      stageMarkers.push({ index: i, stage: s.stage, label: STAGE_LABELS[s.stage] || s.stage });
    }
    if (s.stage) lastStage = s.stage;
  });

  const chartW = 900;
  const chartH = 280;
  const padX = 60;
  const padY = 48;
  const labelAreaH = 60; // space at bottom for stage + job labels

  const makePoints = (data: number[], maxVal: number, offset = 0) =>
    data
      .map((v, i) => {
        const x = padX + (i / Math.max(1, data.length - 1)) * (chartW - padX * 2);
        const y = padY + chartH - ((v + offset) / maxVal) * chartH;
        return `${x},${y}`;
      })
      .join(" ");

  const intervalSec = (pollIntervalMs / 1000).toFixed(0);

  return (
    <>
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">⚡ Performance Across Jobs</span>
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
          {aggData.length} job(s) · {allSamples.length} samples
        </span>
        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={fetchData} title="Refresh now">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-list" style={{ fontFamily: "var(--font)" }}>
        {loading && <div className="dev-panel-empty">Loading performance data...</div>}
        {error && (
          <div className="dev-panel-empty" style={{ color: "var(--red)" }}>
            ❌ {error}
          </div>
        )}

        {!loading && !error && allSamples.length === 0 && (
          <div className="dev-panel-empty">No performance data available. Performance is recorded during active jobs.</div>
        )}

        {!loading && allSamples.length > 1 && (
          <>
            {/* Summary cards */}
            <div className="dev-panel-db-stat-cards" style={{ padding: "8px 12px", margin: 0 }}>
              <div className="dev-panel-db-stat-card" style={{ minWidth: 70 }}>
                <span className="dev-panel-db-stat-value" style={{ color: "#58a6ff" }}>
                  {maxCpu.toFixed(1)}%
                </span>
                <span className="dev-panel-db-stat-label">Peak CPU</span>
              </div>
              <div className="dev-panel-db-stat-card" style={{ minWidth: 70 }}>
                <span className="dev-panel-db-stat-value" style={{ color: "#3fb950" }}>
                  {formatMem(maxMem)}
                </span>
                <span className="dev-panel-db-stat-label">Peak Memory</span>
              </div>
            </div>

            {/* Main chart — one big graph across all jobs */}
            <div className="usage-bar-chart" style={{ margin: "8px 12px" }}>
              <div style={{ fontSize: "var(--fs-11)", fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
                📈 CPU & Memory Across Jobs
                <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 10, opacity: 0.7 }}>
                  {aggData.length} job(s) · {allSamples.length} samples
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <svg
                  viewBox={`0 0 ${chartW} ${chartH + labelAreaH + 10}`}
                  width="100%"
                  height={chartH + labelAreaH + 10}
                  style={{ display: "block", minWidth: 500 }}>
                  <rect x={0} y={0} width={chartW} height={chartH + labelAreaH + 10} fill="var(--surface)" rx={6} />

                  {/* Grid lines */}
                  {[0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) => {
                    const y = padY + chartH - frac * chartH;
                    return (
                      <g key={frac}>
                        <line x1={padX} y1={y} x2={chartW - padX} y2={y} stroke="var(--border)" strokeWidth={0.5} opacity={0.3} />
                        <text x={padX - 8} y={y + 3} fill="var(--text-muted)" fontSize={8} textAnchor="end">
                          {formatCpu(maxCpu * frac)}
                        </text>
                      </g>
                    );
                  })}
                  {/* Secondary Y-axis (memory) labels — right side */}
                  {[0, 0.5, 1].map((frac) => {
                    const y = padY + chartH - frac * chartH;
                    return (
                      <text key={`mem-${frac}`} x={chartW - padX + 8} y={y + 3} fill="#3fb950" fontSize={7} textAnchor="start" opacity={0.6}>
                        {formatMem(maxMem * frac)}
                      </text>
                    );
                  })}
                  {/* Axis labels */}
                  <text
                    x={padX - 30}
                    y={padY + chartH / 2}
                    fill="var(--text-muted)"
                    fontSize={8}
                    textAnchor="middle"
                    transform={`rotate(-90, ${padX - 30}, ${padY + chartH / 2})`}
                    opacity={0.5}>
                    CPU
                  </text>
                  <text
                    x={chartW - padX + 20}
                    y={padY + chartH / 2}
                    fill="#3fb950"
                    fontSize={8}
                    textAnchor="middle"
                    transform={`rotate(90, ${chartW - padX + 20}, ${padY + chartH / 2})`}
                    opacity={0.5}>
                    Memory
                  </text>

                  {/* Job segment background highlights */}
                  {jobSegments.map((seg, i) => {
                    const x1 = padX + (seg.startIdx / Math.max(1, allSamples.length - 1)) * (chartW - padX * 2);
                    const x2 = padX + (seg.endIdx / Math.max(1, allSamples.length - 1)) * (chartW - padX * 2);
                    return <rect key={i} x={x1} y={padY} width={Math.max(3, x2 - x1)} height={chartH} fill={seg.color} opacity={0.05} rx={2} />;
                  })}

                  {/* CPU line */}
                  <polyline
                    points={makePoints(cpuVals, maxCpu || 1)}
                    fill="none"
                    stroke="#58a6ff"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.85}
                  />
                  {/* Memory line */}
                  <polyline
                    points={makePoints(memVals, maxMem || 1)}
                    fill="none"
                    stroke="#3fb950"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="4,3"
                    opacity={0.7}
                  />

                  {/* ── Job boundary markers (solid lines, labeled at top) ── */}
                  {jobSegments.slice(1).map((seg, i) => {
                    const x = padX + (seg.startIdx / Math.max(1, allSamples.length - 1)) * (chartW - padX * 2);
                    return (
                      <g key={i}>
                        <line x1={x} y1={padY} x2={x} y2={padY + chartH} stroke={seg.color} strokeWidth={2} opacity={0.5} />
                      </g>
                    );
                  })}
                  {/* Job ID labels at top of chart */}
                  {jobSegments.map((seg, i) => {
                    const midIdx = Math.floor((seg.startIdx + seg.endIdx) / 2);
                    const x = padX + (midIdx / Math.max(1, allSamples.length - 1)) * (chartW - padX * 2);
                    return (
                      <g key={i}>
                        <rect x={x - 28} y={padY - 18} width={56} height={14} rx={3} fill={seg.color} opacity={0.15} />
                        <text x={x} y={padY - 7} fill={seg.color} fontSize={9} textAnchor="middle" fontWeight={600}>
                          {seg.jobId.slice(0, 8)}
                        </text>
                      </g>
                    );
                  })}

                  {/* ── Stage transition markers (dashed lines, labeled at bottom) ── */}
                  {stageMarkers.map((m, i) => {
                    const x = padX + (m.index / Math.max(1, allSamples.length - 1)) * (chartW - padX * 2);
                    const color = STAGE_MARKER_COLORS[m.stage] || "#58a6ff";
                    return (
                      <g key={i}>
                        <line x1={x} y1={padY} x2={x} y2={padY + chartH} stroke={color} strokeWidth={1} strokeDasharray="3,3" opacity={0.7} />
                        <rect x={x - 16} y={padY + chartH + 2} width={32} height={14} rx={3} fill={color} opacity={0.12} />
                        <text x={x} y={padY + chartH + 12} fill={color} fontSize={8} textAnchor="middle" fontWeight={500}>
                          {m.label.slice(0, 8)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              {/* Legend */}
              <div
                style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: "var(--text-muted)", flexWrap: "wrap", alignItems: "center" }}>
                <span>
                  <span style={{ color: "#58a6ff" }}>━</span> CPU
                </span>
                <span>
                  <span style={{ color: "#3fb950" }}>┅</span> Memory
                </span>
                <span style={{ borderLeft: "1px solid var(--border)", paddingLeft: 12 }}>
                  <span style={{ opacity: 0.6 }}>━</span> Job boundary
                </span>
                <span>
                  <span style={{ opacity: 0.6 }}>╌</span> Stage marker
                </span>
                {jobSegments.slice(0, 3).map((seg) => (
                  <span key={seg.jobId}>
                    <span style={{ color: seg.color }}>▬</span> {seg.jobId.slice(0, 8)}
                  </span>
                ))}
                {jobSegments.length > 3 && <span style={{ opacity: 0.5 }}>+{jobSegments.length - 3} more</span>}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="dev-panel-footer">
        <span>
          {aggData.length} job(s) · polled every {intervalSec}s
          {stageMarkers.length > 0 && <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.7 }}>· {stageMarkers.length} stage markers</span>}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#58a6ff" }}>●</span> CPU <span style={{ color: "#3fb950" }}>●</span> Memory
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

/* ── Usage Tab ── */

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function UsageTab() {
  const [balance, setBalance] = useState<{ balance: string | null; available: boolean; error: string | null } | null>(null);
  const [pollInterval, setPollInterval] = useState(60000);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [aggregate, setAggregate] = useState<{
    jobs: Array<{
      job_id: string;
      title: string;
      provider: string;
      model: string;
      step_count: number;
      totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      saved_at: string;
    }>;
    totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    job_count: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"date" | "tokens">("date");

  // Load config for credit poll interval
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      const val = Number(cfg.CREDIT_POLL_INTERVAL) || 60000;
      setPollInterval(val);
      setConfigLoaded(true);
    });
  }, []);

  // Poll credit balance
  useEffect(() => {
    if (!configLoaded) return;
    const poll = async () => {
      const result = await window.electronAPI?.checkDeepSeekBalance();
      if (result) setBalance(result);
    };
    poll();
    const interval = setInterval(poll, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval, configLoaded]);

  // Save updated poll interval
  const handleIntervalChange = useCallback(async (ms: number) => {
    setPollInterval(ms);
    await window.electronAPI?.saveConfig({ CREDIT_POLL_INTERVAL: String(ms) });
  }, []);

  // Fetch aggregate token usage
  const fetchAggregate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getAggregateUsage();
      if (result?.error) {
        setError(result.error);
      } else if (result) {
        setAggregate(result);
      } else {
        setError("Bridge unreachable");
      }
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAggregate();
  }, [fetchAggregate]);

  // Sort jobs
  const sortedJobs = aggregate?.jobs
    ? [...aggregate.jobs].sort((a, b) => {
        if (sortBy === "tokens") return b.totals.total_tokens - a.totals.total_tokens;
        return b.saved_at.localeCompare(a.saved_at);
      })
    : [];

  // Bar chart config
  const maxTokens = Math.max(...sortedJobs.map((j) => j.totals.total_tokens), 1);
  const BAR_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#8b949e", "#bc8cff", "#f0883e", "#79c0ff"];

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">💰 Usage</span>
        <div className="dev-panel-filters">
          <select
            className="dev-panel-select"
            value={pollInterval}
            onChange={(e) => handleIntervalChange(Number(e.target.value))}
            title="Credit polling interval">
            <option value={30000}>Every 30s</option>
            <option value={60000}>Every 1 min</option>
            <option value={300000}>Every 5 min</option>
            <option value={600000}>Every 10 min</option>
          </select>
        </div>
        <div className="dev-panel-actions">
          <button className="dev-panel-btn" onClick={fetchAggregate} title="Refresh usage data">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-list" style={{ padding: "12px 16px", fontFamily: "var(--font)" }}>
        {/* ── Credit Balance Card ── */}
        <div style={{ marginBottom: 20 }}>
          <h4
            style={{
              fontSize: "var(--fs-12)",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              margin: "0 0 10px",
            }}>
            💳 DeepSeek API Credit Balance
          </h4>
          <div className="dev-panel-db-stat-cards" style={{ marginBottom: 0 }}>
            <div className="dev-panel-db-stat-card" style={{ minWidth: 140 }}>
              <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-24)" }}>
                {balance === null ? (
                  <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)" }}>Checking...</span>
                ) : balance.error ? (
                  <span style={{ color: "var(--red)", fontSize: "var(--fs-12)" }}>Error</span>
                ) : (
                  <>${parseFloat(balance.balance || "0").toFixed(2)}</>
                )}
              </span>
              <span className="dev-panel-db-stat-label">Balance</span>
            </div>
            <div className="dev-panel-db-stat-card" style={{ minWidth: 100 }}>
              <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-16)" }}>
                {balance === null ? (
                  "—"
                ) : balance.available ? (
                  <span style={{ color: "var(--green)" }}>✅ Available</span>
                ) : (
                  <span style={{ color: "var(--red)" }}>❌ Unavailable</span>
                )}
              </span>
              <span className="dev-panel-db-stat-label">Status</span>
            </div>
            {balance?.error && (
              <div className="dev-panel-db-stat-card" style={{ minWidth: 200, flex: 2 }}>
                <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-10)", color: "var(--red)", fontWeight: 400 }}>
                  {balance.error}
                </span>
                <span className="dev-panel-db-stat-label">Error</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Token Usage ── */}
        <div>
          <h4
            style={{
              fontSize: "var(--fs-12)",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              margin: "0 0 10px",
            }}>
            📊 Token Usage Across Jobs
          </h4>

          {loading && (
            <div className="dev-panel-empty" style={{ padding: 12 }}>
              Loading token usage data...
            </div>
          )}
          {error && (
            <div className="dev-panel-empty" style={{ padding: 12, color: "var(--red)" }}>
              ❌ {error}
            </div>
          )}

          {!loading && !error && aggregate && (
            <>
              {/* Summary cards */}
              <div className="dev-panel-db-stat-cards" style={{ marginBottom: 14 }}>
                <div className="dev-panel-db-stat-card" style={{ minWidth: 80 }}>
                  <span className="dev-panel-db-stat-value">{aggregate.job_count}</span>
                  <span className="dev-panel-db-stat-label">Jobs</span>
                </div>
                <div className="dev-panel-db-stat-card" style={{ minWidth: 80 }}>
                  <span className="dev-panel-db-stat-value">{formatTokenCount(aggregate.totals.total_tokens)}</span>
                  <span className="dev-panel-db-stat-label">Total Tokens</span>
                </div>
                <div className="dev-panel-db-stat-card" style={{ minWidth: 80 }}>
                  <span className="dev-panel-db-stat-value">{formatTokenCount(aggregate.totals.prompt_tokens)}</span>
                  <span className="dev-panel-db-stat-label">Prompt</span>
                </div>
                <div className="dev-panel-db-stat-card" style={{ minWidth: 80 }}>
                  <span className="dev-panel-db-stat-value">{formatTokenCount(aggregate.totals.completion_tokens)}</span>
                  <span className="dev-panel-db-stat-label">Completion</span>
                </div>
              </div>

              {/* ── Token Usage Over Time Chart ── */}
              {sortedJobs.length > 1 && (
                <div className="usage-bar-chart" style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", marginBottom: 8, fontWeight: 600 }}>
                    📈 Token Usage Over Time
                  </div>
                  <svg width="100%" height={140} viewBox={`0 0 ${Math.max(400, sortedJobs.length * 80)} 140`} style={{ display: "block" }}>
                    {/* Background */}
                    <rect x={0} y={0} width="100%" height={140} fill="var(--bg)" rx={4} />
                    {(() => {
                      const chartW = Math.max(400, sortedJobs.length * 80) - 40;
                      const chartH = 100;
                      const padX = 30;
                      const padY = 20;
                      const maxT = Math.max(...sortedJobs.map((j) => j.totals.total_tokens), 1);
                      // Sort by date for timeline
                      const byDate = [...sortedJobs].sort((a, b) => a.saved_at.localeCompare(b.saved_at));
                      const totalHistory = byDate.map((j) => j.totals.total_tokens);
                      const promptHistory = byDate.map((j) => j.totals.prompt_tokens);
                      const completionHistory = byDate.map((j) => j.totals.completion_tokens);
                      const makePoints = (data: number[]) =>
                        data
                          .map((v, i) => {
                            const x = padX + (i / Math.max(1, data.length - 1)) * chartW;
                            const y = padY + chartH - (v / maxT) * chartH;
                            return `${x},${y}`;
                          })
                          .join(" ");
                      return (
                        <>
                          {/* Grid lines */}
                          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                            const y = padY + chartH - frac * chartH;
                            return (
                              <g key={frac}>
                                <line x1={padX} y1={y} x2={padX + chartW} y2={y} stroke="var(--border)" strokeWidth={0.5} opacity={0.5} />
                                <text x={padX - 4} y={y + 3} fill="var(--text-muted)" fontSize={8} textAnchor="end">
                                  {formatTokenCount(maxT * frac)}
                                </text>
                              </g>
                            );
                          })}
                          {/* Total tokens line */}
                          <polyline
                            points={makePoints(totalHistory)}
                            fill="none"
                            stroke="#58a6ff"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={0.8}
                          />
                          {/* Prompt tokens line */}
                          <polyline
                            points={makePoints(promptHistory)}
                            fill="none"
                            stroke="#3fb950"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeDasharray="4,3"
                            opacity={0.6}
                          />
                          {/* Completion tokens line */}
                          <polyline
                            points={makePoints(completionHistory)}
                            fill="none"
                            stroke="#d29922"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeDasharray="2,3"
                            opacity={0.6}
                          />
                          {/* Date labels */}
                          {byDate.map((j, i) => {
                            const x = padX + (i / Math.max(1, byDate.length - 1)) * chartW;
                            const date = j.saved_at ? new Date(j.saved_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
                            // Only show every few labels to avoid crowding
                            if (byDate.length > 8 && i % Math.ceil(byDate.length / 6) !== 0 && i !== byDate.length - 1) return null;
                            return (
                              <text key={i} x={x} y={padY + chartH + 14} fill="var(--text-muted)" fontSize={8} textAnchor="middle" opacity={0.7}>
                                {date}
                              </text>
                            );
                          })}
                          {/* Data dots on total line */}
                          {totalHistory.map((v, i) => {
                            const x = padX + (i / Math.max(1, totalHistory.length - 1)) * chartW;
                            const y = padY + chartH - (v / maxT) * chartH;
                            return (
                              <circle key={i} cx={x} cy={y} r={3} fill="#58a6ff" opacity={0.7}>
                                <title>{`${byDate[i]?.title || byDate[i]?.job_id}: ${v.toLocaleString()} tokens`}</title>
                              </circle>
                            );
                          })}
                        </>
                      );
                    })()}
                  </svg>
                  {/* Legend */}
                  <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                    <span>
                      <span style={{ color: "#58a6ff" }}>━</span> Total
                    </span>
                    <span>
                      <span style={{ color: "#3fb950" }}>┅</span> Prompt
                    </span>
                    <span>
                      <span style={{ color: "#d29922" }}>╌</span> Completion
                    </span>
                  </div>
                </div>
              )}

              {/* Vertical bar chart — job names on X, token count on Y, sorted by time */}
              {sortedJobs.length > 0 && (
                <div className="usage-bar-chart" style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", fontWeight: 600 }}>📊 Token Usage Per Job</span>
                    <select
                      className="dev-panel-select"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as "date" | "tokens")}
                      style={{ fontSize: "var(--fs-10)" }}>
                      <option value="date">Sort by time</option>
                      <option value="tokens">Sort by tokens</option>
                    </select>
                  </div>
                  <svg width="100%" height={Math.max(160, 50 + sortedJobs.length * 28)} style={{ display: "block", overflow: "visible" }}>
                    {(() => {
                      const jobs =
                        sortBy === "tokens"
                          ? [...sortedJobs].sort((a, b) => b.totals.total_tokens - a.totals.total_tokens)
                          : [...sortedJobs].sort((a, b) => a.saved_at.localeCompare(b.saved_at));
                      const count = jobs.length;
                      const maxT = Math.max(...jobs.map((j) => j.totals.total_tokens), 1);
                      const chartW = 340;
                      const chartH = count * 24 + 10;
                      const barH = 16;
                      const gap = 8;
                      const labelW = 140;
                      const valW = 52;
                      const trackW = chartW - labelW - valW - 16;
                      return (
                        <g>
                          {/* Background */}
                          <rect x={0} y={0} width={chartW} height={chartH} fill="var(--surface)" rx={6} />
                          {/* Y-axis grid lines (horizontal) */}
                          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                            const y = chartH - 6;
                            return (
                              <g key={frac}>
                                <line
                                  x1={labelW + 8}
                                  y1={y - frac * (chartH - 14)}
                                  x2={chartW - valW - 8}
                                  y2={y - frac * (chartH - 14)}
                                  stroke="var(--border)"
                                  strokeWidth={0.5}
                                  opacity={0.3}
                                />
                              </g>
                            );
                          })}
                          {/* Bars */}
                          {jobs.map((job, i) => {
                            const y = 4 + i * (barH + gap);
                            const pct = job.totals.total_tokens / maxT;
                            const barW = Math.max(2, pct * trackW);
                            const color = BAR_COLORS[i % BAR_COLORS.length];
                            const label = job.title ? job.title : job.job_id.slice(0, 12);
                            return (
                              <g key={job.job_id}>
                                {/* Job name label */}
                                <text x={labelW - 6} y={y + barH - 3} fill="var(--text)" fontSize={10} textAnchor="end" fontFamily="var(--font)">
                                  <title>{`${job.title || job.job_id}: ${job.totals.total_tokens.toLocaleString()} tokens`}</title>
                                  {label.length > 17 ? label.slice(0, 16) + "…" : label}
                                </text>
                                {/* Bar */}
                                <rect x={labelW + 8} y={y} width={barW} height={barH} fill={color} rx={3} opacity={0.85}>
                                  <title>{`${job.title || job.job_id}: ${job.totals.total_tokens.toLocaleString()} tokens`}</title>
                                </rect>
                                {/* Token count value */}
                                <text x={labelW + 12 + barW + 4} y={y + barH - 3} fill="var(--text-muted)" fontSize={9} fontFamily="monospace">
                                  {formatTokenCount(job.totals.total_tokens)}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      );
                    })()}
                  </svg>
                </div>
              )}

              {/* Per-job table */}
              {sortedJobs.length > 0 && (
                <table className="dev-panel-metrics-table" style={{ fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10 }}>
                      <th style={{ padding: "4px 8px", textAlign: "left" }}>Job</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Prompt</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Completion</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Total</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Steps</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedJobs.map((job) => (
                      <tr key={job.job_id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "4px 8px" }}>
                          <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 10 }}>{job.job_id.slice(0, 8)}</span>
                          {job.title && <span style={{ marginLeft: 6, color: "var(--text)" }}>{job.title.slice(0, 30)}</span>}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}>
                          {job.totals.prompt_tokens.toLocaleString()}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}>
                          {job.totals.completion_tokens.toLocaleString()}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                          {job.totals.total_tokens.toLocaleString()}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>
                          {job.step_count}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)", fontSize: 10 }}>
                          {job.saved_at ? new Date(job.saved_at).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {!loading && !error && !aggregate && (
            <div className="dev-panel-empty" style={{ padding: 12 }}>
              No token usage data available. Complete a job first.
            </div>
          )}
        </div>
      </div>

      <div className="dev-panel-footer">
        <span>Polling every {(pollInterval / 1000).toFixed(0)}s</span>
        <span>{aggregate?.job_count || 0} job(s) with token data</span>
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
        <button className={`dev-panel-tab ${activeTab === "usage" ? "dev-panel-tab--active" : ""}`} onClick={() => setActiveTab("usage")}>
          💰 Usage
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
      {activeTab === "usage" && <UsageTab />}
      {activeTab === "updates" && <UpdatesTab />}
    </div>
  );
}
