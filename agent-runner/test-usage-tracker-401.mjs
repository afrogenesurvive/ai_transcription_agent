/**
 * test-usage-tracker-401.mjs — DS-mon permanent-auth-failure behaviour.
 *
 * The DS-mon host is fail-closed and requires `Authorization: Bearer <token>` on
 * every route, so a 401 is a CONFIGURATION error that retrying can never fix. This
 * test pins the behaviour the handoff asked for:
 *
 *   1. a 401 pauses pushing, keeps every buffered record, and collects nothing new
 *      (so the buffer cannot reach MAX_BUFFER_BYTES and silently drop records);
 *   2. no record is dropped *because of* the 401;
 *   3. a later successful push replays the preserved buffer and clears the pause;
 *   4. a configured URL with NO token makes no request at all and pauses as
 *      `no-token`;
 *   5. the state is published to dsmon_status.json for the Config Panel.
 *
 * Usage: node test-usage-tracker-401.mjs      (exits non-zero on failure)
 *
 * Both cases load a FRESH copy of the module (`?case=`), because usage-tracker
 * reads its whole config from process.env at import time — which is also exactly
 * why the runner must be restarted after the token is changed in the Config Panel.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${label}\n      ${err.message}`);
  }
}

// ── A local stand-in for the DS-mon host ──
let mode = "401";
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ authorization: req.headers.authorization ?? null, url: req.url });
  if (mode === "401") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const makeStorage = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsmon-${tag}-`));

/** Import a fresh tracker instance configured from `env` (read at module load). */
async function loadTracker(tag, env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return await import(`./usage-tracker.js?case=${tag}`);
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const readStatusFile = (storage) => JSON.parse(fs.readFileSync(path.join(storage, "dsmon_status.json"), "utf8"));

// ─────────────────────────────────────────────────────────────────────────────
console.log("case 1 — a rejected token pauses and preserves the buffer");
const storageA = makeStorage("401");
const tracker = await loadTracker("401", {
  TRANSCRIPTION_STORAGE: storageA,
  USAGE_TRACKING_ENABLED: "true",
  DSMON_PUSH_INTERVAL: "60000",
  DSMON_PUSH_TOKEN: "wrong-token",
  DSMON_PUSH_URL: `http://127.0.0.1:${port}/sync/push`,
});

tracker.recordCall(USAGE, "deepseek-chat", 12, { step: 1, tool: "t" }, "deepseek");
let status = tracker.getDsmonStatus();
check("a healthy push config buffers a record", () => {
  assert.equal(status.bufferCount, 1);
  assert.equal(status.paused, false);
});

await tracker.flushBuffer();
status = tracker.getDsmonStatus();
check("the token is sent as a bearer header", () => {
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer wrong-token");
  assert.match(requests[0].url, /\/sync\/push$/);
});
check("401 is reported as unauthorized (not an HTTP blob)", () => {
  assert.equal(status.error, "unauthorized");
  assert.equal(status.ok, false);
});
check("401 pauses pushing", () => {
  assert.equal(status.paused, true);
  assert.equal(status.pauseReason, "unauthorized");
});
check("the buffered record is preserved", () => {
  assert.equal(status.bufferCount, 1);
  assert.equal(fs.readFileSync(path.join(storageA, "dsmon_buffer.jsonl"), "utf8").trim().split("\n").length, 1);
});

tracker.recordCall(USAGE, "deepseek-chat", 12, { step: 2, tool: "t" }, "deepseek");
status = tracker.getDsmonStatus();
check("no new records are collected while paused", () => {
  assert.equal(status.skippedWhilePaused, 1);
  assert.equal(status.bufferCount, 1);
});

await tracker.flushBuffer();
const attemptsBefore = requests.length;
await tracker.flushBuffer();
check("the interval tick retries the same buffer without draining or growing it", () => {
  assert.equal(requests.length, attemptsBefore + 1);
  const after = tracker.getDsmonStatus();
  assert.equal(after.bufferCount, 1);
  assert.equal(after.paused, true);
});
check("the paused state is published for the Config Panel", () => {
  const published = readStatusFile(storageA);
  assert.equal(published.paused, true);
  assert.equal(published.pauseReason, "unauthorized");
  assert.equal(published.bufferCount, 1);
});

// The operator fixes the token in the Config Panel and restarts the runner.
mode = "200";
const requestsBeforeRecovery = requests.length;
await tracker.flushBuffer();
status = tracker.getDsmonStatus();
check("a successful push replays the preserved buffer and clears the pause", () => {
  assert.ok(requests.length > requestsBeforeRecovery, "expected another push attempt");
  assert.equal(status.paused, false);
  assert.equal(status.pauseReason, null);
  assert.equal(status.error, null);
  assert.equal(status.bufferCount, 0);
  assert.equal(status.ok, true);
});
check("the recovered state is republished", () => {
  const published = readStatusFile(storageA);
  assert.equal(published.paused, false);
  assert.equal(published.bufferCount, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("case 2 — a push URL with no token makes no request at all");
mode = "401";
const storageB = makeStorage("no-token");
const requestsBefore = requests.length;
const trackerNoToken = await loadTracker("no-token", {
  TRANSCRIPTION_STORAGE: storageB,
  USAGE_TRACKING_ENABLED: "true",
  DSMON_PUSH_INTERVAL: "60000",
  DSMON_PUSH_TOKEN: "",
  DSMON_PUSH_URL: `http://127.0.0.1:${port}/sync/push`,
});

trackerNoToken.recordCall(USAGE, "deepseek-chat", 12, { step: 1, tool: "t" }, "deepseek");
await trackerNoToken.flushBuffer();
let statusB = trackerNoToken.getDsmonStatus();
check("pushing pauses with reason no-token", () => {
  assert.equal(statusB.paused, true);
  assert.equal(statusB.pauseReason, "no-token");
});
check("no HTTP request is attempted (the guard runs before the fetch)", () => {
  assert.equal(requests.length, requestsBefore);
});
check("the record stays buffered", () => {
  assert.equal(statusB.bufferCount, 1);
});

trackerNoToken.recordCall(USAGE, "deepseek-chat", 12, { step: 2, tool: "t" }, "deepseek");
statusB = trackerNoToken.getDsmonStatus();
check("collection stops while paused, and the state is published", () => {
  assert.equal(statusB.skippedWhilePaused, 1);
  const published = readStatusFile(storageB);
  assert.equal(published.paused, true);
  assert.equal(published.pauseReason, "no-token");
});

// ─────────────────────────────────────────────────────────────────────────────
server.close();
fs.rmSync(storageA, { recursive: true, force: true });
fs.rmSync(storageB, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll DS-mon 401 / no-token behaviour checks passed.");
// Explicit exit: a transient-failure path would leave a 60s retry timer pending,
// and this script must never hang a CI run.
process.exit(0);
