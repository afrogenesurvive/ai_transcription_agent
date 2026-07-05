/**
 * User Guide Screenshot Generator
 *
 * Generates screenshots of the Transcription Agent Electron app for
 * documentation and the user guide.
 *
 * Usage:
 *   1. Build the app:  npm run build
 *   2. Run this:      npx playwright test tests/screenshots/user-guide-screenshots.spec.ts
 *
 * Screenshots are saved to: docs/screenshots/
 */

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import path from "path";

const SCREENSHOT_DIR = path.resolve(__dirname, "../../docs/screenshots");

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  // Launch the Electron app — point to the built main process
  app = await electron.launch({
    args: [path.resolve(__dirname, "../dist/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
    },
  });

  // Wait for the first BrowserWindow to appear
  window = await app.firstWindow();

  // Ensure the window is a consistent size for screenshots
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterAll(async () => {
  await app.close();
});

test("01 - main window (empty state)", async () => {
  await window.waitForSelector(".app");
  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "01-main-window-empty.png"),
    fullPage: false,
  });
});

test("02 - upload panel with file picker", async () => {
  // Click the "New" button in the sidebar to ensure we're on the upload view
  const newBtn = window.locator(".sidebar-btn", { hasText: "New" });
  await newBtn.click();
  await window.waitForSelector(".drop-zone");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "02-upload-panel.png"),
  });
});

test("03 - configuration panel", async () => {
  const configBtn = window.locator(".sidebar-btn", { hasText: "Config" });
  await configBtn.click();
  await window.waitForSelector(".config-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "03-config-panel.png"),
  });
});

test("04 - appearance settings", async () => {
  const appearanceBtn = window.locator(".sidebar-btn", { hasText: "Appearance" });
  await appearanceBtn.click();
  await window.waitForSelector(".appearance-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "04-appearance-settings.png"),
  });
});

test("05 - about panel", async () => {
  const aboutBtn = window.locator(".sidebar-btn", { hasText: "About" });
  await aboutBtn.click();
  await window.waitForSelector(".about-panel");

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "05-about-panel.png"),
  });
});

test("06 - storage panel", async () => {
  const storageBtn = window.locator(".sidebar-btn", { hasText: "Storage" });
  await storageBtn.click();
  await window.waitForSelector(".about-panel", { state: "detached" });
  // Wait for storage panel to render
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "06-storage-panel.png"),
  });
});

test("07 - history panel", async () => {
  const historyBtn = window.locator(".sidebar-btn", { hasText: "History" });
  await historyBtn.click();
  await window.waitForTimeout(500);

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "07-history-panel.png"),
  });
});

test("08 - dev tools panel", async () => {
  const devBtn = window.locator(".sidebar-btn", { hasText: "Dev" });
  await devBtn.click();
  await window.waitForSelector(".log-viewer", { timeout: 5_000 }).catch(() => {
    // Log viewer selector may vary — just screenshot whatever is there
  });

  await window.screenshot({
    path: path.join(SCREENSHOT_DIR, "08-dev-tools.png"),
  });
});
