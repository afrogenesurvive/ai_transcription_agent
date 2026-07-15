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
import Icon from "./Icon";
import LoadingModal from "./LoadingModal";
import type { LogEntry } from "../types";

interface Props {
  onClose: () => void;
}

type Tab = "live" | "database" | "performance" | "usage" | "updates" | "logfiles" | "testing";

const BRIDGE_URL = "http://127.0.0.1:5010";

type SourceFilter = "all" | LogEntry["source"];
type LevelFilter = "all" | LogEntry["level"];
type SubSourceFilter = "all" | string;

const SOURCE_COLORS: Record<string, string> = {
  python: "#58a6ff",
  bridge: "#3fb950",
  agent: "#d29922",
  main: "#8b949e",
  transcription: "#f0883e",
  pipeline: "#79c0ff",
  usage: "#db61a2",
  ollama: "#7ee787",
  startup: "#8b949e",
  voiceprint: "#bc8cff",
  memory: "#f85149",
  agent_bridge: "#d29922",
  upload: "#2ea043",
  config: "#8b949e",
};

const LEVEL_PREFIX: Record<string, string> = {
  info: "",
  warn: "",
  error: "",
  debug: "",
};

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

/** Extract a [tag] prefix from the start of a log message, e.g. "[transcription] hello" → "transcription" */
function extractMessageTag(message: string): string | null {
  const match = message.match(/^\[(\w+)\]/);
  return match ? match[1].toLowerCase() : null;
}

function LiveLogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(loadPersisted(LS_KEY_SOURCE, "all") as SourceFilter);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>(loadPersisted(LS_KEY_LEVEL, "all") as LevelFilter);
  const [subSourceFilter, setSubSourceFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
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

  /** Highlight search matches in text — returns React nodes with <em> wrappers. */
  const highlightText = useCallback(
    (text: string): React.ReactNode => {
      if (!searchQuery.trim()) return text;
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = text.split(new RegExp(`(${escaped})`, "gi"));
      if (parts.length === 1) return text;
      return parts.map((part, i) =>
        part.toLowerCase() === searchQuery.toLowerCase() ? (
          <em key={i} className="dev-panel-search-highlight">
            {part}
          </em>
        ) : (
          part
        ),
      );
    },
    [searchQuery],
  );

  const filtered = logs.filter((entry) => {
    if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
    if (subSourceFilter !== "all" && entry.subSource !== subSourceFilter) return false;
    if (levelFilter !== "all" && entry.level !== levelFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!entry.message.toLowerCase().includes(q) && !entry.source.toLowerCase().includes(q) && !entry.level.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">
          <Icon name="terminal" size="14" color="accent" /> Live Logs
        </span>

        <div className="dev-panel-filters">
          {/* 🔍 Text search */}
          <div className="dev-panel-search-wrap">
            <span className="dev-panel-search-icon">🔍</span>
            <input
              className="dev-panel-search-input"
              type="text"
              placeholder="Search logs…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="dev-panel-search-clear"
                onClick={() => setSearchQuery("")}
                title="Clear search"
                data-tooltip="Clear the log search query">
                <Icon name="close" size="12" />
              </button>
            )}
          </div>
          <select
            className="dev-panel-select"
            value={sourceFilter}
            onChange={(e) => handleSourceFilterChange(e.target.value as SourceFilter)}
            title="Filter logs by source service"
            data-tooltip="Filter logs by source — Python, Bridge, Agent, or Main">
            <option value="all">All sources</option>
            <option value="python">Python</option>
            <option value="bridge">Bridge</option>
            <option value="agent">Agent</option>
            <option value="main">Main</option>
          </select>

          <select
            className="dev-panel-select"
            value={subSourceFilter}
            onChange={(e) => setSubSourceFilter(e.target.value)}
            title="Filter by sub-source tag"
            data-tooltip="Filter logs by sub-source — Runner, Model, Pipeline, etc.">
            <option value="all">All sub-sources</option>
            <option value="agent_bridge">Agent Bridge</option>
            <option value="api">API</option>
            <option value="auto-update">Auto Update</option>
            <option value="bridge">Bridge</option>
            <option value="cleanup">Cleanup</option>
            <option value="config">Config</option>
            <option value="ephemeral">Ephemeral</option>
            <option value="executor">Executor</option>
            <option value="http">HTTP</option>
            <option value="label_and_resume">Label & Resume</option>
            <option value="memory">Memory</option>
            <option value="model">Model</option>
            <option value="models_status">Models Status</option>
            <option value="ollama">Ollama</option>
            <option value="pipeline">Pipeline</option>
            <option value="reconciliation">Reconciliation</option>
            <option value="runner">Runner</option>
            <option value="semantic_memory">Semantic Memory</option>
            <option value="startup">Startup</option>
            <option value="transcription">Transcription</option>
            <option value="upload">Upload</option>
            <option value="upload_by_path">Upload by Path</option>
            <option value="usage">Usage</option>
            <option value="voiceprint">Voiceprint</option>
          </select>

          <select
            className="dev-panel-select"
            value={levelFilter}
            onChange={(e) => handleLevelFilterChange(e.target.value as LevelFilter)}
            title="Filter logs by severity level"
            data-tooltip="Filter logs by severity — Info, Warnings, Errors, or Debug">
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
            <option value="debug">Debug</option>
          </select>

          <label className="dev-panel-checkbox" data-tooltip="Automatically scroll to the bottom when new logs arrive">
            <input type="checkbox" checked={autoScroll} onChange={(e) => handleAutoScrollChange(e.target.checked)} />
            Auto-scroll
          </label>
        </div>

        <div className="dev-panel-actions">
          <button
            className="dev-panel-btn"
            onClick={handleClear}
            title="Clear all logs from the display"
            data-tooltip="Clear all log entries from the current view">
            Clear
          </button>
        </div>
      </div>

      {/* Log list */}
      <div className="dev-panel-list" ref={listRef}>
        {filtered.length === 0 && <div className="dev-panel-empty">No logs match the current filters.</div>}
        {filtered.map((entry, i) => {
          // Determine which sub-source tag to show: prefer entry.subSource, fall back to message tag
          const displaySubSource = entry.subSource ?? extractMessageTag(entry.message);
          // Strip [tag] prefix from message if we're showing it as a badge
          const displayMessage = displaySubSource && !entry.subSource ? entry.message.replace(/^\[\w+\]\s*/, "") : entry.message;
          return (
            <div key={i} className="dev-panel-entry">
              <span className="dev-panel-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span className="dev-panel-source-badge">
                <span className="dev-panel-source" style={{ color: SOURCE_COLORS[entry.source] || "#8b949e" }}>
                  [{entry.source}]
                </span>
                {displaySubSource && displaySubSource !== entry.source && (
                  <span className="dev-panel-sub-source" style={{ color: SOURCE_COLORS[displaySubSource] || "#f0883e" }}>
                    [{displaySubSource}]
                  </span>
                )}
              </span>
              <span className={`dev-panel-level dev-panel-level--${entry.level}`}>{LEVEL_PREFIX[entry.level]}</span>
              <span className="dev-panel-message">{highlightText(displayMessage)}</span>
            </div>
          );
        })}
      </div>

      {/* Footer with stats */}
      <div className="dev-panel-footer">
        <span>{filtered.length} entries</span>
        <span>{logs.length} total buffered</span>
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
  const [activeView, setActiveView] = useState<"ephemeral" | "semantic" | "voiceprints">("ephemeral");
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
  // ── Voiceprint state ──
  const [voiceprints, setVoiceprints] = useState<any[]>([]);
  const [vpLoading, setVpLoading] = useState(false);
  const [vpError, setVpError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null); // email to delete
  const [deletingVp, setDeletingVp] = useState(false);
  const [playingVp, setPlayingVp] = useState<string | null>(null); // email of currently playing
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const loadVoiceprints = useCallback(async () => {
    setVpLoading(true);
    setVpError(null);
    try {
      const result = await callBridge("transcribe_list_voiceprints");
      setVoiceprints(result?.voiceprints || []);
    } catch (err: any) {
      setVpError(err.message || "Failed to load voiceprints");
      setVoiceprints([]);
    }
    setVpLoading(false);
  }, []);

  const handleDeleteVoiceprint = useCallback(async (email: string) => {
    setDeleteConfirm(null);
    setDeletingVp(true);
    try {
      await callBridge("transcribe_delete_voiceprint", { email });
      setVoiceprints((prev) => prev.filter((vp: any) => vp.email !== email));
    } catch (err: any) {
      console.error("Failed to delete voiceprint:", err);
    }
    setDeletingVp(false);
  }, []);

  const handlePlayVoiceprint = useCallback(
    (email: string) => {
      if (playingVp === email) {
        audioRef.current?.pause();
        setPlayingVp(null);
        return;
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(`http://127.0.0.1:5010/agent/voiceprints/sample/${encodeURIComponent(email)}`);
      audio.onended = () => setPlayingVp(null);
      audio.onerror = () => setPlayingVp(null);
      audio.play().catch(() => setPlayingVp(null));
      audioRef.current = audio;
      setPlayingVp(email);
    },
    [playingVp],
  );

  useEffect(() => {
    loadTables();
    loadMeetings();
    loadVoiceprints();
  }, [loadTables, loadMeetings, loadVoiceprints]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

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
    loadVoiceprints();
    if (selectedTable) handleSelectTable(selectedTable);
  }, [loadTables, loadMeetings, loadVoiceprints, handleSelectTable, selectedTable]);

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
        <span className="dev-panel-title">
          <Icon name="database" size="14" color="accent" /> Database
        </span>
        <div className="dev-panel-filters">
          <div className="dev-panel-view-toggle">
            <button
              className={`dev-panel-view-btn ${activeView === "ephemeral" ? "dev-panel-view-btn--active" : ""}`}
              onClick={() => setActiveView("ephemeral")}>
              <Icon name="save" size="14" /> Ephemeral
            </button>
            <button
              className={`dev-panel-view-btn ${activeView === "semantic" ? "dev-panel-view-btn--active" : ""}`}
              onClick={() => setActiveView("semantic")}>
              <Icon name="memory" size="14" /> Semantic
            </button>
            <button
              className={`dev-panel-view-btn ${activeView === "voiceprints" ? "dev-panel-view-btn--active" : ""}`}
              onClick={() => setActiveView("voiceprints")}>
              <Icon name="badge" size="14" /> Voiceprints
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
            <Icon name="refresh" size="14" /> Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-db">
        {activeView === "ephemeral" && (
          <>
            {/* Table list sidebar */}
            <div className="dev-panel-db-sidebar" ref={sidebarRef} style={{ width: dbSidebarWidth }}>
              <LoadingModal visible={loading && tables.length === 0} message="Loading ephemeral memory tables…" />
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

        {activeView === "voiceprints" && (
          <div className="dev-panel-db-content" ref={contentRef}>
            {vpLoading && <div className="dev-panel-empty">Loading voiceprints...</div>}
            {vpError && (
              <div className="dev-panel-empty" style={{ color: "var(--red)" }}>
                Error: {vpError}
              </div>
            )}
            {!vpLoading && !vpError && voiceprints.length === 0 && (
              <div className="dev-panel-empty">No voiceprints enrolled yet. Voiceprints are created when you label speakers during processing.</div>
            )}

            {voiceprints.length > 0 && (
              <>
                <div className="dev-panel-db-stats">
                  <span>{voiceprints.length} voiceprint(s) enrolled</span>
                  <span className="dev-panel-db-stats-hint">
                    Click <Icon name="play_arrow" size="12" /> to hear a sample, or <Icon name="delete" size="12" /> to remove
                  </span>
                </div>
                <table className="dev-panel-db-table">
                  <thead>
                    <tr>
                      {renderTh("Name", "vp-name")}
                      {renderTh("Email", "vp-email")}
                      {renderTh("Enrolled", "vp-created")}
                      {renderTh("Audio", "vp-audio")}
                      {renderTh("Action", "vp-action")}
                    </tr>
                  </thead>
                  <tbody>
                    {voiceprints.map((vp: any) => (
                      <tr key={vp.email} className="dev-panel-db-row">
                        <td className="dev-panel-db-cell-nowrap">{vp.name || "—"}</td>
                        <td className="dev-panel-db-cell-nowrap">{vp.email || "—"}</td>
                        <td className="dev-panel-db-cell-nowrap">{vp.created_at ? new Date(vp.created_at).toLocaleDateString() : "—"}</td>
                        <td className="dev-panel-db-cell-nowrap">
                          {vp.sample_job_id ? (
                            <button
                              className="dev-panel-btn"
                              style={{ padding: "2px 8px", fontSize: 12 }}
                              onClick={() => handlePlayVoiceprint(vp.email)}
                              title={playingVp === vp.email ? "Stop playback" : "Play sample audio"}
                              data-tooltip={playingVp === vp.email ? "Stop playback" : "Hear a 3-second sample of this speaker's voice"}>
                              <Icon name={playingVp === vp.email ? "stop" : "play_arrow"} size="14" color="accent" />
                            </button>
                          ) : (
                            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>No sample</span>
                          )}
                        </td>
                        <td className="dev-panel-db-cell-nowrap">
                          <button
                            className="dev-panel-btn"
                            style={{ padding: "2px 8px", fontSize: 12, color: "var(--red)" }}
                            onClick={() => setDeleteConfirm(vp.email)}
                            disabled={deletingVp}
                            title="Delete this voiceprint"
                            data-tooltip="Permanently remove this speaker's voiceprint — they will no longer be automatically identified">
                            <Icon name="delete" size="14" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {activeView === "semantic" && (
          <div className="dev-panel-db-content" ref={contentRef}>
            <LoadingModal visible={loading && meetings.length === 0} message="Loading semantic memory meetings…" />
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
                <h4 className="dev-panel-db-section-title">
                  <Icon name="analytics" size="14" color="accent" /> Embedding Stats
                </h4>
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
                <h4 className="dev-panel-db-section-title">
                  <Icon name="sync_alt" size="14" /> Cross-Meeting Overlap
                </h4>

                {/* Common attendees */}
                {semanticOverlap.common_attendees.length > 0 && (
                  <div className="dev-panel-db-overlap-group">
                    <h5 className="dev-panel-db-overlap-title">
                      <Icon name="group" size="14" color="accent" /> Common Attendees
                    </h5>
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
                    <h5 className="dev-panel-db-overlap-title">
                      <Icon name="label" size="14" color="accent" /> Shared Keywords
                    </h5>
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
                <h4 className="dev-panel-db-section-title">
                  <Icon name="search" size="14" color="accent" /> Search Relevance
                </h4>

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
                {searchError && (
                  <div className="dev-panel-db-search-error">
                    <Icon name="error" color="red" size="14" /> {searchError}
                  </div>
                )}

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
        {activeView === "voiceprints" && <span>{voiceprints.length} voiceprint(s)</span>}
        {selectedTable && <span>{tableTotal} row(s) in table</span>}
      </div>

      {/* ── Confirm Delete Voiceprint Dialog ── */}
      {deleteConfirm && (
        <div className="confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-dialog-title">
              <Icon name="warning" size="16" color="red" /> Delete Voiceprint
            </h3>
            <p className="confirm-dialog-text">
              This will permanently remove the voiceprint for{" "}
              <strong>{voiceprints.find((vp: any) => vp.email === deleteConfirm)?.name || deleteConfirm}</strong> with email{" "}
              <code>{deleteConfirm}</code>. Future meetings will no longer automatically recognize this speaker unless a new voiceprint is enrolled.
            </p>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setDeleteConfirm(null)} disabled={deletingVp}>
                Cancel
              </button>
              <button className="btn-danger" onClick={() => handleDeleteVoiceprint(deleteConfirm)} disabled={deletingVp}>
                {deletingVp ? "Deleting..." : "Delete Voiceprint"}
              </button>
            </div>
          </div>
        </div>
      )}
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
        <span className="dev-panel-title">
          <Icon name="bolt" size="14" color="accent" /> Performance Across Jobs
        </span>
        <div className="dev-panel-filters">
          <select
            className="dev-panel-select"
            value={pollIntervalMs}
            onChange={(e) => setPollIntervalMs(Number(e.target.value))}
            title="Performance data polling interval"
            data-tooltip="How often to poll for new performance data">
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
          <button className="dev-panel-btn" onClick={fetchData} title="Refresh performance data" data-tooltip="Fetch the latest performance data now">
            <Icon name="refresh" size="14" /> Refresh
          </button>
        </div>
      </div>

      <div className="dev-panel-list" style={{ fontFamily: "var(--font)" }}>
        {loading && <div className="dev-panel-empty">Loading performance data...</div>}
        {error && (
          <div className="dev-panel-empty" style={{ color: "var(--red)" }}>
            <Icon name="error" color="red" size="16" /> {error}
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
                <Icon name="trending_up" size="14" color="accent" /> CPU & Memory Across Jobs
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

  // ── Derived state ──

  const isUpToDate = !status.checking && !status.updateAvailable && !status.updateDownloaded && !status.error;
  const hasUpdate = status.updateAvailable && !status.updateDownloaded;
  const isDownloaded = status.updateDownloaded;

  const bannerClass = status.error
    ? "updates-banner--error"
    : status.checking
      ? "updates-banner--checking"
      : isDownloaded
        ? "updates-banner--downloaded"
        : hasUpdate
          ? "updates-banner--available"
          : "updates-banner--uptodate";

  const bannerIcon = status.error ? "error" : status.checking ? "sync" : isDownloaded ? "check_circle" : hasUpdate ? "system_update" : "check_circle";

  const bannerText = status.error
    ? `Update check failed`
    : status.checking
      ? "Checking for updates…"
      : isDownloaded
        ? "Update downloaded — ready to install"
        : hasUpdate
          ? `Update available: ${status.updateAvailable}`
          : "Up to date";

  const modeLabel =
    status.mode === "packaged" ? (
      <>
        <Icon name="inventory" size="14" color="accent" /> Packaged App
      </>
    ) : (
      <>
        <Icon name="code" size="14" color="accent" /> Development (git)
      </>
    );

  const currentLabel = status.mode === "packaged" ? `v${status.currentVersion}` : `branch: ${status.currentVersion}`;

  return (
    <div className="updates-container">
      {/* ── Status banner ── */}
      <div className={`updates-banner ${bannerClass}`}>
        <Icon name={bannerIcon} size="18" />
        <span className="updates-banner-text">{bannerText}</span>
        {status.checking && <span className="updates-spinner" />}
      </div>

      {/* ── Main content card ── */}
      <div className="updates-card">
        {/* Header row */}
        <div className="updates-card-header">
          <h3 className="updates-card-title">
            <Icon name="system_update" size="16" color="accent" /> Auto-Update
          </h3>
          <span className="updates-mode-badge">{modeLabel}</span>
        </div>

        {/* ── Version comparison ── */}
        <div className="updates-versions">
          <div className="updates-version-block">
            <span className="updates-version-label">Current</span>
            <span className="updates-version-value">{currentLabel}</span>
          </div>
          {hasUpdate && (
            <>
              <div className="updates-version-arrow">
                <Icon name="arrow_forward" size="16" color="accent" />
              </div>
              <div className="updates-version-block">
                <span className="updates-version-label">Available</span>
                <span className="updates-version-value updates-version-value--new">v{status.updateAvailable}</span>
              </div>
            </>
          )}
        </div>

        {/* ── Detail fields ── */}
        <div className="updates-details">
          {status.lastCheck && (
            <div className="updates-detail-row">
              <span className="updates-detail-label">Last checked</span>
              <span className="updates-detail-value">{new Date(status.lastCheck).toLocaleString()}</span>
            </div>
          )}
          {status.lastUpdate && (
            <div className="updates-detail-row">
              <span className="updates-detail-label">Last updated</span>
              <span className="updates-detail-value">{new Date(status.lastUpdate).toLocaleString()}</span>
            </div>
          )}
          <div className="updates-detail-row">
            <span className="updates-detail-label">Check interval</span>
            <span className="updates-detail-value">Every 12 hours</span>
          </div>
        </div>

        {/* ── Download progress ── */}
        {status.downloadProgress !== null && (
          <div className="updates-progress-section">
            <div className="updates-progress-header">
              <span className="updates-progress-label">Downloading update…</span>
              <span className="updates-progress-pct">{status.downloadProgress}%</span>
            </div>
            <div className="updates-progress-track">
              <div className="updates-progress-fill" style={{ width: `${status.downloadProgress}%` }} />
            </div>
          </div>
        )}

        {/* ── Error display ── */}
        {status.error && (
          <div className="updates-error-box">
            <Icon name="warning" size="14" color="orange" />
            <span>{status.error}</span>
          </div>
        )}

        {/* ── Action buttons ── */}
        <div className="updates-actions">
          <button className="updates-btn updates-btn--primary" onClick={handleCheck} disabled={working || status.checking}>
            {status.checking ? (
              <>
                <span className="updates-spinner updates-spinner--small" /> Checking…
              </>
            ) : (
              <>
                <Icon name="search" size="14" /> Check for Updates
              </>
            )}
          </button>

          {status.mode === "packaged" && hasUpdate && (
            <button className="updates-btn updates-btn--primary" onClick={handleDownload} disabled={working}>
              {working ? (
                <>
                  <span className="updates-spinner updates-spinner--small" /> Downloading…
                </>
              ) : (
                <>
                  <Icon name="download" size="14" /> Download Update
                </>
              )}
            </button>
          )}

          {isDownloaded && (
            <button className="updates-btn updates-btn--install" onClick={handleInstall}>
              <Icon name="restart_alt" size="14" /> Restart &amp; Install
            </button>
          )}

          {/* Auto-check toggle */}
          <label className="updates-toggle">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={working}
              onChange={async (e) => {
                await window.electronAPI?.setAutoUpdateEnabled(e.target.checked);
                refresh();
              }}
            />
            <span className="updates-toggle-slider" />
            <span className="updates-toggle-label">Auto-check periodically</span>
          </label>
        </div>
      </div>

      {/* ── How it works ── */}
      <details className="updates-info">
        <summary className="updates-info-summary">
          <Icon name="info" size="14" color="accent" /> How updates work
        </summary>
        <div className="updates-info-body">
          {status.mode === "dev" ? (
            <ul>
              <li>Checks the Git repository every 12 hours for new commits on your current branch</li>
              <li>On finding updates: pulls changes, installs dependencies, rebuilds, then restarts</li>
              <li>Only works in development mode where the source code and git are available</li>
            </ul>
          ) : (
            <ul>
              <li>Checks GitHub Releases every 12 hours for new versions of the app</li>
              <li>When a new version is found, a notification appears in the app</li>
              <li>
                Click <strong>Download Update</strong> to download the new version in the background
              </li>
              <li>
                Once downloaded, click <strong>Restart &amp; Install</strong> to apply the update and relaunch
              </li>
              {status.mode === "packaged" && (
                <li>
                  Update source: <code>{status.mode === "packaged" ? "afrogenesurvive/ai_transcription_agent" : "local git repository"}</code>
                </li>
              )}
            </ul>
          )}
        </div>
      </details>
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
      costs?: { input_cost: number; output_cost: number; total_cost: number };
      saved_at: string;
    }>;
    totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    costs?: { input_cost: number; output_cost: number; total_cost: number };
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
        <span className="dev-panel-title">
          <Icon name="account_balance_wallet" size="14" color="accent" /> Usage
        </span>
        <div className="dev-panel-filters">
          <select
            className="dev-panel-select"
            value={pollInterval}
            onChange={(e) => handleIntervalChange(Number(e.target.value))}
            title="Credit balance polling interval"
            data-tooltip="How often to check the DeepSeek API credit balance">
            <option value={30000}>Every 30s</option>
            <option value={60000}>Every 1 min</option>
            <option value={300000}>Every 5 min</option>
            <option value={600000}>Every 10 min</option>
          </select>
        </div>
        <div className="dev-panel-actions">
          <button
            className="dev-panel-btn"
            onClick={fetchAggregate}
            title="Refresh token usage data"
            data-tooltip="Fetch the latest token usage and credit balance data">
            <Icon name="refresh" size="14" /> Refresh
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
            <Icon name="credit_card" size="14" color="accent" /> DeepSeek API Credit Balance
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
                  <span style={{ color: "var(--green)" }}>
                    <Icon name="check_circle" size="12" color="green" /> Available
                  </span>
                ) : (
                  <span style={{ color: "var(--red)" }}>
                    <Icon name="cancel" size="12" color="red" /> Unavailable
                  </span>
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
            <Icon name="analytics" size="14" color="accent" /> Token Usage Across Jobs
          </h4>

          {loading && (
            <div className="dev-panel-empty" style={{ padding: 12 }}>
              Loading token usage data...
            </div>
          )}
          {error && (
            <div className="dev-panel-empty" style={{ padding: 12, color: "var(--red)" }}>
              <Icon name="error" color="red" size="14" /> {error}
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
                  <span className="dev-panel-db-stat-label">Input Tokens</span>
                </div>
                <div className="dev-panel-db-stat-card" style={{ minWidth: 80 }}>
                  <span className="dev-panel-db-stat-value">{formatTokenCount(aggregate.totals.completion_tokens)}</span>
                  <span className="dev-panel-db-stat-label">Output Tokens</span>
                </div>
                {/* Cost cards */}
                {aggregate.costs && (
                  <>
                    <div className="dev-panel-db-stat-card" style={{ minWidth: 90, borderLeft: "2px solid #58a6ff" }}>
                      <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-14)" }}>
                        ${aggregate.costs.input_cost.toFixed(4)}
                      </span>
                      <span className="dev-panel-db-stat-label">Input Cost</span>
                    </div>
                    <div className="dev-panel-db-stat-card" style={{ minWidth: 90, borderLeft: "2px solid #d29922" }}>
                      <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-14)" }}>
                        ${aggregate.costs.output_cost.toFixed(4)}
                      </span>
                      <span className="dev-panel-db-stat-label">Output Cost</span>
                    </div>
                    <div className="dev-panel-db-stat-card" style={{ minWidth: 90, borderLeft: "2px solid #3fb950" }}>
                      <span className="dev-panel-db-stat-value" style={{ fontSize: "var(--fs-16)", fontWeight: 700 }}>
                        ${aggregate.costs.total_cost.toFixed(4)}
                      </span>
                      <span className="dev-panel-db-stat-label">Total Cost</span>
                    </div>
                  </>
                )}
              </div>

              {/* ── Token Usage Over Time Chart ── */}
              {sortedJobs.length > 1 && (
                <div className="usage-bar-chart" style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", marginBottom: 8, fontWeight: 600 }}>
                    <Icon name="trending_up" size="14" color="accent" /> Token Usage Over Time
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
                    <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", fontWeight: 600 }}>
                      <Icon name="analytics" size="14" color="accent" /> Token Usage Per Job
                    </span>
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
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Input</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Output</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Total</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Cost</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Steps</th>
                      <th style={{ padding: "4px 8px", textAlign: "right" }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedJobs.map((job) => {
                      const costs: { input_cost?: number; output_cost?: number; total_cost?: number } = job.costs || {};
                      return (
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
                          <td
                            style={{
                              padding: "4px 8px",
                              textAlign: "right",
                              fontFamily: "monospace",
                              color: costs.total_cost ? "var(--text)" : "var(--text-muted)",
                            }}>
                            {costs.total_cost ? `$${costs.total_cost.toFixed(4)}` : "—"}
                          </td>
                          <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)" }}>
                            {job.step_count}
                          </td>
                          <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: "var(--text-muted)", fontSize: 10 }}>
                            {job.saved_at ? new Date(job.saved_at).toLocaleDateString() : "—"}
                          </td>
                        </tr>
                      );
                    })}
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
        {aggregate?.costs?.total_cost ? (
          <span>
            <Icon name="account_balance_wallet" size="14" color="accent" /> ${aggregate.costs.total_cost.toFixed(4)} total cost
          </span>
        ) : null}
      </div>
    </>
  );
}

/* ── Log Files Tab ── */

/** Parse a timestamp from a log line and return a local-time formatted string.
 *  Handles ISO format: "[2026-07-14T16:10:57.123Z]" or "[2026-07-14 16:10:57]". */
function parseLogTimestamp(line: string): string | null {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]/);
  if (!m) return null;
  // Replace space separator with T, append Z if missing, for consistent Date parsing
  const raw = m[1].replace(" ", "T");
  const isoStr = raw.endsWith("Z") ? raw : raw + "Z";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return m[1]; // fallback: show raw string
  return d.toLocaleTimeString(); // e.g. "11:10:57 AM"
}

/** Extract a log source from a line like "[pipeline]" or "[voiceprint]" or "[api]" */
function parseLogSource(line: string): string {
  const m = line.match(/\[([a-z_]+)\]/i);
  return m ? m[1].toLowerCase() : "main";
}

/** Extract a sub-source from a pipeline.log line like "[2026-...] [agent][runner] ..." → "runner" */
function parseLogSubSource(line: string): string | undefined {
  // Match [source][subsource] after the timestamp — e.g. "[2026-...] [agent][runner]"
  const m = line.match(/^\[\d{4}.*?\]\s*\[\w+\]\[([a-zA-Z0-9 _-]+)\]/i);
  return m ? m[1].toLowerCase() : undefined;
}

function LogFilesTab() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [logSourceFilter, setLogSourceFilter] = useState<string>("all");
  const [logLevelFilter, setLogLevelFilter] = useState<string>("all");
  const [logSubSourceFilter, setLogSubSourceFilter] = useState<string>("all");
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [logSubTab, setLogSubTab] = useState<"pipeline" | "agent" | "transcript" | "raw">("pipeline");
  const [collapseRepeated, setCollapseRepeated] = useState(true);
  const [prettifiedBlock, setPrettifiedBlock] = useState<string | null>(null);
  const resizingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const BRIDGE_URL = "http://127.0.0.1:5010";

  /** Call a bridge tool and return the parsed JSON response. */
  async function bridgeCall(tool: string, args: Record<string, unknown> = {}) {
    const res = await fetch(`${BRIDGE_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    if (!res.ok) throw new Error(`Bridge error: ${res.status}`);
    return res.json();
  }

  // Fetch job history on mount
  useEffect(() => {
    bridgeCall("transcribe_history", {})
      .then((r: any) => {
        if (r?.jobs) setJobs(r.jobs);
      })
      .catch(() => {});
  }, []);

  // Fetch pipeline log when a job is selected
  const fetchLog = useCallback(async (jobId: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await bridgeCall("transcribe_get_job_logs", { jobId, maxLines: 2000 });
      // Separate pipeline.log lines from other job-specific files
      const allLines: string[] = [];
      const otherFiles: { file: string; content: string }[] = [];
      if (result.job_logs) {
        for (const jl of result.job_logs) {
          const content = jl.content || "";
          const fname = (jl.file || jl.name || "").toLowerCase();
          // Only pipeline.log lines go through the parsed log view
          if (fname.includes("pipeline.log") || fname.endsWith(".log")) {
            const lines = content.split("\n").filter(Boolean);
            allLines.push(...lines);
          } else {
            otherFiles.push({ file: jl.file || jl.name || "unknown", content });
          }
        }
      }
      if (result.logs) {
        allLines.push(...result.logs);
      }
      setLogLines(allLines);
      setJobSpecificFiles(otherFiles);
    } catch (err: any) {
      // Fallback: fetch pipeline_log endpoint directly
      try {
        const resp = await fetch(`http://127.0.0.1:5010/transcribe/pipeline_log/${jobId}?max_lines=2000`);
        if (resp.ok) {
          const data = await resp.json();
          setLogLines(data.lines || []);
        } else {
          setError(`Failed to load logs: ${resp.status}`);
        }
      } catch (fallbackErr: any) {
        setError(fallbackErr.message || "Failed to load logs");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const [jobSpecificFiles, setJobSpecificFiles] = useState<{ file: string; content: string }[]>([]);

  useEffect(() => {
    if (selectedJobId) {
      fetchLog(selectedJobId);
    }
  }, [selectedJobId, fetchLog]);

  // Sidebar drag resize
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      document.body.classList.add("dev-panel-sidebar-resizing");
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const newW = Math.max(160, Math.min(600, startW + (ev.clientX - startX)));
        setSidebarWidth(newW);
      };
      const onUp = () => {
        resizingRef.current = false;
        document.body.classList.remove("dev-panel-sidebar-resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  // Filter jobs by search
  const filteredJobs = jobs.filter((j) => {
    if (!sidebarSearch) return true;
    const q = sidebarSearch.toLowerCase();
    return (
      j.job_id?.toLowerCase().includes(q) ||
      j.title?.toLowerCase().includes(q) ||
      (j.attendees || []).some((a: string) => a.toLowerCase().includes(q))
    );
  });

  const selectedJob = jobs.find((j) => j.job_id === selectedJobId);

  // Filter log lines by source, level, sub-source, and search text
  // ── Agent log pre-filter: agent source only, exclude poller/usage/raw I/O ──
  const agentFilteredLogLines = logLines.filter((line) => {
    const src = parseLogSource(line);
    if (src !== "agent") return false;
    const sub = parseLogSubSource(line);
    if (sub === "poller" || sub === "usage") return false;
    if (/\bRAW API\b/i.test(line)) return false;
    if (/\u2697\ufe0f.*\[usage\]/i.test(line)) return false;
    return true;
  });

  const filteredLogLines = (logSubTab === "agent" ? agentFilteredLogLines : logLines).filter((line) => {
    if (logSourceFilter !== "all") {
      const src = parseLogSource(line);
      if (src !== logSourceFilter) return false;
    }
    if (logSubSourceFilter !== "all") {
      const sub = parseLogSubSource(line);
      if (!sub || sub !== logSubSourceFilter) return false;
    }
    if (logLevelFilter !== "all" && !line.toLowerCase().includes(`[${logLevelFilter}]`)) {
      // also check for level in message text
      if (!new RegExp(`\\b${logLevelFilter}\\b`, "i").test(line)) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!line.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Build structured entries from raw log lines for grouping
  const logEntries = filteredLogLines.map((line) => {
    const ts = parseLogTimestamp(line);
    const source = parseLogSource(line);
    const subSource = parseLogSubSource(line);
    const level = /\berror\b/i.test(line) ? "error" : /\bwarn\b/i.test(line) ? "warn" : /\bdebug\b/i.test(line) ? "debug" : "info";
    const cleanMessage = line.replace(
      /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3}Z\]\s*\[[a-z_]+\](?:\[[^\]]*\])?\s*\[(?:info|error|warn|debug)\]\s*/i,
      "",
    );
    return { ts: ts || "──", source, subSource, level, cleanMessage, sourceColor: SOURCE_COLORS[source] || SOURCE_COLORS.main };
  });

  // Group consecutive entries with same source+subSource+level when collapse is on
  const groupedLogEntries = collapseRepeated
    ? logEntries.reduce(
        (
          acc: Array<{
            ts: string;
            source: string;
            subSource?: string;
            level: string;
            sourceColor: string;
            lines: Array<{ ts: string; message: string }>;
          }>,
          e,
        ) => {
          const last = acc[acc.length - 1];
          if (last && last.source === e.source && last.subSource === e.subSource && last.level === e.level) {
            last.lines.push({ ts: e.ts, message: e.cleanMessage });
          } else {
            acc.push({
              ts: e.ts,
              source: e.source,
              subSource: e.subSource,
              level: e.level,
              sourceColor: e.sourceColor,
              lines: [{ ts: e.ts, message: e.cleanMessage }],
            });
          }
          return acc;
        },
        [],
      )
    : logEntries.map((e) => ({
        ts: e.ts,
        source: e.source,
        subSource: e.subSource,
        level: e.level,
        sourceColor: e.sourceColor,
        lines: [{ ts: e.ts, message: e.cleanMessage }],
      }));

  /** Detect section-header decoration lines */
  const isSectionHeader = (msg: string): boolean => /^[═=]{3,}|^[─━]{3,}|^━━━/.test(msg);

  /** Render a single log entry or group */
  const renderGroupedLog = (
    group: { ts: string; source: string; subSource?: string; level: string; sourceColor: string; lines: Array<{ ts: string; message: string }> },
    gi: number,
  ) => {
    const isGroup = group.lines.length > 1;
    const isHeader = isSectionHeader(group.lines[0]?.message || "");
    return (
      <div key={gi} className={`rv-log-group ${isGroup ? "rv-log-group--multi" : ""} ${isHeader ? "rv-log-group--header" : ""}`}>
        {/* ── Single line ── */}
        {!isGroup && (
          <div className="rv-log-line rv-log-line--parsed">
            <span className="rv-log-line-time">{group.ts}</span>
            <span className="rv-log-line-source" style={{ color: group.sourceColor }}>
              [{group.source}]
            </span>
            {group.subSource && (
              <span className="rv-log-line-subsource" style={{ color: SOURCE_COLORS[group.subSource] || group.sourceColor }}>
                [{group.subSource}]
              </span>
            )}
            <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
              {group.level === "error" ? "✖" : group.level === "warn" ? "⚠" : ""}
            </span>
            <span className="rv-log-line-text">{group.lines[0].message}</span>
            <button
              className="rv-log-prettify-btn"
              onClick={() => setPrettifiedBlock(group.lines[0].message)}
              title="View prettified"
              data-tooltip="Open this log entry in the prettified viewer">
              <Icon name="open_in_new" size="10" />
            </button>
          </div>
        )}
        {/* ── Multi-line group ── */}
        {isGroup && (
          <details className="rv-log-details" open={isHeader ? true : undefined}>
            <summary className="rv-log-summary">
              <span className="rv-log-summary-line">
                <span className="rv-log-line-time">{group.ts}</span>
                <span className="rv-log-line-source" style={{ color: group.sourceColor }}>
                  [{group.source}]
                </span>
                {group.subSource && (
                  <span className="rv-log-line-subsource" style={{ color: SOURCE_COLORS[group.subSource] || group.sourceColor }}>
                    [{group.subSource}]
                  </span>
                )}
                <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
                  {group.level === "error" ? "✖" : group.level === "warn" ? "⚠" : ""}
                </span>
                <span className="rv-log-summary-msg">{group.lines[0].message}</span>
              </span>
              <button
                className="rv-log-prettify-btn rv-log-prettify-btn--group"
                onClick={() => setPrettifiedBlock(group.lines.map((l) => l.message).join("\n"))}
                title="View all lines prettified"
                data-tooltip="Open the entire group content in the prettified viewer">
                <Icon name="open_in_new" size="10" />
              </button>
              <span className="rv-log-group-badge">{group.lines.length} lines</span>
            </summary>
            <div className="rv-log-group-lines">
              {group.lines.map((line, li) => (
                <div key={li} className="rv-log-line rv-log-line--nested">
                  <span className="rv-log-gutter">│</span>
                  <span className="rv-log-line-text">{line.message}</span>
                  <button
                    className="rv-log-prettify-btn"
                    onClick={() => setPrettifiedBlock(line.message)}
                    title="View prettified"
                    data-tooltip="Open this log entry in the prettified viewer">
                    <Icon name="open_in_new" size="10" />
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="dev-panel-file-browser" style={{ height: "100%" }}>
      {/* Left sidebar — job list */}
      <div className="dev-panel-file-list" style={{ width: sidebarWidth, flex: "none" }}>
        <div className="dev-panel-file-filter-bar">
          <div className="dev-panel-search-wrap">
            <span className="dev-panel-search-icon material-symbols-outlined">search</span>
            <input
              className="dev-panel-search-input"
              type="text"
              placeholder="Filter jobs..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
            />
          </div>
          <span className="dev-panel-file-filter-count">
            {filteredJobs.length} job{filteredJobs.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }} ref={listRef}>
          {filteredJobs.length === 0 && <div className="dev-panel-empty">{sidebarSearch ? "No matching jobs" : "No jobs yet"}</div>}
          {filteredJobs.map((job) => (
            <div
              key={job.job_id}
              className={`dev-panel-file-item ${selectedJobId === job.job_id ? "dev-panel-file-item--active" : ""}`}
              onClick={() => setSelectedJobId(job.job_id)}>
              <span className="dev-panel-file-name">{job.title || "Untitled"}</span>
              <span className="dev-panel-file-meta">
                {job.status} · {job.attendees?.length || 0} attendee{(job.attendees?.length || 0) !== 1 ? "s" : ""}
              </span>
              <span className="dev-panel-file-date">
                {job.job_id?.slice(0, 8)} · {new Date(job.mtime * 1000).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Resize handle */}
      <div className="dev-panel-sidebar-resize-handle" onMouseDown={handleMouseDown} />

      {/* Right panel — log details */}
      <div className="dev-panel-file-content" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!selectedJobId && <div className="dev-panel-empty">Select a job from the list to view its log files</div>}
        <LoadingModal visible={!!selectedJobId && loading} message="Loading log files…" />
        {selectedJobId && error && (
          <div className="dev-panel-empty" style={{ color: "var(--red)" }}>
            <Icon name="warning" size="14" color="red" /> {error}
          </div>
        )}
        {selectedJobId && !loading && !error && (
          <>
            {/* Sub-tab navigation */}
            <div className="rv-logs-sub-tabs" style={{ flexShrink: 0 }}>
              <button
                className={`rv-logs-sub-tab ${logSubTab === "pipeline" ? "rv-logs-sub-tab--active" : ""}`}
                onClick={() => setLogSubTab("pipeline")}
                title="View parsed pipeline log entries">
                <Icon name="terminal" size="14" /> Pipeline Log
              </button>
              <button
                className={`rv-logs-sub-tab ${logSubTab === "agent" ? "rv-logs-sub-tab--active" : ""}`}
                onClick={() => setLogSubTab("agent")}
                title="View agent-only logs, excluding polling, usage, and raw I/O">
                <Icon name="smart_toy" size="14" /> Agent Log
              </button>
              <button
                className={`rv-logs-sub-tab ${logSubTab === "transcript" ? "rv-logs-sub-tab--active" : ""}`}
                onClick={() => setLogSubTab("transcript")}
                title="View the formatted transcript text file">
                <Icon name="description" size="14" /> Transcript TXT
              </button>
              <button
                className={`rv-logs-sub-tab ${logSubTab === "raw" ? "rv-logs-sub-tab--active" : ""}`}
                onClick={() => setLogSubTab("raw")}
                title="View the raw transcript text file">
                <Icon name="article" size="14" /> Raw Transcript TXT
              </button>
            </div>

            {/* ── Pipeline Log / Agent Log sub-tabs (share same renderer) ── */}
            {(logSubTab === "pipeline" || logSubTab === "agent") && (
              <>
                <div className="rv-logs-toolbar" style={{ flexShrink: 0 }}>
                  <span className="rv-logs-toolbar-title">
                    {logSubTab === "agent" ? (
                      <>
                        <Icon name="smart_toy" size="14" color="accent" /> Agent Logs
                        <span className="rv-logs-badge" style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
                          (agent only, no poller/usage/raw I/O)
                        </span>
                      </>
                    ) : (
                      <>Logs: {selectedJob?.title || selectedJobId?.slice(0, 8)}</>
                    )}
                  </span>
                  <div className="rv-logs-toolbar-filters" style={{ flex: 1, justifyContent: "flex-end", gap: 6 }}>
                    <div className="rv-logs-search-wrap">
                      <span className="rv-logs-search-icon">🔍</span>
                      <input
                        className="rv-logs-search-input"
                        type="text"
                        placeholder="Search log lines…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      {searchQuery && (
                        <button className="rv-logs-search-clear" onClick={() => setSearchQuery("")} title="Clear search">
                          <Icon name="close" size="12" />
                        </button>
                      )}
                    </div>
                    <select
                      className="rv-logs-filter-select"
                      value={logSourceFilter}
                      onChange={(e) => setLogSourceFilter(e.target.value)}
                      style={logSubTab === "agent" ? { display: "none" } : undefined}>
                      <option value="all">All sources</option>
                      <option value="python">Python</option>
                      <option value="bridge">Bridge</option>
                      <option value="agent">Agent</option>
                      <option value="main">Main</option>
                    </select>
                    <select className="rv-logs-filter-select" value={logSubSourceFilter} onChange={(e) => setLogSubSourceFilter(e.target.value)}>
                      <option value="all">All sub-sources</option>
                      <option value="agent_bridge">Agent Bridge</option>
                      <option value="api">API</option>
                      <option value="auto-update">Auto Update</option>
                      <option value="bridge">Bridge</option>
                      <option value="cleanup">Cleanup</option>
                      <option value="config">Config</option>
                      <option value="ephemeral">Ephemeral</option>
                      <option value="executor">Executor</option>
                      <option value="http">HTTP</option>
                      <option value="label_and_resume">Label & Resume</option>
                      <option value="memory">Memory</option>
                      <option value="model">Model</option>
                      <option value="models_status">Models Status</option>
                      <option value="ollama">Ollama</option>
                      <option value="pipeline">Pipeline</option>
                      <option value="reconciliation">Reconciliation</option>
                      <option value="runner">Runner</option>
                      <option value="semantic_memory">Semantic Memory</option>
                      <option value="startup">Startup</option>
                      <option value="transcription">Transcription</option>
                      <option value="upload">Upload</option>
                      <option value="upload_by_path">Upload by Path</option>
                      <option value="usage">Usage</option>
                      <option value="voiceprint">Voiceprint</option>
                      {logSubTab === "agent" && (
                        <>
                          <option value="build-context">Build Context</option>
                          <option value="poller">Poller</option>
                          <option value="step-complete">Step Complete</option>
                        </>
                      )}
                    </select>
                    <select className="rv-logs-filter-select" value={logLevelFilter} onChange={(e) => setLogLevelFilter(e.target.value)}>
                      <option value="all">All levels</option>
                      <option value="info">Info</option>
                      <option value="warn">Warnings</option>
                      <option value="error">Errors</option>
                    </select>
                    <label
                      className="rv-logs-toggle"
                      title="Collapse consecutive log entries with identical source/sub-source/level"
                      data-tooltip="Collapse repeated prefix groups">
                      <input type="checkbox" checked={collapseRepeated} onChange={(e) => setCollapseRepeated(e.target.checked)} />
                      <Icon name="compress" size="12" /> Group
                    </label>
                  </div>
                  <span className="rv-logs-filter-count">
                    {filteredLogLines.length} / {(logSubTab === "agent" ? agentFilteredLogLines : logLines).length} line
                    {(logSubTab === "agent" ? agentFilteredLogLines : logLines).length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {groupedLogEntries.length === 0 && (
                    <div className="dev-panel-empty">
                      <Icon name="info" size="14" color="muted" />{" "}
                      {logSubTab === "agent" ? "No agent log entries found for this job." : "No log entries found for this job."}
                    </div>
                  )}
                  {groupedLogEntries.map((group, gi) => renderGroupedLog(group, gi))}
                </div>
              </>
            )}

            {/* ── Transcript TXT sub-tab ── */}
            {logSubTab === "transcript" && (
              <div style={{ overflowY: "auto", flex: 1, padding: "12px 18px" }}>
                {(() => {
                  const tf = jobSpecificFiles.find((jf) => jf.file === "transcript.txt");
                  if (!tf || !tf.content) {
                    return (
                      <div className="dev-panel-empty">
                        <Icon name="description" size="14" color="muted" /> No transcript text available for this job.
                      </div>
                    );
                  }
                  return (
                    <div className="rv-logs-file-item">
                      <div className="rv-logs-file-header">
                        <span className="rv-logs-file-name">transcript.txt</span>
                        <span className="rv-logs-file-size">{(tf.content.length / 1024).toFixed(1)} KB</span>
                      </div>
                      <pre className="rv-logs-rpre">{tf.content}</pre>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── Raw Transcript TXT sub-tab ── */}
            {logSubTab === "raw" && (
              <div style={{ overflowY: "auto", flex: 1, padding: "12px 18px" }}>
                {(() => {
                  const rf = jobSpecificFiles.find((jf) => jf.file === "raw_transcript.txt");
                  if (!rf || !rf.content) {
                    return (
                      <div className="dev-panel-empty">
                        <Icon name="article" size="14" color="muted" /> No raw transcript text available for this job.
                      </div>
                    );
                  }
                  return (
                    <div className="rv-logs-file-item">
                      <div className="rv-logs-file-header">
                        <span className="rv-logs-file-name">raw_transcript.txt</span>
                        <span className="rv-logs-file-size">{(rf.content.length / 1024).toFixed(1)} KB</span>
                      </div>
                      <pre className="rv-logs-rpre">{rf.content}</pre>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── Prettified View Modal ── */}
            {prettifiedBlock !== null && (
              <div className="rv-prettify-overlay" onClick={() => setPrettifiedBlock(null)}>
                <div className="rv-prettify-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="rv-prettify-header">
                    <h3 className="rv-prettify-title">
                      <Icon name="open_in_new" size="14" color="accent" /> Prettified View
                    </h3>
                    <button className="rv-prettify-close" onClick={() => setPrettifiedBlock(null)} title="Close" data-tooltip="Close prettified view">
                      <Icon name="close" size="14" />
                    </button>
                  </div>
                  <div className="rv-prettify-tabs">
                    <button className="rv-prettify-tab rv-prettify-tab--active">Text</button>
                  </div>
                  <div className="rv-prettify-body">
                    <pre className="rv-prettify-content">{prettifiedBlock}</pre>
                  </div>
                  <div className="rv-prettify-footer">
                    <button
                      className="rv-prettify-copy-btn"
                      onClick={() => navigator.clipboard.writeText(prettifiedBlock)}
                      title="Copy to clipboard"
                      data-tooltip="Copy the prettified content to your clipboard">
                      <Icon name="content_copy" size="12" /> Copy
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Testing Tab ── */

/** Default 20 generic speaker names (comma-separated, matches config.ts) */
const DEFAULT_GENERIC_NAMES =
  "Alex,Blake,Casey,Drew,Ellis,Finley,Gray,Harper,Indigo,Jade,Kai,Logan,Morgan,Nico,Oakley,Parker,Quinn,Reese,Skyler,Taylor";

function TestingTab() {
  const [audioPath, setAudioPath] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("test {autoNum}");
  const [genericNames, setGenericNames] = useState(DEFAULT_GENERIC_NAMES);
  const [namesValid, setNamesValid] = useState(true);

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // ── Prerequisite live status ──
  const [backendStatus, setBackendStatus] = useState<{ python: boolean; bridge: boolean; agent: boolean } | null>(null);
  const [fileExists, setFileExists] = useState<boolean | null>(null);
  const [appBuilt, setAppBuilt] = useState<boolean | null>(null);
  const [builtAt, setBuiltAt] = useState<string | null>(null);

  // Poll backend status and build check every 10s
  useEffect(() => {
    const check = () => {
      window.electronAPI
        ?.checkServers()
        .then(setBackendStatus)
        .catch(() => setBackendStatus(null));
      window.electronAPI
        ?.checkPlaywrightBuild()
        .then((r) => {
          setAppBuilt(r.exists);
          setBuiltAt(r.builtAt);
        })
        .catch(() => {
          setAppBuilt(false);
          setBuiltAt(null);
        });
    };
    check();
    const interval = setInterval(check, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Check file existence when audioPath changes
  useEffect(() => {
    if (!audioPath.trim()) {
      setFileExists(null);
      return;
    }
    let cancelled = false;
    window.electronAPI?.fileExists(audioPath).then((exists) => {
      if (!cancelled) setFileExists(exists);
    });
    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  // Validate generic names (must have at least 20 non-empty items)
  useEffect(() => {
    const names = genericNames
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setNamesValid(names.length >= 20);
  }, [genericNames]);

  // Load test vars from config on mount
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      if (cfg.PLAYWRIGHT_AUDIO_FILE_PATH) setAudioPath(cfg.PLAYWRIGHT_AUDIO_FILE_PATH);
      if (cfg.PLAYWRIGHT_TITLE_TEMPLATE) setTitleTemplate(cfg.PLAYWRIGHT_TITLE_TEMPLATE);
      if (cfg.PLAYWRIGHT_GENERIC_NAMES) setGenericNames(cfg.PLAYWRIGHT_GENERIC_NAMES);
    });
  }, []);

  // Subscribe to real-time test output
  useEffect(() => {
    const unsub = window.electronAPI?.onPlaywrightOutput((text: string) => {
      setOutput((prev) => [...prev, text]);
    });
    return () => unsub?.();
  }, []);

  // Auto-scroll on new output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleBrowse = useCallback(async () => {
    const filePath = await window.electronAPI?.selectAudioFile();
    if (filePath) {
      setAudioPath(filePath);
      // Persist to config immediately so the path survives a panel close
      window.electronAPI?.saveConfig({ PLAYWRIGHT_AUDIO_FILE_PATH: filePath });
    }
  }, []);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setOutput([]);
    setExitCode(null);

    // Build vars to save to config and pass as env
    const vars: Record<string, string> = {
      PLAYWRIGHT_AUDIO_FILE_PATH: audioPath,
      PLAYWRIGHT_TITLE_TEMPLATE: titleTemplate,
      PLAYWRIGHT_GENERIC_NAMES: genericNames,
    };

    // Save test vars to config first
    await window.electronAPI?.saveConfig(vars);

    const result = await window.electronAPI?.runPlaywrightTests(vars);
    if (result) {
      setExitCode(result.exitCode);
      if (result.output) {
        setOutput((prev) => [...prev, result.output]);
      }
    }
    setRunning(false);
  }, [audioPath, titleTemplate, genericNames]);

  // ── Prerequisite status helpers ──
  const statusIcon = (ok: boolean | null) => {
    if (ok === null) return <span style={{ color: "var(--text-muted)" }}>◌</span>;
    return ok ? <span style={{ color: "var(--green)" }}>●</span> : <span style={{ color: "var(--red)" }}>●</span>;
  };
  const statusText = (ok: boolean | null, yes: string, no: string, unknown: string) => {
    if (ok === null) return <span style={{ color: "var(--text-muted)" }}>{unknown}</span>;
    return ok ? <span style={{ color: "var(--green)" }}>{yes}</span> : <span style={{ color: "var(--red)" }}>{no}</span>;
  };

  // All prerequisite checks must have resolved (not null) before the button enables
  const allChecksComplete = backendStatus !== null && appBuilt !== null && fileExists !== null;
  const allPrereqsMet =
    allChecksComplete &&
    backendStatus!.python &&
    backendStatus!.bridge &&
    backendStatus!.agent &&
    appBuilt === true &&
    fileExists === true &&
    namesValid;

  const outputColor = exitCode === null ? "var(--text-muted)" : exitCode === 0 ? "var(--green)" : "var(--red)";
  const outputIcon = exitCode === null ? "info" : exitCode === 0 ? "check_circle" : "error";

  return (
    <>
      {/* Toolbar */}
      <div className="dev-panel-toolbar">
        <span className="dev-panel-title">
          <Icon name="bug_report" size="14" color="accent" /> Testing
        </span>
        <div className="dev-panel-actions">
          <button
            className="dev-panel-btn"
            onClick={handleRun}
            disabled={running || !allPrereqsMet}
            title={allPrereqsMet ? "Run Playwright screenshot tests" : "Fix prerequisites above before running"}
            data-tooltip="Launch Playwright screenshot tests in a headed browser.">
            <Icon name={running ? "sync" : "play_arrow"} size="14" color={running ? "muted" : "accent"} />
            {running ? " Running..." : " Run Tests"}
          </button>
          <button className="dev-panel-btn" onClick={() => setOutput([])} disabled={output.length === 0} title="Clear test output">
            Clear Output
          </button>
        </div>
      </div>

      <div className="dev-panel-list" style={{ padding: "12px 16px", fontFamily: "var(--font)", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ── Prerequisites (live status) ── */}
        <div
          style={{
            background: "var(--surface)",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            fontSize: "var(--fs-11)",
            lineHeight: 1.8,
          }}>
          <h4
            style={{
              fontSize: "var(--fs-12)",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              margin: "0 0 8px",
            }}>
            <Icon name="checklist" size="14" color="accent" /> Prerequisites
          </h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
            <span>
              {statusIcon(backendStatus?.python ?? null)} Python :5001 {statusText(backendStatus?.python ?? null, "Running", "Down", "Checking…")}
            </span>
            <span>
              {statusIcon(backendStatus?.bridge ?? null)} Bridge :5010 {statusText(backendStatus?.bridge ?? null, "Running", "Down", "Checking…")}
            </span>
            <span>
              {statusIcon(backendStatus?.agent ?? null)} Agent Runner {statusText(backendStatus?.agent ?? null, "Running", "Down", "Checking…")}
            </span>
            <span>
              {statusIcon(appBuilt)} App build{" "}
              {appBuilt === true ? (
                <span style={{ color: "var(--green)" }}>Built{builtAt ? ` — ${new Date(builtAt).toLocaleString()}` : ""}</span>
              ) : (
                statusText(appBuilt, "Built", "Missing (run build)", "Checking…")
              )}
            </span>
            <span>
              {statusIcon(fileExists)} Audio file {statusText(fileExists, "Found", "Not found", audioPath ? "Checking…" : "Not set")}
            </span>
            <span>
              {statusIcon(namesValid)} 20 speaker names {statusText(namesValid, "Valid", "Need ≥20", "—")}
            </span>
          </div>
          {!allPrereqsMet && (
            <div style={{ marginTop: 6, color: "var(--orange)", fontSize: "var(--fs-10)" }}>
              Complete all prerequisites to enable the Run Tests button.
            </div>
          )}
        </div>

        {/* ── Test Variables ── */}
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
            <Icon name="settings" size="14" color="accent" /> Test Variables
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Audio file path with Browse button */}
            <label className="dev-panel-testing-field">
              <span className="dev-panel-testing-field-label">Audio File Path</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="dev-panel-testing-input"
                  type="text"
                  placeholder="/path/to/test-meeting.mp3"
                  value={audioPath}
                  onChange={(e) => setAudioPath(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="dev-panel-btn"
                  onClick={handleBrowse}
                  title="Browse for audio file"
                  data-tooltip="Open a native file picker to select an audio file">
                  <Icon name="folder_open" size="14" color="accent" /> Browse
                </button>
              </div>
            </label>

            {/* Title template */}
            <label className="dev-panel-testing-field">
              <span className="dev-panel-testing-field-label">Title Template</span>
              <input
                className="dev-panel-testing-input"
                type="text"
                placeholder="test {autoNum}"
                value={titleTemplate}
                onChange={(e) => setTitleTemplate(e.target.value)}
              />
            </label>

            {/* Generic names (editable textarea, 20 lines) */}
            <label className="dev-panel-testing-field">
              <span className="dev-panel-testing-field-label">
                Generic Speaker Names ({genericNames.split(",").filter((s) => s.trim()).length}/20 required)
              </span>
              <textarea
                className="dev-panel-testing-textarea"
                rows={10}
                value={genericNames
                  .split(",")
                  .map((s) => s.trim())
                  .join("\n")}
                onChange={(e) => {
                  const lines = e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  setGenericNames(lines.join(","));
                }}
                placeholder="One name per line (at least 20 required)"
                style={{ fontFamily: "monospace", fontSize: "var(--fs-11)" }}
              />
              {!namesValid && (
                <span style={{ color: "var(--red)", fontSize: "var(--fs-10)", marginTop: 2 }}>
                  At least 20 names are required ({genericNames.split(",").filter((s) => s.trim()).length} provided)
                </span>
              )}
            </label>
          </div>
        </div>

        {/* ── Output ── */}
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
            <Icon name="terminal" size="14" color="accent" /> Test Output
          </h4>
          <div
            ref={outputRef}
            className="dev-panel-testing-output"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 12,
              maxHeight: 300,
              overflowY: "auto",
              fontFamily: "monospace",
              fontSize: "var(--fs-11)",
              whiteSpace: "pre-wrap",
              lineHeight: 1.5,
              color: "var(--text)",
            }}>
            {output.length === 0 && !running && <span style={{ color: "var(--text-muted)" }}>No output yet — click "Run Tests" to start.</span>}
            {output.length === 0 && running && <span style={{ color: "var(--text-muted)" }}>Starting Playwright...</span>}
            {output.map((chunk, i) => (
              <span key={i}>{chunk}</span>
            ))}
            {running && <span className="dev-panel-testing-cursor">▊</span>}
          </div>
          {exitCode !== null && (
            <div style={{ marginTop: 8, fontSize: "var(--fs-12)", color: outputColor }}>
              <Icon name={outputIcon} size="14" color={exitCode === 0 ? "green" : "red"} />{" "}
              {exitCode === 0 ? "All tests passed" : `Tests failed (exit code: ${exitCode})`}
            </div>
          )}
        </div>
      </div>

      <div className="dev-panel-footer">
        <span>
          {exitCode !== null ? (exitCode === 0 ? "Passed" : "Failed") : "Idle"}
          {running && " · Running…"}
        </span>
        <span>{output.length > 0 ? `${output.length} output chunk(s)` : ""}</span>
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
        <button
          className={`dev-panel-tab ${activeTab === "live" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("live")}
          title="Live real-time logs from all services"
          data-tooltip="View real-time log stream from Python, Bridge, Agent, and Main processes">
          <Icon name="terminal" size="14" color="accent" /> Live Logs
        </button>

        <button
          className={`dev-panel-tab ${activeTab === "database" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("database")}
          title="Browse internal databases"
          data-tooltip="Explore ChromaDB, ephemeral memory, and voiceprint databases">
          <Icon name="database" size="14" color="accent" /> Database
        </button>
        <button
          className={`dev-panel-tab ${activeTab === "performance" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("performance")}
          title="Performance metrics across jobs"
          data-tooltip="View CPU, memory, and pipeline performance metrics across jobs">
          <Icon name="bolt" size="14" color="accent" /> Performance
        </button>
        <button
          className={`dev-panel-tab ${activeTab === "usage" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("usage")}
          title="LLM token usage and costs"
          data-tooltip="View DeepSeek API credit balance and LLM token usage across jobs">
          <Icon name="account_balance_wallet" size="14" color="accent" /> Usage
        </button>
        <button
          className={`dev-panel-tab ${activeTab === "updates" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("updates")}
          title="Check for app updates"
          data-tooltip="Check for and install application updates">
          <Icon name="system_update" size="14" color="accent" /> Updates
        </button>
        <button
          className={`dev-panel-tab ${activeTab === "logfiles" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("logfiles")}
          title="Browse per-job log files"
          data-tooltip="Select a job to view its pipeline logs — jobs on the left, formatted log details on the right">
          <Icon name="description" size="14" color="accent" /> Log Files
        </button>
        <button
          className={`dev-panel-tab ${activeTab === "testing" ? "dev-panel-tab--active" : ""}`}
          onClick={() => setActiveTab("testing")}
          title="Run Playwright screenshot tests"
          data-tooltip="Run screenshot tests and edit test variables — variables are saved to config.json">
          <Icon name="bug_report" size="14" color="accent" /> Testing
        </button>
        <div className="dev-panel-tabs-spacer" />
        <button
          className="dev-panel-btn dev-panel-btn-close"
          onClick={onClose}
          title="Close developer tools"
          data-tooltip="Close the developer tools panel">
          ✕
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "live" && <LiveLogsTab />}
      {activeTab === "database" && <DatabaseTab />}
      {activeTab === "performance" && <PerformanceTab />}
      {activeTab === "usage" && <UsageTab />}
      {activeTab === "updates" && <UpdatesTab />}
      {activeTab === "logfiles" && <LogFilesTab />}
      {activeTab === "testing" && <TestingTab />}
    </div>
  );
}
