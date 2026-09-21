/**
 * Usage Tracker — per-API-call usage buffer + push to DS-mon
 *
 * After each cloud LLM call (deepseek / openai / anthropic), captures token
 * usage data and buffers it locally in a JSONL file. Periodically flushes to
 * DS-mon's /sync/push endpoint for centralized per-machine usage monitoring
 * across multiple instances sharing the same API key. Ollama (local, no cost)
 * is intentionally excluded — its per-job totals still land in usage.json.
 *
 * The push URL is set statically via DSMON_PUSH_URL (e.g. a stable named-tunnel
 * URL). Offline-resilient: on a transient push failure, records are retained in
 * the buffer file and retried on the next cycle.
 *
 * Auth failures are NOT transient. The DS-mon host is fail-closed — it requires
 * `Authorization: Bearer <DSMON_PUSH_TOKEN>` on every route and refuses to serve
 * without a token — so a 401/403 is a configuration error that retrying can never
 * fix. On 401/403 (or a URL with no token at all) pushing PAUSES: buffered records
 * are kept for replay, new records are not collected (so the buffer can't reach
 * the cap and silently drop them), and the reason is logged once. A successful
 * push clears the pause. The current state is mirrored to
 * `<storage>/dsmon_status.json` for the Config Panel's status line.
 *
 * Config (env vars; DSMON_PUSH_TOKEN is required whenever DSMON_PUSH_URL is set):
 *   DSMON_PUSH_URL          — Static DS-mon push URL (e.g. https://<tunnel-id>.cfargotunnel.com/sync/push)
 *   DSMON_INSTANCE_ID       — Instance identifier (default: auto-generated)
 *   DSMON_PUSH_INTERVAL     — Flush interval in ms (default: 300000 = 5 min)
 *   DSMON_PUSH_TOKEN        — Shared bearer token REQUIRED by the DS-mon host's /sync/push endpoint
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { encryptEnvelope } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRACKING_ENABLED = process.env.USAGE_TRACKING_ENABLED === "true";
// Normalize the static URL so a bare host (e.g. https://<tunnel-id>.cfargotunnel.com)
// gets the /sync/push path.
let PUSH_URL = (process.env.DSMON_PUSH_URL || "").trim().replace(/\/+$/, "");
if (PUSH_URL && !/\/sync\/push$/i.test(PUSH_URL)) PUSH_URL += "/sync/push";
const PUSH_INTERVAL = parseInt(process.env.DSMON_PUSH_INTERVAL || "300000", 10);
const PUSH_TOKEN = process.env.DSMON_PUSH_TOKEN || "";
// Optional shared AES-256 key (base64url 32-byte) — when set, the push body is
// wrapped in an encryption envelope (see crypto.js). Matches DS-mon's
// afrogene/dsmon.key. Plaintext fallback when unset.
const ENCRYPTION_KEY = process.env.DSMON_ENCRYPTION_KEY || "";
const ENCRYPTION_KEY_ID = process.env.DSMON_ENCRYPTION_KEY_ID || "dsmon";
const STORAGE_BASE = process.env.TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");
const BUFFER_FILE = path.join(STORAGE_BASE, "dsmon_buffer.jsonl");
// Diagnostic log — persists every push outcome so failures are visible even
// when no job is active (the main-process logger only writes to a job's
// pipeline.log while a job is running).
const LOG_FILE = path.join(STORAGE_BASE, "dsmon.log");
// Push-status snapshot — read by the Config Panel (main process → `dsmon:push-status`)
// so a paused / failing push is visible where the operator already looks.
const STATUS_FILE = path.join(STORAGE_BASE, "dsmon_status.json");
// Cap the buffer so a permanently-unreachable DS-mon host can't grow it forever.
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const PUSH_TIMEOUT_MS = 30000; // 30s (was 15s — a slow tunnel can exceed 15s)

// Last-push status (for UI/telemetry visibility via getDsmonStatus).
let lastPush = { at: null, ok: null, count: 0, error: null };
let retryTimer = null;
// Paused = pushing has stopped on a permanent (auth) error. Sticky until a push
// succeeds, so a bad token can never drain — or silently drop — the buffer.
// `null` while healthy; "no-token" | "unauthorized" otherwise.
let pushPaused = false;
let pushPausedReason = null;
// De-duplicates the pause log line (once per transition, not per flush cycle).
let lastLoggedPauseKey = null;
// Records not collected because pushing was paused (surfaced in the status line).
let skippedWhilePaused = 0;

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
  return { ...lastPush, bufferBytes, bufferCount, paused: pushPaused, pauseReason: pushPausedReason, skippedWhilePaused };
}

/**
 * Persist the status snapshot for the UI. Written atomically (tmp + rename) so
 * the main process can never read a half-written file.
 */
function _writeStatus() {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    const tmp = `${STATUS_FILE}.tmp`;
    const snapshot = {
      ...getDsmonStatus(),
      instanceId: INSTANCE_ID,
      pushUrl: PUSH_URL,
      trackingEnabled: TRACKING_ENABLED,
      writtenAt: Date.now(),
    };
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(tmp, STATUS_FILE);
  } catch {
    // Non-fatal — diagnostics only
  }
}

/**
 * Enter (or refresh) the paused state. Sticky: only a successful push clears it.
 * The reason is logged once per transition rather than on every flush cycle.
 *
 * @param {string} reason - "no-token" | "unauthorized"
 * @param {string} detail - Human-readable cause, including the exact value to fix
 */
function _setPaused(reason, detail) {
  pushPaused = true;
  pushPausedReason = reason;
  const key = `${reason}:${detail}`;
  if (key !== lastLoggedPauseKey) {
    lastLoggedPauseKey = key;
    const cause = reason === "unauthorized" ? "push token missing/invalid" : detail;
    _log(
      `⛔ [DSMON] ${cause} — tracking paused (fix DSMON_PUSH_TOKEN) — buffered records preserved, new records not collected`,
    );
  }
  _writeStatus();
}

/** Clear the paused state after a successful push, so the buffer replays. */
function _clearPaused() {
  const wasPaused = pushPaused;
  pushPaused = false;
  pushPausedReason = null;
  lastLoggedPauseKey = null;
  skippedWhilePaused = 0;
  if (wasPaused) _log(`📊 [DSMON] Pushing resumed — paused state cleared`);
  _writeStatus();
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
 * @param {string} providerId - "deepseek" | "openai" | "anthropic" (defaults to env LLM_PROVIDER)
 */
export function recordCall(usage, model, latencyMs, stepInfo, providerId) {
  // Master switch — no collection unless USAGE_TRACKING_ENABLED=true.
  // (recordCall used to be gated only on PUSH_URL, so records were still
  // buffered while tracking was disabled whenever a push URL was configured.)
  if (!TRACKING_ENABLED) return;
  if (!PUSH_URL) return;

  // While paused (missing or rejected push token) new records are NOT collected:
  // that keeps the buffer away from MAX_BUFFER_BYTES so the drop path below can
  // never be reached because of an auth problem. The skipped count is surfaced in
  // the status snapshot, so nothing is silently invisible.
  if (pushPaused) {
    skippedWhilePaused += 1;
    return;
  }

  // Normalize the provider id (env LLM_PROVIDER is deepseek|openai|anthropic|ollama).
  const pid = (providerId || process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  // Endpoint reflects the actual upstream API shape DS-mon's UsageLogger parses:
  // chat-completions shape for deepseek/openai, Messages API for anthropic.
  const endpoint = pid === "anthropic" ? "/v1/messages" : "/v1/chat/completions";

  const record = {
    uuid: crypto.randomUUID(),
    timestamp: Date.now() / 1000,
    providerId: pid,
    model: model || "unknown",
    endpoint,
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
      _log(`⚠️ [DSMON] Buffer exceeds ${MAX_BUFFER_BYTES} bytes — dropping record (DS-mon unreachable for an extended period; see dsmon.log)`);
      return;
    }
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    _log(`⚠️ [DSMON] Failed to buffer usage record: ${err.message}`);
  }
}

/**
 * Flush buffered records to DS-mon's /sync/push endpoint.
 * On success (HTTP 200), truncates the buffer file and clears any pause.
 * On a transient failure, leaves records intact for retry on the next cycle.
 * On a permanent (auth) failure, PAUSES — records are kept, no retry is
 * scheduled, and collection stops until the token is fixed.
 */
export async function flushBuffer() {
  // Master switch — never push while tracking is disabled.
  if (!TRACKING_ENABLED) return;
  if (!PUSH_URL) return;

  // Fail-closed config guard: the hardened DS-mon host requires the bearer token on
  // every route and refuses to serve without one, so a request sent without a token
  // can only ever come back 401. Pause instead of pushing — buffered records are
  // preserved and nothing new is collected until DSMON_PUSH_TOKEN is configured.
  if (!PUSH_TOKEN) {
    _setPaused("no-token", "DSMON_PUSH_URL is set but DSMON_PUSH_TOKEN is empty");
    return;
  }

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
    // Every route on the hardened DS-mon host requires the bearer token, so this
    // is unconditional (a missing token is handled by the fail-closed guard above).
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${PUSH_TOKEN}` };
    // Encrypt the whole batch when a shared AES key is configured (envelope).
    const body = ENCRYPTION_KEY ? JSON.stringify(encryptEnvelope(ENCRYPTION_KEY_ID, ENCRYPTION_KEY, records)) : JSON.stringify(records);
    const resp = await fetch(PUSH_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    if (resp.ok) {
      // Truncate the buffer — write empty string (not unlink) to avoid
      // race conditions with concurrent recordCall() appends
      fs.writeFileSync(BUFFER_FILE, "", "utf8");
      lastPush = { at: Date.now(), ok: true, count: records.length, error: null };
      _log(`📊 [DSMON] Pushed ${records.length} usage records to ${PUSH_URL}`);
      // A good push clears any pause (e.g. the token was corrected on the host),
      // which is what replays the records preserved during the paused window.
      _clearPaused();
    } else if (resp.status === 401 || resp.status === 403) {
      // PERMANENT. Retrying cannot fix a rejected or missing token, so don't
      // schedule a retry: the buffer keeps its records and the next interval tick
      // (or a runner restart after fixing DSMON_PUSH_TOKEN) drains them.
      await resp.text().catch(() => "");
      lastPush = { at: Date.now(), ok: false, count: records.length, error: "unauthorized" };
      _setPaused("unauthorized", `DS-mon rejected the push token (HTTP ${resp.status})`);
    } else {
      const text = await resp.text().catch(() => "");
      lastPush = { at: Date.now(), ok: false, count: records.length, error: `HTTP ${resp.status} ${text.slice(0, 100)}` };
      _log(`⚠️ [DSMON] Push failed: HTTP ${resp.status} ${text.slice(0, 100)} — ${records.length} records retained`);
      _writeStatus();
      _scheduleRetry();
    }
  } catch (err) {
    lastPush = { at: Date.now(), ok: false, count: records.length, error: err.message };
    _log(`⚠️ [DSMON] Push error: ${err.message} — ${records.length} records retained for retry`);
    _writeStatus();
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

  // Publish a snapshot even when there was nothing to flush (a healthy runner with
  // no buffered records), so the Config Panel's status line always has a state to
  // render instead of reporting "no status".
  _writeStatus();

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
