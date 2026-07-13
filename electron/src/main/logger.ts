/**
 * Logger — ring buffer for child process output + main process logs.
 *
 * Stores the last 2000 entries in memory (for the live log / DevPanel),
 * notifies subscribers when new entries arrive, and writes all entries
 * to per-job pipeline.log files on disk.
 *
 * Per-job log files are stored in: <storage>/<job_id>/pipeline.log
 * When a job's pipeline completes or fails, the per-job log stream is
 * closed so the file stops growing.
 *
 * Used by backend-manager.ts (to capture stdout/stderr from Python/Bridge/Agent),
 * config.ts (to log config changes), and index.ts (to forward logs to the renderer).
 */

import fs from "fs";
import path from "path";

export interface LogEntry {
  timestamp: number;
  source: "python" | "bridge" | "agent" | "main";
  /** Optional sub-source extracted from [tag] prefix in the message, e.g. "transcription", "pipeline", "voiceprint" */
  subSource?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface LogFileInfo {
  path: string;
  name: string;
  size: number;
  mtime: Date;
  source: "primary" | "mirror" | "job";
}

const MAX_ENTRIES = 50000;
const buffer: LogEntry[] = [];
let subscribers: Array<(entry: LogEntry) => void> = [];

// ── Per-job log stream tracking ──
interface JobLogStream {
  stream: fs.WriteStream;
  storageDir: string;
  closed: boolean;
}
const jobLogs = new Map<string, JobLogStream>();

// Storage base path — set once during app startup
let _storageBase: string | null = null;

// Tracks the most recently seen active job ID so subsequent log entries
// without an explicit jobId can still be written to the right job's log.
let _currentJobId: string | null = null;

/**
 * Set or clear the "current" job ID. The logger remembers this so that
 * subsequent addLog() calls without an explicit jobId will still write to
 * the active job's pipeline.log. Call with null to clear when the job ends.
 */
export function setCurrentJobId(jobId: string | null): void {
  _currentJobId = jobId;
}

/** Get the currently tracked job ID (if any). */
export function getCurrentJobId(): string | null {
  return _currentJobId;
}

/**
 * Set the storage base directory (e.g. <userData>/storage).
 * Must be called once during app startup.
 */
export function setStorageBase(base: string): void {
  _storageBase = base;
}

/** Get the storage base directory. */
export function getStorageBase(): string | null {
  return _storageBase;
}

/**
 * Shared UUID/hex-string capture pattern.
 * Matches full UUIDs (550e8400-e29b-41d4-a716-446655440000) and bare hex strings (8+ chars).
 */
const _UUID_RE = /([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})/i;

/**
 * Extract a job ID from a log message by trying multiple patterns:
 *   "job <uuid>"               — Pipeline start/complete/fail messages
 *   "job_id=<uuid>"             — Upload messages, agent tool calls
 *   "/transcribe/.../<uuid>"    — API endpoint logs
 *   "/agent/.../<uuid>"         — Agent API endpoint logs
 *   "/label_and_resume/<uuid>"  — Label and resume endpoint
 *
 * Returns the full UUID or hex string, or null if no job ID found.
 */
function _extractJobId(message: string): string | null {
  // Pattern 1: "job <uuid>"  (e.g. "Starting pipeline for job abc123...")
  let m = message.match(new RegExp(`\\bjob\\s+${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  // Pattern 2: "job_id=<uuid>"  (e.g. "→ job_id=abc123" or "job_id=abc123 rules=...")
  m = message.match(new RegExp(`job_id=${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  // Pattern 3: "/.../<uuid>" in API paths (e.g. "/transcribe/status/abc123" or "/transcribe/cancel/abc123")
  // These appear in messages like "GET /transcribe/status/abc123 → ..." or "POST /transcribe/cancel/abc123 → ..."
  m = message.match(new RegExp(`/(?:transcribe|agent)/(?:[a-z_]+/)?${_UUID_RE.source}(?:/|\\s|$)`, "i"));
  if (m) return m[1];

  return null;
}

/**
 * Detect pipeline end markers in a message to know when to close a job log.
 * Returns the job ID if this message signals pipeline completion or failure.
 *
 * Handles patterns from:
 *   - Python backend: "Pipeline complete for job <uuid>", "ERROR in job <uuid>"
 *   - Agent runner:  "Job <short_id> marked as complete", "Pipeline failed for job <short_id>"
 *   - Also matches "complete/<uuid>" and "fail/<uuid>" URL patterns
 */
function _detectPipelineEnd(message: string): string | null {
  // Python backend completion: "✅ [PIPELINE] Pipeline complete for job abc123..."
  let m = message.match(new RegExp(`(?:Pipeline complete|Resumed pipeline complete)\\s+for\\s+job\\s+${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  // Agent runner completion: "✅ [RUNNER] Job abc12345 marked as complete"
  m = message.match(new RegExp(`Job\\s+${_UUID_RE.source}\\s+marked\\s+as\\s+complete`, "i"));
  if (m) return m[1];

  // Python backend failure: "❌ [pipeline] ERROR in job abc123: ..."
  m = message.match(new RegExp(`ERROR\\s+in\\s+job\\s+${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  // Agent runner failure: "❌ [RUNNER] Pipeline failed for job abc12345: ..."
  m = message.match(new RegExp(`Pipeline\\s+failed\\s+for\\s+job\\s+${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  // Python cancellation: "🛑 [pipeline] Job abc123 task cancelled."
  m = message.match(new RegExp(`Job\\s+${_UUID_RE.source}\\s+task\\s+cancelled`, "i"));
  if (m) return m[1];

  // URL-based end markers: "POST /transcribe/complete/<uuid>" or "POST /transcribe/fail/<uuid>"
  m = message.match(new RegExp(`/(?:transcribe|agent)/(?:complete|fail)/${_UUID_RE.source}`, "i"));
  if (m) return m[1];

  return null;
}

function _getOrCreateJobStream(jobId: string): JobLogStream | null {
  // Return existing stream if available and not closed
  const existing = jobLogs.get(jobId);
  if (existing && !existing.closed) return existing;
  if (existing && existing.closed) return null; // already closed

  // Create new stream
  if (!_storageBase) return null;
  const jobDir = path.join(_storageBase, jobId);
  const logPath = path.join(jobDir, "pipeline.log");
  try {
    fs.mkdirSync(jobDir, { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    const entry: JobLogStream = { stream, storageDir: _storageBase, closed: false };
    jobLogs.set(jobId, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Close the per-job log stream for a given job ID.
 * Once closed, no more log entries will be written to that job's pipeline.log.
 * Called automatically when pipeline completion/failure is detected.
 */
export function closeJobLog(jobId: string): void {
  const entry = jobLogs.get(jobId);
  if (!entry || entry.closed) return;
  entry.closed = true;
  try {
    entry.stream.end();
  } catch {
    // non-fatal
  }
  jobLogs.delete(jobId);
}

/** Read the last N lines from a log file. Pass 0 (default) to return all lines. */
export function readLogFile(filePath: string, maxLines = 0): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    if (maxLines <= 0) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** List per-job log files from the storage directory. */
export function listJobLogFiles(storageDir: string): LogFileInfo[] {
  const files: LogFileInfo[] = [];
  if (!storageDir || !fs.existsSync(storageDir)) return files;
  try {
    const entries = fs.readdirSync(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["chroma", "logs", "uploads", ".model_cache"].includes(entry.name)) continue;
      const jobDir = path.join(storageDir, entry.name);
      try {
        const jobFiles = fs.readdirSync(jobDir);
        for (const fname of jobFiles) {
          if (!fname.endsWith(".log") && !fname.endsWith(".jsonl")) continue;
          const fpath = path.join(jobDir, fname);
          try {
            const stat = fs.statSync(fpath);
            files.push({
              path: fpath,
              name: `${entry.name}/${fname}`,
              size: stat.size,
              mtime: stat.mtime,
              source: "job",
            });
          } catch {
            // skip unreadable
          }
        }
      } catch {
        // job directory not readable or doesn't exist
      }
    }
  } catch {
    // non-fatal
  }
  return files;
}

/**
 * Write a formatted log line to the per-job pipeline.log.
 * If the job's log stream has been closed (pipeline completed/failed),
 * the line is silently dropped.
 */
function _writeToJobLog(jobId: string, formattedLine: string): void {
  const entry = jobLogs.get(jobId);
  if (!entry || entry.closed) return;
  try {
    entry.stream.write(formattedLine + "\n");
  } catch {
    // non-fatal
  }
}

export function addLog(
  source: LogEntry["source"],
  level: LogEntry["level"],
  message: string,
  subSource?: string,
  /** Optional job ID — if provided, the entry is written to that job's pipeline.log */
  jobId?: string,
): void {
  if (!message) return;
  const timestamp = Date.now();

  if (!subSource) {
    const match = message.match(/^\[(\w+)\]/);
    if (match) {
      subSource = match[1];
    } else {
      const tsMatch = message.match(/^\[\d{1,2}:\d{2}\.\d{3}\s*-->/);
      if (tsMatch) {
        subSource = "transcription";
      }
    }
  }

  // console.log("Live Log Debug!!!!", {
  //   source,
  //   subSource,
  //   msg_substring: message.substring(0, 15),
  //   level,
  // });

  if (subSource === undefined || subSource === null || subSource.trim() === "") {
    const firstBracketIndex = message.indexOf("[");
    const firstClosingBracketIndex = message.indexOf("]");
    if (firstBracketIndex !== -1 && firstClosingBracketIndex !== -1 && firstClosingBracketIndex > firstBracketIndex) {
      subSource = message.substring(firstBracketIndex + 1, firstClosingBracketIndex).trim();
    } else {
      subSource = undefined;
    }
  }

  const entry: LogEntry = { timestamp, source, subSource, level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // ── Write to per-job pipeline.log ──
  // Priority: explicit jobId > _currentJobId (tracked active job) > extracted from message text
  const logJobId = jobId || _currentJobId || _extractJobId(message);

  if (logJobId) {
    // Check if this message signals pipeline end — close the log if so
    const endJobId = _detectPipelineEnd(message);
    if (endJobId) {
      // Write the final entry before closing
      const stream = _getOrCreateJobStream(endJobId);
      if (stream) {
        const timeStr = new Date(timestamp).toISOString();
        const subTag = subSource ? `[${subSource}] ` : "";
        _writeToJobLog(endJobId, `[${timeStr}] [${source}] [${subTag}] [${level}] ${message}`);
      }
      closeJobLog(endJobId);
      // Clear current job tracking when the pipeline ends
      if (_currentJobId === endJobId) {
        _currentJobId = null;
      }
    } else {
      // Normal entry — write to job log
      const stream = _getOrCreateJobStream(logJobId);
      if (stream) {
        const timeStr = new Date(timestamp).toISOString();
        const subTag = subSource ? `[${subSource}] ` : "";
        _writeToJobLog(logJobId, `[${timeStr}] [${source}] [${subTag}] [${level}] ${message}`);
      }
      // Track this as the current active job if we don't already have one
      // (ensures subsequent logs without explicit jobId still go to this job)
      if (!_currentJobId) {
        _currentJobId = logJobId;
      }
    }
  }

  // Notify subscribers synchronously (for the in-memory live log in DevPanel)
  for (const fn of subscribers) fn(entry);
}

export function getLogs(limit = 200): LogEntry[] {
  return buffer.slice(-limit);
}

export function getAllLogs(): LogEntry[] {
  return [...buffer];
}

export function subscribe(fn: (entry: LogEntry) => void): () => void {
  subscribers.push(fn);
  return () => {
    subscribers = subscribers.filter((s) => s !== fn);
  };
}

export function clearLogs(): void {
  buffer.length = 0;
}
