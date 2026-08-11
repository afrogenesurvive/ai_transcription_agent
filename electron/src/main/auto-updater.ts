/**
 * Auto-Updater — unified update mechanism for dev and packaged modes.
 *
 * **Dev mode** (not packaged):
 *   Uses git: fetch → count behind → pull → install deps → rebuild → relaunch.
 *
 * **Packaged mode** (electron-builder):
 *   Uses electron-updater to check GitHub Releases, download, and install.
 *
 * IPC handlers registered:
 *   auto-update:status     → { mode, enabled, lastCheck, lastUpdate, updateAvailable, checking, ... }
 *   auto-update:check      → trigger an immediate check
 *   auto-update:setEnabled → enable/disable auto-updates
 *   auto-update:download   → download the available update (packaged mode only)
 *   auto-update:install    → install downloaded update and restart (packaged mode only)
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { app, ipcMain, Notification } from "electron";
import { addLog } from "./logger";
import { stopAll } from "./backend-manager";
import { getConfig } from "./config";

const IS_WIN = process.platform === "win32";

// ── electron-updater (packaged mode only — may not be available in dev) ──
let autoUpdater: any = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch {
  // Not available — dev mode or module not installed
}

// ── Config ──

const DEV_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const PACKAGED_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const GIT_FETCH_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 120_000;

/** Dev-mode auto-update is intentionally disabled for now (all platforms). */
const DEV_UPDATE_ENABLED = false;

interface UpdateState {
  mode: "dev" | "packaged";
  enabled: boolean;
  lastCheck: string | null;
  lastUpdate: string | null;
  /** Dev mode: number of commits behind. Packaged: version string of available update. */
  updateAvailable: string | null;
  checking: boolean;
  /** Dev mode: branch name. Packaged: current app version. */
  currentVersion: string;
  error: string | null;
  /** Packaged mode: download progress (0–100, null if not downloading) */
  downloadProgress: number | null;
  /** Whether the update has been downloaded and is ready to install */
  updateDownloaded: boolean;
}

const isPackaged = app.isPackaged;

// ── Seed GH_TOKEN from config for electron-updater (packaged mode) ──
// electron-updater's GitHub provider reads process.env.GH_TOKEN at runtime.
// This is called at module load AND inside checkAndUpdate() so that
// the PAT is available even if the config file wasn't ready at startup.
(function initGitHubToken(): void {
  try {
    const token = getConfig().GITHUB_TOKEN;
    if (token) {
      if (!process.env.GH_TOKEN) process.env.GH_TOKEN = token;
      if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token;
    }
  } catch {
    // Config not ready yet — will be retried in checkAndUpdate()
  }
})();

let state: UpdateState = {
  mode: isPackaged ? "packaged" : "dev",
  enabled: true,
  lastCheck: null,
  lastUpdate: null,
  updateAvailable: null,
  checking: false,
  currentVersion: isPackaged ? app.getVersion() : "dev",
  error: null,
  downloadProgress: null,
  updateDownloaded: false,
};

let updateInterval: ReturnType<typeof setInterval> | null = null;

// ══════════════════════════════════════════════════════════════
//  PERSISTENT UPDATE LOG
// ══════════════════════════════════════════════════════════════
// The auto-updater may pull/rebuild then relaunch/exit the app, so its messages
// must survive in a dedicated file for post-mortem diagnosis — the in-memory ring
// buffer dies with the process. Written to <userData>/logs/update.log (same dir as
// startup-error.log). Used by auto-updater.ts and index.ts (single-instance lock).
function updateLogDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

function updateLogPath(): string {
  return path.join(updateLogDir(), "update.log");
}

/** Append a line to <userData>/logs/update.log (best-effort, never throws). */
export function writeUpdateLog(level: "info" | "warn" | "error", message: string): void {
  try {
    fs.mkdirSync(updateLogDir(), { recursive: true });
    fs.appendFileSync(updateLogPath(), `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`, "utf8");
  } catch {
    // non-fatal — in-memory buffer + console still capture it
  }
}

/** Log an auto-update message to the live log AND the persistent update.log. */
function updateLog(level: "info" | "warn" | "error", message: string): void {
  addLog("main", level, `[auto-update] ${message}`);
  writeUpdateLog(level, message);
}

// ══════════════════════════════════════════════════════════════
//  DEV MODE — git-based
// ══════════════════════════════════════════════════════════════

function projectRoot(): string {
  return path.resolve(app.getAppPath(), "..");
}

function git(args: string[], timeoutMs = 15_000): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: projectRoot(),
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: "pipe",
  }).trim();
}

function isGitRepo(): boolean {
  try {
    git(["rev-parse", "--git-dir"], 5000);
    return true;
  } catch {
    return false;
  }
}

function currentBranch(): string {
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], 5000);
  } catch {
    return "unknown";
  }
}

/**
 * Get the configured GitHub PAT from the app config (if any).
 * electron-updater also auto-picks up process.env.GH_TOKEN in packaged mode.
 */
function getGitHubToken(): string {
  return getConfig().GITHUB_TOKEN || process.env.GH_TOKEN || "";
}

/**
 * Rewrite the git remote origin URL to include a GitHub PAT for authentication.
 *
 * Transforms: https://github.com/owner/repo.git
 *         → https://x-access-token:<PAT>@github.com/owner/repo.git
 *
 * Restores the original URL after the operation. No-op if no PAT is configured
 * or the remote is already using SSH (git@).
 */
function withPatOrigin<T>(fn: () => T): T {
  const pat = getGitHubToken();
  if (!pat) return fn();

  let originalUrl: string | null = null;
  try {
    originalUrl = git(["remote", "get-url", "origin"], 5000);
    // Only rewrite HTTPS URLs — SSH URLs (git@) use keys, not tokens
    if (originalUrl.startsWith("https://")) {
      const authedUrl = originalUrl.replace("https://", `https://x-access-token:${pat}@`);
      git(["remote", "set-url", "origin", authedUrl], 5000);
      updateLog("info", "Using PAT-authenticated remote for git fetch");
    }
  } catch {
    updateLog("warn", "Could not read git remote URL — proceeding without PAT");
  }

  try {
    return fn();
  } finally {
    // Restore original URL
    if (originalUrl) {
      try {
        git(["remote", "set-url", "origin", originalUrl], 5000);
      } catch {
        // non-critical
      }
    }
  }
}

function fetchOrigin(): boolean {
  try {
    withPatOrigin(() => {
      git(["fetch", "origin"], GIT_FETCH_TIMEOUT_MS);
    });
    return true;
  } catch (err: any) {
    updateLog("error", `git fetch failed: ${err.message}`);
    return false;
  }
}

function countBehind(branch: string): number {
  try {
    return parseInt(git(["rev-list", "--count", "HEAD..origin/" + branch], 10_000), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Parse a branch name into a version tuple if it looks like a version branch.
 * "0.7.11" → [0, 7, 11]; "main" / "feature-x" → null.
 */
function parseVersionBranch(branch: string): number[] | null {
  const m = branch.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0];
}

/** Compare two version tuples — negative if a < b. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** List remote (origin) branch names, e.g. ["0.7.11", "main", ...]. */
function remoteBranches(): string[] {
  try {
    // Note: git() shells out via /bin/sh, so the %(…) format must be shell-quoted
    // (unquoted %(refname:short) is a sh syntax error and would return [] here).
    return git(["for-each-ref", "refs/remotes/origin", "--format='%(refname:short)'"], 10_000)
      .split("\n")
      .filter(Boolean)
      .map((b) => b.replace(/^origin\//, ""));
  } catch {
    return [];
  }
}

/** Commits reachable from origin/<branch> but not from HEAD. */
function aheadOfHead(branch: string): number {
  try {
    return parseInt(git(["rev-list", "--count", "HEAD..origin/" + branch], 10_000), 10) || 0;
  } catch {
    return 0;
  }
}

/** True when the working tree has no uncommitted changes. */
function workingTreeClean(): boolean {
  try {
    return git(["status", "--porcelain"], 10_000).length === 0;
  } catch {
    return false;
  }
}

function installDeps(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "package.json"))) return true;
  try {
    updateLog("info", `Installing deps in ${path.basename(dir)}...`);
    execSync("npm install --loglevel=error", { cwd: dir, stdio: "pipe", timeout: BUILD_TIMEOUT_MS });
    return true;
  } catch (err: any) {
    updateLog("error", `npm install failed in ${path.basename(dir)}: ${err.message}`);
    return false;
  }
}

function installPythonDeps(backendDir: string): boolean {
  if (!fs.existsSync(path.join(backendDir, "requirements.txt"))) return true;
  try {
    updateLog("info", "Installing Python deps...");
    const pipCmd = IS_WIN ? "python -m pip install -r requirements.txt" : "pip3 install -r requirements.txt";
    execSync(pipCmd, { cwd: backendDir, stdio: "pipe", timeout: BUILD_TIMEOUT_MS });
    return true;
  } catch (err: any) {
    updateLog("info", "Python deps skipped (non-blocking): " + err.message);
    return true;
  }
}

function rebuildMain(): boolean {
  try {
    updateLog("info", "Rebuilding main process...");
    execSync("npx tsc -p tsconfig.main.json", { cwd: app.getAppPath(), stdio: "pipe", timeout: BUILD_TIMEOUT_MS });
    return true;
  } catch (err: any) {
    updateLog("error", `Rebuild failed: ${err.message}`);
    return false;
  }
}

async function checkDevUpdate(force: boolean): Promise<{
  updateAvailable: boolean;
  details: string | null;
  error: string | null;
}> {
  // Dev-mode auto-update is DISABLED for now (all platforms) — dev users manage their
  // branch/updates manually with git. Flip DEV_UPDATE_ENABLED to re-enable; the git
  // machinery below is retained for that purpose.
  if (!DEV_UPDATE_ENABLED) {
    updateLog("info", "Dev-mode auto-update disabled — skipping check (manage updates manually with git)");
    state.lastCheck = new Date().toISOString();
    state.updateAvailable = null;
    state.error = null;
    return { updateAvailable: false, details: null, error: null };
  }

  if (!isGitRepo()) {
    state.error = "Not a git repository";
    return { updateAvailable: false, details: null, error: "Not a git repository" };
  }

  state.currentVersion = currentBranch();
  if (state.currentVersion === "HEAD" || state.currentVersion === "unknown") {
    state.error = `Detached HEAD: ${state.currentVersion}`;
    return { updateAvailable: false, details: null, error: state.error };
  }

  if (!fetchOrigin()) {
    state.error = "git fetch failed";
    return { updateAvailable: false, details: null, error: "Fetch failed" };
  }

  // Commits behind on the CURRENT branch (existing behavior)
  const behind = countBehind(state.currentVersion);
  // Highest-version remote branch (ignoring `main`) with commits not in HEAD
  const newerBranch = findNewerBranch(state.currentVersion);

  state.lastCheck = new Date().toISOString();
  state.updateAvailable = behind > 0
    ? `${behind} commit(s)`
    : newerBranch
      ? `${newerBranch.ahead} commit(s) ahead on branch ${newerBranch.name}`
      : null;

  // Up to date on the current branch AND no newer branch → done
  if (behind === 0 && !newerBranch) {
    return { updateAvailable: false, details: null, error: null };
  }

  // 1) Current branch has new commits → pull it (existing path)
  if (behind > 0) {
    updateLog("info", `${behind} commit(s) behind — pulling...`);
    try {
      git(["pull", "--ff-only", "origin", state.currentVersion], 60_000);
    } catch (err: any) {
      const msg = `git pull failed: ${err.message}`;
      updateLog("error", msg);
      state.error = msg;
      return { updateAvailable: false, details: null, error: msg };
    }
    return await applyDevUpdate(`${behind} commit(s) pulled`);
  }

  // 2) A newer (higher-version) branch exists → switch to it
  const target = newerBranch!;
  updateLog("info", `Branch ${target.name} is ahead (${target.ahead} commit(s)) — switching...`);

  if (!workingTreeClean()) {
    const msg = `Working tree not clean — commit or stash before switching to ${target.name}`;
    updateLog("warn", msg);
    state.error = msg;
    return { updateAvailable: true, details: `${target.ahead} commit(s) ahead on branch ${target.name}`, error: msg };
  }

  try {
    git(["checkout", "-B", target.name, "origin/" + target.name], 60_000);
  } catch (err: any) {
    const msg = `git checkout ${target.name} failed: ${err.message}`;
    updateLog("error", msg);
    state.error = msg;
    return { updateAvailable: false, details: null, error: msg };
  }

  return await applyDevUpdate(`switched to branch ${target.name}`);
}

/**
 * Find the highest-version remote branch (ignoring `main` / non-version branches)
 * that has commits not reachable from HEAD. Returns null when none exists.
 */
function findNewerBranch(current: string): { name: string; ahead: number } | null {
  const currentVer = parseVersionBranch(current);
  if (!currentVer) return null; // non-version branch (e.g. main) — ignored for now

  let best: { name: string; ahead: number } | null = null;
  for (const branch of remoteBranches()) {
    if (branch === current) continue;
    const ver = parseVersionBranch(branch);
    if (!ver) continue; // skip main / non-version branches
    if (compareVersions(ver, currentVer) <= 0) continue; // not higher than current
    const ahead = aheadOfHead(branch);
    if (ahead > 0 && (!best || compareVersions(ver, parseVersionBranch(best.name)!) > 0)) {
      best = { name: branch, ahead };
    }
  }
  return best;
}

/**
 * Shared post-update path: install deps, rebuild main, relaunch.
 * Only reached after a successful pull or branch switch.
 */
async function applyDevUpdate(summary: string): Promise<{
  updateAvailable: boolean;
  details: string | null;
  error: string | null;
}> {
  const rootDir = projectRoot();
  const depsOk = installDeps(app.getAppPath()) && installDeps(path.join(rootDir, "bridge-server")) && installDeps(path.join(rootDir, "agent-runner"));
  installPythonDeps(path.join(rootDir, "python-backend"));

  if (!depsOk) {
    state.error = "Dependency installation failed";
    state.lastUpdate = new Date().toISOString();
    return { updateAvailable: true, details: summary, error: "Deps install failed" };
  }

  const buildOk = rebuildMain();
  state.lastUpdate = new Date().toISOString();
  state.updateAvailable = null;

  if (!buildOk) {
    state.error = "Rebuild failed";
    return { updateAvailable: true, details: summary, error: "Rebuild failed" };
  }

  new Notification({ title: "App Updated", body: `${summary}. Restarting...` }).show();
  updateLog("info", `${summary} — restarting`);

  await new Promise((r) => setTimeout(r, 1500));
  app.relaunch();
  try {
    await stopAll();
  } catch {
    /* best effort */
  }
  app.exit(0);

  return { updateAvailable: true, details: summary, error: null };
}

// ══════════════════════════════════════════════════════════════
//  PACKAGED MODE — electron-updater
// ══════════════════════════════════════════════════════════════

function setupPackagedUpdater(): void {
  if (!autoUpdater) return;

  autoUpdater.autoDownload = false; // we control download manually
  autoUpdater.allowPrerelease = false;
  // electron-updater reads the "build.publish" field from electron/package.json
  // to determine the update source (GitHub Releases, S3, etc.)

  autoUpdater.on("checking-for-update", () => {
    state.checking = true;
    updateLog("info", "Checking for updates (packaged)...");
  });

  autoUpdater.on("update-available", (info: any) => {
    state.checking = false;
    state.lastCheck = new Date().toISOString();
    state.updateAvailable = info?.version || "yes";
    state.error = null;
    updateLog("info", `Update available: v${info.version}`);
    new Notification({ title: "Update Available", body: `Version ${info.version} is ready to download.` }).show();
  });

  autoUpdater.on("update-not-available", () => {
    state.checking = false;
    state.lastCheck = new Date().toISOString();
    state.updateAvailable = null;
    state.error = null;
    updateLog("info", "Already up to date");
  });

  autoUpdater.on("error", (err: Error) => {
    state.checking = false;
    state.error = err.message;
    updateLog("error", err.message);
  });

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    state.downloadProgress = Math.round(progress.percent);
  });

  autoUpdater.on("update-downloaded", (info: any) => {
    state.downloadProgress = null;
    state.updateDownloaded = true;
    state.lastUpdate = new Date().toISOString();
    updateLog("info", `Update v${info.version} downloaded`);
    new Notification({ title: "Update Ready", body: `Version ${info.version} downloaded. Restart to install.` }).show();
  });
}

async function checkPackagedUpdate(): Promise<{
  updateAvailable: boolean;
  details: string | null;
  error: string | null;
}> {
  if (!autoUpdater) {
    state.error = "electron-updater not available";
    return { updateAvailable: false, details: null, error: "electron-updater not available" };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (version) {
      state.updateAvailable = version;
      return { updateAvailable: true, details: version, error: null };
    }
    return { updateAvailable: false, details: null, error: null };
  } catch (err: any) {
    state.error = err.message;
    return { updateAvailable: false, details: null, error: err.message };
  }
}

async function downloadPackagedUpdate(): Promise<{ success: boolean; error: string | null }> {
  if (!autoUpdater) return { success: false, error: "electron-updater not available" };
  if (!state.updateAvailable) return { success: false, error: "No update available to download" };
  try {
    state.downloadProgress = 0;
    autoUpdater.downloadUpdate();
    return { success: true, error: null };
  } catch (err: any) {
    state.downloadProgress = null;
    state.error = err.message;
    return { success: false, error: err.message };
  }
}

function installPackagedUpdate(): void {
  if (!autoUpdater || !state.updateDownloaded) return;
  updateLog("info", "Installing update and restarting...");
  // On Windows, use non-silent install so the UAC elevation prompt appears.
  // On macOS/Linux, silent install works fine without elevation.
  autoUpdater.quitAndInstall(false, !IS_WIN);
}

// ══════════════════════════════════════════════════════════════
//  UNIFIED PUBLIC API
// ══════════════════════════════════════════════════════════════

/** Check for updates and apply if found. */
export async function checkAndUpdate(force = false): Promise<{
  updateAvailable: boolean;
  details: string | null;
  error: string | null;
}> {
  if (state.checking) return { updateAvailable: false, details: null, error: "Already checking" };
  state.checking = true;
  state.error = null;

  // Refresh GH_TOKEN from config in case user just saved it
  try {
    const token = getConfig().GITHUB_TOKEN;
    if (token) {
      if (!process.env.GH_TOKEN) process.env.GH_TOKEN = token;
      if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token;
    }
  } catch {
    // config not ready
  }

  try {
    return isPackaged ? await checkPackagedUpdate() : await checkDevUpdate(force);
  } finally {
    state.checking = false;
  }
}

/** Download the available update (packaged mode only). */
export async function downloadUpdate(): Promise<{ success: boolean; error: string | null }> {
  if (!isPackaged) {
    return { success: false, error: "Download not supported in dev mode — use check to pull and restart" };
  }
  return await downloadPackagedUpdate();
}

/** Install the downloaded update and restart (packaged mode only). */
export function installUpdate(): void {
  if (isPackaged) installPackagedUpdate();
}

// ── Lifecycle ──

export function startAutoUpdater(): void {
  if (updateInterval) return;
  if (isPackaged) setupPackagedUpdater();

  const interval = isPackaged ? PACKAGED_CHECK_INTERVAL_MS : DEV_CHECK_INTERVAL_MS;
  updateLog("info", `Starting auto-updater (every 12 hours, mode: ${state.mode})`);

  setTimeout(() => {
    if (state.enabled) checkAndUpdate().catch(() => {});
  }, 30_000);
  updateInterval = setInterval(() => {
    if (state.enabled) checkAndUpdate().catch(() => {});
  }, interval);
}

export function stopAutoUpdater(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

export function getUpdateState(): UpdateState {
  return { ...state };
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  state.enabled = enabled;
  updateLog("info", enabled ? "Enabled" : "Disabled");
}

// ── IPC Handlers ──

export function registerAutoUpdateIpc(): void {
  ipcMain.handle("auto-update:status", () => getUpdateState());
  ipcMain.handle("auto-update:check", async () => await checkAndUpdate(true));
  ipcMain.handle("auto-update:setEnabled", async (_e, enabled: boolean) => {
    setAutoUpdateEnabled(enabled);
    return { success: true };
  });
  ipcMain.handle("auto-update:download", async () => await downloadUpdate());
  ipcMain.handle("auto-update:install", async () => {
    installUpdate();
    return { success: true };
  });
}
