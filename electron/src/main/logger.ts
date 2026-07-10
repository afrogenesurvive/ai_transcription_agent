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

const MAX_ENTRIES = 2000;
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
 * Extract a job ID from a log message by looking for common patterns:
 *   "Starting pipeline for job <uuid>" — Python backend
 *   "ERROR in job <uuid>" — Python backend
 *   "Job <uuid> task cancelled" — Python backend
 *   "Pipeline complete for job <uuid>" — Python backend
 *   "Processing event <id> for job <id>" — agent runner
 *
 * Returns the full UUID or hex string, or null if no job ID found.
 */
function _extractJobId(message: string): string | null {
  // Match "job <uuid-like>" where uuid-like can be a full UUID or hex string
  const match = message.match(/\bjob\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})/i);
  if (match) return match[1];
  return null;
}

/**
 * Detect pipeline end markers in a message to know when to close a job log.
 * Returns the job ID if this message signals pipeline completion or failure.
 *
 * Handles patterns from:
 *   - Python backend: "Pipeline complete for job <uuid>", "ERROR in job <uuid>"
 *   - Agent runner:  "Job <short_id> marked as complete", "Pipeline failed for job <short_id>"
 */
function _detectPipelineEnd(message: string): string | null {
  // Python backend completion: "✅ [PIPELINE] Pipeline complete for job abc123..."
  const completePy = message.match(/(?:Pipeline complete|Resumed pipeline complete)\s+for\s+job\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})/i);
  if (completePy) return completePy[1];

  // Agent runner completion: "✅ [RUNNER] Job abc12345 marked as complete"
  const completeAr = message.match(/Job\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})\s+marked\s+as\s+complete/i);
  if (completeAr) return completeAr[1];

  // Python backend failure: "❌ [pipeline] ERROR in job abc123: ..."
  const failPy = message.match(/ERROR\s+in\s+job\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})/i);
  if (failPy) return failPy[1];

  // Agent runner failure: "❌ [RUNNER] Pipeline failed for job abc12345: ..."
  const failAr = message.match(/Pipeline\s+failed\s+for\s+job\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})/i);
  if (failAr) return failAr[1];

  // Python cancellation: "🛑 [pipeline] Job abc123 task cancelled."
  const cancel = message.match(/Job\s+([a-f0-9]{8,}(?:-[a-f0-9]{4}){0,3}[a-f0-9]{4,})\s+task\s+cancelled/i);
  if (cancel) return cancel[1];

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

  const entry: LogEntry = { timestamp, source, subSource, level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // ── Write to per-job pipeline.log ──
  // If no explicit jobId, try to extract one from the message text.
  const logJobId = jobId || _extractJobId(message);
  if (logJobId) {
    // Check if this message signals pipeline end — close the log if so
    const endJobId = _detectPipelineEnd(message);
    if (endJobId) {
      // Write the final entry before closing
      const stream = _getOrCreateJobStream(endJobId);
      if (stream) {
        const timeStr = new Date(timestamp).toISOString();
        const subTag = subSource ? `[${subSource}] ` : "";
        _writeToJobLog(endJobId, `[${timeStr}] [${source}] [${level}] ${subTag}${message}`);
      }
      closeJobLog(endJobId);
    } else {
      // Normal entry — write to job log
      const stream = _getOrCreateJobStream(logJobId);
      if (stream) {
        const timeStr = new Date(timestamp).toISOString();
        const subTag = subSource ? `[${subSource}] ` : "";
        _writeToJobLog(logJobId, `[${timeStr}] [${source}] [${level}] ${subTag}${message}`);
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
