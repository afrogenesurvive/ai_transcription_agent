/**
 * Logger — ring buffer for child process output + main process logs.
 *
 * Stores the last 2000 entries and notifies subscribers when new entries arrive.
 * Used by backend-manager.ts (to capture stdout/stderr from Python/Bridge/Agent)
 * and index.ts (to forward logs to the renderer via IPC).
 */

export interface LogEntry {
  timestamp: number;
  source: "python" | "bridge" | "agent" | "main";
  level: "info" | "warn" | "error";
  message: string;
}

const MAX_ENTRIES = 2000;
const buffer: LogEntry[] = [];
let subscribers: Array<(entry: LogEntry) => void> = [];

export function addLog(source: LogEntry["source"], level: LogEntry["level"], message: string): void {
  if (!message) return;
  const entry: LogEntry = { timestamp: Date.now(), source, level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
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
