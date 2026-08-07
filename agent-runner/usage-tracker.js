/**
 * Usage Tracker — per-API-call usage buffer + push to DS-mon
 *
 * After each DeepSeek LLM call, captures token usage data and buffers it
 * locally in a JSONL file. Periodically flushes to DS-mon's /sync/push
 * endpoint for centralized per-machine usage monitoring across multiple
 * instances sharing the same API key.
 *
 * The push URL is set statically via DSMON_PUSH_URL (e.g. a stable named-tunnel
 * URL). Offline-resilient: on push failure, records are retained in the buffer
 * file and retried on the next cycle.
 *
 * Config (all env vars, optional — tracking disabled when all empty):
 *   DSMON_PUSH_URL          — Static DS-mon push URL (e.g. https://<tunnel-id>.cfargotunnel.com/sync/push)
 *   DSMON_INSTANCE_ID       — Instance identifier (default: auto-generated)
 *   DSMON_PUSH_INTERVAL     — Flush interval in ms (default: 300000 = 5 min)
 *   DSMON_PUSH_TOKEN        — Shared bearer token required by the DS-mon host's /sync/push endpoint
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRACKING_ENABLED = process.env.USAGE_TRACKING_ENABLED === "true";
// Normalize the static URL so a bare host (e.g. https://<tunnel-id>.cfargotunnel.com)
// gets the /sync/push path.
let PUSH_URL = (process.env.DSMON_PUSH_URL || "").trim().replace(/\/+$/, "");
if (PUSH_URL && !/\/sync\/push$/i.test(PUSH_URL)) PUSH_URL += "/sync/push";
const PUSH_INTERVAL = parseInt(process.env.DSMON_PUSH_INTERVAL || "300000", 10);
const PUSH_TOKEN = process.env.DSMON_PUSH_TOKEN || "";
const STORAGE_BASE = process.env.TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");
const BUFFER_FILE = path.join(STORAGE_BASE, "dsmon_buffer.jsonl");
// Diagnostic log — persists every push outcome so failures are visible even
// when no job is active (the main-process logger only writes to a job's
// pipeline.log while a job is running).
const LOG_FILE = path.join(STORAGE_BASE, "dsmon.log");
// Cap the buffer so a permanently-unreachable DS-mon host can't grow it forever.
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const PUSH_TIMEOUT_MS = 30000; // 30s (was 15s — a slow tunnel can exceed 15s)

// Last-push status (for UI/telemetry visibility via getDsmonStatus).
let lastPush = { at: null, ok: null, count: 0, error: null };
let retryTimer = null;

/** Append a line to the DS-mon diagnostic log (and mirror to stdout). */
function _log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // Non-fatal — diagnostics only
  }
}

/** Export current push status + buffer stats (for UI / diagnostics). */
export function getDsmonStatus() {
  let bufferBytes = 0;
  let bufferCount = 0;
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      bufferBytes = fs.statSync(BUFFER_FILE).size;
      const content = fs.readFileSync(BUFFER_FILE, "utf8");
      bufferCount = content.split("\n").filter((l) => l.trim()).length;
    }
  } catch {
    // ignore
  }
  return { ...lastPush, bufferBytes, bufferCount };
}

/** Schedule a fast retry after a failed push (recovers quickly when the host returns). */
function _scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushBuffer();
  }, 60000);
}

/**
 * Generate a stable, human-readable instance identifier.
 *
 * Format: <hostname>-<username>-<short-uuid>
 * Example: michaels-mbp-mike-a1b2c3d4
 *
 * The short UUID is persisted to a file so it remains stable across restarts
 * while still uniquely identifying this machine/user combination.
 * When DSMON_INSTANCE_ID env var is set explicitly, it takes precedence.
 */
function generateInstanceId() {
  const explicit = process.env.DSMON_INSTANCE_ID;
  if (explicit) return explicit;

  const hostname = os
    .hostname()
    .replace(/\.local$/, "")
    .replace(/\..*$/, "")
    .toLowerCase();
  const username = (os.userInfo().username || "unknown").toLowerCase();

  // Persistent UUID file — survives restarts
  const idFile = path.join(STORAGE_BASE, ".dsmon_instance_id");
  let shortId;
  try {
    shortId = fs.readFileSync(idFile, "utf8").trim();
    if (shortId) return `${hostname}-${username}-${shortId}`;
  } catch {
    // File doesn't exist yet — generate new ID
  }

  shortId = crypto.randomUUID().split("-")[0];
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, shortId, "utf8");
  } catch {
    // Non-fatal — use a transient ID
  }

  return `${hostname}-${username}-${shortId}`;
}

const INSTANCE_ID = generateInstanceId();

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
  // Master switch — no collection unless USAGE_TRACKING_ENABLED=true.
  // (recordCall used to be gated only on PUSH_URL, so records were still
  // buffered while tracking was disabled whenever a push URL was configured.)
  if (!TRACKING_ENABLED) return;
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
    if (fs.existsSync(BUFFER_FILE) && fs.statSync(BUFFER_FILE).size > MAX_BUFFER_BYTES) {
      _log(`⚠️ [DSMON] Buffer exceeds ${MAX_BUFFER_BYTES} bytes — dropping record (host unreachable?)`);
      return;
    }
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    _log(`⚠️ [DSMON] Failed to buffer usage record: ${err.message}`);
  }
}

/**
 * Flush buffered records to DS-mon's /sync/push endpoint.
 * On success (HTTP 200), truncates the buffer file.
 * On failure, leaves records intact for retry on the next cycle.
 */
export async function flushBuffer() {
  // Master switch — never push while tracking is disabled.
  if (!TRACKING_ENABLED) return;
  if (!PUSH_URL) return;

  if (!fs.existsSync(BUFFER_FILE)) return;

  let records = [];
  try {
    const content = fs.readFileSync(BUFFER_FILE, "utf8");
    records = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    _log(`⚠️ [DSMON] Failed to read buffer file: ${err.message}`);
    return;
  }

  if (records.length === 0) return;

  try {
    // Authenticate against the DS-mon host when a shared push token is configured.
    const headers = { "Content-Type": "application/json" };
    if (PUSH_TOKEN) headers["Authorization"] = `Bearer ${PUSH_TOKEN}`;
    const resp = await fetch(PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(records),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    if (resp.ok) {
      // Truncate the buffer — write empty string (not unlink) to avoid
      // race conditions with concurrent recordCall() appends
      fs.writeFileSync(BUFFER_FILE, "", "utf8");
      lastPush = { at: Date.now(), ok: true, count: records.length, error: null };
      _log(`📊 [DSMON] Pushed ${records.length} usage records to ${PUSH_URL}`);
    } else {
      const text = await resp.text().catch(() => "");
      lastPush = { at: Date.now(), ok: false, count: records.length, error: `HTTP ${resp.status} ${text.slice(0, 100)}` };
      _log(`⚠️ [DSMON] Push failed: HTTP ${resp.status} ${text.slice(0, 100)} — ${records.length} records retained`);
      _scheduleRetry();
    }
  } catch (err) {
    lastPush = { at: Date.now(), ok: false, count: records.length, error: err.message };
    _log(`⚠️ [DSMON] Push error: ${err.message} — ${records.length} records retained for retry`);
    _scheduleRetry();
  }
}

/**
 * Start the periodic flush timer.
 * Also performs an immediate flush on start to catch any records that
 * were buffered while the runner was previously offline.
 */
export function startFlushTimer() {
  if (!TRACKING_ENABLED) {
    console.log(`📊 [DSMON] Tracking disabled — enable in Config Panel to activate`);
    return;
  }
  if (!PUSH_URL) return;
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
