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
 *
 * Coverage (33 screenshots): main window, upload, appearance, about, storage,
 * history, config (LLM & Delivery sections, Agent, Logging), pipeline progress,
 * speaker labeling, completion notification, results (Transcript/Summary/
 * Analysis/Attendees/Delivery/Audio/Developer), and Dev Tools (Live Logs,
 * Database, Performance, Usage, Log Files, Updates, Testing, Guide).
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
 *   PLAYWRIGHT_GENERIC_NAMES
 */

/** Absolute path to a short audio file for upload testing (MP3, WAV, etc.) */
const AUDIO_FILE_PATH =
  process.env.PLAYWRIGHT_AUDIO_FILE_PATH ||
  "/Users/michaelgrandison/Downloads/Transcription_test_audio/Best update ever from caller with four baby mamas.mp3";

/** Meeting title template. {autoNum} will be replaced with the auto-incremented number */
const TITLE_TEMPLATE = process.env.PLAYWRIGHT_TITLE_TEMPLATE || "test {autoNum}";

/** Bridge server URL */
const BRIDGE_URL = "http://127.0.0.1:5010";

/**
 * Generic speaker names used during the labeling modal.
 * Read from PLAYWRIGHT_GENERIC_NAMES env var (comma-separated, set by the
 * DevPanel Testing tab from config.json). Must contain at least 20 names.
 * Falls back to the default 20 if the env var is unset.
 */
const GENERIC_NAMES = (
  process.env.PLAYWRIGHT_GENERIC_NAMES ||
  "Alex,Blake,Casey,Drew,Ellis,Finley,Gray,Harper,Indigo,Jade,Kai,Logan,Morgan,Nico,Oakley,Parker,Quinn,Reese,Skyler,Taylor"
)
  .split(",")
  .map((s) => s.trim());

// ════════════════════════════════════════════════════════════════

/** Attendee entry with name and required email. */
interface AttendeeEntry {
  name: string;
  email: string;
}

/** Root directory for guide screenshots (always shows the latest run) */
const SCREENSHOT_DIR_ROOT = path.resolve(__dirname, "../../../docs/screenshots");

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
 * Fetch the first 2 registered attendees from the bridge with their emails.
 * Falls back to default entries if none are registered.
 */
async function getFirstTwoAttendees(): Promise<AttendeeEntry[]> {
  try {
    const data = await callBridge("transcribe_list_attendees", { limit: 100 });
    const attendees: AttendeeEntry[] = (data.attendees || data.results || [])
      .map((a: any) => ({ name: a.name || "", email: a.email || "" }))
      .filter((a: AttendeeEntry) => a.name);
    if (attendees.length >= 2) return attendees.slice(0, 2);
    return [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ];
  } catch {
    return [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ];
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
async function uploadAudioByPath(filePath: string, title: string, attendeeEntries: AttendeeEntry[]): Promise<string> {
  const result = await callBridge("transcribe_upload_by_path", {
    filePath,
    title,
    attendees: attendeeEntries.map((a) => a.name),
    attendeeEmails: attendeeEntries.map((a) => a.email),
    eventType: "internal",
    skipSteps: ["transcribe_analyze", "transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items"],
  });
  return result.job_id;
}

// ── Test hooks ──

test.beforeAll(async () => {
  // Launch the Electron app — point to the built main process
  app = await electron.launch({
    args: [path.resolve(__dirname, "../../dist/main/index.js")],
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
// Shows: The app just after launch — "No Active Job" placeholder,
//        sidebar with all 8 buttons (New, Current, History, Storage,
//        Dev, Config, Appearance, About), and the status bar at the
//        bottom showing service health dots and controls.
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
// SCREENSHOT 03: Configuration Panel — LLM Provider Section
// ════════════════════════════════════════════════════════════════
// Shows: The Config tab with the LLM Provider section visible —
//        API/Ollama radio buttons, nested DeepSeek/OpenAI/Anthropic
//        selector, API key + model fields, Hugging Face token, Whisper
//        model size selector, temperature, pipeline timeout, and
//        keep-models-warm toggle.
// Guide section: "Settings & Configuration — Config Tab — LLM Provider Section"
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
// Shows: Theme selector (dark/light/system), 8 accent color presets
//        + custom color picker, font size presets (small/medium/large/
//        extra large), sidebar width control.
// Guide section: "Appearance Settings"
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
// Shows: Disk usage breakdown with 6 categories (History, Logs,
//        ChromaDB, Databases, System, Ollama), per-category sizes
//        with file paths, and the collapsible developer clear-actions
//        section for deleting logs, history, databases, and models.
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
// Shows: Left-column list of past transcription jobs with status
//        icons, titles, relative timestamps, attendee names,
//        expandable pipeline detail (▼), and delete buttons (🗑️).
//        The right column shows the selected job's results.
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
// SCREENSHOT 08: Dev Tools Panel — Live Logs
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools panel with the Live Logs tab active — source
//        filter, level filter, sub-source filter, search, auto-scroll
//        toggle, and real-time log entries with color-coded sources.
// Guide section: "Dev Tools — Live Logs Tab"
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
// SCREENSHOT 09: Config — Services Section
// ════════════════════════════════════════════════════════════════
// Shows: The Services section within the Config tab — Gmail OAuth
//        credentials (Client ID/Secret/Refresh Token/User Email) and
//        Trello API Key/Token in collapsible accordions.
// Guide section: "Settings & Configuration — Config Tab — Services Section"
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
// SCREENSHOT 10: Config — Agent Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Agent tab with the draggable pipeline-step checklist
//        (enable/disable toggles, drag handles, expand buttons),
//        context window slider, max steps/retries/delay fields.
// Guide section: "Settings & Configuration — Agent Tab"
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
// Shows: The pipeline progress tracker with progress bar, 11-stage
//        vertical stepper (Uploading → Getting Ready → Identifying
//        Speakers → Matching Voices → Transcribing Speech → Building
//        Transcript → Review Transcript → AI Processing → Saving to
//        Memory → Review Deliverable → Delivering Results), Mini Live
//        Log at the bottom, and Stop Processing button.
//        This test uploads a real audio file and captures mid-flight.
// Guide section: "The Transcription Pipeline"
// Add to guide as: ![Pipeline Progress](screenshots/11-pipeline-progress.png)
test("11 - pipeline progress", async () => {
  // 1. Get auto-incremented title
  const nextNum = await getNextJobNumber();
  const title = TITLE_TEMPLATE.replace("{autoNum}", String(nextNum).padStart(4, "0"));

  // 2. Get first 2 registered attendees (name + email pairs)
  const attendeeEntries = await getFirstTwoAttendees();
  const attendeeNames = attendeeEntries.map((a) => a.name);

  // 3. Upload via bridge (passes attendeeEmails separately)
  const jobId = await uploadAudioByPath(AUDIO_FILE_PATH, title, attendeeEntries);
  console.log(`[test] Uploaded job ${jobId} with title "${title}", attendees: ${attendeeNames.join(", ")}`);

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
// Shows: The speaker identification modal with audio clips (play
//        button per speaker), name input fields, email input fields
//        (validated), and non-speaking attendee list. Conflict
//        detection banner may appear if voiceprints exist.
//        If the pipeline doesn't pause for labeling, this screenshot
//        is skipped with a warning.
// Guide section: "The Transcription Pipeline — Matching Voices (Step 4)"
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

  // Fill each speaker name and email input. Email is required for every speaker.
  const nameInputs = modal.locator(".speaker-name-input");
  const emailInputs = modal.locator(".speaker-email-input");
  const inputCount = await nameInputs.count();
  for (let i = 0; i < inputCount; i++) {
    const name = GENERIC_NAMES[i % GENERIC_NAMES.length];
    await nameInputs.nth(i).fill(name);
    // Generate email from the name (lowercased)
    await emailInputs.nth(i).fill(`${name.toLowerCase()}@example.com`);
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
//        saying "Transcription Complete" (or failure message if job
//        failed), with a dismiss (✕) button.
// Guide section: "Notifications — In-App Notification Toasts"
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
//        color-coded speaker badges, timestamps (clickable to jump
//        to audio), text search bar with match count, segment list.
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
//        discussion points, checkable action items, and export
//        buttons (PDF/Word) + Edit button in toolbar.
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
// Shows: The Analysis tab with topics (shown as tags), sentiment
//        description, key entities list, meeting effectiveness,
//        follow-ups, and export buttons + Edit button in toolbar.
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

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 17: Results Viewer — Attendees Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Attendees tab with summary cards (total/voiceprint-
//        matched/registered-only), attendee cards with avatar, name,
//        email, voiceprint status badge, play button for samples,
//        export buttons in toolbar.
// Guide section: "Reviewing Results — Attendees Tab"
// Add to guide as: ![Meeting Attendees](screenshots/17-results-attendees.png)
test("17 - results viewer attendees", async () => {
  const attendeesTab = window.locator(".rv-tab", { hasText: "Attendees" });
  try {
    await attendeesTab.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    console.warn("[test] Attendees tab did not appear — results viewer may not be loaded");
    test.skip();
    return;
  }

  await attendeesTab.click();

  // Wait for attendee content to load (not the loading spinner)
  try {
    await window.waitForFunction(
      () => {
        const el = document.querySelector(".rv-tab-content--attendees");
        if (!el) return false;
        // Ensure at least one attendee row or the empty state is rendered
        return (
          el.querySelector(".rv-attendee-section") !== null ||
          el.querySelector(".rv-tokens-card-value") !== null ||
          el.textContent?.includes("No attendees")
        );
      },
      { timeout: 15_000 },
    );
  } catch {
    console.warn("[test] Attendees content did not load in time — taking screenshot anyway");
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "17-results-attendees.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 18: Results Viewer — Delivery Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Delivery tab with summary cards (total/succeeded/failed),
//        per-delivery cards with method icon, success/failure badge,
//        expandable result details, and timestamps.
// Guide section: "Reviewing Results — Delivery Tab"
// Add to guide as: ![Delivery Results](screenshots/18-results-delivery.png)
test("18 - results viewer delivery", async () => {
  const deliveryTab = window.locator(".rv-tab", { hasText: "Delivery" });
  try {
    await deliveryTab.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    console.warn("[test] Delivery tab did not appear — delivery steps were skipped");
    test.skip();
    return;
  }

  await deliveryTab.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "18-results-delivery.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 22: Results Viewer — Audio Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Audio tab with the meeting recording player — play/
//        pause button, seek bar, elapsed/total time, and volume.
// Guide section: "Reviewing Results — Audio Tab"
// Add to guide as: ![Audio Player](screenshots/22-results-audio.png)
test("22 - results viewer audio", async () => {
  const audioTab = window.locator(".rv-tab", { hasText: "Audio" });
  try {
    await audioTab.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    console.warn("[test] Audio tab did not appear — results viewer may not be loaded");
    test.skip();
    return;
  }

  await audioTab.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "22-results-audio.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 23: Results Viewer — Developer Tab (Tokens)
// ════════════════════════════════════════════════════════════════
// Shows: The Developer tab with the Tokens sub-tab active — LLM
//        token usage breakdown per pipeline step (prompt/completion
//        counts and costs).
// Guide section: "Reviewing Results — Developer Tab — Tokens"
// Add to guide as: ![Developer Tokens](screenshots/23-results-developer-tokens.png)
test("23 - results viewer developer tokens", async () => {
  const devTab = window.locator(".rv-tab", { hasText: "Developer" });
  try {
    await devTab.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    console.warn("[test] Developer tab did not appear — results viewer may not be loaded");
    test.skip();
    return;
  }

  await devTab.click();
  await window.waitForTimeout(300);

  const tokensSub = window.locator(".rv-dev-subtab", { hasText: "Tokens" });
  if (await tokensSub.isVisible()) {
    await tokensSub.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "23-results-developer-tokens.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 24: Results Viewer — Developer Tab (Performance)
// ════════════════════════════════════════════════════════════════
// Shows: The Developer tab with the Performance sub-tab active —
//        per-stage timings, elapsed duration, and pipeline metrics.
// Guide section: "Reviewing Results — Developer Tab — Performance"
// Add to guide as: ![Developer Performance](screenshots/24-results-developer-performance.png)
test("24 - results viewer developer performance", async () => {
  const devTab = window.locator(".rv-tab", { hasText: "Developer" });
  if (await devTab.isVisible()) {
    await devTab.click();
  }
  await window.waitForTimeout(300);

  const perfSub = window.locator(".rv-dev-subtab", { hasText: "Performance" });
  if (await perfSub.isVisible()) {
    await perfSub.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "24-results-developer-performance.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 19: Config — Pipeline Section
// ════════════════════════════════════════════════════════════════
// Shows: The Pipeline section within the Config tab — Gate 1 (Raw
//        Transcript Review) toggle and Gate 2 (Delivery Review)
//        toggle.
// Guide section: "Settings & Configuration — Config Tab — Pipeline Section"
// Add to guide as: ![Pipeline Gate Settings](screenshots/19-config-pipeline.png)
test("19 - config pipeline section", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  // Click the "Pipeline" section heading
  const pipelineSection = window.locator("text=Pipeline").first();
  if (await pipelineSection.isVisible()) {
    await pipelineSection.click();
  }
  await window.waitForTimeout(300);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "19-config-pipeline.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 20: Config — Logging Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Logging tab in the Config panel — LLM Data Logging
//        toggle, Collapse Repeated Lines toggle, per-source
//        checkboxes (Python/Bridge/Agent/Main), log level dropdown,
//        max file size, and max files settings.
// Guide section: "Settings & Configuration — Logging Tab"
// Add to guide as: ![Logging Settings](screenshots/20-config-logging.png)
test("20 - config logging tab", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  // Click the "Logging" tab button in the config tab bar
  const loggingTab = window.locator(".config-tab", { hasText: "Logging" });
  if (await loggingTab.isVisible()) {
    await loggingTab.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "20-config-logging.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 25: Config — Delivery Config Section
// ════════════════════════════════════════════════════════════════
// Shows: The Delivery Config section — default recipient emails,
//        email subject template, additional email content, Drive
//        destination folder, and custom-delivery-per-meeting toggle.
// Guide section: "Settings & Configuration — Config Tab — Delivery Config Section"
// Add to guide as: ![Delivery Config Settings](screenshots/25-config-delivery-config.png)
test("25 - config delivery config section", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  const section = window.locator(".config-section-tab", { hasText: "Delivery Config" });
  if (await section.isVisible()) {
    await section.click();
  }
  await window.waitForTimeout(300);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "25-config-delivery-config.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 26: Config — Usage Tracking Section
// ════════════════════════════════════════════════════════════════
// Shows: The Usage Tracking section — enable toggle, DS-mon instance
//        ID, push/poll intervals, gist URL, and push token.
// Guide section: "Settings & Configuration — Config Tab — Usage Tracking Section"
// Add to guide as: ![Usage Tracking Settings](screenshots/26-config-usage-tracking.png)
test("26 - config usage tracking section", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  const section = window.locator(".config-section-tab", { hasText: "Usage Tracking" });
  if (await section.isVisible()) {
    await section.click();
  }
  await window.waitForTimeout(300);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "26-config-usage-tracking.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 27: Config — Diarization Section
// ════════════════════════════════════════════════════════════════
// Shows: The Diarization section — min speaker duration/segments,
//        merging gap, clustering threshold, max speakers, and the
//        diarization timeout.
// Guide section: "Settings & Configuration — Config Tab — Diarization Section"
// Add to guide as: ![Diarization Settings](screenshots/27-config-diarization.png)
test("27 - config diarization section", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  const section = window.locator(".config-section-tab", { hasText: "Diarization" });
  if (await section.isVisible()) {
    await section.click();
  }
  await window.waitForTimeout(300);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "27-config-diarization.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 21: Dev Tools — Database Voiceprints
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Database tab with the Voiceprints sub-view
//        active — list of enrolled voiceprints with name, email,
//        linked job, play button, and delete button.
// Guide section: "Dev Tools — Database Tab — Voiceprints"
// Add to guide as: ![Voiceprint Database](screenshots/21-dev-database-voiceprints.png)
test("21 - dev database voiceprints", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  // Click the "Database" tab
  const dbTab = window.locator(".dev-panel-tab", { hasText: "Database" });
  if (await dbTab.isVisible()) {
    await dbTab.click();
  }
  await window.waitForTimeout(300);

  // Click the "Voiceprints" sub-view button
  const vpBtn = window.locator(".dev-panel-view-btn", { hasText: "Voiceprints" });
  if (await vpBtn.isVisible()) {
    await vpBtn.click();
  }
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "21-dev-database-voiceprints.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 28: Dev Tools — Performance Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Performance tab — per-job stage timings,
//        CPU/memory metrics, and elapsed pipeline durations.
// Guide section: "Dev Tools — Performance Tab"
// Add to guide as: ![Dev Performance](screenshots/28-dev-performance.png)
test("28 - dev tools performance tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Performance" });
  if (await tab.isVisible()) {
    await tab.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "28-dev-performance.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 29: Dev Tools — Usage Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Usage tab — per-provider sub-tabs (All/DeepSeek/
//        OpenAI/Anthropic/Ollama), credit balance or "usage can't be
//        tracked" badge, and LLM token usage/cost across jobs.
// Guide section: "Dev Tools — Usage Tab"
// Add to guide as: ![Dev Usage](screenshots/29-dev-usage.png)
test("29 - dev tools usage tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Usage" });
  if (await tab.isVisible()) {
    await tab.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "29-dev-usage.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 30: Dev Tools — Log Files Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Log Files tab — job list on the left and the
//        formatted per-job pipeline log on the right (parsed source/
//        level/sub-source columns with Pipeline/Agent/Transcript/Raw
//        sub-tabs).
// Guide section: "Dev Tools — Log Files Tab"
// Add to guide as: ![Dev Log Files](screenshots/30-dev-log-files.png)
test("30 - dev tools log files tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Log Files" });
  if (await tab.isVisible()) {
    await tab.click();
  }
  await window.waitForTimeout(500);

  // Select the most recent job so the log viewer populates
  const firstJob = window.locator(".dev-panel-file-item").first();
  if (await firstJob.isVisible()) {
    await firstJob.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "30-dev-log-files.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 31: Dev Tools — Updates Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Updates tab — current version, latest
//        version, and check/install update controls.
// Guide section: "Dev Tools — Updates Tab"
// Add to guide as: ![Dev Updates](screenshots/31-dev-updates.png)
test("31 - dev tools updates tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Updates" });
  if (await tab.isVisible()) {
    await tab.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "31-dev-updates.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 32: Dev Tools — Testing Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Testing tab — frontend (Playwright) and
//        backend (test bot) test runners with the sub-tab bar,
//        audio/title/names inputs, and run output.
// Guide section: "Dev Tools — Testing Tab"
// Add to guide as: ![Dev Testing](screenshots/32-dev-testing.png)
test("32 - dev tools testing tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Testing" });
  if (await tab.isVisible()) {
    await tab.click();
  }
  await window.waitForTimeout(1000);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "32-dev-testing.png"),
  });
});

// ════════════════════════════════════════════════════════════════
// SCREENSHOT 33: Dev Tools — Guide Tab
// ════════════════════════════════════════════════════════════════
// Shows: The Dev Tools Guide tab — documentation sub-tab bar (API
//        Endpoints, Backend Architecture, Known Bugs, etc.) and the
//        DocViewer with sidebar TOC, search, and paged content.
// Guide section: "Dev Tools — Guide Tab"
// Add to guide as: ![Dev Guide](screenshots/33-dev-guide.png)
test("33 - dev tools guide tab", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForTimeout(500);

  const tab = window.locator(".dev-panel-tab", { hasText: "Guide" });
  if (await tab.isVisible()) {
    await tab.click();
  }

  // Wait for the DocViewer (sidebar TOC) to finish loading the docs
  await window.waitForSelector(".guide-sidebar", { timeout: 15_000 });
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "33-dev-guide.png"),
  });
});
