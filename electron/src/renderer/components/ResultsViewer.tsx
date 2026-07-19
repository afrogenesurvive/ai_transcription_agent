/**
 * ResultsViewer — tabbed process viewer for completed transcription jobs.
 *
 * Tabs:
 *   [Audio]     — Audio player for the original meeting recording
 *   [Transcript] — Speaker-labeled raw transcript with timestamps
 *   [Summary]    — Executive summary, key decisions, action items
 *   [Analysis]   — Topics, sentiment, entities, effectiveness
 *   [Logs]       — Job-specific developer log files
 *   [Tokens]    — LLM token usage breakdown per pipeline step
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import LoadingModal from "./LoadingModal";
import ExportButton from "./ExportButton";
import type { TranscriptionSegment, AnalysisData } from "../types";

const BRIDGE_URL = "http://127.0.0.1:5010";

type TabId =
  | "pipeline"
  | "audio"
  | "transcript"
  | "summary"
  | "analysis"
  | "tokens"
  | "performance"
  | "attendees"
  | "delivery"
  | "config"
  | "logs"
  | "developer";

interface Tab {
  id: TabId;
  label: string;
  icon: string;
}

interface TabGroup {
  id: "developer";
  label: string;
  icon: string;
  subTabs: Tab[];
}

type TabDef = Tab | TabGroup;

const DEV_SUB_TABS: Tab[] = [
  { id: "tokens", label: "Tokens", icon: "token" },
  { id: "performance", label: "Performance", icon: "speed" },
  { id: "config", label: "Config", icon: "settings" },
  { id: "logs", label: "Logs", icon: "terminal" },
];

const TABS: TabDef[] = [
  { id: "pipeline", label: "Pipeline", icon: "timeline" },
  { id: "transcript", label: "Transcript", icon: "description" },
  { id: "summary", label: "Summary", icon: "summarize" },
  { id: "analysis", label: "Analysis", icon: "analytics" },
  { id: "attendees", label: "Attendees", icon: "group" },
  { id: "delivery", label: "Delivery", icon: "mail" },
  { id: "audio", label: "Audio", icon: "headphones" },
  { id: "developer", label: "Developer", icon: "code", subTabs: DEV_SUB_TABS },
];

interface Props {
  jobId: string;
  segments?: TranscriptionSegment[];
  summary?: {
    executive_summary?: string;
    key_decisions?: string[];
    discussion_points?: string[];
    action_items?: { description: string; assignee?: string; deadline?: string }[];
  };
  metadata?: {
    title?: string;
    originalFilename?: string;
    attendees?: string[];
    event_type?: string;
  };
  /** Pipeline status info for the Pipeline tab */
  jobStatus?: string;
  jobProgress?: number;
  jobError?: string | null;
}

/* ── Helpers ── */

const SPEAKER_COLORS = ["#4A90D9", "#E67E22", "#2ECC71", "#E74C3C", "#9B59B6", "#1ABC9C", "#F39C12", "#3498DB"];

function speakerColor(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
}

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || !isFinite(seconds)) {
    return "--:--";
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Tab: Audio ── */

function AudioTab({ jobId, metadata }: { jobId: string; metadata?: Props["metadata"] }) {
  const audioUrl = `http://127.0.0.1:5010/transcribe/audio/${jobId}`;
  const [audioError, setAudioError] = useState(false);
  const [audioKey, setAudioKey] = useState(0);

  // Reset error state when switching jobs
  useEffect(() => {
    setAudioError(false);
    setAudioKey((k) => k + 1);
  }, [jobId]);

  const handleRetry = () => {
    setAudioError(false);
    setAudioKey((k) => k + 1);
  };

  const handleAudioError = () => {
    setAudioError(true);
  };

  return (
    <div className="rv-tab-content rv-tab-content--audio">
      <div className="rv-audio-header">
        <h3>
          <Icon name="music_note" size="18" color="accent" /> Meeting Recording
        </h3>
        {metadata?.title && <span className="rv-audio-title">{metadata.title}</span>}
        {metadata?.originalFilename && (
          <span className="rv-audio-filename">
            <Icon name="file" size="12" color="muted" /> {metadata.originalFilename}
          </span>
        )}
      </div>

      <div className="rv-audio-player-wrapper">
        {!audioError ? (
          <audio key={audioKey} controls className="rv-audio-player" onError={handleAudioError} preload="metadata">
            <source src={audioUrl} />
            Your browser does not support the audio element.
          </audio>
        ) : (
          <div className="rv-audio-error">
            <span className="rv-audio-error-icon">
              <Icon name="warning" color="orange" size="20" />
            </span>
            <div>
              <p>
                <strong>Audio file unavailable</strong>
              </p>
              <p className="rv-muted">The audio could not be loaded. The file may be missing or the backend may not be running.</p>
              <button className="rv-audio-retry-btn" onClick={handleRetry}>
                <Icon name="refresh" size="14" /> Retry
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rv-audio-info">
        <p className="rv-muted">
          Audio stream URL: <code className="rv-code">{audioUrl}</code>
        </p>
        {metadata?.attendees && metadata.attendees.length > 0 && <p className="rv-muted">Attendees: {metadata.attendees.join(", ")}</p>}
      </div>
    </div>
  );
}

/* ── Tab: Transcript ── */

function TranscriptTab({ segments }: { segments?: TranscriptionSegment[] }) {
  const [searchTerm, setSearchTerm] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = segments
    ? searchTerm
      ? segments.filter((s) => s.text.toLowerCase().includes(searchTerm.toLowerCase()) || s.speaker.toLowerCase().includes(searchTerm.toLowerCase()))
      : segments
    : [];

  const handleJumpToTime = (seconds: number) => {
    // Scroll to the segment
    const el = document.getElementById(`seg-${seconds}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!segments || segments.length === 0) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="description" size="32" color="muted" />
          </span>
          <p>No transcript data available.</p>
          <p className="rv-muted">The transcript will appear here once processing completes.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--transcript">
      <div className="rv-transcript-toolbar">
        <span className="rv-segment-count">
          {filtered.length} segment{filtered.length !== 1 ? "s" : ""}
        </span>
        <div className="rv-search-box">
          <span className="rv-search-icon">
            <Icon name="search" size="14" color="muted" />
          </span>
          <Tooltip content="Search through transcript text by speaker name or keyword">
            <input
              type="text"
              placeholder="Search transcript…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="rv-search-input"
              title="Search through transcript text by speaker name or keyword"
            />
            {searchTerm && (
              <Tooltip content="Clear the transcript search term">
                <button className="rv-search-clear" onClick={() => setSearchTerm("")} title="Clear search">
                  <Icon name="close" size="12" />
                </button>
              </Tooltip>
            )}
          </Tooltip>
        </div>
      </div>

      <div className="rv-segments" ref={listRef}>
        {filtered.map((seg, i) => (
          <div key={i} id={`seg-${seg.start}`} className="rv-segment" onClick={() => handleJumpToTime(seg.start)}>
            <span className="rv-speaker-badge" style={{ backgroundColor: speakerColor(seg.speaker) }}>
              {seg.speaker}
            </span>
            <span className="rv-timestamp">{formatTime(seg.start)}</span>
            <span className="rv-text">{seg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Export helpers ── */

/** Build an HTML string from summary data for PDF/Word export. */
function buildSummaryExportHtml(summary: Props["summary"]): string {
  if (!summary) return "<p>No summary data available.</p>";
  const parts: string[] = [];
  if (summary.executive_summary) {
    parts.push(`<div class="section"><h2>Executive Summary</h2><p>${escapeHtml(summary.executive_summary)}</p></div>`);
  }
  if (summary.discussion_points?.length) {
    parts.push(
      `<div class="section"><h2>Discussion Points</h2><ul>${summary.discussion_points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`,
    );
  }
  if (summary.key_decisions?.length) {
    parts.push(`<div class="section"><h2>Key Decisions</h2><ul>${summary.key_decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul></div>`);
  }
  if (summary.action_items?.length) {
    const items = summary.action_items
      .map((a) => {
        const assignee = a.assignee ? ` — ${escapeHtml(a.assignee)}` : "";
        const deadline = a.deadline ? ` (due: ${escapeHtml(a.deadline)})` : "";
        return `<li><strong>${escapeHtml(a.description)}</strong>${assignee}${deadline}</li>`;
      })
      .join("");
    parts.push(`<div class="section"><h2>Action Items</h2><ul>${items}</ul></div>`);
  }
  return parts.join("\n");
}

/** Build an HTML string from analysis data for PDF/Word export. */
function buildAnalysisExportHtml(analysis: AnalysisData | null): string {
  if (!analysis || Object.keys(analysis).length === 0) return "<p>No analysis data available.</p>";
  const parts: string[] = [];
  if (analysis.topics?.length) {
    parts.push(
      `<div class="section"><h2>Topics Discussed</h2><p>${analysis.topics.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</p></div>`,
    );
  }
  if (analysis.sentiment) {
    parts.push(`<div class="section"><h2>Meeting Sentiment</h2><p>${escapeHtml(analysis.sentiment)}</p></div>`);
  }
  if (analysis.key_entities?.length) {
    parts.push(`<div class="section"><h2>Key Entities</h2><ul>${analysis.key_entities.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`);
  }
  if (analysis.effectiveness) {
    parts.push(`<div class="section"><h2>Meeting Effectiveness</h2><p>${escapeHtml(analysis.effectiveness)}</p></div>`);
  }
  if (analysis.follow_ups?.length) {
    parts.push(`<div class="section"><h2>Follow-Ups</h2><ul>${analysis.follow_ups.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`);
  }
  return parts.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ── Tab: Summary ── */

function SummaryTab({ summary }: { summary?: Props["summary"] }) {
  const hasSummaryContent =
    summary &&
    (summary.executive_summary ||
      (summary.discussion_points && summary.discussion_points.length > 0) ||
      (summary.key_decisions && summary.key_decisions.length > 0) ||
      (summary.action_items && summary.action_items.length > 0));
  if (!hasSummaryContent) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="summarize" size="32" color="muted" />
          </span>
          <p>No summary available yet.</p>
          <p className="rv-muted">The agent will generate a summary after transcription completes.</p>
        </div>
      </div>
    );
  }

  const summaryHtml = buildSummaryExportHtml(summary);

  return (
    <div className="rv-tab-content rv-tab-content--summary">
      <div className="rv-export-toolbar">
        <ExportButton format="pdf" content={summaryHtml} defaultName="Meeting_Summary" />
        <ExportButton format="word" content={summaryHtml} defaultName="Meeting_Summary" />
      </div>

      {summary.executive_summary && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">
              <Icon name="article" size="16" color="accent" />
            </span>
            <h3>Executive Summary</h3>
          </div>
          <p className="rv-summary-text">{summary.executive_summary}</p>
        </div>
      )}

      {summary.discussion_points && summary.discussion_points.length > 0 && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">
              <Icon name="chat" size="16" color="accent" />
            </span>
            <h3>Discussion Points</h3>
          </div>
          <ul className="rv-summary-list">
            {summary.discussion_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.key_decisions && summary.key_decisions.length > 0 && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">
              <Icon name="check_circle" size="16" color="green" />
            </span>
            <h3>Key Decisions</h3>
          </div>
          <ul className="rv-summary-list rv-list--decisions">
            {summary.key_decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.action_items && summary.action_items.length > 0 && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">
              <Icon name="push_pin" size="16" color="accent" />
            </span>
            <h3>Action Items</h3>
          </div>
          <ul className="rv-action-items">
            {summary.action_items.map((a, i) => (
              <li key={i}>
                <label className="rv-action-checkbox">
                  <input type="checkbox" />
                  <span className="rv-action-text">
                    <strong>{a.description}</strong>
                    {a.assignee && <span className="rv-assignee"> — {a.assignee}</span>}
                    {a.deadline && <span className="rv-deadline"> (due: {a.deadline})</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── Tab: Analysis ── */

function AnalysisTab({ analysis }: { analysis: AnalysisData | null }) {
  const hasAnalysisContent =
    analysis &&
    ((analysis.topics && analysis.topics.length > 0) ||
      analysis.sentiment ||
      (analysis.key_entities && analysis.key_entities.length > 0) ||
      analysis.effectiveness ||
      (analysis.follow_ups && analysis.follow_ups.length > 0));
  if (!hasAnalysisContent) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="analytics" size="32" color="muted" />
          </span>
          <p>No analysis data available.</p>
          <p className="rv-muted">Analysis includes topics, sentiment, and key entities from the meeting.</p>
        </div>
      </div>
    );
  }

  const analysisHtml = buildAnalysisExportHtml(analysis);

  return (
    <div className="rv-tab-content rv-tab-content--analysis">
      <div className="rv-export-toolbar">
        <ExportButton format="pdf" content={analysisHtml} defaultName="Meeting_Analysis" />
        <ExportButton format="word" content={analysisHtml} defaultName="Meeting_Analysis" />
      </div>

      <div className="rv-analysis-grid">
        {analysis.topics && analysis.topics.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">
                <Icon name="label" size="16" color="accent" />
              </span>
              <h3>Topics Discussed</h3>
            </div>
            <div className="rv-tag-list">
              {analysis.topics.map((t, i) => (
                <span key={i} className="rv-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {analysis.sentiment && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">
                <Icon name="sentiment_satisfied" size="16" color="accent" />
              </span>
              <h3>Meeting Sentiment</h3>
            </div>
            <p className="rv-analysis-text">{analysis.sentiment}</p>
          </div>
        )}

        {analysis.key_entities && analysis.key_entities.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">
                <Icon name="key" size="16" color="accent" />
              </span>
              <h3>Key Entities</h3>
            </div>
            <ul className="rv-entity-list">
              {analysis.key_entities.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {analysis.effectiveness && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">
                <Icon name="trending_up" size="16" color="accent" />
              </span>
              <h3>Meeting Effectiveness</h3>
            </div>
            <p className="rv-analysis-text">{analysis.effectiveness}</p>
          </div>
        )}

        {analysis.follow_ups && analysis.follow_ups.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">
                <Icon name="outgoing_mail" size="16" color="accent" />
              </span>
              <h3>Follow-Ups</h3>
            </div>
            <ul className="rv-entity-list">
              {analysis.follow_ups.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Tab: Logs ── */

/** Source colour palette, matching DevPanel. */
const RV_SOURCE_COLORS: Record<string, string> = {
  python: "#58a6ff",
  bridge: "#3fb950",
  agent: "#d29922",
  main: "#8b949e",
  transcription: "#f0883e",
  usage: "#db61a2",
  ollama: "#7ee787",
};

/** Try to parse a raw log line into a structured LogEntry-like object.

  Handles the pipeline.log format:
    `[ISO timestamp] [source][subsource] [level] message`

  Strips all structured tags so only the clean message text remains
  (the UI renders timestamp, source, and level separately).
*/
function parseLogLine(raw: string): { timestamp: number; source: string; subSource?: string; level: string; message: string } | null {
  // ── 1. Strip leading [ISO timestamp] ──
  const tsMatch = raw.match(/^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3}Z)\]\s*/);
  const timestamp = tsMatch ? new Date(tsMatch[1]).getTime() : Date.now();
  let remainder = tsMatch ? raw.slice(tsMatch[0].length) : raw;

  // ── 2. Strip [source] tag ──
  const srcMatch = remainder.match(/^\[(python|bridge|agent|main|usage|ollama)\]\s*/i);
  let source = srcMatch ? srcMatch[1].toLowerCase() : "main";
  if (srcMatch) remainder = remainder.slice(srcMatch[0].length);

  // ── 3. Strip [level] tag (appears right after source/subsource) ──
  const levelMatch = remainder.match(/^\[(info|error|warn(?:ing)?|debug)\]\s*/i);
  let level = "info";
  let subSource: string | undefined;
  if (levelMatch) {
    level = levelMatch[1].toLowerCase();
    remainder = remainder.slice(levelMatch[0].length);
  } else {
    // ── 4. No level tag — strip optional [subsource] tag and capture it ──
    // After [source] there may be a [subsource] (e.g. [transcription], [pipeline], [runner], [build-context])
    const subMatch = remainder.match(/^\[([a-zA-Z0-9 _-]+)\]\s*/);
    if (subMatch) {
      subSource = subMatch[1].toLowerCase();
      remainder = remainder.slice(subMatch[0].length);
      // Now try to strip the [level] tag after subsource
      const lvlMatch = remainder.match(/^\[(info|error|warn(?:ing)?|debug)\]\s*/i);
      if (lvlMatch) {
        level = lvlMatch[1].toLowerCase();
        remainder = remainder.slice(lvlMatch[0].length);
      }
    }
  }

  // Also match the [USAGE] pattern inside the remaining text
  if (/💰\s*\[usage\]/i.test(remainder)) source = "usage";

  return { timestamp, source, subSource, level, message: remainder.trim() };
}

/* ── Log grouping helpers ── */

interface LogGroupEntry {
  timestamp: number;
  source: string;
  subSource?: string;
  level: string;
  lines: Array<{
    timestamp: number;
    message: string;
  }>;
}

function groupConsecutiveEntries(
  entries: Array<{ timestamp: number; source: string; subSource?: string; level: string; message: string }>,
): LogGroupEntry[] {
  const groups: LogGroupEntry[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.source === entry.source && last.subSource === entry.subSource && last.level === entry.level) {
      last.lines.push({ timestamp: entry.timestamp, message: entry.message });
    } else {
      groups.push({
        timestamp: entry.timestamp,
        source: entry.source,
        subSource: entry.subSource,
        level: entry.level,
        lines: [{ timestamp: entry.timestamp, message: entry.message }],
      });
    }
  }
  return groups;
}

/** Detect section-header decoration lines like ═══ ... ═══ or ===== */
function isSectionHeader(msg: string): boolean {
  return /^[═=]{3,}|^[─━]{3,}|^━━━/.test(msg);
}

function LogsTab({ jobId }: { jobId: string }) {
  const [rawLogs, setRawLogs] = useState<string[]>([]);
  const [entries, setEntries] = useState<ReturnType<typeof parseLogLine>[]>([]);
  const [jobLogFiles, setJobLogFiles] = useState<{ file: string; content: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [subSourceFilter, setSubSourceFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [noTruncate, setNoTruncate] = useState(true);
  const [logSubTab, setLogSubTab] = useState<"pipeline" | "agent" | "transcript" | "raw">("pipeline");
  const [collapseRepeated, setCollapseRepeated] = useState(true);
  const [prettifiedBlock, setPrettifiedBlock] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Read LOG_COLLAPSE_REPEATED_PREFIXES from config on mount
  useEffect(() => {
    window.electronAPI?.getConfig().then((cfg) => {
      if (cfg?.LOG_COLLAPSE_REPEATED_PREFIXES === "false") {
        setCollapseRepeated(false);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        // Primary source: per-job pipeline.log via dedicated endpoint (returns ALL lines)
        const pipelineRes = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool: "transcribe_get_pipeline_log",
            args: { jobId, maxLines: noTruncate ? 0 : 1000, includeGlobal: "true" },
          }),
        });
        const pipelineData = await pipelineRes.json();
        if (!cancelled && pipelineData?.lines) {
          setRawLogs(pipelineData.lines);
          setEntries(pipelineData.lines.map((l: string) => parseLogLine(l)));
        }

        // Secondary source: per-job file listing (pipeline.log, agent-trace.jsonl, etc.)
        const jobLogsRes = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_job_logs", args: { jobId, maxLines: 0 } }),
        });
        const jobLogsData = await jobLogsRes.json();
        if (!cancelled) {
          setJobLogFiles(jobLogsData.job_logs || []);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          // Fallback: try the old endpoint if pipeline_log fails
          try {
            const fallbackRes = await fetch(`${BRIDGE_URL}/tools/call`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tool: "transcribe_get_job_logs", args: { jobId, maxLines: noTruncate ? 0 : 300 } }),
            });
            const fallbackData = await fallbackRes.json();
            if (!cancelled) {
              const lines: string[] = fallbackData.logs || [];
              setRawLogs(lines);
              setEntries(lines.map((l: string) => parseLogLine(l)));
              setJobLogFiles(fallbackData.job_logs || []);
            }
          } catch {
            if (!cancelled) setError(err.message);
          }
          setLoading(false);
        }
      }
    };
    fetchLogs();
    return () => {
      cancelled = true;
    };
  }, [jobId, noTruncate]);

  // Auto-scroll when entries change
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Strip nulls first to keep TS happy
  const nonNullEntries = entries.filter((e): e is NonNullable<typeof e> => e !== null);

  // ── Agent log pre-filter: agent source only, exclude poller/usage/raw I/O ──
  const agentFilteredEntries = nonNullEntries.filter((entry) => {
    if (entry.source !== "agent") return false;
    if (entry.subSource === "poller" || entry.subSource === "usage") return false;
    if (/\bRAW API\b/i.test(entry.message)) return false;
    if (/\u2697\ufe0f.*\[usage\]/i.test(entry.message)) return false;
    return true;
  });

  const searchMatchTotal = searchQuery.trim() ? nonNullEntries.filter((e) => e.message.toLowerCase().includes(searchQuery.toLowerCase())).length : 0;
  const filteredEntries = (logSubTab === "agent" ? agentFilteredEntries : nonNullEntries).filter((entry) => {
    if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
    if (subSourceFilter !== "all" && (!entry.subSource || entry.subSource !== subSourceFilter)) return false;
    if (levelFilter !== "all" && entry.level !== levelFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const inMessage = entry.message.toLowerCase().includes(q);
      const inSource = entry.source.toLowerCase().includes(q);
      const inLevel = entry.level.toLowerCase().includes(q);
      if (!inMessage && !inSource && !inLevel) return false;
    }
    return true;
  });

  // Group consecutive entries when collapse mode is on
  const groupedEntries: LogGroupEntry[] = collapseRepeated
    ? groupConsecutiveEntries(filteredEntries)
    : filteredEntries.map((e) => ({
        timestamp: e.timestamp,
        source: e.source,
        subSource: e.subSource,
        level: e.level,
        lines: [{ timestamp: e.timestamp, message: e.message }],
      }));

  /** Highlight search matches in text */
  const highlightText = useCallback(
    (text: string): React.ReactNode => {
      if (!searchQuery.trim()) return text;
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = text.split(new RegExp(`(${escaped})`, "gi"));
      if (parts.length === 1) return text;
      return parts.map((part, i) =>
        part.toLowerCase() === searchQuery.toLowerCase() ? (
          <em key={i} className="rv-search-highlight">
            {part}
          </em>
        ) : (
          part
        ),
      );
    },
    [searchQuery],
  );

  if (error) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="error" color="red" size="32" />
          </span>
          <p>Failed to load logs: {error}</p>
        </div>
      </div>
    );
  }

  // Find transcript and raw transcript file content
  const transcriptFile = jobLogFiles.find((jf) => jf.file === "transcript.txt");
  const rawTranscriptFile = jobLogFiles.find((jf) => jf.file === "raw_transcript.txt");
  const pipelineLogFile = jobLogFiles.find((jf) => jf.file === "pipeline.log");

  /** Render a collapsed log viewer for a raw log file content */
  const renderCollapsedLogViewer = (jf: { file: string; content: string } | undefined) => {
    if (!jf || !jf.content) {
      return (
        <div className="rv-empty-state" style={{ padding: 24 }}>
          <span className="rv-empty-icon">
            <Icon name="terminal" size="24" color="muted" />
          </span>
          <p>No pipeline log file available for this job.</p>
          <p className="rv-muted">The file will appear here once generated by the pipeline.</p>
        </div>
      );
    }

    const lines = jf.content.split("\n").filter(Boolean);
    const parsed = lines.map((l) => parseLogLine(l)).filter(Boolean) as NonNullable<ReturnType<typeof parseLogLine>>[];
    const grouped = collapseRepeated
      ? groupConsecutiveEntries(parsed)
      : parsed.map((e) => ({
          timestamp: e.timestamp,
          source: e.source,
          subSource: e.subSource,
          level: e.level,
          lines: [{ timestamp: e.timestamp, message: e.message }],
        }));

    return (
      <div className="rv-logs-file-item" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="rv-logs-file-header">
          <span className="rv-logs-file-name">{jf.file}</span>
          <span className="rv-logs-file-size">{(jf.content.length / 1024).toFixed(1)} KB</span>
        </div>
        <div className="rv-logs-list" style={{ flex: 1, maxHeight: "none" }}>
          {grouped.map((group, gi) => {
            const isGroup = group.lines.length > 1;
            const isHeader = isSectionHeader(group.lines[0]?.message || "");
            return (
              <div key={gi} className={`rv-log-group ${isGroup ? "rv-log-group--multi" : ""} ${isHeader ? "rv-log-group--header" : ""}`}>
                {!isGroup && (
                  <div className="rv-log-line rv-log-line--parsed">
                    <span className="rv-log-line-time">{new Date(group.timestamp).toLocaleTimeString()}</span>
                    <span className="rv-log-line-source" style={{ color: RV_SOURCE_COLORS[group.source] || "#8b949e" }}>
                      [{group.source}]
                    </span>
                    {group.subSource && (
                      <span className="rv-log-line-subsource" style={{ color: RV_SOURCE_COLORS[group.subSource] || "#8b949e" }}>
                        [{group.subSource}]
                      </span>
                    )}
                    <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
                      {group.level === "error" ? "!" : group.level === "warn" ? "▲" : ""}
                    </span>
                    <span className="rv-log-line-text">{group.lines[0].message}</span>
                    <Tooltip content="Open this log entry in the prettified viewer">
                      <button className="rv-log-prettify-btn" onClick={() => setPrettifiedBlock(group.lines[0].message)} title="View prettified">
                        <Icon name="open_in_new" size="10" />
                      </button>
                    </Tooltip>
                  </div>
                )}
                {isGroup && (
                  <details className="rv-log-details" open={isHeader ? true : undefined}>
                    <summary className="rv-log-summary">
                      <span className="rv-log-summary-line">
                        <span className="rv-log-line-time">{new Date(group.timestamp).toLocaleTimeString()}</span>
                        <span className="rv-log-line-source" style={{ color: RV_SOURCE_COLORS[group.source] || "#8b949e" }}>
                          [{group.source}]
                        </span>
                        {group.subSource && (
                          <span className="rv-log-line-subsource" style={{ color: RV_SOURCE_COLORS[group.subSource] || "#8b949e" }}>
                            [{group.subSource}]
                          </span>
                        )}
                        <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
                          {group.level === "error" ? "!" : group.level === "warn" ? "▲" : ""}
                        </span>
                        <span className="rv-log-summary-msg">{group.lines[0].message}</span>
                      </span>
                      <Tooltip content="Open the entire group content in the prettified viewer">
                        <button
                          className="rv-log-prettify-btn rv-log-prettify-btn--group"
                          onClick={() => setPrettifiedBlock(group.lines.map((l) => l.message).join("\n"))}
                          title="View all lines prettified">
                          <Icon name="open_in_new" size="10" />
                        </button>
                      </Tooltip>
                      <span className="rv-log-group-badge">{group.lines.length} lines</span>
                    </summary>
                    <div className="rv-log-group-lines">
                      {group.lines.map((line, li) => (
                        <div key={li} className="rv-log-line rv-log-line--nested">
                          <span className="rv-log-gutter">│</span>
                          <span className="rv-log-line-text">{line.message}</span>
                          <Tooltip content="Open this log entry in the prettified viewer">
                            <button className="rv-log-prettify-btn" onClick={() => setPrettifiedBlock(line.message)} title="View prettified">
                              <Icon name="open_in_new" size="10" />
                            </button>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  /** Render a file viewer for a given job file */
  const renderFileViewer = (jf: { file: string; content: string } | undefined, label: string) => {
    if (!jf || !jf.content) {
      return (
        <div className="rv-empty-state" style={{ padding: 24 }}>
          <span className="rv-empty-icon">
            <Icon name="description" size="24" color="muted" />
          </span>
          <p>No {label} available for this job.</p>
          <p className="rv-muted">The file will appear here once generated by the pipeline.</p>
        </div>
      );
    }
    return (
      <div className="rv-logs-file-item" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="rv-logs-file-header">
          <span className="rv-logs-file-name">{jf.file}</span>
          <span className="rv-logs-file-size">{(jf.content.length / 1024).toFixed(1)} KB</span>
        </div>
        <pre className="rv-logs-rpre">{jf.content}</pre>
      </div>
    );
  };

  return (
    <div className="rv-tab-content rv-tab-content--logs" style={{ display: "flex", flexDirection: "column", overflow: "hidden", height: "100%" }}>
      <LoadingModal visible={loading} message="Loading log files…" />

      {/* Sub-tab navigation */}
      <div className="rv-logs-sub-tabs">
        <button
          className={`rv-logs-sub-tab ${logSubTab === "pipeline" ? "rv-logs-sub-tab--active" : ""}`}
          onClick={() => setLogSubTab("pipeline")}
          title="View parsed pipeline log entries with source and level filtering">
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
          title="View the raw (unrefined) transcript text file">
          <Icon name="article" size="14" /> Raw Transcript TXT
        </button>
      </div>

      {/* ── Pipeline Log / Agent Log sub-tabs (share same renderer) ── */}
      {(logSubTab === "pipeline" || logSubTab === "agent") && (
        <>
          {/* Filter toolbar */}
          {rawLogs.length > 0 && (
            <div className="rv-logs-toolbar" style={{ flexShrink: 0, flexWrap: "wrap" }}>
              <span className="rv-logs-toolbar-title">
                {logSubTab === "agent" ? (
                  <>
                    <Icon name="smart_toy" size="14" color="accent" /> Agent Logs
                    <span className="rv-logs-badge" style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
                      (agent only, no poller/usage/raw I/O)
                    </span>
                  </>
                ) : (
                  <>
                    <Icon name="terminal" size="14" color="accent" /> Pipeline Logs
                  </>
                )}
              </span>
              <div className="rv-logs-toolbar-filters">
                <div className="rv-logs-search-wrap">
                  <span className="rv-logs-search-icon">🔍</span>
                  <input
                    className="rv-logs-search-input"
                    type="text"
                    placeholder="Search logs…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    title={
                      searchQuery.trim()
                        ? `${searchMatchTotal} match${searchMatchTotal !== 1 ? "es" : ""} in unfiltered logs`
                        : "Search log entries by text"
                    }
                  />
                  {searchQuery && (
                    <Tooltip content="Clear the log search query">
                      <button className="rv-logs-search-clear" onClick={() => setSearchQuery("")} title="Clear search">
                        <Icon name="close" size="12" />
                      </button>
                    </Tooltip>
                  )}
                </div>
                <select
                  className="rv-logs-filter-select"
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  style={logSubTab === "agent" ? { display: "none" } : undefined}>
                  <option value="all">All sources</option>
                  <option value="python">Python</option>
                  <option value="bridge">Bridge</option>
                  <option value="agent">Agent</option>
                  <option value="main">Main</option>
                </select>
                <select className="rv-logs-filter-select" value={subSourceFilter} onChange={(e) => setSubSourceFilter(e.target.value)}>
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
                <select className="rv-logs-filter-select" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
                  <option value="all">All levels</option>
                  <option value="info">Info</option>
                  <option value="warn">Warnings</option>
                  <option value="error">Errors</option>
                  <option value="debug">Debug</option>
                </select>
                <Tooltip content="Collapse repeated prefix groups">
                  <label className="rv-logs-toggle" title="Collapse consecutive log entries with identical source/sub-source/level">
                    <input type="checkbox" checked={collapseRepeated} onChange={(e) => setCollapseRepeated(e.target.checked)} />
                    <Icon name="compress" size="12" /> Group
                  </label>
                </Tooltip>
              </div>
              <span className="rv-logs-filter-count">
                {filteredEntries.length} / {rawLogs.length} entry{rawLogs.length !== 1 ? "ies" : "y"}
              </span>
            </div>
          )}

          {/* Filtered pipeline logs */}
          {rawLogs.length > 0 ? (
            <div className="rv-logs-section" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {filteredEntries.length > 0 ? (
                <div className="rv-logs-list" ref={logRef} style={{ maxHeight: "none", flex: 1 }}>
                  {groupedEntries.map((group, gi) => {
                    const isGroup = group.lines.length > 1;
                    const isHeader = isSectionHeader(group.lines[0]?.message || "");
                    return (
                      <div key={gi} className={`rv-log-group ${isGroup ? "rv-log-group--multi" : ""} ${isHeader ? "rv-log-group--header" : ""}`}>
                        {/* ── Single line: render normally ── */}
                        {!isGroup && (
                          <div className="rv-log-line rv-log-line--parsed">
                            <span className="rv-log-line-time">{new Date(group.timestamp).toLocaleTimeString()}</span>
                            <span className="rv-log-line-source" style={{ color: RV_SOURCE_COLORS[group.source] || "#8b949e" }}>
                              [{group.source}]
                            </span>
                            {group.subSource && (
                              <span className="rv-log-line-subsource" style={{ color: RV_SOURCE_COLORS[group.subSource] || "#8b949e" }}>
                                [{group.subSource}]
                              </span>
                            )}
                            <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
                              {group.level === "error" ? "!" : group.level === "warn" ? "▲" : ""}
                            </span>
                            <span className="rv-log-line-text">{highlightText(group.lines[0].message)}</span>
                            <Tooltip content="Open this log entry in the prettified viewer">
                              <button
                                className="rv-log-prettify-btn"
                                onClick={() => setPrettifiedBlock(group.lines[0].message)}
                                title="View prettified">
                                <Icon name="open_in_new" size="10" />
                              </button>
                            </Tooltip>
                          </div>
                        )}
                        {/* ── Multi-line group: collapsible ── */}
                        {isGroup && (
                          <details className="rv-log-details" open={isHeader ? true : undefined}>
                            <summary className="rv-log-summary">
                              <span className="rv-log-summary-line">
                                <span className="rv-log-line-time">{new Date(group.timestamp).toLocaleTimeString()}</span>
                                <span className="rv-log-line-source" style={{ color: RV_SOURCE_COLORS[group.source] || "#8b949e" }}>
                                  [{group.source}]
                                </span>
                                {group.subSource && (
                                  <span className="rv-log-line-subsource" style={{ color: RV_SOURCE_COLORS[group.subSource] || "#8b949e" }}>
                                    [{group.subSource}]
                                  </span>
                                )}
                                <span className={`rv-log-line-level rv-log-line-level--${group.level}`}>
                                  {group.level === "error" ? "!" : group.level === "warn" ? "▲" : ""}
                                </span>
                                <span className="rv-log-summary-msg">{group.lines[0].message}</span>
                              </span>
                              <Tooltip content="Open the entire group content in the prettified viewer">
                                <button
                                  className="rv-log-prettify-btn rv-log-prettify-btn--group"
                                  onClick={() => setPrettifiedBlock(group.lines.map((l) => l.message).join("\n"))}
                                  title="View all lines prettified">
                                  <Icon name="open_in_new" size="10" />
                                </button>
                              </Tooltip>
                              <span className="rv-log-group-badge">{group.lines.length} lines</span>
                            </summary>
                            <div className="rv-log-group-lines">
                              {group.lines.map((line, li) => (
                                <div key={li} className="rv-log-line rv-log-line--nested">
                                  <span className="rv-log-gutter">│</span>
                                  <span className="rv-log-line-text">{highlightText(line.message)}</span>
                                  <Tooltip content="Open this log entry in the prettified viewer">
                                    <button className="rv-log-prettify-btn" onClick={() => setPrettifiedBlock(line.message)} title="View prettified">
                                      <Icon name="open_in_new" size="10" />
                                    </button>
                                  </Tooltip>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rv-logs-empty-filter">
                  <span className="rv-logs-empty-filter-icon">
                    <Icon name="search_off" size="14" color="muted" />
                  </span>
                  <span>{logSubTab === "agent" ? "No agent logs match the current filters." : "No logs match the current filters."}</span>
                </div>
              )}
              <div className="dev-panel-footer">
                <span>{filteredEntries.length} matches</span>
                <span>{rawLogs.length} total</span>
              </div>
            </div>
          ) : (
            <div className="rv-empty-state">
              <span className="rv-empty-icon">
                <Icon name={logSubTab === "agent" ? "smart_toy" : "terminal"} size="32" color="muted" />
              </span>
              {logSubTab === "agent" ? (
                <>
                  <p>No agent log entries found for this job.</p>
                  <p className="rv-muted">Agent logs will appear here as the agent runner processes the job.</p>
                </>
              ) : (
                <>
                  <p>No pipeline log entries found for this job.</p>
                  <p className="rv-muted">Pipeline log will appear here as the pipeline runs.</p>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Prettified View Modal ── */}
      {prettifiedBlock !== null && (
        <div className="rv-prettify-overlay" onClick={() => setPrettifiedBlock(null)}>
          <div className="rv-prettify-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rv-prettify-header">
              <h3 className="rv-prettify-title">
                <Icon name="open_in_new" size="14" color="accent" /> Prettified View
              </h3>
              <Tooltip content="Close prettified view">
                <button className="rv-prettify-close" onClick={() => setPrettifiedBlock(null)} title="Close">
                  <Icon name="close" size="14" />
                </button>
              </Tooltip>
            </div>
            <div className="rv-prettify-tabs">
              <button className="rv-prettify-tab rv-prettify-tab--active">Text</button>
            </div>
            <div className="rv-prettify-body">
              <pre className="rv-prettify-content">{prettifiedBlock}</pre>
            </div>
            <div className="rv-prettify-footer">
              <Tooltip content="Copy the prettified content to your clipboard">
                <button className="rv-prettify-copy-btn" onClick={() => navigator.clipboard.writeText(prettifiedBlock)} title="Copy to clipboard">
                  <Icon name="content_copy" size="12" /> Copy
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      {/* ── Transcript TXT sub-tab ── */}
      {logSubTab === "transcript" && renderFileViewer(transcriptFile, "transcript text")}

      {/* ── Raw Transcript TXT sub-tab ── */}
      {logSubTab === "raw" && renderFileViewer(rawTranscriptFile, "raw transcript text")}
    </div>
  );
}

/* ── Tab: Tokens ── */

interface TokenUsageData {
  job_id: string;
  title: string;
  provider: string;
  model: string;
  steps: Array<{
    step: number;
    tool: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
  totals: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  costs?: {
    input_cost: number;
    output_cost: number;
    total_cost: number;
  };
  saved_at: string;
}

function TokensTab({ jobId }: { jobId: string }) {
  const [usage, setUsage] = useState<TokenUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchUsage = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_token_usage", args: { jobId } }),
        });
        if (!res.ok) {
          // Try to extract the server's error message for a friendlier display
          let serverMsg = "";
          try {
            const body = await res.json();
            serverMsg = body.error || "";
          } catch {
            /* ignore */
          }
          if (res.status === 404) throw new Error(serverMsg || "Token usage not available for this job");
          throw new Error(serverMsg || `Bridge error: ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setUsage(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUsage();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (loading) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <p>Loading token usage…</p>
        </div>
      </div>
    );
  }

  if (error || !usage) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="token" size="32" color="muted" />
          </span>
          <p>Token usage data unavailable</p>
          <p className="rv-muted">{error || "No usage data recorded for this job."}</p>
          <p className="rv-muted">Token tracking was added after this job was processed. Future jobs will include this data.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--tokens">
      {/* Summary card */}
      <div className="rv-tokens-summary">
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.totals.total_tokens.toLocaleString()}</span>
          <span className="rv-tokens-card-label">Total Tokens</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.totals.prompt_tokens.toLocaleString()}</span>
          <span className="rv-tokens-card-label">Prompt (Input)</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.totals.completion_tokens.toLocaleString()}</span>
          <span className="rv-tokens-card-label">Completion (Output)</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.steps.length}</span>
          <span className="rv-tokens-card-label">LLM Calls</span>
        </div>
        {/* Cost cards — only if costs data is available */}
        {usage.costs && (
          <>
            <div className="rv-tokens-card rv-tokens-card--cost">
              <span className="rv-tokens-card-value">${usage.costs.input_cost.toFixed(4)}</span>
              <span className="rv-tokens-card-label">Input Cost @ $0.25/M</span>
            </div>
            <div className="rv-tokens-card rv-tokens-card--cost">
              <span className="rv-tokens-card-value">${usage.costs.output_cost.toFixed(4)}</span>
              <span className="rv-tokens-card-label">Output Cost @ $1.00/M</span>
            </div>
            <div className="rv-tokens-card rv-tokens-card--cost">
              <span className="rv-tokens-card-value" style={{ fontWeight: 700 }}>
                ${usage.costs.total_cost.toFixed(4)}
              </span>
              <span className="rv-tokens-card-label">Total Cost</span>
            </div>
          </>
        )}
      </div>

      {/* Model info */}
      <div className="rv-tokens-model-info">
        {usage.provider === "ollama" && (
          <span className="rv-tokens-model-badge rv-tokens-model-badge--local" style={{ background: "rgba(210,153,34,0.15)", color: "#d29922" }}>
            <Icon name="computer" size="14" color="orange" /> Local (no cost)
          </span>
        )}
        <span className="rv-tokens-model-badge">{usage.provider}</span>
        <code className="rv-code">{usage.model}</code>
        <span className="rv-muted" style={{ marginLeft: "auto" }}>
          Saved {new Date(usage.saved_at).toLocaleString()}
        </span>
      </div>

      {/* Per-step breakdown */}
      <h4 className="rv-tokens-steps-title">Per-Step Breakdown</h4>
      <div className="rv-tokens-table-wrapper">
        <table className="rv-tokens-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Tool</th>
              <th>Prompt</th>
              <th>Completion</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {usage.steps.map((step) => (
              <tr key={step.step}>
                <td className="rv-tokens-step-num">{step.step}</td>
                <td>
                  <code className="rv-code">{step.tool}</code>
                </td>
                <td className="rv-tokens-num">{step.prompt_tokens.toLocaleString()}</td>
                <td className="rv-tokens-num">{step.completion_tokens.toLocaleString()}</td>
                <td className="rv-tokens-num rv-tokens-num--total">{step.total_tokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Pipeline stage definitions (mirrors ProgressPanel) ── */

interface StageDef {
  key: string;
  icon: string;
  label: string;
  description: string;
  matches: string[];
}

const PIPELINE: StageDef[] = [
  { key: "uploaded", icon: "upload_file", label: "Uploading", description: "Receiving your audio file", matches: ["uploaded"] },
  { key: "initializing", icon: "build", label: "Getting Ready", description: "Preparing the transcription system", matches: ["initializing"] },
  {
    key: "diarization",
    icon: "group",
    label: "Identifying Speakers",
    description: "Detecting who speaks and when",
    matches: ["processing_diarization"],
  },
  {
    key: "voiceprints",
    icon: "badge",
    label: "Matching Voices",
    description: "Matching voices to known attendees",
    matches: ["matching_voiceprints"],
  },
  {
    key: "transcription",
    icon: "mic",
    label: "Transcribing Speech",
    description: "Converting speech to text",
    matches: ["processing_transcription"],
  },
  { key: "aligning", icon: "link", label: "Building Transcript", description: "Matching words to each speaker", matches: ["aligning"] },
  {
    key: "agent",
    icon: "smart_toy",
    label: "AI Processing",
    description: "Refining, summarizing & analyzing",
    matches: ["transcribed", "ready_for_agent", "labeling_needed", "refined", "summarized"],
  },
  {
    key: "memory",
    icon: "memory",
    label: "Saving to Memory",
    description: "Storing meeting context for future reference",
    matches: ["analyzed"],
  },
  { key: "delivery", icon: "mail", label: "Delivering Results", description: "Sending via email, Trello & Drive", matches: ["delivered"] },
];

const COMPLETE_STATUSES = new Set(["delivered", "complete"]);

function getStageState(stage: StageDef, status: string, isFailed: boolean, isComplete: boolean): "done" | "active" | "pending" | "error" {
  if (isFailed && stage.matches.includes(status)) return "error";
  if (isFailed) return "done";
  if (isComplete) return "done";
  if (stage.matches.includes(status)) return "active";
  const currentIdx = PIPELINE.findIndex((s) => s.matches.includes(status));
  const stageIdx = PIPELINE.findIndex((s) => s.key === stage.key);
  if (stageIdx < currentIdx) return "done";
  return "pending";
}

/* ── Tab: Pipeline ── */

function PipelineTab({ status, progress, error }: { status: string; progress: number; error?: string | null }) {
  const isFailed = status === "failed";
  const isComplete = COMPLETE_STATUSES.has(status);
  // Progress comes in as 0-1; for completed jobs the backend may return a
  // small value (e.g. 0.01), so always clamp to 100% when complete.
  const barWidth = isComplete ? "100%" : `${Math.min(Math.round(progress * 100), 100)}%`;

  return (
    <div className="rv-tab-content rv-tab-content--pipeline">
      {/* Progress bar */}
      <div className="pp-bar-track">
        <div className={`pp-bar-fill ${isFailed ? "pp-bar-fill--error" : isComplete ? "pp-bar-fill--done" : ""}`} style={{ width: barWidth }} />
      </div>
      <div className="pp-bar-label">
        {isFailed ? (
          <>
            <Icon name="error" color="red" size="14" /> Failed
          </>
        ) : isComplete ? (
          <>
            <Icon name="check_circle" color="green" size="14" /> Complete
          </>
        ) : (
          `${Math.round(progress * 100)}%`
        )}
      </div>

      {/* Pipeline stepper */}
      <div className="pp-stepper">
        {PIPELINE.map((stage) => {
          const state = getStageState(stage, status, isFailed, isComplete);
          return (
            <div key={stage.key} className={`pp-step pp-step--${state}`}>
              <div className="pp-step-line" />
              <div className="pp-step-dot">
                {state === "done" && (
                  <span className="pp-step-check">
                    <Icon name="check" size="12" />
                  </span>
                )}
                {state === "active" && <span className="pp-step-spinner" />}
                {state === "error" && (
                  <span className="pp-step-check" style={{ color: "#fff" }}>
                    <Icon name="close" size="12" />
                  </span>
                )}
                {state === "pending" && <span className="pp-step-pending-dot" />}
              </div>
              <div className="pp-step-content">
                <span className="pp-step-icon">
                  <Icon name={stage.icon} size="14" />
                </span>
                <div className="pp-step-text">
                  <span className="pp-step-label">{stage.label}</span>
                  {(state === "done" || state === "active" || state === "error") && <span className="pp-step-desc">{stage.description}</span>}
                </div>
                {state === "done" && <span className="pp-step-done-badge">Done</span>}
                {state === "active" && <span className="pp-step-active-badge">In progress</span>}
                {state === "error" && (
                  <span className="pp-step-done-badge" style={{ color: "var(--red)", background: "rgba(248, 81, 73, 0.12)" }}>
                    Error
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {isFailed && error && (
        <div className="pp-error-box">
          <span className="pp-error-header">
            <Icon name="error" color="red" size="14" /> Error
          </span>
          <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>{error}</p>
        </div>
      )}
    </div>
  );
}

/* ── Performance Tab (per-job CPU & memory) ── */

interface PerfSample {
  timestamp: number;
  cpu: number;
  memoryBytes: number;
  label: string;
  stage: string | null;
}

/** Stage marker colors */
const PERF_STAGE_COLORS: Record<string, string> = {
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

const PERF_STAGE_LABELS: Record<string, string> = {
  uploaded: "Upload",
  initializing: "Init",
  diarization: "Speakers",
  voiceprints: "Voices",
  transcription: "Transcribe",
  aligning: "Align",
  agent: "AI",
  memory: "Memory",
  delivery: "Delivery",
};

function PerformanceTab({ jobId }: { jobId: string }) {
  const [samples, setSamples] = useState<PerfSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const data = await window.electronAPI?.getPerJobPerformance(jobId);
        if (!cancelled && data) setSamples(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    // Poll for live data every 5s
    const interval = setInterval(fetchData, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId]);

  if (loading) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <p>Loading performance data…</p>
        </div>
      </div>
    );
  }

  if (error || samples.length === 0) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="speed" size="32" color="muted" />
          </span>
          <p>Performance data unavailable</p>
          <p className="rv-muted">{error || "No performance data recorded for this job yet."}</p>
        </div>
      </div>
    );
  }

  // Sort by timestamp
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const startTime = sorted[0].timestamp;
  const cpuVals = sorted.map((s) => s.cpu);
  const memVals = sorted.map((s) => s.memoryBytes);
  const maxCpu = Math.max(...cpuVals, 1);
  const maxMem = Math.max(...memVals, 1);
  const chartW = 600;
  const chartH = 140;
  const padX = 50;
  const padY = 20;

  const makePoints = (data: number[], maxVal: number, offset = 0) =>
    data
      .map((v, i) => {
        const x = padX + (i / Math.max(1, data.length - 1)) * (chartW - padX * 2);
        const y = padY + chartH - ((v + offset) / maxVal) * chartH;
        return `${x},${y}`;
      })
      .join(" ");

  // Build stage transition markers
  const stageMarkers: { index: number; stage: string; label: string }[] = [];
  let lastStage: string | null = null;
  sorted.forEach((s, i) => {
    if (s.stage && s.stage !== lastStage && lastStage !== null) {
      stageMarkers.push({ index: i, stage: s.stage, label: PERF_STAGE_LABELS[s.stage] || s.stage });
    }
    if (s.stage) lastStage = s.stage;
  });

  return (
    <div className="rv-tab-content" style={{ padding: "12px 16px", fontFamily: "var(--font)" }}>
      <div className="usage-bar-chart" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: "var(--fs-11)", fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
          <Icon name="speed" size="12" color="accent" /> CPU &amp; Memory During Job
          <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 10, opacity: 0.7 }}>{sorted.length} samples</span>
        </div>
        <svg viewBox={`0 0 ${chartW} ${chartH + 40}`} width="100%" height={chartH + 40} style={{ display: "block" }}>
          <rect x={0} y={0} width={chartW} height={chartH + 40} fill="var(--bg)" rx={4} />
          {/* Grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padY + chartH - frac * chartH;
            return (
              <g key={frac}>
                <line x1={padX} y1={y} x2={chartW - padX} y2={y} stroke="var(--border)" strokeWidth={0.5} opacity={0.4} />
                <text x={padX - 6} y={y + 3} fill="var(--text-muted)" fontSize={9} textAnchor="end">
                  {Math.round(maxCpu * frac)}%
                </text>
              </g>
            );
          })}
          {/* CPU line */}
          <polyline
            points={makePoints(cpuVals, maxCpu)}
            fill="none"
            stroke="#58a6ff"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
          {/* Memory line (scaled to fit on secondary axis) */}
          <polyline
            points={makePoints(memVals, maxMem)}
            fill="none"
            stroke="#3fb950"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="4,3"
            opacity={0.7}
          />
          {/* Stage transition markers */}
          {stageMarkers.map((m, i) => {
            const x = padX + (m.index / Math.max(1, sorted.length - 1)) * (chartW - padX * 2);
            const color = PERF_STAGE_COLORS[m.stage] || "#58a6ff";
            return (
              <g key={i}>
                <line x1={x} y1={padY} x2={x} y2={padY + chartH} stroke={color} strokeWidth={1.5} strokeDasharray="3,2" opacity={0.8} />
                <text x={x} y={padY + chartH + 14} fill={color} fontSize={8} textAnchor="middle" opacity={0.8}>
                  {m.label}
                </text>
              </g>
            );
          })}
          {/* Time labels */}
          {sorted
            .filter((_, i) => i % Math.max(1, Math.floor(sorted.length / 6)) === 0 || i === sorted.length - 1)
            .map((s, i) => {
              const idx = sorted.indexOf(s);
              const x = padX + (idx / Math.max(1, sorted.length - 1)) * (chartW - padX * 2);
              const elapsed = ((s.timestamp - startTime) / 1000).toFixed(0);
              // Avoid overlapping with stage labels — skip if a stage marker is nearby
              const hasMarkerNearby = stageMarkers.some((m) => Math.abs(m.index - idx) < Math.max(2, sorted.length * 0.05));
              if (hasMarkerNearby && i > 0 && i < sorted.length - 1) return null;
              return (
                <text key={i} x={x} y={chartH + padY + 28} fill="var(--text-muted)" fontSize={8} textAnchor="middle" opacity={0.6}>
                  {elapsed}s
                </text>
              );
            })}
        </svg>
        <div style={{ display: "flex", gap: 16, marginTop: 4, fontSize: 10, color: "var(--text-muted)" }}>
          <span>
            <span style={{ color: "#58a6ff" }}>━</span> CPU %
          </span>
          <span>
            <span style={{ color: "#3fb950" }}>┅</span> Memory
          </span>
          <span style={{ marginLeft: "auto" }}>{sorted.length} samples</span>
        </div>
      </div>
    </div>
  );
}

/* ── Tab: Attendees ── */

interface JobAttendee {
  name: string;
  email: string;
  has_voiceprint: boolean;
  has_sample: boolean;
  sample_job_id: string | null;
  sample_start: number | null;
  sample_end: number | null;
}

function AttendeesTab({ jobId }: { jobId: string }) {
  const [attendees, setAttendees] = useState<JobAttendee[]>([]);
  const [deliveryEmails, setDeliveryEmails] = useState<Set<string>>(new Set());
  const [hasDeliveryData, setHasDeliveryData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingEmail, setPlayingEmail] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchAttendees = async () => {
      try {
        const [attRes, delRes] = await Promise.allSettled([
          fetch(`${BRIDGE_URL}/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_job_attendees", args: { jobId } }),
          }),
          fetch(`${BRIDGE_URL}/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_delivery_results", args: { jobId } }),
          }),
        ]);

        if (!cancelled) {
          // Process attendees
          if (attRes.status === "fulfilled") {
            const attData = await attRes.value.json();
            setAttendees(attData?.attendees || []);
          } else {
            setError(attRes.reason?.message || "Failed to load attendees");
          }

          // Process delivery results — extract email recipients
          if (delRes.status === "fulfilled") {
            const delData = await delRes.value.json();
            const recipients = new Set<string>();
            if (delData?.results) {
              for (const r of delData.results) {
                if (r.tool === "send_delivery_email" && r.success && r.result) {
                  // Handle both single-recipient and multi-recipient formats
                  if (r.result.to) recipients.add(r.result.to.toLowerCase());
                  if (r.result.recipients) {
                    for (const rec of r.result.recipients) {
                      if (rec.email) recipients.add(rec.email.toLowerCase());
                    }
                  }
                }
              }
            }
            setDeliveryEmails(recipients);
            setHasDeliveryData(recipients.size > 0);
          }

          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    };
    fetchAttendees();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  /** Play or stop a voiceprint sample. Only one sample plays at a time. */
  const handlePlaySample = useCallback(
    (email: string) => {
      if (playingEmail === email) {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
        }
        setPlayingEmail(null);
        return;
      }

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }

      const sampleUrl = `${BRIDGE_URL}/agent/voiceprints/sample/${encodeURIComponent(email)}`;
      const audio = new Audio(sampleUrl);
      audio.addEventListener("ended", () => setPlayingEmail(null));
      audio.addEventListener("error", () => {
        setPlayingEmail(null);
        console.warn(`[Attendees] Failed to play sample for ${email}`);
      });
      audio.play().catch(() => setPlayingEmail(null));
      audioRef.current = audio;
      setPlayingEmail(email);
    },
    [playingEmail],
  );

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (error) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="error" color="red" size="32" />
          </span>
          <p>Failed to load attendees: {error}</p>
        </div>
      </div>
    );
  }

  if (!loading && attendees.length === 0) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="group" size="32" color="muted" />
          </span>
          <p>No attendees registered for this job.</p>
          <p className="rv-muted">Attendees are registered when a job is created or when the agent labels speakers.</p>
        </div>
      </div>
    );
  }

  const withVoiceprint = attendees.filter((a) => a.has_voiceprint);
  const withoutVoiceprint = attendees.filter((a) => !a.has_voiceprint);

  // Build attendee export HTML with delivery cross-reference
  const attendeeExportHtml = (() => {
    if (attendees.length === 0) return "<p>No attendees registered.</p>";
    const rows = attendees
      .map((a) => {
        const vpBadge = a.has_voiceprint
          ? '<span class="badge badge--vp">Voiceprint enrolled</span>'
          : '<span class="badge badge--no-vp">Registered only</span>';
        const receivedDelivery =
          hasDeliveryData && a.email && deliveryEmails.has(a.email.toLowerCase())
            ? '<span class="badge badge--delivered">Yes</span>'
            : hasDeliveryData
              ? '<span class="badge badge--no-delivery">No</span>'
              : '<span class="badge badge--no-delivery">N/A</span>';
        return `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.email || "—")}</td><td>${vpBadge}</td><td>${receivedDelivery}</td></tr>`;
      })
      .join("");
    return `
<h1>Meeting Attendees</h1>
<p class="meta">Total: ${attendees.length} attendee(s)${hasDeliveryData ? " · Delivery data available" : ""}</p>
<table>
<thead><tr><th>Name</th><th>Email</th><th>Voiceprint</th><th>Results Delivered</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
  })();

  return (
    <div className="rv-tab-content rv-tab-content--attendees">
      <div className="rv-export-toolbar">
        <ExportButton format="pdf" content={attendeeExportHtml} defaultName="Meeting_Attendees" />
        <ExportButton format="word" content={attendeeExportHtml} defaultName="Meeting_Attendees" />
      </div>
      <LoadingModal visible={loading} message="Loading attendees…" />

      {/* Summary cards */}
      <div className="rv-tokens-summary">
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{attendees.length}</span>
          <span className="rv-tokens-card-label">Total Attendees</span>
        </div>
        <div className="rv-tokens-card rv-tokens-card--green">
          <span className="rv-tokens-card-value">{withVoiceprint.length}</span>
          <span className="rv-tokens-card-label">Voiceprint Matched</span>
        </div>
        <div className="rv-tokens-card rv-tokens-card--muted">
          <span className="rv-tokens-card-value">{withoutVoiceprint.length}</span>
          <span className="rv-tokens-card-label">Registered Only</span>
        </div>
      </div>

      {/* Voiceprint-matched attendees */}
      {withVoiceprint.length > 0 && (
        <>
          <h4 className="rv-tokens-steps-title">
            <Icon name="badge" size="14" color="accent" /> Voiceprint Matched
          </h4>
          <div className="rv-attendee-list">
            {withVoiceprint.map((att, i) => (
              <div key={i} className="rv-attendee-card rv-attendee-card--vp">
                <div className="rv-attendee-avatar" style={{ backgroundColor: speakerColor(att.name) }}>
                  {att.name.charAt(0).toUpperCase()}
                </div>
                <div className="rv-attendee-info">
                  <span className="rv-attendee-name">{att.name}</span>
                  {att.email && <span className="rv-attendee-email">{att.email}</span>}
                  <span className="rv-attendee-meta">
                    <Icon name="badge" size="10" color="green" /> Voiceprint enrolled
                    {att.has_sample && (
                      <>
                        <span className="rv-attendee-meta-sep">·</span>
                        Audio sample available
                      </>
                    )}
                  </span>
                </div>
                <div className="rv-attendee-actions">
                  {att.has_sample ? (
                    <Tooltip content={playingEmail === att.email ? "Click to stop playback" : "Play this attendee's voice sample"}>
                      <button
                        className={`rv-attendee-play-btn ${playingEmail === att.email ? "rv-attendee-play-btn--playing" : ""}`}
                        onClick={() => handlePlaySample(att.email)}
                        title={playingEmail === att.email ? "Stop playback" : "Play voice sample"}>
                        {playingEmail === att.email ? <Icon name="stop" size="16" /> : <Icon name="play_arrow" size="16" />}
                      </button>
                    </Tooltip>
                  ) : (
                    <Tooltip content="This voiceprint was enrolled without an audio sample">
                      <span className="rv-attendee-no-sample" title="No audio sample available">
                        <Icon name="volume_off" size="14" color="muted" />
                      </span>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Registered-only attendees (no voiceprint) */}
      {withoutVoiceprint.length > 0 && (
        <>
          <h4 className="rv-tokens-steps-title rv-attendee-section-title">
            <Icon name="person" size="14" color="muted" /> Registered Attendees
          </h4>
          <p className="rv-muted rv-attendee-section-desc">These attendees were registered for this meeting but do not have voiceprints enrolled.</p>
          <div className="rv-attendee-list">
            {withoutVoiceprint.map((att, i) => (
              <div key={i} className="rv-attendee-card">
                <div className="rv-attendee-avatar rv-attendee-avatar--unregistered" style={{ backgroundColor: speakerColor(att.name) }}>
                  {att.name.charAt(0).toUpperCase()}
                </div>
                <div className="rv-attendee-info">
                  <span className="rv-attendee-name">{att.name}</span>
                  {att.email && <span className="rv-attendee-email">{att.email}</span>}
                  <span className="rv-attendee-meta">
                    <Icon name="person" size="10" color="muted" /> Registered
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Tab: Delivery ── */

interface DeliveryToolResult {
  tool: string;
  success: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  timestamp: string;
}

interface DeliveryResultsData {
  job_id: string;
  title: string;
  results: DeliveryToolResult[];
  summary: {
    total: number;
    success: number;
    failed: number;
  };
  saved_at: string;
}

const DELIVERY_TOOL_LABELS: Record<string, { icon: string; label: string }> = {
  send_delivery_email: { icon: "email", label: "Email" },
  save_to_drive: { icon: "cloud", label: "Google Drive" },
  create_trello_action_items: { icon: "dashboard", label: "Trello Cards" },
};

/** Human-readable labels for delivery result keys. */
const DELIVERY_RESULT_KEY_LABELS: Record<string, string> = {
  to: "Recipients",
  subject: "Subject",
  folderName: "Drive Folder",
  listId: "Trello List ID",
  firstCardName: "First Card",
  cardsCreated: "Cards Created",
  summaryDocId: "Summary Doc ID",
  transcriptFileId: "Transcript File ID",
  folderId: "Folder ID",
  id: "Message ID",
};

function DeliveryTab({ jobId }: { jobId: string }) {
  const [data, setData] = useState<DeliveryResultsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchDelivery = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_delivery_results", args: { jobId } }),
        });
        if (!res.ok) {
          let serverMsg = "";
          try {
            const body = await res.json();
            serverMsg = body.error || "";
          } catch {
            /* ignore */
          }
          if (res.status === 404) throw new Error(serverMsg || "Delivery results not available for this job");
          throw new Error(serverMsg || `Bridge error: ${res.status}`);
        }
        const result = await res.json();
        if (!cancelled) setData(result);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchDelivery();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (loading) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <p>Loading delivery results…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="mail" size="32" color="muted" />
          </span>
          <p>Delivery data unavailable</p>
          <p className="rv-muted">{error || "No delivery results recorded for this job."}</p>
          <p className="rv-muted">Delivery results appear here after the agent pipeline runs delivery steps.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--delivery">
      {/* Summary cards */}
      <div className="rv-tokens-summary">
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{data.summary.total}</span>
          <span className="rv-tokens-card-label">Total Deliveries</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value" style={{ color: "var(--green)" }}>
            {data.summary.success}
          </span>
          <span className="rv-tokens-card-label">Succeeded</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value" style={{ color: data.summary.failed > 0 ? "var(--red)" : undefined }}>
            {data.summary.failed}
          </span>
          <span className="rv-tokens-card-label">Failed</span>
        </div>
      </div>

      {/* Per-delivery breakdown */}
      <h4 className="rv-tokens-steps-title">Per-Delivery Results</h4>
      <div className="rv-delivery-list">
        {data.results.map((r, i) => {
          const meta = DELIVERY_TOOL_LABELS[r.tool] || { icon: "build", label: r.tool };
          return (
            <div key={i} className={`rv-delivery-card ${r.success ? "rv-delivery-card--success" : "rv-delivery-card--failed"}`}>
              <div className="rv-delivery-card-header">
                <span className="rv-delivery-card-icon">
                  <Icon name={meta.icon} size="18" />
                </span>
                <span className="rv-delivery-card-name">{meta.label}</span>
                <span className={`rv-delivery-card-badge ${r.success ? "rv-delivery-badge--ok" : "rv-delivery-badge--fail"}`}>
                  {r.success ? (
                    <>
                      <Icon name="check_circle" color="green" size="14" /> Success
                    </>
                  ) : (
                    <>
                      <Icon name="cancel" color="red" size="14" /> Failed
                    </>
                  )}
                </span>
              </div>
              <div className="rv-delivery-card-body">
                {r.success && r.result && (
                  <div className="rv-delivery-card-detail">
                    {Object.entries(r.result)
                      .slice(0, 6)
                      .map(([k, v]) => (
                        <span key={k} className="rv-delivery-detail-item">
                          <span className="rv-delivery-detail-key">{DELIVERY_RESULT_KEY_LABELS[k] || k}:</span>
                          <span className="rv-delivery-detail-value">{String(v ?? "").slice(0, 80)}</span>
                        </span>
                      ))}
                  </div>
                )}
                {!r.success && r.error && <div className="rv-delivery-card-error">{r.error}</div>}
              </div>
              <div className="rv-delivery-card-time">{new Date(r.timestamp).toLocaleString()}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Tab: Config ── */

interface JobRecordData {
  id: string;
  title: string;
  result: string;
  config_snapshot?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  [key: string]: unknown;
}

interface ConfigSnapshot {
  // ── Python backend config ──
  whisper_model_size?: string;
  diarization_model?: string;
  embedding_model?: string;
  embedding_provider?: string;
  device?: string;
  platform?: string;
  voiceprint_threshold?: number;
  keep_transcript_timestamps?: boolean;
  max_concurrent_pipelines?: number;
  default_skip_steps?: string[];
  hugging_face_token_set?: boolean;
  whisper_initial_prompt_enabled?: boolean;

  // ── Per-job metadata ──
  title?: string;
  attendees?: string[];
  event_type?: string;
  skip_steps?: string[];

  // ── Agent runner config (Phase B) ──
  llm_provider?: string;
  llm_model?: string;
  ollama_base_url?: string;
  ollama_model?: string;
  ollama_num_ctx?: string;
  llm_temperature?: string;
  agent_tools?: string[];
  agent_pipeline_steps?: Array<{ id: string; toolName: string; label: string; enabled: boolean; isTerminal: boolean }>;
  // Full pipeline step details (enriched Phase B)
  agent_pipeline_steps_full?: Array<{
    id: string;
    toolName: string;
    label: string;
    description: string;
    systemPromptTemplate: string;
    hintTemplate: string;
    enabled: boolean;
    isTerminal: boolean;
  }>;
  agent_terminal_tools?: string[];
  agent_system_prompt_length?: number;
  agent_system_prompt?: string;
  agent_pipeline_hints?: number;
  agent_pipeline_hints_full?: Record<string, string>;
  agent_event_templates?: Record<string, string>;
  agent_max_pipeline_steps?: number;
  agent_llm_context_window?: number;
  agent_ollama_max_retries?: number;
  agent_ollama_retry_base_delay_ms?: number;
  agent_max_retries?: number;
  agent_retry_base_delay_ms?: number;
  gmail_user?: string;
  delivery_recipient_emails?: string;
  delivery_email_subject?: string;
  delivery_drive_folder?: string;
  log_llm_data?: string;
  log_collapse_repeated_prefixes?: string;
}

/** Render a single config key-value row */
function ConfigRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rv-config-row">
      <span className="rv-config-label">{label}</span>
      <span className={`rv-config-value ${mono ? "rv-config-value--mono" : ""}`}>{value ?? <span className="rv-config-null">—</span>}</span>
    </div>
  );
}

/** Render a section header with icon */
function ConfigSectionHeader({ icon, title }: { icon: string; title: string }) {
  return (
    <h4 className="rv-config-section-title">
      <Icon name={icon} size="14" color="accent" /> {title}
    </h4>
  );
}

function ConfigTab({ jobId }: { jobId: string }) {
  const [record, setRecord] = useState<JobRecordData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_job", args: { jobId } }),
        });
        if (!res.ok) {
          let serverMsg = "";
          try {
            const body = await res.json();
            serverMsg = body.error || "";
          } catch {
            /* ignore */
          }
          if (res.status === 404) throw new Error(serverMsg || "Job record not found in ephemeral DB");
          throw new Error(serverMsg || `Bridge error: ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setRecord(data?.job || null);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchConfig();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (loading) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <p>Loading config snapshot…</p>
        </div>
      </div>
    );
  }

  const rawSnapshot: string | object | null | undefined = record?.config_snapshot;
  let snapshot: ConfigSnapshot | null = null;
  if (rawSnapshot) {
    if (typeof rawSnapshot === "object") {
      // Python backend now parses config_snapshot before returning
      snapshot = rawSnapshot as ConfigSnapshot;
    } else {
      try {
        snapshot = JSON.parse(rawSnapshot) as ConfigSnapshot;
      } catch {
        snapshot = null;
      }
    }
  }

  if (error || !record) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="settings" size="32" color="muted" />
          </span>
          <p>Config snapshot unavailable</p>
          <p className="rv-muted">{error || "No job record found."}</p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">
            <Icon name="settings" size="32" color="muted" />
          </span>
          <p>Config snapshot not available for this job</p>
          <p className="rv-muted">
            Config snapshots are captured at job creation time. Jobs created before this feature was added will not have a snapshot.
          </p>
          <p className="rv-muted" style={{ marginTop: 4 }}>
            Job result: <code className="rv-code">{record.result}</code>
            {record.created_at && <> · Created: {new Date(record.created_at).toLocaleString()}</>}
          </p>
        </div>
      </div>
    );
  }

  // ── Utility: render a boolean value nicely ──
  const boolIcon = (val: boolean | undefined | null) => {
    if (val === true) return <Icon name="check" size="14" color="green" />;
    if (val === false) return <Icon name="close" size="14" color="muted" />;
    return <span className="rv-config-null">—</span>;
  };

  // ── Helper: render enabled pipeline steps as a compact list ──
  const pipelineStepsSummary = (steps: ConfigSnapshot["agent_pipeline_steps"]) => {
    if (!steps || steps.length === 0) return null;
    return (
      <div className="rv-config-step-list">
        {steps.map((s) => (
          <span key={s.id} className={`rv-config-step-chip ${s.enabled ? "rv-config-step-chip--on" : "rv-config-step-chip--off"}`}>
            {s.enabled ? <Icon name="check_circle" size="10" color="green" /> : <Icon name="remove_circle" size="10" color="muted" />}
            {s.label || s.toolName}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="rv-tab-content rv-tab-content--config">
      {/* ── Section 1: Job Metadata ── */}
      <ConfigSectionHeader icon="badge" title="Job Metadata" />
      <div className="rv-config-grid">
        <ConfigRow label="Title" value={snapshot.title} />
        <ConfigRow label="Event Type" value={snapshot.event_type} />
        <ConfigRow label="Attendees" value={snapshot.attendees?.length ? snapshot.attendees.join(", ") : "None"} />
        <ConfigRow label="Skip Steps" value={snapshot.skip_steps?.length ? snapshot.skip_steps.join(", ") : "None"} />
        <ConfigRow label="Result" value={record.result} mono />
        <ConfigRow label="Created" value={record.created_at ? new Date(record.created_at).toLocaleString() : null} />
        {record.completed_at && <ConfigRow label="Completed" value={new Date(record.completed_at).toLocaleString()} />}
      </div>

      {/* ── Section 2: LLM & Model Config ── */}
      <ConfigSectionHeader icon="smart_toy" title="LLM &amp; Model Config" />
      <div className="rv-config-grid">
        <ConfigRow label="LLM Provider" value={snapshot.llm_provider ?? "—"} mono />
        <ConfigRow label="LLM Model" value={snapshot.llm_model ?? "—"} mono />
        {snapshot.llm_temperature && <ConfigRow label="Temperature" value={snapshot.llm_temperature} />}
        {snapshot.ollama_base_url && <ConfigRow label="Ollama Base URL" value={snapshot.ollama_base_url} mono />}
        {snapshot.ollama_model && <ConfigRow label="Ollama Model" value={snapshot.ollama_model} mono />}
        {snapshot.ollama_num_ctx && <ConfigRow label="Ollama Context Window" value={snapshot.ollama_num_ctx} />}
        <ConfigRow label="Whisper Model" value={snapshot.whisper_model_size} mono />
        <ConfigRow label="Diarization Model" value={snapshot.diarization_model} mono />
        <ConfigRow label="Embedding Provider" value={snapshot.embedding_provider} mono />
        <ConfigRow label="Embedding Model" value={snapshot.embedding_model} mono />
        <ConfigRow label="Device" value={snapshot.device} mono />
        <ConfigRow label="Platform" value={snapshot.platform} mono />
        <ConfigRow label="Voiceprint Threshold" value={snapshot.voiceprint_threshold != null ? snapshot.voiceprint_threshold.toFixed(2) : null} />
        <ConfigRow label="Keep Timestamps" value={boolIcon(snapshot.keep_transcript_timestamps)} />
        <ConfigRow
          label="HF Token Set"
          value={snapshot.hugging_face_token_set ? <Icon name="check" size="14" color="green" /> : <Icon name="close" size="14" color="muted" />}
        />
        <ConfigRow label="Whisper Initial Prompt" value={boolIcon(snapshot.whisper_initial_prompt_enabled)} />
        <ConfigRow
          label="Max Concurrent Pipelines"
          value={snapshot.max_concurrent_pipelines != null ? String(snapshot.max_concurrent_pipelines) : null}
        />
      </div>

      {/* ── Section 3: Agent Instructions ── */}
      <ConfigSectionHeader icon="menu_book" title="Agent Instructions" />
      <div className="rv-config-grid">
        <ConfigRow label="Available Tools" value={snapshot.agent_tools?.length != null ? `${snapshot.agent_tools.length} tool(s)` : null} />
        {snapshot.agent_tools && snapshot.agent_tools.length > 0 && <ConfigRow label="Tool Names" value={snapshot.agent_tools.join(", ")} mono />}
        <ConfigRow label="Terminal Tools" value={snapshot.agent_terminal_tools?.join(", ") || "None"} mono />
        {snapshot.agent_system_prompt_length != null && (
          <ConfigRow label="System Prompt Size" value={`${snapshot.agent_system_prompt_length.toLocaleString()} chars`} />
        )}
        {snapshot.agent_pipeline_hints != null && <ConfigRow label="Pipeline Hints" value={`${snapshot.agent_pipeline_hints} hint(s)`} />}
        {snapshot.agent_max_retries != null && <ConfigRow label="Max Retries" value={String(snapshot.agent_max_retries)} />}
        {snapshot.agent_retry_base_delay_ms != null && <ConfigRow label="Retry Base Delay" value={`${snapshot.agent_retry_base_delay_ms}ms`} />}
      </div>

      {/* ── Section 3a: Pipeline Steps (detailed view, enriched) ── */}
      {(() => {
        const fullSteps = snapshot.agent_pipeline_steps_full;
        if (fullSteps && fullSteps.length > 0) {
          return (
            <div className="rv-config-subsection">
              <ConfigSectionHeader icon="checklist" title="Pipeline Steps" />
              <div className="rv-config-step-detail-list">
                {fullSteps.map((step, i) => (
                  <div key={step.id} className={`rv-config-step-detail ${step.enabled ? "rv-config-step-detail--on" : "rv-config-step-detail--off"}`}>
                    <span className="rv-config-step-detail-icon">
                      {step.enabled ? <Icon name="check_circle" size="14" color="green" /> : <Icon name="remove_circle" size="14" color="muted" />}
                    </span>
                    <span className="rv-config-step-detail-number">#{i + 1}</span>
                    <div className="rv-config-step-detail-info">
                      <span className="rv-config-step-detail-label">{step.label}</span>
                      <span className="rv-config-step-detail-toolname">{step.toolName}</span>
                      {step.description && <span className="rv-config-step-detail-desc">{step.description}</span>}
                    </div>
                    {step.isTerminal && <span className="rv-config-step-detail-badge rv-config-step-detail-badge--terminal">Terminal</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        }
        // Fallback: compact chips for older snapshots without full details
        if (snapshot.agent_pipeline_steps && snapshot.agent_pipeline_steps.length > 0) {
          return (
            <div className="rv-config-subsection">
              <div style={{ marginBottom: 4, fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
                <Icon name="checklist" size="12" color="muted" /> Pipeline Steps
              </div>
              {pipelineStepsSummary(snapshot.agent_pipeline_steps)}
            </div>
          );
        }
        return null;
      })()}

      {/* ── Section 3b: Pipeline Hints (enriched) ── */}
      {snapshot.agent_pipeline_hints_full && Object.keys(snapshot.agent_pipeline_hints_full).length > 0 && (
        <div className="rv-config-subsection">
          <details className="rv-config-details" open>
            <summary className="rv-config-details-summary">
              <span className="rv-config-details-summary-icon">▸</span>
              <Icon name="explore" size="14" color="accent" /> Pipeline Hints ({Object.keys(snapshot.agent_pipeline_hints_full).length})
            </summary>
            <div className="rv-config-details-body">
              <div className="rv-config-hint-grid">
                {Object.entries(snapshot.agent_pipeline_hints_full).map(([key, val]) => (
                  <div key={key} className="rv-config-hint-row">
                    <span className="rv-config-hint-key">{key}</span>
                    <span className="rv-config-hint-arrow">→</span>
                    <span className="rv-config-hint-value">{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </details>
        </div>
      )}

      {/* ── Section 3c: Pipeline Constants (enriched) ── */}
      {(snapshot.agent_max_pipeline_steps != null ||
        snapshot.agent_llm_context_window != null ||
        snapshot.agent_ollama_max_retries != null ||
        snapshot.agent_ollama_retry_base_delay_ms != null) && (
        <div className="rv-config-subsection">
          <details className="rv-config-details">
            <summary className="rv-config-details-summary">
              <span className="rv-config-details-summary-icon">▸</span>
              <Icon name="tune" size="14" color="accent" /> Pipeline Constants
            </summary>
            <div className="rv-config-details-body">
              <div className="rv-config-grid">
                {snapshot.agent_max_pipeline_steps != null && (
                  <ConfigRow label="Max Pipeline Steps" value={String(snapshot.agent_max_pipeline_steps)} />
                )}
                {snapshot.agent_llm_context_window != null && (
                  <ConfigRow label="LLM Context Window" value={String(snapshot.agent_llm_context_window)} />
                )}
                {snapshot.agent_ollama_max_retries != null && (
                  <ConfigRow label="Ollama Max Retries" value={String(snapshot.agent_ollama_max_retries)} />
                )}
                {snapshot.agent_ollama_retry_base_delay_ms != null && (
                  <ConfigRow label="Ollama Retry Delay" value={`${snapshot.agent_ollama_retry_base_delay_ms}ms`} />
                )}
              </div>
            </div>
          </details>
        </div>
      )}

      {/* ── Section 3d: Event Templates (enriched) ── */}
      {snapshot.agent_event_templates && Object.keys(snapshot.agent_event_templates).length > 0 && (
        <div className="rv-config-subsection">
          <details className="rv-config-details">
            <summary className="rv-config-details-summary">
              <span className="rv-config-details-summary-icon">▸</span>
              <Icon name="event" size="14" color="accent" /> Event Templates
            </summary>
            <div className="rv-config-details-body">
              {Object.entries(snapshot.agent_event_templates).map(([key, val]) => (
                <div key={key} className="rv-config-template-block">
                  <span className="rv-config-template-label">{key}</span>
                  <pre className="rv-config-pre">{val}</pre>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* ── Section 3e: System Prompt (enriched) ── */}
      {snapshot.agent_system_prompt && (
        <div className="rv-config-subsection">
          <details className="rv-config-details">
            <summary className="rv-config-details-summary">
              <span className="rv-config-details-summary-icon">▸</span>
              <Icon name="edit_note" size="14" color="accent" /> System Prompt ({snapshot.agent_system_prompt.length.toLocaleString()} chars)
            </summary>
            <div className="rv-config-details-body">
              <pre className="rv-config-pre">{snapshot.agent_system_prompt}</pre>
            </div>
          </details>
        </div>
      )}

      {/* ── Section 4: Delivery & Logging Config ── */}
      <ConfigSectionHeader icon="mail" title="Delivery &amp; Logging" />
      <div className="rv-config-grid">
        {snapshot.gmail_user && <ConfigRow label="Gmail User" value={snapshot.gmail_user} mono />}
        {snapshot.delivery_recipient_emails && <ConfigRow label="Recipient Emails" value={snapshot.delivery_recipient_emails} mono />}
        {snapshot.delivery_email_subject && <ConfigRow label="Email Subject" value={snapshot.delivery_email_subject} />}
        {snapshot.delivery_drive_folder && <ConfigRow label="Drive Folder" value={snapshot.delivery_drive_folder} />}
        <ConfigRow label="Log LLM Data" value={snapshot.log_llm_data ?? "false"} />
        <ConfigRow label="Collapse Repeated" value={snapshot.log_collapse_repeated_prefixes ?? "true"} />
        <ConfigRow label="Default Skip Steps" value={snapshot.default_skip_steps?.join(", ") || "None"} />
      </div>
    </div>
  );
}

/* ── Main ResultsViewer ── */

export default function ResultsViewer({ jobId, segments, summary, metadata, jobStatus, jobProgress, jobError }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("pipeline");
  const [activeDevSubTab, setActiveDevSubTab] = useState<TabId>("tokens");

  // Reset to first tab when switching to a different job
  useEffect(() => {
    setActiveTab("pipeline");
    setActiveDevSubTab("tokens");
  }, [jobId]);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);

  // Fetch analysis data when the component mounts
  useEffect(() => {
    let cancelled = false;
    const fetchAnalysis = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_analysis", args: { jobId } }),
        });
        const data = await res.json();
        if (!cancelled) {
          setAnalysis(data.analysis || data || null);
          setAnalysisLoading(false);
        }
      } catch {
        if (!cancelled) {
          setAnalysis(null);
          setAnalysisLoading(false);
        }
      }
    };
    fetchAnalysis();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const isDevTab = (id: TabId) => DEV_SUB_TABS.some((st) => st.id === id);
  const effectiveTab = isDevTab(activeTab) ? "developer" : activeTab;

  const tabMeta = (() => {
    const def = TABS.find((t) => t.id === effectiveTab);
    if (def && "subTabs" in def && effectiveTab === "developer") {
      const sub = def.subTabs.find((st) => st.id === activeDevSubTab);
      return { id: "developer" as TabId, label: sub?.label || "Developer", icon: "code" };
    }
    return def || { id: "pipeline" as TabId, label: "Pipeline", icon: "timeline" };
  })();

  return (
    <div className="rv-container">
      {/* Tab navigation */}
      <div className="rv-tabs">
        {TABS.map((tab) => {
          const tabDescriptions: Record<string, string> = {
            pipeline: "View pipeline progress — current stage, completion status, and any errors",
            audio: "Play the original meeting recording audio",
            transcript: "Browse the speaker-labeled transcript with timestamps and search",
            summary: "Read the executive summary, key decisions, discussion points, and action items",
            analysis: "Explore topics discussed, sentiment, key entities, and meeting effectiveness",
            developer: "View developer details — tokens, performance, config snapshot, and logs",
            attendees: "View registered attendees and their voiceprint status with playable audio samples",
            delivery: "Check delivery status — email, Trello, and Google Drive",
          };
          if ("subTabs" in tab) {
            return (
              <button
                key={tab.id}
                className={`rv-tab ${effectiveTab === tab.id ? "rv-tab--active" : ""}`}
                onClick={() => {
                  setActiveTab(tab.id);
                  setActiveDevSubTab(tab.subTabs[0].id);
                }}
                title={tabDescriptions[tab.id] || tab.label}>
                <span className="rv-tab-icon">
                  <Icon name={tab.icon} size="14" />
                </span>
                <span className="rv-tab-label">{tab.label}</span>
                <span className="rv-tab-arrow">
                  <Icon name="arrow_drop_down" size="14" />
                </span>
              </button>
            );
          }
          return (
            <button
              key={tab.id}
              className={`rv-tab ${activeTab === tab.id ? "rv-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tabDescriptions[tab.id] || tab.label}>
              <span className="rv-tab-icon">
                <Icon name={tab.icon} size="14" />
              </span>
              <span className="rv-tab-label">{tab.label}</span>
              {tab.id === "analysis" && analysisLoading && <span className="rv-tab-spinner" />}
            </button>
          );
        })}
      </div>

      {/* Tab header with meta info */}
      <div className="rv-panel-header">
        <div className="rv-panel-header-left">
          <h2 className="rv-panel-title">
            <Icon name={tabMeta?.icon || "description"} size="16" color="accent" /> {tabMeta?.label}
          </h2>
          {metadata?.title && <span className="rv-panel-subtitle">{metadata.title}</span>}
        </div>
        <div className="rv-panel-header-right">
          <Tooltip content="Click to copy the full job ID to your clipboard">
            <span
              className="rv-job-badge"
              title="Click to copy job ID to clipboard"
              onClick={() => {
                navigator.clipboard.writeText(jobId);
              }}>
              <Icon name="badge" size="12" color="muted" /> {jobId.slice(0, 12)}…
            </span>
          </Tooltip>
        </div>
      </div>

      {/* Tab content */}
      <div className="rv-body">
        {activeTab === "pipeline" && <PipelineTab status={jobStatus || "unknown"} progress={jobProgress ?? 0} error={jobError} />}
        {activeTab === "audio" && <AudioTab jobId={jobId} metadata={metadata} />}
        {activeTab === "transcript" && <TranscriptTab segments={segments} />}
        {activeTab === "summary" && <SummaryTab summary={summary} />}
        {activeTab === "analysis" &&
          (analysisLoading ? (
            <div className="rv-tab-content">
              <div className="rv-empty-state">
                <p>Loading analysis…</p>
              </div>
            </div>
          ) : (
            <AnalysisTab analysis={analysis} />
          ))}
        {activeTab === "attendees" && <AttendeesTab jobId={jobId} />}
        {activeTab === "delivery" && <DeliveryTab jobId={jobId} />}

        {/* Developer grouped tabs */}
        {effectiveTab === "developer" && (
          <div className="rv-tab-content rv-tab-content--dev">
            {/* Sub-tab navigation bar */}
            <div className="rv-dev-subtabs">
              {DEV_SUB_TABS.map((st) => (
                <Tooltip content={`View ${st.label.toLowerCase()} details for this job`}>
                  <button
                    key={st.id}
                    className={`rv-dev-subtab ${activeDevSubTab === st.id ? "rv-dev-subtab--active" : ""}`}
                    onClick={() => setActiveDevSubTab(st.id)}
                    title={`View ${st.label}`}>
                    <Icon name={st.icon} size="12" /> {st.label}
                  </button>
                </Tooltip>
              ))}
            </div>
            {/* Sub-tab content */}
            <div className="rv-dev-content">
              {activeDevSubTab === "tokens" && <TokensTab jobId={jobId} />}
              {activeDevSubTab === "performance" && <PerformanceTab jobId={jobId} />}
              {activeDevSubTab === "config" && <ConfigTab jobId={jobId} />}
              {activeDevSubTab === "logs" && <LogsTab jobId={jobId} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
