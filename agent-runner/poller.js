/**
 * Queue Poller — reads unactioned items from transcription.jsonl
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.resolve(__dirname, "..", "queue", "transcription.jsonl");

const processing = new Set();

export function readPending() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const lines = fs.readFileSync(QUEUE_FILE, "utf8").split("\n").filter(Boolean);
    const pending = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.cleared) continue;
        if (processing.has(evt.id)) continue;
        pending.push(evt);
      } catch {
        /* skip malformed */
      }
    }
    return pending;
  } catch (err) {
    console.error("   ❌ [POLLER]", err.message);
    return [];
  }
}

export function markCleared(eventId) {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return false;
    const content = fs.readFileSync(QUEUE_FILE, "utf8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const evt = JSON.parse(line);
        if (evt.id === eventId && !evt.cleared) {
          evt.cleared = true;
          evt.clearedAt = new Date().toISOString();
          evt.clearedBy = "transcription-agent";
          found = true;
          return JSON.stringify(evt);
        }
        return line;
      } catch {
        return line;
      }
    });
    if (found) {
      fs.writeFileSync(QUEUE_FILE, updated.join("\n"), "utf8");
      processing.delete(eventId);
    }
    return found;
  } catch (err) {
    console.error("   ❌ [POLLER]", err.message);
    return false;
  }
}

export function acquireLock(eventId) {
  processing.add(eventId);
}
export function releaseLock(eventId) {
  processing.delete(eventId);
}
