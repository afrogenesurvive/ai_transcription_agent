/**
 * Logger — writes actions to agent-runner log file
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.TRANSCRIPTION_LOGS_DIR || path.resolve(__dirname, "..", "logs");

export function logAction(entry) {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const logEntry = { timestamp: ts, source: "transcription-agent", ...entry };

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${today}.jsonl`), JSON.stringify(logEntry) + "\n");
  } catch {
    /* ignore */
  }
}
