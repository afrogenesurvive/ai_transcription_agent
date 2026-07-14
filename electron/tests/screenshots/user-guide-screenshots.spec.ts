/**
 * User Guide Screenshot Generator
 *
 * Generates screenshots of the Transcription Agent Electron app for
 * documentation and the user guide.
 *
 * Prerequisites:
 *   1. Backend services running (Python :5001, Bridge :5010)
 *   2. App built: npm run electron:build
 *   3. An audio file exists at the path in AUDIO_FILE_PATH
 *
 * Usage:
 *   cd electron
 *   npx playwright test tests/screenshots/user-guide-screenshots.spec.ts
 *
 * Screenshots are saved to a timestamped subdirectory under docs/screenshots/
 * (e.g. docs/screenshots/2026-07-14/01-main-window-empty.png) AND copied to
 * the root docs/screenshots/ directory so the user guide always sees the
 * latest run. Previous runs remain accessible in their date-stamped folders.
 */

import { test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

// ════════════════════════════════════════════════════════════════
// CONFIGURATION — edit these before running
// ════════════════════════════════════════════════════════════════

/**
 * Test variable defaults — can be overridden via environment variables
 * (set by the DevPanel Testing tab which reads/writes config.json).
 *
 * When running from Dev Panel or with env vars set:
 *   PLAYWRIGHT_AUDIO_FILE_PATH
 *   PLAYWRIGHT_TITLE_TEMPLATE
 *   PLAYWRIGHT_DEFAULT_SPEAKER_NAME
 */

/** Absolute path to a short audio file for upload testing (MP3, WAV, etc.) */
const AUDIO_FILE_PATH = process.env.PLAYWRIGHT_AUDIO_FILE_PATH || "/Users/michaelgrandison/Downloads/test-meeting.mp3";

/** Meeting title template. {autoNum} will be replaced with the auto-incremented number */
const TITLE_TEMPLATE = process.env.PLAYWRIGHT_TITLE_TEMPLATE || "test {autoNum}";

/** Bridge server URL */
const BRIDGE_URL = "http://127.0.0.1:5010";

/** Default name to assign to unlabeled speakers during the labeling modal */
const DEFAULT_SPEAKER_NAME = process.env.PLAYWRIGHT_DEFAULT_SPEAKER_NAME || "dave";

// ════════════════════════════════════════════════════════════════

/** Root directory for guide screenshots (always shows the latest run) */
const SCREENSHOT_DIR_ROOT = path.resolve(__dirname, "../../docs/screenshots");

/**
 * Timestamped subdirectory for this run (e.g. docs/screenshots/2026-07-14).
 * Each run gets its own dated folder so prior runs are preserved.
 */
const SCREENSHOT_DIR = path.join(
  SCREENSHOT_DIR_ROOT,
  new Date().toISOString().slice(0, 10), // YYYY-MM-DD
);

let app: ElectronApplication;
let window: Page;

/**
 * Call a bridge tool and return the parsed JSON response.
 */
async function callBridge(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => `${res.status}`);
    throw new Error(`Bridge error (${res.status}): ${err}`);
  }
  return res.json();
}

/**
 * Fetch the first 2 registered attendees from the bridge.
 * Falls back to ["Alice", "Bob"] if none are registered.
 */
async function getFirstTwoAttendees(): Promise<string[]> {
  try {
    const data = await callBridge("transcribe_list_attendees", { limit: 100 });
    const attendees: string[] = (data.attendees || data.results || []).map((a: any) => a.name || "").filter(Boolean);
    return attendees.length >= 2 ? attendees.slice(0, 2) : ["Alice", "Bob"];
  } catch {
    return ["Alice", "Bob"];
  }
}

/**
 * Get the last job name from history and return the next auto-increment number.
 * Looks for numeric suffix (e.g. "Sprint Review 0011" → returns 12).
 * If no jobs or no match, starts at 1.
 */
async function getNextJobNumber(): Promise<number> {
  try {
    const data = await callBridge("transcribe_history", {});
    const jobs: Array<{ title: string; mtime: number }> = data.jobs || [];
    if (jobs.length === 0) return 1;

    // Sort by mtime descending, take the most recent
    jobs.sort((a, b) => b.mtime - a.mtime);
    const lastTitle = jobs[0].title;

    // Extract trailing numeric portion
    const match = lastTitle.match(/(\d+)$/);
    if (match) {
      return parseInt(match[1], 10) + 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * Upload an audio file by path (skipping analysis & delivery steps for speed).
 * Returns the job_id.
 */
async function uploadAudioByPath(filePath: string, title: string, attendees: string[]): Promise<string> {
  const result = await callBridge("transcribe_upload_by_path", {
    filePath,
    title,
    attendees,
    eventType: "internal",
    skipSteps: ["transcribe_analyze", "transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items"],
  });
  return result.job_id;
}

// ── Test hooks ──

test.beforeAll(async () => {
  // Launch the Electron app — point to the built main process
  app = await electron.launch({
    args: [path.resolve(__dirname, "../dist/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
    },
  });

  window = await app.firstWindow();
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterAll(async () => {
  await app.close();

  // Copy all screenshots from the timestamped subdirectory to the root
  // screenshots directory so the user guide's markdown links (which point
  // to e.g. screenshots/01-main-window-empty.png) always show the latest run.
  if (!fs.existsSync(SCREENSHOT_DIR_ROOT)) {
    fs.mkdirSync(SCREENSHOT_DIR_ROOT, { recursive: true });
  }

  try {
    const files = fs.readdirSync(SCREENSHOT_DIR);
    for (const file of files) {
      const src = path.join(SCREENSHOT_DIR, file);
      const dst = path.join(SCREENSHOT_DIR_ROOT, file);
      fs.copyFileSync(src, dst);
    }
    console.log(`[test] Copied ${files.length} screenshot(s) to ${SCREENSHOT_DIR_ROOT}`);
  } catch (err) {
    console.warn(`[test] Failed to sync screenshots to root: ${err}`);
  }
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 01: Main Window (Empty State)
// ════════════════════════════════════════════════════════════════
// Shows: The app just after launch — empty upload area, "No Active Job"
//        placeholder, sidebar with New/Current/History/Storage/Dev/Config/
//        Appearance/About buttons, and a status bar at the bottom.
// Guide section: "Getting Started — Understanding the Interface"
// Add to guide as: ![Main Window](screenshots/01-main-window-empty.png)
test("01 - main window (empty state)", async () => {
  await window.waitForSelector(".app");
  await window.waitForTimeout(1000); // let server status checks settle

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "01-main-window-empty.png"),
    fullPage: false,
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 02: Upload Panel with File Picker
// ════════════════════════════════════════════════════════════════
// Shows: The upload/drag-drop area with the "New" form open,
//        title field, attendee input, and skip-step checkboxes.
// Guide section: "Uploading Audio — How to Upload"
// Add to guide as: ![Upload Panel](screenshots/02-upload-panel.png)
test("02 - upload panel with file picker", async () => {
  // Click the "New" button in the sidebar to ensure we're on the upload view
  const newBtn = window.locator(".sidebar-btn", { hasText: "New" });
  await newBtn.click();
  await window.waitForSelector(".drop-zone");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "02-upload-panel.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 03: Configuration Panel — LLM Provider Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Config panel with the LLM Provider section visible —
//        API key fields for DeepSeek, Ollama settings, Hugging Face
//        token, Whisper model size selector.
// Guide section: "Settings & Configuration — LLM Provider Tab"
// Add to guide as: ![LLM Provider Settings](screenshots/03-config-panel.png)
test("03 - configuration panel", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "03-config-panel.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 04: Appearance Settings
// ════════════════════════════════════════════════════════════════
// Shows: Theme selector (dark/light), accent color picker, font size
//        slider, sidebar width adjustment.
// Guide section: "Settings & Configuration (sidebar)"
// Add to guide as: ![Appearance Settings](screenshots/04-appearance-settings.png)
test("04 - appearance settings", async () => {
  const appearanceBtn = window.locator(".sidebar-btn", { hasText: "Appearance" });
  await appearanceBtn.click();
  await window.waitForSelector(".appearance-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "04-appearance-settings.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 05: About Panel
// ════════════════════════════════════════════════════════════════
// Shows: App name, version number, and the full README content.
// Guide section: "Getting Started — Understanding the Interface (sidebar)"
// Add to guide as: ![About Panel](screenshots/05-about-panel.png)
test("05 - about panel", async () => {
  const aboutBtn = window.locator(".sidebar-btn", { hasText: "About" });
  await aboutBtn.click();
  await window.waitForSelector(".about-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "05-about-panel.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 06: Storage Panel
// ════════════════════════════════════════════════════════════════
// Shows: Disk usage breakdown with a stacked bar chart, per-category
//        sizes (History, Logs, ChromaDB, Databases, System, Ollama),
//        and the developer clear-actions section.
// Guide section: "Managing Past Meetings — Storage Management"
// Add to guide as: ![Storage Panel](screenshots/06-storage-panel.png)
test("06 - storage panel", async () => {
  const storageBtn = window.locator(".sidebar-btn", { hasText: "Storage" });
  await storageBtn.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "06-storage-panel.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 07: History Panel
// ════════════════════════════════════════════════════════════════
// Shows: List of past transcription jobs with status icons, titles,
//        dates, attendee names, and delete buttons.
// Guide section: "Managing Past Meetings — Viewing History"
// Add to guide as: ![History Panel](screenshots/07-history-panel.png)
test("07 - history panel", async () => {
  const historyBtn = window.locator(".sidebar-btn", { hasText: "History" });
  await historyBtn.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "07-history-panel.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 08: Dev Tools Panel
// ════════════════════════════════════════════════════════════════
// Shows: The developer tools panel — live log viewer, database browser,
//        performance metrics, and update section.
// Guide section: "Troubleshooting — Dev Tools"
// Add to guide as: ![Dev Tools](screenshots/08-dev-tools.png)
test("08 - dev tools panel", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "08-dev-tools.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 09: Config — Services Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Services section within Config panel — Gmail Client ID/
//        Secret/Refresh Token, Trello API Key/Token fields.
// Guide section: "Settings & Configuration — Services Tab"
// Add to guide as: ![Services Settings](screenshots/09-config-services.png)
test("09 - config services tab", async () => {
  // Navigate to Config panel first
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  // Click the "Services" section heading
  const servicesSection = window.locator("text=Services").first();
  await servicesSection.click();
  await window.waitForTimeout(300);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "09-config-services.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 10: Config — Agent Instructions Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Agent Instructions tab with the draggable pipeline-step
//        checklist, system prompt editor, and configuration JSON.
// Guide section: "Settings & Configuration — Agent Instructions Tab"
// Add to guide as: ![Agent Instructions](screenshots/10-config-agent.png)
test("10 - config agent instructions tab", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  // Click the "Agent" tab button
  const agentTab = window.locator(".config-tab", { hasText: "Agent" });
  if (await agentTab.isVisible()) {
    await agentTab.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "10-config-agent.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 11: Upload & Transcribe (Pipeline In Progress)
// ════════════════════════════════════════════════════════════════
// Shows: The 8-stage pipeline stepper with progress bar, current
//        active stage highlighted, and estimated completion.
//        This test uploads a real audio file and captures mid-flight.
// Guide section: "The Transcription Pipeline"
// Add to guide as: ![Pipeline Progress](screenshots/11-pipeline-progress.png)
test("11 - pipeline progress", async () => {
  // 1. Get auto-incremented title
  const nextNum = await getNextJobNumber();
  const title = TITLE_TEMPLATE.replace("{autoNum}", String(nextNum).padStart(4, "0"));

  // 2. Get first 2 registered attendees
  const attendees = await getFirstTwoAttendees();

  // 3. Upload via bridge
  const jobId = await uploadAudioByPath(AUDIO_FILE_PATH, title, attendees);
  console.log(`[test] Uploaded job ${jobId} with title "${title}", attendees: ${attendees.join(", ")}`);

  // 4. Navigate to "Current" view so PipelineProgress renders
  const currentBtn = window.locator(".sidebar-btn", { hasText: "Current" });
  await currentBtn.click();

  // 5. Wait for pipeline stepper to appear
  await window.waitForSelector(".pp-container", { timeout: 10_000 });

  // 6. Wait a moment for the status to update past "uploaded"
  await window.waitForTimeout(3000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "11-pipeline-progress.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 12: Speaker Labeling Modal (if pipeline pauses)
// ════════════════════════════════════════════════════════════════
// Shows: The speaker identification modal with audio clips and name
//        input fields for each detected speaker.
//        If the pipeline doesn't pause for labeling, this screenshot
//        is skipped with a warning.
// Guide section: "The Transcription Pipeline — Speaker Labeling"
// Add to guide as: ![Speaker Labeling](screenshots/12-speaker-labeling.png)
test("12 - speaker labeling modal", async () => {
  // Wait for the modal to appear (2 min timeout — diarization takes a while)
  const modal = window.locator(".speaker-label-modal");
  try {
    await modal.waitFor({ state: "visible", timeout: 120_000 });
  } catch {
    console.warn("[test] Speaker labeling modal did not appear — pipeline auto-labeled or too short");
    test.skip();
    return;
  }

  // Fill all speaker name inputs with the default name
  const nameInputs = modal.locator(".speaker-name-input");
  const inputCount = await nameInputs.count();
  for (let i = 0; i < inputCount; i++) {
    await nameInputs.nth(i).fill(DEFAULT_SPEAKER_NAME);
  }

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "12-speaker-labeling.png"),
  });

  // Confirm labels and resume pipeline
  const confirmBtn = modal.locator("button", { hasText: "Confirm" });
  if (await confirmBtn.isVisible()) {
    await confirmBtn.click();
    await window.waitForTimeout(1000);
  }
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 13: Completion Notification Toast
// ════════════════════════════════════════════════════════════════
// Shows: The in-app notification toast at the top of the screen
//        saying "Transcription Complete" (or failure message if job failed).
// Guide section: "The Transcription Pipeline" / "Troubleshooting"
// Add to guide as: ![Completion Notification](screenshots/13-notification.png)
test("13 - completion notification", async () => {
  // Wait for the notification toast to appear (up to 10 min for full pipeline)
  const notification = window.locator(".notification");
  try {
    await notification.waitFor({ state: "visible", timeout: 600_000 });
  } catch {
    console.warn("[test] No notification appeared — pipeline may still be running or timed out");
    test.skip();
    return;
  }

  await window.waitForTimeout(500); // let animation settle

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "13-notification.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 14: Results Viewer — Transcript Tab
// ════════════════════════════════════════════════════════════════
// Shows: The results viewer with the Transcript tab active —
//        color-coded speaker labels, timestamps, search bar.
// Guide section: "Reviewing Results — Transcript Tab"
// Add to guide as: ![Transcript View](screenshots/14-results-transcript.png)
test("14 - results viewer transcript", async () => {
  // Wait for the Transcript tab to be visible in the results viewer
  const transcriptTab = window.locator(".rv-tab", { hasText: "Transcript" });
  try {
    await transcriptTab.waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    console.warn("[test] Results viewer did not appear — job may not have completed");
    test.skip();
    return;
  }

  // Click the Transcript tab to ensure it's active
  await transcriptTab.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "14-results-transcript.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 15: Results Viewer — Summary Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Summary tab with executive summary, key decisions,
//        discussion points, and action items sections.
// Guide section: "Reviewing Results — Summary Tab"
// Add to guide as: ![Meeting Summary](screenshots/15-results-summary.png)
test("15 - results viewer summary", async () => {
  const summaryTab = window.locator(".rv-tab", { hasText: "Summary" });
  if (await summaryTab.isVisible()) {
    await summaryTab.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "15-results-summary.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 16: Results Viewer — Analysis Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Analysis tab with topics, sentiment, key entities,
//        meeting effectiveness, and follow-up items.
// Guide section: "Reviewing Results — Analysis Tab"
// Add to guide as: ![Meeting Analysis](screenshots/16-results-analysis.png)
test("16 - results viewer analysis", async () => {
  const analysisTab = window.locator(".rv-tab", { hasText: "Analysis" });
  if (await analysisTab.isVisible()) {
    await analysisTab.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "16-results-analysis.png"),
  });
});
