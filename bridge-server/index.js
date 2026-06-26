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

// ── Python API proxy ──

async function callPython(method, path, body = null) {
  const url = `${PYTHON_API}${path}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Python ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Tool dispatch ──

async function dispatch(tool, args) {
  switch (tool) {
    case "transcribe_upload":
      // For URL-based uploads only; file uploads use multipart directly
      return await callPython("POST", "/transcribe/upload_url", args);

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
  let body = "";
  if (req.method === "POST") {
    for await (const chunk of req) body += chunk;
  }

  try {
    let result;
    if (req.method === "POST" && url.pathname === "/tools/call") {
      const { tool, args } = JSON.parse(body);
      result = await dispatch(tool, args || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pythonApi: PYTHON_API }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.log(`[bridge] Listening on http://127.0.0.1:${BRIDGE_PORT}`);
  console.log(`[bridge] Proxying to Python backend at ${PYTHON_API}`);
});
