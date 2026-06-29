/**
 * Logger — ring buffer for child process output + main process logs.
 *
 * Stores the last 2000 entries, notifies subscribers when new entries arrive,
 * and persists all entries to rotating log files on disk.
 *
 * Log files are stored in: <userData>/logs/app-YYYY-MM-DD.log
 * In dev, also mirrored to: <project>/storage/logs/app-YYYY-MM-DD.log
 *
 * Used by backend-manager.ts (to capture stdout/stderr from Python/Bridge/Agent),
 * config.ts (to log config changes), and index.ts (to forward logs to the renderer).
 */

import fs from "fs";
import path from "path";

export interface LogEntry {
  timestamp: number;
  source: "python" | "bridge" | "agent" | "main";
  level: "info" | "warn" | "error";
  message: string;
}

const MAX_ENTRIES = 2000;
const buffer: LogEntry[] = [];
let subscribers: Array<(entry: LogEntry) => void> = [];
let logDir: string | null = null;
let currentLogDate: string | null = null;
let writeStream: fs.WriteStream | null = null;

function getDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rotateFile(): void {
  const dateStr = getDateStr();
  if (dateStr === currentLogDate && writeStream) return;
  // Close previous
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
  currentLogDate = dateStr;
  if (!logDir) return;
  const filePath = path.join(logDir, `app-${dateStr}.log`);
  try {
    writeStream = fs.createWriteStream(filePath, { flags: "a" });
  } catch {
    // Can't write to log file — non-fatal
  }
}

/**
 * Initialize file logging. Call once after app is ready.
 * @param primaryDir — primary log directory (e.g. app.getPath("userData") + "/logs")
 * @param mirrorDir — optional secondary directory (e.g. project storage/logs for dev)
 */
/** Get the primary log directory path (set by initFileLogging). */
export function getLogDir(): string | null {
  return logDir;
}

/** Get the mirror log directory path (set by initFileLogging). */
export function getMirrorDir(): string | null {
  return _mirrorDir;
}

/** List all log files from both primary and mirror directories, newest first. */
export interface LogFileInfo {
  path: string;
  name: string;
  size: number;
  mtime: Date;
  source: "primary" | "mirror";
}

export function listLogFiles(): LogFileInfo[] {
  const files: LogFileInfo[] = [];
  const dirs: [string | null, "primary" | "mirror"][] = [
    [logDir, "primary"],
    [_mirrorDir, "mirror"],
  ];
  for (const [dir, source] of dirs) {
    if (!dir) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith(".log")) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, name: entry.name, size: stat.size, mtime: stat.mtime, source });
      }
    } catch {
      // directory might not exist yet
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files;
}

/** Read the last N lines from a log file. */
export function readLogFile(filePath: string, maxLines = 500): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function initFileLogging(primaryDir: string, mirrorDir?: string): void {
  logDir = primaryDir;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    // Also create mirror dir if provided
    if (mirrorDir) {
      fs.mkdirSync(mirrorDir, { recursive: true });
      // In the addLog function we'll try to write to both
    }
  } catch {
    // non-fatal
  }
  // Store mirror for use in addLog
  if (mirrorDir) _mirrorDir = mirrorDir;
  rotateFile();
}

let _mirrorDir: string | null = null;

function writeToFile(message: string): void {
  rotateFile();
  if (writeStream) {
    try {
      writeStream.write(message + "\n");
    } catch {
      // non-fatal
    }
  }
  // Also write to mirror directory if set
  if (_mirrorDir) {
    const dateStr = getDateStr();
    const mirrorPath = path.join(_mirrorDir, `app-${dateStr}.log`);
    try {
      fs.mkdirSync(_mirrorDir, { recursive: true });
      fs.appendFileSync(mirrorPath, message + "\n");
    } catch {
      // non-fatal
    }
  }
}

export function addLog(source: LogEntry["source"], level: LogEntry["level"], message: string): void {
  if (!message) return;
  const timestamp = Date.now();
  const entry: LogEntry = { timestamp, source, level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // Write to log file
  const timeStr = new Date(timestamp).toISOString();
  writeToFile(`[${timeStr}] [${source}] [${level}] ${message}`);

  // Notify subscribers synchronously
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
