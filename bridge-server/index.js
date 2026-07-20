#!/usr/bin/env node

/**
 * Bridge Server — REST API on port 5010
 *
 * The agent runner calls this server instead of talking to Python directly.
 * This server translates tool calls into HTTP requests to the Python backend.
 *
 * This keeps the agent runner purely Node.js and the Python backend isolated.
 */

import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_API = process.env.PYTHON_API_URL || "http://127.0.0.1:5001";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "5010", 10);
const ELECTRON_LOGS_DIR = process.env.ELECTRON_LOGS_DIR || null;
const TRANSCRIPTION_STORAGE = process.env.TRANSCRIPTION_STORAGE || null;

// Resolve agent-config directory (same logic as agent-runner/agent-config.js)
const CONFIG_DIR_CANDIDATES = [
  path.resolve(__dirname, "..", "agent-config"),
  path.resolve(__dirname, "..", "..", "agent-config"),
  path.resolve(__dirname, "agent-config"),
];
const AGENT_CONFIG_DIR = CONFIG_DIR_CANDIDATES.find((d) => fs.existsSync(d)) || path.resolve(__dirname, "..", "agent-config");

// ── Defaults backup directory ──
// On first startup, snapshot the shipped agent-config files so the user can
// restore original defaults if they've made edits that break the pipeline.
const DEFAULTS_DIR = path.join(AGENT_CONFIG_DIR, ".defaults");

function snapshotDefaults() {
  try {
    if (!fs.existsSync(AGENT_CONFIG_DIR)) return;
    fs.mkdirSync(DEFAULTS_DIR, { recursive: true });
    const files = ["tools.json", "pipeline.json", "system-prompt.md"];
    let snapshotNeeded = false;
    for (const f of files) {
      const src = path.join(AGENT_CONFIG_DIR, f);
      const dst = path.join(DEFAULTS_DIR, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        snapshotNeeded = true;
        break;
      }
    }
    if (!snapshotNeeded) {
      console.log(`[bridge] Defaults already snapshotted at ${DEFAULTS_DIR}`);
      return;
    }
    for (const f of files) {
      const src = path.join(AGENT_CONFIG_DIR, f);
      const dst = path.join(DEFAULTS_DIR, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log(`[bridge]   Snapshot: ${f}`);
      }
    }
    console.log(`[bridge] ✅ Default agent configs snapshotted to ${DEFAULTS_DIR}`);
  } catch (err) {
    console.error(`[bridge] ⚠️  Could not snapshot defaults: ${err.message}`);
  }
}
snapshotDefaults();

// ── Sanitize (Tier 1 — mandatory for all proxied responses) ──

const MAX_STRING_LENGTH = 100000;
const MAX_NESTING_DEPTH = 10;
const SENSITIVE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9]{20,})\b/g,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g,
  /<script[\s>][\s\S]*?<\/script\s*>/gi,
];

/** Keys redacted from API responses — never expose credentials. */
const REDACT_KEYS = new Set([
  "access_token",
  "refresh_token",
  "api_key",
  "secret",
  "password",
  "passwd",
  "token",
  "authorization",
  "auth",
  "credentials",
  "client_secret",
  "client_id",
  "private_key",
]);

function sanitizeValue(data, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) return "[truncated]";
  if (typeof data === "string") {
    let s = data.slice(0, MAX_STRING_LENGTH);
    for (const p of SENSITIVE_PATTERNS) s = s.replace(p, "[REDACTED]");
    return s;
  }
  if (typeof data === "number" || typeof data === "boolean" || data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.slice(0, 100).map((v) => sanitizeValue(v, depth + 1));
  if (typeof data === "object") {
    const result = {};
    for (const [k, v] of Object.entries(data).slice(0, 200)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        result[k] = "[REDACTED]";
        continue;
      }
      result[k] = sanitizeValue(v, depth + 1);
    }
    return result;
  }
  return data;
}

// ── Python API proxy ──

const FETCH_TIMEOUT_MS = parseInt(process.env.BRIDGE_FETCH_TIMEOUT || "30000", 10);

class PythonNetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "PythonNetworkError";
    this.statusCode = 502;
  }
}

async function callPython(method, path, body = null) {
  const url = `${PYTHON_API}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const opts = { method, headers: { "Content-Type": "application/json" }, signal: controller.signal };
  if (body) opts.body = JSON.stringify(body);

  console.log(`[bridge]   → Python ${method} ${path} (timeout: ${FETCH_TIMEOUT_MS}ms)`);
  const startTime = Date.now();
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (fetchErr) {
    clearTimeout(timeout);
    const elapsed = Date.now() - startTime;
    if (fetchErr.name === "AbortError") {
      console.error(`[bridge]   ← Python TIMEOUT after ${elapsed}ms`);
      throw new PythonNetworkError(`Python backend timed out after ${FETCH_TIMEOUT_MS}ms — ${method} ${path}`);
    }
    console.error(`[bridge]   ← Python NETWORK ERROR after ${elapsed}ms: ${fetchErr.message}`);
    throw new PythonNetworkError(`Python backend unreachable: ${fetchErr.message}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await resp.text();
  const elapsed = Date.now() - startTime;

  // Parse response — defensive in case it's an error page, not JSON
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!resp.ok) {
    console.error(`[bridge]   ← Python ${resp.status} (${elapsed}ms): ${JSON.stringify(data)}`);
    // Extract a clean message from Python's HTTPException body
    // Ensure detail is always a string — FastAPI validation errors return
    // data.detail as an array of objects, which would become "[object Object]"
    // if passed directly to new Error().
    const rawDetail = data.detail || data.error || data.message || JSON.stringify(data);
    const detail = typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
    const err = new Error(detail);
    err.statusCode = resp.status;
    throw err;
  }
  console.log(`[bridge]   ← Python ${resp.status} (${elapsed}ms)`);
  return data;
}

// ── Tool dispatch ──

async function dispatch(tool, args) {
  switch (tool) {
    case "transcribe_upload":
      // For URL-based uploads only; file uploads use multipart directly
      return await callPython("POST", "/transcribe/upload_url", args);

    case "transcribe_upload_by_path":
      return await callPython("POST", "/transcribe/upload_by_path", {
        file_path: args.filePath,
        title: args.title || "Untitled Meeting",
        attendees: args.attendees || [],
        attendee_emails: args.attendeeEmails || [],
        event_type: args.eventType || "internal",
        skip_steps: args.skipSteps || args.skip_steps || undefined,
      });

    case "transcribe_status":
      return await callPython("GET", `/transcribe/status/${args.jobId}`);

    case "transcribe_get_transcript":
      return await callPython("GET", `/transcribe/transcript/${args.jobId}?format=${args.format || "json"}`);

    case "transcribe_get_raw_transcript":
      return await callPython("GET", `/transcribe/raw_transcript/${args.jobId}`);

    case "transcribe_get_summary":
      return await callPython("GET", `/transcribe/summary/${args.jobId}`);

    case "transcribe_refine":
      return await callPython("POST", "/agent/refine", {
        job_id: args.jobId,
        transcript: args.transcript || [],
        rules: args.rules || [],
        keep_timestamps: args.keepTimestamps ?? process.env.KEEP_TRANSCRIPT_TIMESTAMPS !== "false",
      });

    case "transcribe_analyze":
      return await callPython("POST", "/agent/analyze", {
        job_id: args.jobId,
        analysis: args.analysis || {},
      });

    case "transcribe_summarize":
      return await callPython("POST", "/agent/summarize", {
        job_id: args.jobId,
        summary: args.summary || {},
      });

    case "transcribe_label_speaker":
      return await callPython("POST", "/agent/label_speakers", {
        job_id: args.jobId,
        labels: [{ speaker_id: args.speakerId, name: args.name, email: args.email || "" }],
      });

    case "transcribe_list_voiceprints": {
      const vpResult = await callPython("GET", "/agent/voiceprints");
      const vps = vpResult?.voiceprints || [];
      if (vps.length > 0) {
        console.log(`   🗣️ [BRIDGE] Voiceprints enrolled (${vps.length} total):`);
        for (const vp of vps) {
          console.log(`   🗣️ [BRIDGE]   - ${vp.name} (${vp.email || "no email"}) — enrolled ${vp.created_at || "?"}`);
        }
      } else {
        console.log(`   🗣️ [BRIDGE] No voiceprints enrolled`);
      }
      return vpResult;
    }

    case "transcribe_delete_voiceprint":
      return await callPython("DELETE", `/agent/voiceprints/${encodeURIComponent(args.email)}`);

    case "transcribe_get_voiceprint_sample":
      // Returns a URL to the sample audio endpoint (can't proxy binary through JSON)
      return { url: `http://127.0.0.1:${BRIDGE_PORT}/agent/voiceprints/sample/${encodeURIComponent(args.email)}` };

    case "transcribe_prepare_delivery":
      return await callPython("POST", "/agent/deliver", {
        job_id: args.jobId,
        title: args.title || "",
        attendees: args.attendees || [],
        destinations: args.destinations || [],
        email_recipients: args.emailRecipients || [],
      });

    case "transcribe_search_memory":
      return await callPython("POST", "/memory/search", {
        query: args.query,
        n_results: args.nResults || 5,
      });

    case "transcribe_save_ephemeral":
      return await callPython("POST", "/memory/ephemeral/save", {
        table: args.table || "notes",
        data: args.data || {},
      });

    case "transcribe_query_ephemeral":
      return await callPython("POST", "/memory/ephemeral/query", {
        table: args.table || "notes",
        query: args.query || "",
        limit: args.limit || 10,
      });

    case "transcribe_register_attendees":
      return await callPython("POST", "/memory/ephemeral/register_attendees", {
        names: args.names || [],
        emails: args.emails || [],
        source: args.source || "agent_labeling",
        job_id: args.jobId || "",
      });

    case "transcribe_list_attendees":
      return await callPython("GET", `/memory/ephemeral/list_attendees?limit=${args.limit || 100}`);

    case "transcribe_search_attendees":
      return await callPython("GET", `/memory/ephemeral/search_attendees?name=${encodeURIComponent(args.name || "")}&limit=${args.limit || 50}`);

    case "transcribe_save_context":
      return await callPython("POST", "/memory/save_context", {
        job_id: args.jobId,
        title: args.title || "",
        attendees: args.attendees || [],
        transcript_text: args.transcriptText || "",
        summary: args.summary || {},
        action_items: args.actionItems || [],
        budgets: args.budgets || [],
        decisions: args.decisions || [],
      });

    // ── Database browsing (read-only, for DevPanel) ──

    case "memory_ephemeral_tables":
      return await callPython("GET", "/memory/ephemeral/tables");

    case "memory_ephemeral_table":
      return await callPython("GET", `/memory/ephemeral/table/${args.tableName}?limit=${args.limit || 100}&offset=${args.offset || 0}`);

    case "memory_semantic_meetings":
      return await callPython("GET", "/memory/semantic/meetings");

    case "memory_semantic_stats":
      return await callPython("GET", "/memory/semantic/stats");

    case "memory_semantic_overlap":
      return await callPython("GET", "/memory/semantic/overlap");

    case "memory_semantic_search":
      return await callPython("GET", `/memory/semantic/search?query=${encodeURIComponent(args.query || "")}&n=${args.n || 5}`);

    case "transcribe_get_audio":
      // Returns the bridge-proxied audio URL (port 5010) so the frontend
      // gets the URL through the bridge, avoiding CORS issues with Python.
      return { url: `http://127.0.0.1:${BRIDGE_PORT}/transcribe/audio/${args.jobId}` };

    case "transcribe_get_analysis":
      return await callPython("GET", `/transcribe/analysis/${args.jobId}`);

    case "transcribe_get_job_attendees":
      return await callPython("GET", `/transcribe/attendees/${args.jobId}`);

    case "transcribe_get_delivery_results":
      return await callPython("GET", `/transcribe/delivery/${args.jobId}`);

    case "transcribe_get_speaker_clips":
      return await callPython("GET", `/transcribe/speaker_clips/${args.jobId}`);

    case "transcribe_label_and_resume": {
      try {
        const lrResult = await callPython("POST", `/transcribe/label_and_resume/${args.jobId}`, args.labels || []);
        if (lrResult?.voice_match_conflicts?.length) {
          console.warn(`[bridge] ⚠️  Voice match conflict(s) detected for job ${args.jobId?.slice(0, 8) || "?"}:`);
          for (const c of lrResult.voice_match_conflicts) {
            console.warn(
              `[bridge]   "${c.assigned_name}" (${c.speaker_id}) matches existing voiceprint "${c.matched_name}" (sim=${c.similarity?.toFixed(3) || "?"}) from job ${c.matched_sample_job_id?.slice(0, 8) || "?"}`,
            );
          }
        }
        return lrResult;
      } catch (err) {
        // Check if this is a voice match conflict (409 from Python)
        try {
          const parsed = JSON.parse(err.message);
          if (parsed?.error === "voice_match_conflict") {
            console.error(`[bridge] ❌ VOICE MATCH CONFLICT for job ${args.jobId?.slice(0, 8) || "?"}:`);
            for (const c of parsed.conflicts || []) {
              console.error(
                `[bridge]   "${c.assigned_name}" (${c.speaker_id}) ↔ "${c.matched_name}" (sim=${(c.similarity || 0).toFixed(3)}) from job ${(c.matched_sample_job_id || "?").slice(0, 8)}`,
              );
            }
            // Re-throw a clean error message for the caller
            throw new Error(parsed.message || "Voice match conflict — resolve and re-submit");
          }
        } catch (parseErr) {
          // Not a conflict error or parse failed — re-throw original
          if (parseErr instanceof Error && parseErr.message !== err.message) {
            // It's our re-throw above
            throw parseErr;
          }
        }
        throw err;
      }
    }

    case "transcribe_verify_labels":
      return await callPython("POST", `/agent/verify-labels`, args);

    case "transcribe_get_token_usage": {
      const usageResult = await callPython("GET", `/transcribe/usage/${args.jobId}`);
      if (usageResult?.totals) {
        console.log(`   [USAGE] Token usage fetched for job ${args.jobId?.slice(0, 8) || "?"}: ${usageResult.totals.total_tokens} total tokens`);
      }
      return usageResult;
    }
    case "transcribe_get_aggregate_usage": {
      const aggResult = await callPython("GET", "/transcribe/usage/aggregate");
      if (aggResult?.totals) {
        console.log(
          `   [USAGE] Aggregate token usage: ${aggResult.job_count} jobs, ${aggResult.totals.total_tokens} total tokens (${aggResult.totals.prompt_tokens} prompt + ${aggResult.totals.completion_tokens} completion)`,
        );
      }
      return aggResult;
    }

    case "transcribe_get_job_logs":
      return await callPython("GET", `/transcribe/job_logs/${args.jobId}?max_lines=${args.maxLines ?? 200}`);

    case "transcribe_get_job_files":
      return await callPython("GET", `/transcribe/job_files/${args.jobId}`);

    case "transcribe_get_pipeline_log": {
      const maxLines = args.maxLines ?? 500;
      const includeGlobal = args.includeGlobal === true ? "true" : "false";
      return await callPython("GET", `/transcribe/pipeline_log/${args.jobId}?max_lines=${maxLines}&include_global=${includeGlobal}`);
    }

    case "transcribe_cancel":
      try {
        return await callPython("POST", `/transcribe/cancel/${args.jobId}`);
      } catch (pyErr) {
        // Python backend may be down — fall back to writing status.json directly
        console.error(`[bridge] Python cancel failed (${pyErr.message}), trying direct write...`);
        if (TRANSCRIPTION_STORAGE) {
          const statusPath = path.join(TRANSCRIPTION_STORAGE, args.jobId, "status.json");
          if (fs.existsSync(statusPath)) {
            const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            status.status = "failed";
            status.error = `Cancelled by user (Python was unreachable: ${pyErr.message})`;
            status.progress = 0.0;
            fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
            console.log(`[bridge] ✅ Direct cancel write succeeded for ${args.jobId}`);
            return { job_id: args.jobId, status: "failed", cancelled: true, direct_write: true };
          }
        }
        // Re-throw if we can't fall back
        throw pyErr;
      }

    case "transcribe_get_job":
      return await callPython("GET", `/transcribe/job/${args.jobId}`);

    case "transcribe_upsert_job":
      // CamelCase keys from JS are mapped to snake_case by the Python endpoint
      return await callPython("POST", "/transcribe/job/upsert", args);

    case "transcribe_update_status":
      // Directly write a status update to status.json on disk (no Python dependency).
      // Used by the agent runner to set pending_delivery_review etc.
      try {
        const storage = TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");
        const statusPath = path.join(storage, args.jobId, "status.json");
        if (!fs.existsSync(statusPath)) {
          return { error: `Job ${args.jobId} not found` };
        }
        const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        const updates = args.updates || {};
        Object.assign(status, updates);
        // Atomic write
        const tmp = statusPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
        fs.renameSync(tmp, statusPath);
        console.log(`[bridge]   ✅ Status updated for ${args.jobId?.slice(0, 8)}: ${JSON.stringify(updates)}`);
        return { ok: true, job_id: args.jobId, updates };
      } catch (err) {
        console.error(`[bridge]   ❌ Failed to update status for ${args.jobId?.slice(0, 8)}: ${err.message}`);
        throw new Error(`Failed to update status: ${err.message}`);
      }

    case "transcribe_add_step_message":
      // Push a simplified step message to the job's live log (mini live log in UI).
      // Relays to the Python backend which maintains the step_messages array.
      return await callPython("POST", `/transcribe/step_message/${args.jobId}`, { message: args.message });

    case "transcribe_fail_job":
      return await callPython("POST", `/transcribe/fail/${args.jobId}?error=${encodeURIComponent(args.error || "Processing failed")}`);

    case "transcribe_complete_job":
      return await callPython("POST", `/transcribe/complete/${args.jobId}`);

    case "transcribe_active":
      return await callPython("GET", "/transcribe/active");

    case "transcribe_history":
      return await callPython("GET", "/transcribe/history");

    case "transcribe_models_status":
      return await callPython("GET", "/transcribe/models/status");

    case "storage_usage":
      return await callPython("GET", "/storage/usage");

    case "transcribe_delete_job":
      return await callPython("DELETE", `/transcribe/job/${args.jobId}`);

    case "storage_clear_logs":
      return await callPython("DELETE", `/storage/logs?log_type=${args.logType || "all"}`);

    case "storage_clear_jobs":
      return await callPython("DELETE", "/storage/jobs");

    case "storage_clear_semantic":
      return await callPython("DELETE", "/storage/semantic");

    case "storage_clear_ephemeral":
      return await callPython("DELETE", "/storage/ephemeral");

    case "storage_clear_all": {
      // Chain all four clear operations and aggregate results
      const results = {};
      const operations = [
        { key: "logs", method: "DELETE", url: `/storage/logs?log_type=${args.logType || "all_including_errors"}` },
        { key: "jobs", method: "DELETE", url: "/storage/jobs" },
        { key: "semantic", method: "DELETE", url: "/storage/semantic" },
        { key: "ephemeral", method: "DELETE", url: "/storage/ephemeral" },
      ];
      for (const op of operations) {
        try {
          await callPython(op.method, op.url);
          results[op.key] = { success: true };
        } catch (err) {
          results[op.key] = { success: false, error: err.message };
        }
      }
      const allOk = Object.values(results).every((r) => r.success);
      const failed = Object.keys(results).filter((k) => !results[k].success);
      return {
        success: allOk,
        message: allOk ? "All data cleared successfully" : `Cleared with failures: ${failed.join(", ")}`,
        results,
      };
    }

    // ── Approval Gate dispatches ──

    case "transcribe_approve_delivery":
      // This is handled by the agent-runner pipeline loop (saves state + pauses).
      // The bridge just confirms the tool is recognized.
      return { ok: true, tool: "transcribe_approve_delivery", note: "Pipeline will pause for user approval" };

    case "transcribe_approve_gate1":
      return await callPython("POST", `/transcribe/approve_gate1/${args.jobId}`, args);

    case "transcribe_approve_gate2":
      return await callPython("POST", `/transcribe/approve_gate2/${args.jobId}`, args);

    case "transcribe_get_delivery_review_state": {
      // Read delivery-review-state.json from disk
      const storage = TRANSCRIPTION_STORAGE || path.resolve(__dirname, "..", "storage");
      const statePath = path.join(storage, args.jobId, "delivery-review-state.json");
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        // Don't expose the full LLM context to the frontend — too large
        const { context, ...safeState } = state;
        return safeState;
      }
      return { error: "No delivery review state found" };
    }

    case "transcribe_save_summary":
      return await callPython("POST", `/transcribe/save_summary/${args.jobId}`, { summary: args.summary });

    case "transcribe_save_analysis":
      return await callPython("POST", `/transcribe/save_analysis/${args.jobId}`, { analysis: args.analysis });

    case "voiceprint_check_conflicts":
      return await callPython("POST", "/voiceprints/check-conflicts", { names: args.attendees || [] });

    case "attendees_check_conflicts":
      return await callPython("POST", "/attendees/check-conflicts", args.entries || []);

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${BRIDGE_PORT}`);

  // ── Multipart upload proxy ──
  // File uploads need to be proxied as raw binary (not JSON) to Python
  if (req.method === "POST" && url.pathname === "/transcribe/upload") {
    const contentType = req.headers["content-type"] || "multipart/form-data";
    console.log(`[bridge] → POST /transcribe/upload (multipart proxy)`);

    // Collect the raw binary body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);

    try {
      const pyResp = await fetch(`${PYTHON_API}/transcribe/upload`, {
        method: "POST",
        headers: { "Content-Type": contentType, "Content-Length": bodyBuffer.length.toString() },
        body: bodyBuffer,
      });

      const responseData = await pyResp.text();
      let parsed;
      try {
        parsed = JSON.parse(responseData);
      } catch {
        parsed = { error: responseData };
      }

      // Set CORS headers on the response
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(pyResp.ok ? 200 : pyResp.status);
      res.end(JSON.stringify(parsed));
      console.log(`[bridge] ← POST /transcribe/upload → ${pyResp.status}`);
    } catch (err) {
      console.error(`[bridge] Upload proxy error: ${err.message}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(502);
      res.end(JSON.stringify({ error: `Upload proxy failed: ${err.message}` }));
    }
    return;
  }

  let body = "";
  if (req.method === "POST") {
    for await (const chunk of req) body += chunk;
  }

  try {
    let result;
    if (req.method === "POST" && url.pathname === "/tools/call") {
      const { tool, args } = JSON.parse(body);
      const jobId = args?.jobId || args?.job_id || "?";
      console.log(`[bridge] → ${tool} (job=${jobId})`);
      const startTime = Date.now();
      // Skip sanitization for log endpoints — the content arrays need to be full
      const raw = await dispatch(tool, args || {});
      result = ["transcribe_get_pipeline_log", "transcribe_get_job_logs"].includes(tool) ? raw : sanitizeValue(raw);
      const elapsed = Date.now() - startTime;
      console.log(`[bridge] ← ${tool} OK (${elapsed}ms)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname.startsWith("/agent/voiceprints/sample/")) {
      // Proxy voiceprint sample audio — pipe through for streaming
      const email = decodeURIComponent(url.pathname.split("/").pop() || "");
      console.log(`[bridge] → GET /agent/voiceprints/sample/${email} (proxying voiceprint audio)`);
      const audioUrl = `${PYTHON_API}/agent/voiceprints/sample/${encodeURIComponent(email)}`;
      const audioResp = await fetch(audioUrl);
      if (!audioResp.ok) {
        const errBody = await audioResp.text().catch(() => "");
        console.error(`[bridge] ← GET /agent/voiceprints/sample → ${audioResp.status}: ${errBody.slice(0, 200)}`);
        res.writeHead(audioResp.status, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Voiceprint sample not found" }));
        return;
      }
      const contentType = audioResp.headers.get("content-type") || "audio/wav";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      const reader = audioResp.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch((err) => {
        console.error(`[bridge] Voiceprint audio stream error: ${err.message}`);
        res.end();
      });
    } else if (req.method === "GET" && url.pathname.startsWith("/transcribe/audio/")) {
      // Proxy audio file serving — pipe through for streaming
      const jobId = url.pathname.split("/").pop();
      console.log(`[bridge] → GET /transcribe/audio/${jobId} (proxying audio stream)`);

      // Forward Range header (for audio seeking) in a single fetch — avoids
      // double-fetching the entire file just to check existence.
      const rangeHeader = req.headers["range"];
      const audioUrl = `${PYTHON_API}/transcribe/audio/${jobId}`;
      const fetchOpts = {};
      if (rangeHeader) fetchOpts.headers = { Range: rangeHeader };

      const audioResp = await fetch(audioUrl, fetchOpts);
      if (!audioResp.ok) {
        const errBody = await audioResp.text().catch(() => "");
        console.error(`[bridge] ← GET /transcribe/audio/${jobId} → ${audioResp.status}: ${errBody.slice(0, 200)}`);
        res.writeHead(audioResp.status, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Audio not found" }));
        return;
      }

      const contentType = audioResp.headers.get("content-type") || "audio/wav";
      const contentLength = audioResp.headers.get("content-length");
      const contentRange = audioResp.headers.get("content-range");
      const statusCode = rangeHeader && audioResp.status === 206 ? 206 : 200;

      const responseHeaders = {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
        "Content-Disposition": `inline; filename="${jobId}.wav"`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      };
      if (contentLength) responseHeaders["Content-Length"] = contentLength;
      if (contentRange) responseHeaders["Content-Range"] = contentRange;

      res.writeHead(statusCode, responseHeaders);
      // Stream the audio data through
      const reader = audioResp.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch((err) => {
        console.error(`[bridge] Audio stream error: ${err.message}`);
        res.end();
      });
    } else if (req.method === "GET" && url.pathname === "/health") {
      console.log(`[bridge] GET /health`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pythonApi: PYTHON_API }));

      // ── Agent Config CRUD ──
    } else if (req.method === "GET" && url.pathname === "/agent/config") {
      console.log(`[bridge] GET /agent/config`);
      const toolsPath = path.join(AGENT_CONFIG_DIR, "tools.json");
      const pipelinePath = path.join(AGENT_CONFIG_DIR, "pipeline.json");
      const promptPath = path.join(AGENT_CONFIG_DIR, "system-prompt.md");
      const tools = fs.existsSync(toolsPath) ? JSON.parse(fs.readFileSync(toolsPath, "utf8")) : null;
      const pipeline = fs.existsSync(pipelinePath) ? JSON.parse(fs.readFileSync(pipelinePath, "utf8")) : null;
      const systemPrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools, pipeline, systemPrompt }));
    } else if (req.method === "POST" && url.pathname === "/agent/config") {
      console.log(`[bridge] POST /agent/config`);

      // ── Guard: reject if any pipeline stage is active ──
      // Agent config changes require a runner restart, which would interrupt
      // in-flight diarization, transcription, summarization, or delivery.
      // Check the Python backend for non-terminal jobs first.
      try {
        const activeResp = await fetch(`${PYTHON_API}/transcribe/active`, {
          signal: AbortSignal.timeout(3000),
        });
        if (activeResp.ok) {
          const activeData = await activeResp.json();
          const activeJobs = activeData.active_jobs || [];
          if (activeJobs.length > 0) {
            const jobList = activeJobs.map((j) => `"${j.title || j.job_id}" (${j.status})`).join(", ");
            console.log(`[bridge]   ⛔ Active jobs detected: ${jobList}`);
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Cannot edit agent instructions while jobs are running (${activeJobs.length} active: ${jobList}). Wait for all jobs to complete, then try again.`,
                active_jobs: activeJobs,
              }),
            );
            return;
          }
        }
      } catch {
        // If we can't reach Python, allow the write (the user may be fixing config)
        console.log(`[bridge]   ⚠️  Could not check active jobs — proceeding`);
      }

      try {
        const { tools, pipeline, systemPrompt } = JSON.parse(body);

        if (tools !== undefined) {
          const toolsPath = path.join(AGENT_CONFIG_DIR, "tools.json");
          fs.writeFileSync(toolsPath + ".tmp", JSON.stringify(tools, null, 2), "utf8");
          fs.renameSync(toolsPath + ".tmp", toolsPath);
          console.log(`[bridge]   tools.json written (${tools.length} tools)`);
        }
        if (pipeline !== undefined) {
          const pipelinePath = path.join(AGENT_CONFIG_DIR, "pipeline.json");
          fs.writeFileSync(pipelinePath + ".tmp", JSON.stringify(pipeline, null, 2), "utf8");
          fs.renameSync(pipelinePath + ".tmp", pipelinePath);
          console.log(`[bridge]   pipeline.json written`);
        }
        if (systemPrompt !== undefined) {
          const promptPath = path.join(AGENT_CONFIG_DIR, "system-prompt.md");
          fs.writeFileSync(promptPath + ".tmp", systemPrompt, "utf8");
          fs.renameSync(promptPath + ".tmp", promptPath);
          console.log(`[bridge]   system-prompt.md written`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            written: { tools: tools !== undefined, pipeline: pipeline !== undefined, systemPrompt: systemPrompt !== undefined },
          }),
        );
      } catch (err) {
        console.error(`[bridge] POST /agent/config error: ${err.message}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to write config: ${err.message}` }));
      }
    } else if (req.method === "POST" && url.pathname === "/agent/config/restart") {
      // Touch a restart-flag file so the Electron main process (or a watcher) can
      // detect that the agent runner needs to be restarted to pick up new config.
      console.log(`[bridge] POST /agent/config/restart`);
      try {
        const flagPath = path.join(AGENT_CONFIG_DIR, ".restart-flag");
        const restartPid = body ? JSON.parse(body).pid : null;
        const flag = JSON.stringify({ timestamp: new Date().toISOString(), pid: restartPid });
        fs.writeFileSync(flagPath, flag, "utf8");
        console.log(`[bridge]   .restart-flag written`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Agent runner restart flagged" }));
      } catch (err) {
        console.error(`[bridge] POST /agent/config/restart error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to flag restart: ${err.message}` }));
      }

      // ── Defaults: return the shipped defaults ──
    } else if (req.method === "GET" && url.pathname === "/agent/config/defaults") {
      console.log(`[bridge] GET /agent/config/defaults`);
      try {
        if (!fs.existsSync(DEFAULTS_DIR)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No defaults snapshot found — run a job first to generate defaults." }));
          return;
        }
        const toolsPath = path.join(DEFAULTS_DIR, "tools.json");
        const pipelinePath = path.join(DEFAULTS_DIR, "pipeline.json");
        const promptPath = path.join(DEFAULTS_DIR, "system-prompt.md");
        const tools = fs.existsSync(toolsPath) ? JSON.parse(fs.readFileSync(toolsPath, "utf8")) : null;
        const pipeline = fs.existsSync(pipelinePath) ? JSON.parse(fs.readFileSync(pipelinePath, "utf8")) : null;
        const systemPrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools, pipeline, systemPrompt }));
      } catch (err) {
        console.error(`[bridge] GET /agent/config/defaults error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to read defaults: ${err.message}` }));
      }

      // ── Restore defaults: overwrite current configs with shipped defaults ──
    } else if (req.method === "POST" && url.pathname === "/agent/config/restore-defaults") {
      console.log(`[bridge] POST /agent/config/restore-defaults`);
      try {
        if (!fs.existsSync(DEFAULTS_DIR)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No defaults snapshot found." }));
          return;
        }
        const files = ["tools.json", "pipeline.json", "system-prompt.md"];
        const written = [];
        for (const f of files) {
          const src = path.join(DEFAULTS_DIR, f);
          const dst = path.join(AGENT_CONFIG_DIR, f);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dst);
            written.push(f);
            console.log(`[bridge]   Restored: ${f}`);
          }
        }
        // Touch restart flag so the runner picks up the restored configs
        const flagPath = path.join(AGENT_CONFIG_DIR, ".restart-flag");
        fs.writeFileSync(flagPath, JSON.stringify({ timestamp: new Date().toISOString(), source: "restore-defaults" }), "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: true, restored: written, message: "Default agent configs restored. Restart the agent runner to apply changes." }),
        );
      } catch (err) {
        console.error(`[bridge] POST /agent/config/restore-defaults error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to restore defaults: ${err.message}` }));
      }
    } else {
      console.log(`[bridge] 404 ${req.method} ${url.pathname}`);
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (err) {
    const statusCode = err.statusCode || 500;
    // Guard against err.message being a non-string (e.g. array from FastAPI
    // validation), which would serialize as "[object Object]".
    const safeMsg = typeof err.message === "string" ? err.message : JSON.stringify(err.message);
    console.error(`[bridge] Error (${statusCode}): ${safeMsg}`);
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: safeMsg }));
  }
});

server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.log(`[bridge] Listening on http://127.0.0.1:${BRIDGE_PORT}`);
  console.log(`[bridge] Proxying to Python backend at ${PYTHON_API}`);
});
