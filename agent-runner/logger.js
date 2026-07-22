/**
 * Logger — writes per-job action logs to the job's storage directory.
 *
 * Each log entry is appended to storage/{jobId}/actions.jsonl so all
 * pipeline actions are co-located with the job's other data files.
 * Falls back to storage/{eventId} when jobId is not provided.
 * No date-based log files are created.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_BASE = process.env.TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");

export function logAction(entry) {
  const ts = new Date().toISOString();
  const logEntry = { timestamp: ts, source: "transcription-agent", ...entry };
  const targetId = entry.jobId || entry.eventId;

  // Only write if we have a job to associate with
  if (!targetId) return;

  // Strip routing metadata before writing to disk
  delete logEntry.jobId;

  try {
    const jobDir = path.join(STORAGE_BASE, targetId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.appendFileSync(path.join(jobDir, "actions.jsonl"), JSON.stringify(logEntry) + "\n");
  } catch {
    /* ignore */
  }
}
