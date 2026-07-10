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
  /** Optional sub-source extracted from [tag] prefix in the message, e.g. "transcription", "pipeline", "voiceprint" */
  subSource?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface LogFilter {
  enabledSources: Set<"python" | "bridge" | "agent" | "main">;
  minLevel: "debug" | "info" | "warn" | "error" | "off";
  maxFileSizeBytes: number;
  maxFiles: number;
}

const MAX_ENTRIES = 2000;
const buffer: LogEntry[] = [];
let subscribers: Array<(entry: LogEntry) => void> = [];
let logDir: string | null = null;
let currentLogDate: string | null = null;
let writeStream: fs.WriteStream | null = null;
let currentFilePath: string | null = null;

// Default filter — write everything
let logFilter: LogFilter = {
  enabledSources: new Set(["python", "bridge", "agent", "main"]),
  minLevel: "debug",
  maxFileSizeBytes: 0,
  maxFiles: 0,
};

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldWriteToDisk(source: LogEntry["source"], level: LogEntry["level"]): boolean {
  if (logFilter.minLevel === "off") return false;
  if (!logFilter.enabledSources.has(source)) return false;
  const entryRank = LEVEL_RANK[level] ?? 0;
  const minRank = LEVEL_RANK[logFilter.minLevel] ?? 0;
  return entryRank >= minRank;
}

/**
 * Configure the log filter for disk writes.
 * Call this after app config is loaded, and again whenever config changes.
 * In-memory ring buffer is NEVER filtered — only disk writes are affected.
 */
export function configureLogFilter(filter: { enabledSources?: string; minLevel?: string; maxFileSizeMb?: string; maxFiles?: string }): void {
  if (filter.enabledSources !== undefined) {
    const sources =
      filter.enabledSources === "all"
        ? ["python", "bridge", "agent", "main"]
        : filter.enabledSources
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    logFilter.enabledSources = new Set(sources as ("python" | "bridge" | "agent" | "main")[]);
  }
  if (filter.minLevel !== undefined) {
    const valid = ["debug", "info", "warn", "error", "off"];
    if (valid.includes(filter.minLevel)) {
      logFilter.minLevel = filter.minLevel as LogFilter["minLevel"];
    }
  }
  if (filter.maxFileSizeMb !== undefined) {
    const mb = parseInt(filter.maxFileSizeMb, 10);
    logFilter.maxFileSizeBytes = mb > 0 ? mb * 1024 * 1024 : 0;
  }
  if (filter.maxFiles !== undefined) {
    logFilter.maxFiles = parseInt(filter.maxFiles, 10) || 0;
  }
}

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
  currentFilePath = null;
  if (!logDir) return;
  const filePath = path.join(logDir, `app-${dateStr}.log`);
  try {
    writeStream = fs.createWriteStream(filePath, { flags: "a" });
    currentFilePath = filePath;
  } catch {
    // Can't write to log file — non-fatal
  }
}

/**
 * Check if the current log file has exceeded the max size.
 * If so, rotate by renaming to .1 / .2 / .N and open a fresh file.
 */
function checkSizeRotation(): void {
  if (!logFilter.maxFileSizeBytes || !currentFilePath || !writeStream) return;
  try {
    const stat = fs.statSync(currentFilePath);
    if (stat.size < logFilter.maxFileSizeBytes) return;

    // Close current stream
    writeStream.end();
    writeStream = null;

    // Find next available rotation index
    let idx = 1;
    while (fs.existsSync(`${currentFilePath}.${idx}`)) idx++;

    // Rename current → current.N
    fs.renameSync(currentFilePath, `${currentFilePath}.${idx}`);

    // Prune old rotations beyond maxFiles
    if (logFilter.maxFiles > 0) {
      const dateStr = getDateStr();
      const pattern = `app-${dateStr}.log.`;
      const files = fs
        .readdirSync(logDir!)
        .filter((f) => f.startsWith(pattern))
        .map((f) => ({ name: f, num: parseInt(f.slice(pattern.length), 10) }))
        .filter((f) => !isNaN(f.num))
        .sort((a, b) => b.num - a.num);

      for (const file of files.slice(logFilter.maxFiles - 1)) {
        try {
          fs.unlinkSync(path.join(logDir!, file.name));
        } catch {
          /* non-fatal */
        }
      }
    }

    // Reopen fresh file
    writeStream = fs.createWriteStream(currentFilePath, { flags: "a" });
  } catch {
    // non-fatal
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
  source: "primary" | "mirror" | "job";
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

/** List per-job log files (pipeline.log + agent-trace/actions.jsonl) from the storage directory. */
// export function listJobLogFiles(storageDir: string): LogFileInfo[] {
//   const files: LogFileInfo[] = [];
//   if (!storageDir || !fs.existsSync(storageDir)) return files;
//   try {
//     const entries = fs.readdirSync(storageDir, { withFileTypes: true });
//     for (const entry of entries) {
//       if (!entry.isDirectory()) continue;
//       // Skip special directories
//       if (["chroma", "logs", "uploads", ".model_cache"].includes(entry.name)) continue;
//       const pipelineLogPath = path.join(storageDir, entry.name, "pipeline.log");
//       if (!fs.existsSync(pipelineLogPath)) continue;
//       try {
//         const stat = fs.statSync(pipelineLogPath);
//         files.push({
//           path: pipelineLogPath,
//           name: `${entry.name}/pipeline.log`,
//           size: stat.size,
//           mtime: stat.mtime,
//           source: "job",
//         });
//       } catch {
//         // skip unreadable
//       }
//     }
//   } catch {
//     // non-fatal
//   }
//   return files;
// }

/** List per-job log files (pipeline.log + agent-trace/actions.jsonl) from the storage directory. */
export function listJobLogFiles(storageDir: string): LogFileInfo[] {
  const files: LogFileInfo[] = [];
  if (!storageDir || !fs.existsSync(storageDir)) return files;
  try {
    const entries = fs.readdirSync(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip special directories
      if (["chroma", "logs", "uploads", ".model_cache"].includes(entry.name)) continue;
      // List all .log and .jsonl files from the job directory
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
  checkSizeRotation();
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

export function addLog(source: LogEntry["source"], level: LogEntry["level"], message: string, subSource?: string): void {
  if (!message) return;
  const timestamp = Date.now();
  console.log("Log labelling debug!!!!:", {
    source,
    subSource,
    msg_substr: message.substring(0, 10),
  });

  if (!subSource) {
    // Only match a simple word-only [tag] at the start — NOT bracketed content
    // like timestamps.  This prevents the fallback from accidentally extracting
    // something like "12:28.840 --> 12:33.500" as a sub-source tag when the
    // caller didn't provide one (e.g. for lines that don't start with [tag]).
    const match = message.match(/^\[(\w+)\]/);
    if (match) {
      subSource = match[1];
    } else {
      // Fallback: detect Whisper verbose timestamp format
      //   [01:21.560 --> 01:25.380] text
      // and tag as [transcription] sub-source.
      const tsMatch = message.match(/^\[\d{1,2}:\d{2}\.\d{3}\s*-->/);
      if (tsMatch) {
        subSource = "transcription";
      }
    }
  }

  const entry: LogEntry = { timestamp, source, subSource, level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // Write to log file (filtered by config — in-memory buffer is NEVER filtered)
  if (shouldWriteToDisk(source, level)) {
    const timeStr = new Date(timestamp).toISOString();
    const subTag = subSource ? `[${subSource}] ` : "";
    writeToFile(`[${timeStr}] [${source}] [${level}] ${subTag}${message}`);
  }

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
