#!/usr/bin/env node

/**
 * Test Bot — Sequential Transcription Jobs Runner
 *
 * Runs 3 transcription jobs with the same audio but different attendee sets
 * using a progressive sliding window across the attendee list.
 * Automatically handles speaker labeling when the pipeline pauses.
 *
 * Usage:
 *   node scripts/test-bot.mjs
 *
 * Output: one job ID per line (stdout). Results visible in the app UI.
 * Log: appends to storage/test-bot-log.jsonl with testId, timestamp, jobIds.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ══════════════════════════════════════════════════════════════════════
//  CONFIG — Edit these values before running
// ══════════════════════════════════════════════════════════════════════

const CONFIG = {
  /** Absolute path to the audio file to use for all 3 jobs */
  audioPath: "/Users/michaelgrandison/Downloads/Transcription_test_audio/Best update ever from caller with four baby mamas.mp3",

  /** Base name for jobs — auto-incremented (#1, #2, #3) */
  baseJobName: "Bot Test Meeting",

  /** Bridge server URL */
  bridgeUrl: "http://127.0.0.1:5010",

  /** How often (ms) to poll job status */
  pollIntervalMs: 3000,

  /** Test attendee list — used as the pool for all 3 jobs */
  attendeeList: [
    { name: "Alice Johnson", email: "michael.grandison@gmail.com" },
    { name: "Bob Smith", email: "african.genetic.survival@gmail.com" },
    { name: "Charlie Brown", email: "mgrandison@smartterm.io" },
    { name: "Diana Prince", email: "stonedrone001@gmail.com" },
    { name: "Daniel Prince", email: "stonedrone002@gmail.com" },
  ],
};

// Steps to skip — skip analysis and delivery to keep test focused
const DEFAULT_SKIP_STEPS = [
  "save_to_drive",
  "create_trello_action_items",
];

// ══════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════

/** Call the bridge server's /tools/call endpoint */
async function callBridge(tool, args = {}) {
  const res = await fetch(`${CONFIG.bridgeUrl}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bridge ${tool} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Call the Python backend directly */
async function callPython(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:5001${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.error || parsed.message || text;
    } catch {}
    throw new Error(`Python ${method} ${path} failed (${res.status}): ${String(detail).slice(0, 200)}`);
  }
  return res.json();
}

/** Fetch job status */
async function pollStatus(jobId) {
  return callBridge("transcribe_status", { jobId });
}

/**
 * Wait for a job to reach a terminal state.
 * Returns the final status object.
 * If the job pauses for labeling, handles it automatically.
 */
async function waitForCompletion(jobId, nameOffset) {
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const startTime = Date.now();

  process.stderr.write(`\n[bot] Job ${jobId.slice(0, 8)} running...`);

  while (Date.now() - startTime < TIMEOUT_MS) {
    const status = await pollStatus(jobId);

    if (status.status === "complete" || status.status === "delivered") {
      process.stderr.write(" done\n");
      return { ...status, finalStatus: "success" };
    }

    if (status.status === "failed") {
      process.stderr.write(" failed\n");
      return { ...status, finalStatus: "failed" };
    }

    if (status.status === "paused_for_labeling") {
      const labelsApplied = await labelSpeakers(jobId, nameOffset);
      // Resume polling — pipeline will transition to "resuming" or "complete"
      process.stderr.write(`[bot]   Labeled ${labelsApplied} speaker(s)\n`);
      await sleep(CONFIG.pollIntervalMs);
      continue;
    }

    // Show progress dot for non-terminal status
    process.stderr.write(".");
    await sleep(CONFIG.pollIntervalMs);
  }

  // Timeout
  process.stderr.write(" timeout\n");

  // Timeout
  return { job_id: jobId, status: "timeout", finalStatus: "failed", error: "Timed out waiting for completion" };
}

/**
 * Label unknown speakers and resume the pipeline.
 * Returns the number of labels applied.
 */
async function labelSpeakers(jobId, nameOffset) {
  // Get speaker clips (available only when paused_for_labeling)
  const clips = await callBridge("transcribe_get_speaker_clips", { jobId });
  const { speakers = [], non_speaking_attendees = [] } = clips;

  if (speakers.length === 0) {
    // No unknown speakers — just resume
    await callBridge("transcribe_label_and_resume", { jobId, labels: [] });
    return 0;
  }

  // Build labels: use suggested_name if available, otherwise draw from attendeeList
  let offset = nameOffset;
  const labels = speakers.map((spk) => {
    let name = spk.suggested_name || "";
    let email = "";

    if (!name && offset < CONFIG.attendeeList.length) {
      // Draw the next available name from the pool
      const entry = CONFIG.attendeeList[offset];
      name = entry.name;
      email = entry.email || "";
      offset++;
    } else if (name) {
      // Look up email from attendeeList by name
      const entry = CONFIG.attendeeList.find((a) => a.name.toLowerCase() === name.toLowerCase());
      email = (entry && entry.email) || "";
    }

    return {
      speaker_id: spk.speaker_id,
      name,
      email,
    };
  });

  // Validate that all speakers got a name
  const unnamed = labels.filter((l) => !l.name);
  if (unnamed.length > 0) {
    console.error(`[bot] ⚠️  ${unnamed.length} speaker(s) have no name assigned — attendeeList may be too small`);
  }

  // Submit labels and resume
  await callBridge("transcribe_label_and_resume", { jobId, labels });
  return labels.length;
}

/** Determine which attendees to use for a given job index (0-based) */
function determineAttendees(jobIndex) {
  const list = CONFIG.attendeeList;
  switch (jobIndex) {
    case 0: // Job 1: first 2
      return list.slice(0, 2);
    case 1: // Job 2: first 2 + 3rd
      return list.slice(0, 3);
    case 2: // Job 3: middle 3 (indices 1,2,3)
      return list.slice(1, 4);
    default:
      return [];
  }
}

/** Generate a UUID v4 test ID */
function generateTestId() {
  return crypto.randomUUID();
}

/** Append a test run entry to the log file */
async function appendTestLog(testId, timestamp, jobIds) {
  const storageDir = process.env.TRANSCRIPTION_STORAGE || path.resolve(process.cwd(), "storage");
  const logPath = path.join(storageDir, "test-bot-log.jsonl");
  const entry = JSON.stringify({ testId, timestamp, jobIds }) + "\n";

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, entry, "utf-8");
    // Print nothing — silent logging as agreed
  } catch (err) {
    console.error(`[bot] ⚠️  Could not write test log: ${err.message}`);
  }
}

/** Sleep for ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════════════

async function main() {
  // Validate config
  if (!CONFIG.audioPath) {
    console.error("[bot] ❌ CONFIG.audioPath is not set. Edit the script and provide a path to an audio file.");
    process.exit(1);
  }
  if (CONFIG.attendeeList.length < 4) {
    console.error(`[bot] ❌ CONFIG.attendeeList needs at least 4 entries, got ${CONFIG.attendeeList.length}`);
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG.audioPath)) {
    console.error(`[bot] ❌ Audio file not found: ${CONFIG.audioPath}`);
    process.exit(1);
  }

  const testId = generateTestId();
  const timestamp = new Date().toISOString();
  const jobIds = [];

  // Run 3 sequential jobs
  for (let i = 0; i < 3; i++) {
    const attendees = determineAttendees(i);
    const attendeeEmails = attendees.map((a) => a.email || "");
    const attendeeNames = attendees.map((a) => a.name);
    const jobName = `${CONFIG.baseJobName} #${i + 1}`;

    try {
      // Upload the job
      const result = await callBridge("transcribe_upload_by_path", {
        filePath: CONFIG.audioPath,
        title: jobName,
        attendees: attendeeNames,
        attendeeEmails,
        skipSteps: DEFAULT_SKIP_STEPS,
      });

      const jobId = result.job_id;
      jobIds.push(jobId);

      // Print only the job ID (the only stdout output)
      console.log(jobId);

      // Wait for completion (handles labeling automatically)
      const finalStatus = await waitForCompletion(jobId, i * 2);

      if (finalStatus.finalStatus === "failed") {
        console.error(`[bot] ⚠️  Job #${i + 1} (${jobId}) failed: ${finalStatus.error || "Unknown error"} — continuing to next job`);
      }
    } catch (err) {
      console.error(`[bot] ⚠️  Job #${i + 1} encountered error: ${err.message} — continuing to next job`);
      jobIds.push(`error-${i + 1}`);
    }
  }

  // Write test log
  await appendTestLog(testId, timestamp, jobIds);
}

main().catch((err) => {
  console.error(`[bot] ❌ Fatal error: ${err.message}`);
  process.exit(1);
});
