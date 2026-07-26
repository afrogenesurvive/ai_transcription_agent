/**
 * Usage Tracker — per-API-call usage buffer + push to DS-mon
 *
 * After each DeepSeek LLM call, captures token usage data and buffers it
 * locally in a JSONL file. Periodically flushes to DS-mon's /sync/push
 * endpoint for centralized per-machine usage monitoring across multiple
 * instances sharing the same API key.
 *
 * Offline-resilient: on push failure (network error or non-200), records
 * are retained in the buffer file and retried on the next flush cycle.
 *
 * Config (all env vars, optional — tracking disabled when URL is empty):
 *   DSMON_PUSH_URL       — DS-mon sync server URL (e.g. http://host:18888/sync/push)
 *   DSMON_INSTANCE_ID    — Instance identifier (default: os.hostname())
 *   DSMON_PUSH_INTERVAL  — Flush interval in ms (default: 300000 = 5 min)
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUSH_URL = process.env.DSMON_PUSH_URL || "";
const INSTANCE_ID = process.env.DSMON_INSTANCE_ID || os.hostname();
const PUSH_INTERVAL = parseInt(process.env.DSMON_PUSH_INTERVAL || "300000", 10);
const STORAGE_BASE = process.env.TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");
const BUFFER_FILE = path.join(STORAGE_BASE, "dsmon_buffer.jsonl");

let flushTimer = null;

/**
 * Record a per-API-call usage entry to the local JSONL buffer.
 * No-op when DSMON_PUSH_URL is not set.
 *
 * @param {object} usage - The response.usage object from the LLM API call
 * @param {string} model - The model name used for the call
 * @param {number} latencyMs - Round-trip latency in milliseconds
 * @param {object} stepInfo - { step: number, tool: string } identifying the pipeline step
 */
export function recordCall(usage, model, latencyMs, stepInfo) {
  if (!PUSH_URL) return;

  const record = {
    uuid: crypto.randomUUID(),
    timestamp: Date.now() / 1000,
    providerId: "deepseek",
    model: model || "unknown",
    endpoint: "/v1/chat/completions",
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    totalTokens: usage?.total_tokens || 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens || 0,
    latencyMs: latencyMs || 0,
    statusCode: 200,
    userAgent: `transcription-agent/${INSTANCE_ID}`,
    sourceIP: INSTANCE_ID,
  };

  try {
    fs.mkdirSync(path.dirname(BUFFER_FILE), { recursive: true });
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.log(`⚠️ [DSMON] Failed to buffer usage record: ${err.message}`);
  }
}

/**
 * Flush buffered records to DS-mon's /sync/push endpoint.
 * On success (HTTP 200), truncates the buffer file.
 * On failure, leaves records intact for retry on the next cycle.
 */
export async function flushBuffer() {
  if (!PUSH_URL) return;

  if (!fs.existsSync(BUFFER_FILE)) return;

  let records = [];
  try {
    const content = fs.readFileSync(BUFFER_FILE, "utf8");
    records = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    console.log(`⚠️ [DSMON] Failed to read buffer file: ${err.message}`);
    return;
  }

  if (records.length === 0) return;

  try {
    const resp = await fetch(PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(records),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      // Truncate the buffer — write empty string (not unlink) to avoid
      // race conditions with concurrent recordCall() appends
      fs.writeFileSync(BUFFER_FILE, "", "utf8");
      console.log(`📊 [DSMON] Pushed ${records.length} usage records to ${PUSH_URL}`);
    } else {
      const text = await resp.text().catch(() => "");
      console.log(`⚠️ [DSMON] Push failed: HTTP ${resp.status} ${text.slice(0, 100)} — ${records.length} records retained`);
    }
  } catch (err) {
    console.log(`⚠️ [DSMON] Push error: ${err.message} — ${records.length} records retained for retry`);
  }
}

/**
 * Start the periodic flush timer.
 * Also performs an immediate flush on start to catch any records that
 * were buffered while the runner was previously offline.
 */
export function startFlushTimer() {
  if (!PUSH_URL) {
    console.log(`📊 [DSMON] Tracking disabled — set DSMON_PUSH_URL to enable`);
    return;
  }
  if (flushTimer) return;

  console.log(`📊 [DSMON] Starting flush timer (interval: ${PUSH_INTERVAL}ms, instance: ${INSTANCE_ID})`);

  // Immediate flush on start (catches offline-period records)
  flushBuffer();

  flushTimer = setInterval(flushBuffer, PUSH_INTERVAL);
}

/**
 * Stop the periodic flush timer.
 */
export function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
    console.log(`📊 [DSMON] Flush timer stopped`);
  }
}
