/**
 * ResultsViewer — tabbed process viewer for completed transcription jobs.
 *
 * Tabs:
 *   🔊 Audio     — Audio player for the original meeting recording
 *   📝 Transcript — Speaker-labeled raw transcript with timestamps
 *   📋 Summary    — Executive summary, key decisions, action items
 *   📊 Analysis   — Topics, sentiment, entities, effectiveness
 *   🪵 Logs       — Job-specific developer log files
 *   💰 Tokens    — LLM token usage breakdown per pipeline step
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TranscriptionSegment, AnalysisData } from "../types";

const BRIDGE_URL = "http://127.0.0.1:5010";

type TabId = "pipeline" | "audio" | "transcript" | "summary" | "analysis" | "logs" | "tokens";

interface Tab {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { id: "pipeline", label: "Pipeline", icon: "🔬" },
  { id: "audio", label: "Audio", icon: "🔊" },
  { id: "transcript", label: "Transcript", icon: "📝" },
  { id: "summary", label: "Summary", icon: "📋" },
  { id: "analysis", label: "Analysis", icon: "📊" },
  { id: "tokens", label: "Tokens", icon: "💰" },
  { id: "logs", label: "Logs", icon: "🪵" },
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

  return (
    <div className="rv-tab-content rv-tab-content--audio">
      <div className="rv-audio-header">
        <h3>🎵 Meeting Recording</h3>
        {metadata?.title && <span className="rv-audio-title">{metadata.title}</span>}
      </div>

      <div className="rv-audio-player-wrapper">
        {!audioError ? (
          <audio controls className="rv-audio-player" onError={() => setAudioError(true)} preload="metadata">
            <source src={audioUrl} type="audio/wav" />
            Your browser does not support the audio element.
          </audio>
        ) : (
          <div className="rv-audio-error">
            <span className="rv-audio-error-icon">⚠️</span>
            <div>
              <p>
                <strong>Audio file unavailable</strong>
              </p>
              <p className="rv-muted">The standardized audio may not be accessible. Check that the backend is running.</p>
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
          <span className="rv-empty-icon">📝</span>
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
          <span className="rv-search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search transcript…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="rv-search-input"
          />
          {searchTerm && (
            <button className="rv-search-clear" onClick={() => setSearchTerm("")}>
              ✕
            </button>
          )}
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

/* ── Tab: Summary ── */

function SummaryTab({ summary }: { summary?: Props["summary"] }) {
  if (!summary || (!summary.executive_summary && !summary.key_decisions && !summary.action_items)) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">📋</span>
          <p>No summary available yet.</p>
          <p className="rv-muted">The agent will generate a summary after transcription completes.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--summary">
      {summary.executive_summary && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">📄</span>
            <h3>Executive Summary</h3>
          </div>
          <p className="rv-summary-text">{summary.executive_summary}</p>
        </div>
      )}

      {summary.discussion_points && summary.discussion_points.length > 0 && (
        <div className="rv-summary-card">
          <div className="rv-summary-card-header">
            <span className="rv-summary-card-icon">💬</span>
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
            <span className="rv-summary-card-icon">✅</span>
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
            <span className="rv-summary-card-icon">📌</span>
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
  if (!analysis || Object.keys(analysis).length === 0) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">📊</span>
          <p>No analysis data available.</p>
          <p className="rv-muted">Analysis includes topics, sentiment, and key entities from the meeting.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--analysis">
      <div className="rv-analysis-grid">
        {analysis.topics && analysis.topics.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">🏷️</span>
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
              <span className="rv-analysis-icon">💭</span>
              <h3>Meeting Sentiment</h3>
            </div>
            <p className="rv-analysis-text">{analysis.sentiment}</p>
          </div>
        )}

        {analysis.key_entities && analysis.key_entities.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">🔑</span>
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
              <span className="rv-analysis-icon">📈</span>
              <h3>Meeting Effectiveness</h3>
            </div>
            <p className="rv-analysis-text">{analysis.effectiveness}</p>
          </div>
        )}

        {analysis.follow_ups && analysis.follow_ups.length > 0 && (
          <div className="rv-analysis-card">
            <div className="rv-analysis-card-header">
              <span className="rv-analysis-icon">🔜</span>
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

/** Try to detect a source tag like [python], [bridge], [agent], [main] in a log line. */
function detectSource(line: string): string | null {
  const match = line.match(/\[(python|bridge|agent|main)\]/i);
  return match ? match[1].toLowerCase() : null;
}

/** Try to detect a log level like error, warn, info, debug in a log line. */
function detectLevel(line: string): string | null {
  const lower = line.toLowerCase();
  if (/\berror\b/.test(lower) || /\b❌\b/.test(line)) return "error";
  if (/\bwarn(ing)?\b/.test(lower) || /\b⚠️\b/.test(line)) return "warn";
  if (/\bdebug\b/.test(lower)) return "debug";
  if (/\binfo\b/.test(lower) || /\b✅\b/.test(line) || /\b📝\b/.test(line)) return "info";
  return null;
}

function LogsTab({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [jobLogFiles, setJobLogFiles] = useState<{ file: string; content: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_get_job_logs", args: { jobId, maxLines: 300 } }),
        });
        const data = await res.json();
        if (!cancelled) {
          setLogs(data.logs || []);
          setJobLogFiles(data.job_logs || []);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    };
    fetchLogs();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Filter logs by source and level
  const filteredLogs = logs.filter((line) => {
    if (sourceFilter !== "all") {
      const detectedSource = detectSource(line);
      if (detectedSource !== sourceFilter) return false;
    }
    if (levelFilter !== "all") {
      const detectedLevel = detectLevel(line);
      if (detectedLevel !== levelFilter) return false;
    }
    return true;
  });

  if (loading) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <p>Loading logs…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rv-tab-content">
        <div className="rv-empty-state">
          <span className="rv-empty-icon">❌</span>
          <p>Failed to load logs: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-tab-content rv-tab-content--logs">
      {/* Job-specific log files */}
      {jobLogFiles.length > 0 && (
        <div className="rv-logs-section">
          <h4 className="rv-logs-section-title">📁 Job-Specific Files</h4>
          <div className="rv-logs-file-list">
            {jobLogFiles.map((jf, i) => (
              <div key={i} className="rv-logs-file-item">
                <span className="rv-logs-file-name">{jf.file}</span>
                <pre className="rv-logs-pre">{jf.content}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter toolbar */}
      {logs.length > 0 && (
        <div className="rv-logs-toolbar">
          <span className="rv-logs-toolbar-title">🪵 Job Log Files</span>
          <div className="rv-logs-toolbar-filters">
            <select className="rv-logs-filter-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
              <option value="all">All sources</option>
              <option value="python">Python</option>
              <option value="bridge">Bridge</option>
              <option value="agent">Agent</option>
              <option value="main">Main</option>
            </select>
            <select className="rv-logs-filter-select" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
              <option value="all">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors</option>
              <option value="debug">Debug</option>
            </select>
            <span className="rv-logs-filter-count">
              {filteredLogs.length} / {logs.length} entries
            </span>
          </div>
        </div>
      )}

      {/* Filtered pipeline logs */}
      {logs.length > 0 && (
        <div className="rv-logs-section">
          {filteredLogs.length > 0 ? (
            <div className="rv-logs-list" ref={logRef}>
              {filteredLogs.map((line, i) => (
                <div key={i} className="rv-log-line">
                  <span className="rv-log-line-num">{i + 1}</span>
                  <span className="rv-log-line-text">{line}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rv-logs-empty-filter">
              <span className="rv-logs-empty-filter-icon">🔍</span>
              <span>No logs match the current filters.</span>
            </div>
          )}
        </div>
      )}

      {logs.length === 0 && jobLogFiles.length === 0 && (
        <div className="rv-empty-state">
          <span className="rv-empty-icon">🪵</span>
          <p>No log entries found for this job.</p>
          <p className="rv-muted">Logs will appear here as the pipeline runs.</p>
        </div>
      )}
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
          <span className="rv-empty-icon">💰</span>
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
          <span className="rv-tokens-card-label">Prompt Tokens</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.totals.completion_tokens.toLocaleString()}</span>
          <span className="rv-tokens-card-label">Completion Tokens</span>
        </div>
        <div className="rv-tokens-card">
          <span className="rv-tokens-card-value">{usage.steps.length}</span>
          <span className="rv-tokens-card-label">LLM Calls</span>
        </div>
      </div>

      {/* Model info */}
      <div className="rv-tokens-model-info">
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
  { key: "uploaded", icon: "📤", label: "Uploading", description: "Receiving your audio file", matches: ["uploaded"] },
  { key: "initializing", icon: "🔧", label: "Getting Ready", description: "Preparing the transcription system", matches: ["initializing"] },
  {
    key: "diarization",
    icon: "🔬",
    label: "Identifying Speakers",
    description: "Detecting who speaks and when",
    matches: ["processing_diarization"],
  },
  { key: "voiceprints", icon: "🧬", label: "Matching Voices", description: "Matching voices to known attendees", matches: ["matching_voiceprints"] },
  { key: "transcription", icon: "🎤", label: "Transcribing Speech", description: "Converting speech to text", matches: ["processing_transcription"] },
  { key: "aligning", icon: "🔗", label: "Building Transcript", description: "Matching words to each speaker", matches: ["aligning"] },
  {
    key: "agent",
    icon: "🤖",
    label: "AI Processing",
    description: "Refining, summarizing & analyzing",
    matches: ["transcribed", "ready_for_agent", "labeling_needed", "refined", "summarized", "analyzed"],
  },
  { key: "delivery", icon: "📬", label: "Delivering Results", description: "Sending via email, Trello & Drive", matches: ["delivered"] },
];

const COMPLETE_STATUSES = new Set(["delivered", "refined", "summarized", "analyzed"]);

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
      <div className="pp-bar-label">{isFailed ? "❌ Failed" : isComplete ? "✅ Complete" : `${Math.round(progress * 100)}%`}</div>

      {/* Pipeline stepper */}
      <div className="pp-stepper">
        {PIPELINE.map((stage) => {
          const state = getStageState(stage, status, isFailed, isComplete);
          return (
            <div key={stage.key} className={`pp-step pp-step--${state}`}>
              <div className="pp-step-line" />
              <div className="pp-step-dot">
                {state === "done" && <span className="pp-step-check">✓</span>}
                {state === "active" && <span className="pp-step-spinner" />}
                {state === "error" && (
                  <span className="pp-step-check" style={{ color: "#fff" }}>
                    ✕
                  </span>
                )}
                {state === "pending" && <span className="pp-step-pending-dot" />}
              </div>
              <div className="pp-step-content">
                <span className="pp-step-icon">{stage.icon}</span>
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
          <span className="pp-error-header">❌ Error</span>
          <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>{error}</p>
        </div>
      )}
    </div>
  );
}

/* ── Main ResultsViewer ── */

export default function ResultsViewer({ jobId, segments, summary, metadata, jobStatus, jobProgress, jobError }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("pipeline");

  // Reset to first tab when switching to a different job
  useEffect(() => {
    setActiveTab("pipeline");
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

  const tabMeta = TABS.find((t) => t.id === activeTab);

  return (
    <div className="rv-container">
      {/* Tab navigation */}
      <div className="rv-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`rv-tab ${activeTab === tab.id ? "rv-tab--active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}>
            <span className="rv-tab-icon">{tab.icon}</span>
            <span className="rv-tab-label">{tab.label}</span>
            {tab.id === "analysis" && analysisLoading && <span className="rv-tab-spinner" />}
          </button>
        ))}
      </div>

      {/* Tab header with meta info */}
      <div className="rv-panel-header">
        <div className="rv-panel-header-left">
          <h2 className="rv-panel-title">
            {tabMeta?.icon} {tabMeta?.label}
          </h2>
          {metadata?.title && <span className="rv-panel-subtitle">{metadata.title}</span>}
        </div>
        <div className="rv-panel-header-right">
          <span className="rv-job-badge" title={jobId}>
            🆔 {jobId}
          </span>
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
        {activeTab === "tokens" && <TokensTab jobId={jobId} />}
        {activeTab === "logs" && <LogsTab jobId={jobId} />}
      </div>
    </div>
  );
}
