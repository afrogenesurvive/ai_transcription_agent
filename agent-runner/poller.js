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
    if (!fs.existsSync(QUEUE_FILE)) {
      console.log(`   [POLLER] Queue file not found: ${QUEUE_FILE}`);
      return [];
    }
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    console.log(`   [POLLER] Queue file: ${lines.length} total line(s)`);
    const pending = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.cleared) {
          console.log(`   [POLLER]   ${evt.id?.slice(0, 8)} — cleared (${evt.clearedAt})`);
          continue;
        }
        if (processing.has(evt.id)) {
          console.log(`   [POLLER]   ${evt.id?.slice(0, 8)} — already processing`);
          continue;
        }
        console.log(`   [POLLER]   ${evt.id?.slice(0, 8)} — pending (${evt.type})`);
        pending.push(evt);
      } catch {
        console.log(`   [POLLER]   (malformed line, skipping)`);
      }
    }
    console.log(`   [POLLER] ${pending.length} pending event(s)`);
    return pending;
  } catch (err) {
    console.error("   ❌ [POLLER]", err.message);
    return [];
  }
}

export function markCleared(eventId) {
  const tag = eventId?.slice(0, 8) || "???";
  console.log(`   [POLLER] Marking ${tag} as cleared`);
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
      console.log(`   ✅ [POLLER] ${tag} cleared in queue`);
    } else {
      console.log(`   ⚠️  [POLLER] ${tag} not found or already cleared`);
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
