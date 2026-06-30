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

const PYTHON_API = process.env.PYTHON_API_URL || "http://127.0.0.1:5001";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "5010", 10);

// ── Sanitize (Tier 1 — mandatory for all proxied responses) ──

const MAX_STRING_LENGTH = 2000;
const MAX_NESTING_DEPTH = 5;
const SENSITIVE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9]{20,})\b/g,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g,
  /<script[\s>][\s\S]*?<\/script\s*>/gi,
];

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
      result[k] = sanitizeValue(v, depth + 1);
    }
    return result;
  }
  return data;
}

// ── Python API proxy ──

async function callPython(method, path, body = null) {
  const url = `${PYTHON_API}${path}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);

  console.log(`[bridge]   → Python ${method} ${path}`);
  const startTime = Date.now();
  const resp = await fetch(url, opts);
  const data = await resp.json();
  const elapsed = Date.now() - startTime;
  if (!resp.ok) {
    console.error(`[bridge]   ← Python ${resp.status} (${elapsed}ms): ${JSON.stringify(data)}`);
    throw new Error(`Python ${resp.status}: ${JSON.stringify(data)}`);
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
        event_type: args.eventType || "internal",
      });

    case "transcribe_status":
      return await callPython("GET", `/transcribe/status/${args.jobId}`);

    case "transcribe_get_transcript":
      return await callPython("GET", `/transcribe/transcript/${args.jobId}?format=${args.format || "json"}`);

    case "transcribe_get_summary":
      return await callPython("GET", `/transcribe/summary/${args.jobId}`);

    case "transcribe_refine":
      return await callPython("POST", "/agent/refine", {
        job_id: args.jobId,
        transcript: args.transcript || [],
        rules: args.rules || [],
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

    case "transcribe_list_voiceprints":
      return await callPython("GET", "/agent/voiceprints");

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

    case "transcribe_get_audio":
      // Returns the audio stream URL — frontend constructs the URL directly
      return { url: `${PYTHON_API}/transcribe/audio/${args.jobId}` };

    case "transcribe_get_analysis":
      return await callPython("GET", `/transcribe/analysis/${args.jobId}`);

    case "transcribe_get_job_logs":
      return await callPython("GET", `/transcribe/job_logs/${args.jobId}?max_lines=${args.maxLines || 200}`);

    case "transcribe_get_job_files":
      return await callPython("GET", `/transcribe/job_files/${args.jobId}`);

    case "transcribe_cancel":
      return await callPython("POST", `/transcribe/cancel/${args.jobId}`);

    case "transcribe_models_status":
      return await callPython("GET", "/transcribe/models/status");

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
      result = sanitizeValue(await dispatch(tool, args || {}));
      const elapsed = Date.now() - startTime;
      console.log(`[bridge] ← ${tool} OK (${elapsed}ms)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname.startsWith("/transcribe/audio/")) {
      // Proxy audio file serving — pipe through for streaming
      const jobId = url.pathname.split("/").pop();
      console.log(`[bridge] → GET /transcribe/audio/${jobId} (proxying audio stream)`);
      const audioUrl = `${PYTHON_API}/transcribe/audio/${jobId}`;
      const audioResp = await fetch(audioUrl);
      if (!audioResp.ok) {
        res.writeHead(audioResp.status);
        res.end(JSON.stringify({ error: "Audio not found" }));
        return;
      }
      const contentType = audioResp.headers.get("content-type") || "audio/wav";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${jobId}.wav"`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
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
    } else {
      console.log(`[bridge] 404 ${req.method} ${url.pathname}`);
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (err) {
    console.error(`[bridge] Error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.log(`[bridge] Listening on http://127.0.0.1:${BRIDGE_PORT}`);
  console.log(`[bridge] Proxying to Python backend at ${PYTHON_API}`);
});
