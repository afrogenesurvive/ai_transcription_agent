/**
 * Tool Executor — calls the bridge server or external APIs
 *
 * ALL responses from third-party services (Gmail, Trello, Drive) are
 * sanitized via sanitizeApiResponse() before being returned to the runner.
 * This prevents credentials, tokens, or injection payloads from leaking.
 */

import "dotenv/config";
import { sanitizeApiResponse } from "./sanitize.js";

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:5010";

async function callBridge(tool, args) {
  const resp = await fetch(`${BRIDGE}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!resp.ok) throw new Error(`Bridge ${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

// ── Delivery handlers (direct API calls) ──

async function sendEmail(to, subject, body) {
  // Support both comma-separated string and array of recipients
  const recipients = Array.isArray(to)
    ? to
    : to
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const { google } = await import("googleapis");
  const { OAuth2Client } = await import("google-auth-library");
  const oauth = new OAuth2Client(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const full = body;

  const results = [];
  for (const recipient of recipients) {
    try {
      const email = [
        `From: ${process.env.GMAIL_USER || "me"}`,
        `To: ${recipient}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        full,
      ].join("\r\n");
      const res = await gmail.users.messages.send({
        userId: process.env.GMAIL_USER || "me",
        requestBody: { raw: Buffer.from(email).toString("base64url") },
      });
      results.push({ ok: true, recipient, id: res.data.id });
    } catch (err) {
      results.push({ ok: false, recipient, error: err.message });
    }
  }

  // Single recipient — backwards-compatible single result
  if (results.length === 1) {
    return { ok: true, tool: "send_delivery_email", result: sanitizeApiResponse({ id: results[0].id, to: results[0].recipient, subject }) };
  }
  // Multiple recipients — array in result, one recordDeliveryResult call per recipient
  return {
    ok: results.some((r) => r.ok),
    tool: "send_delivery_email",
    result: sanitizeApiResponse({
      recipients: results.map((r) => ({ email: r.recipient, success: r.ok, id: r.id || null, error: r.error || null })),
      subject,
    }),
  };
}

async function createTrelloCards(listId, items) {
  const cards = [];
  for (const item of items) {
    const desc = [item.description, item.assignee && `Assignee: ${item.assignee}`, item.deadline && `Deadline: ${item.deadline}`]
      .filter(Boolean)
      .join("\n");
    const url = `https://api.trello.com/1/lists/${listId}/cards?key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: (item.description || "Action Item").slice(0, 100), desc }),
    });
    if (resp.ok) cards.push(sanitizeApiResponse(await resp.json()));
  }
  const firstCardName = items.length > 0 ? (items[0].description || "").slice(0, 80) : "";
  return { ok: true, tool: "create_trello_action_items", result: sanitizeApiResponse({ cardsCreated: cards.length, listId, firstCardName }) };
}

async function saveToDrive(folder, title, summary) {
  const { google } = await import("googleapis");
  const { OAuth2Client } = await import("google-auth-library");
  const oauth = new OAuth2Client(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const drive = google.drive({ version: "v3", auth: oauth });

  const folderName = folder || "Meeting Transcripts";
  const search = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
  });
  let folderId = search.data.files?.[0]?.id;
  if (!folderId) {
    const created = await drive.files.create({ requestBody: { name: folderName, mimeType: "application/vnd.google-apps.folder" } });
    folderId = created.data.id;
  }

  const safe = title.replace(/[^a-zA-Z0-9 _-]/g, "");
  const doc = await drive.files.create({
    requestBody: { name: `${safe} — Summary`, mimeType: "application/vnd.google-apps.document", parents: [folderId] },
  });

  return {
    ok: true,
    tool: "save_to_drive",
    result: sanitizeApiResponse({ folderId, folderName, summaryDocId: doc.data.id }),
  };
}

// ── Handler registry ──

const HANDLERS = {
  transcribe_refine: (a) => callBridge("transcribe_refine", a),
  transcribe_analyze: (a) => callBridge("transcribe_analyze", a),
  transcribe_approve_delivery: (a) => callBridge("transcribe_approve_delivery", a),
  transcribe_get_transcript: (a) => callBridge("transcribe_get_transcript", a),
  transcribe_get_summary: (a) => callBridge("transcribe_get_summary", a),
  transcribe_summarize: (a) => callBridge("transcribe_summarize", a),
  transcribe_label_speaker: (a) => callBridge("transcribe_label_speaker", a),
  transcribe_list_voiceprints: () => callBridge("transcribe_list_voiceprints", {}),
  transcribe_prepare_delivery: (a) => callBridge("transcribe_prepare_delivery", a),
  transcribe_save_context: (a) => callBridge("transcribe_save_context", a),
  transcribe_save_ephemeral: (a) => callBridge("transcribe_save_ephemeral", a),
  transcribe_query_ephemeral: (a) => callBridge("transcribe_query_ephemeral", a),
  transcribe_search_memory: (a) => callBridge("transcribe_search_memory", a),
  transcribe_register_attendees: (a) => callBridge("transcribe_register_attendees", a),
  transcribe_list_attendees: (a) => callBridge("transcribe_list_attendees", a),
  transcribe_search_attendees: (a) => callBridge("transcribe_search_attendees", a),
  transcribe_upsert_job: (a) => callBridge("transcribe_upsert_job", a),
  transcribe_fail_job: (a) => callBridge("transcribe_fail_job", a),
  transcribe_complete_job: (a) => callBridge("transcribe_complete_job", a),
  send_delivery_email: (a) => sendEmail(a.to, a.subject, a.body),
  create_trello_action_items: (a) => createTrelloCards(a.listId, a.actionItems),
  save_to_drive: (a) => saveToDrive(a.folderName, a.title, a.summary),
};

export async function executeToolCall(toolName, args) {
  const handler = HANDLERS[toolName];
  if (!handler) return { ok: false, tool: toolName, error: `No handler for "${toolName}"` };
  console.log(`   🔧 [EXECUTOR] ${toolName}...`);
  try {
    const result = await handler(args || {});
    console.log(`   ✅ [EXECUTOR] ${toolName} succeeded`);
    return result;
  } catch (err) {
    console.error(`   ❌ [EXECUTOR] ${toolName} failed: ${err.message}`);
    return { ok: false, tool: toolName, error: err.message };
  }
}
