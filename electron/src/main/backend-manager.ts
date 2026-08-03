/**
 * Backend Manager — spawns and manages Python backend, bridge server,
 * and agent runner as child processes from the Electron main process.
 *
 * Cross-platform: detects Windows vs Unix for paths, Python binary name,
 * and process termination (SIGTERM vs taskkill).
 *
 * In development, assumes Python and Node are available on PATH.
 * In production (packaged), binaries are in extraResources.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { addLog, setCurrentJobId } from "./logger";
import { getChildEnv } from "./config";

/** Cross-platform synchronous sleep using execSync. Falls back gracefully on all platforms. */
function syncSleep(seconds: number): void {
  if (process.platform === "win32") {
    // PowerShell Start-Sleep has no console/stdin dependency, unlike `timeout`,
    // which fails with "Input redirection is not supported" when spawned from a
    // GUI process (no TTY attached).
    execSync(`powershell -NoProfile -NonInteractive -Command "Start-Sleep -Seconds ${seconds}"`, {
      stdio: "pipe",
      timeout: (seconds + 2) * 1000,
    });
  } else {
    execSync(`sleep ${seconds}`, { stdio: "pipe", timeout: (seconds + 2) * 1000 });
  }
}

const isProd = app.isPackaged;
const IS_WIN = process.platform === "win32";

/** Optional callback invoked when the agent runner starts a job via [JOB_START] marker.
 *  Set by index.ts on startup to forward the event to the renderer for notifications. */
let _onJobStarted: ((jobId: string) => void) | null = null;
export function setOnJobStarted(cb: (jobId: string) => void): void {
  _onJobStarted = cb;
}

/** Extract a [tag] prefix from the start of a message, e.g. "[transcription] ..." → "transcription"
 *
 *  Falls back to detecting:
 *    - Whisper's verbose timestamp format: [01:21.560 --> 01:25.380] text → "transcription"
 *    - Uvicorn HTTP access logs: INFO:     127.0.0.1:58029 - "GET /health" → "http"
 */
function extractSubSource(msg: string): string | undefined {
  // Primary: match a word-only [tag] prefix like [transcription], [pipeline], [agent_bridge]
  const tagMatch = msg.match(/^\[(\w+)\]/);
  if (tagMatch) return tagMatch[1].toLowerCase();

  // Fallback: detect Whisper verbose timestamp format
  //   [MM:SS.mmm --> MM:SS.mmm] or [HH:MM:SS.mmm --> HH:MM:SS.mmm]
  // These come from Whisper's internal verbose print() calls and don't
  // have a [transcription] prefix, but should be tagged as such.
  const tsMatch = msg.match(/^\[\d{1,2}:\d{2}\.\d{3}\s*-->/);
  if (tsMatch) return "transcription";

  // Fallback: detect uvicorn HTTP access logs on stderr
  //   e.g. INFO:     127.0.0.1:58029 - "GET /health HTTP/1.1" 200 OK
  //   These come from uvicorn's default access logger and don't have a [tag] prefix.
  const uvicornMatch = msg.match(/^(INFO|WARNING|ERROR):\s+\d+\.\d+\.\d+\.\d+:\d+\s+-\s+"(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/);
  if (uvicornMatch) return "http";

  // Fallback: scan for [tag] anywhere in the message (not just position 0)
  // Catches cases like "✅ [pipeline] Pipeline complete..." or "❌ [pipeline] ERROR..."
  const inlineTagMatch = msg.match(/\[([a-zA-Z0-9 _-]+)\]/);
  if (inlineTagMatch) return inlineTagMatch[1].toLowerCase();

  return undefined;
}

/** Platform-aware Python binary name (dev fallback) */
const PYTHON_BIN = IS_WIN ? "python" : "python3";

/**
 * Resolve the Node.js binary path.
 *
 * In production (packaged), uses the bundled binary from extraResources.
 * In development, falls back to the system PATH.
 */
function resolveNodeBin(): string {
  if (isProd) {
    const bundled = path.join(process.resourcesPath, "node-bin", IS_WIN ? "node.exe" : "node");
    if (fs.existsSync(bundled)) {
      console.log(`[backend] Using bundled Node.js: ${bundled}`);
      return bundled;
    }
    console.log(`[backend] Bundled Node.js not found at ${bundled} — falling back to system PATH`);
  }
  return IS_WIN ? "node.exe" : "node";
}

/** Path to the child-PID file the Windows NSIS uninstaller reads so it can stop
 *  backend processes that outlived the Electron shell (crash, silent uninstall). */
function childPidsFilePath(): string {
  return path.join(app.getPath("userData"), "child-pids.txt");
}

/** Persist the current python/bridge/agent PIDs (comma-separated) so the Windows
 *  uninstaller can taskkill exactly our processes — `node.exe`/`main.exe` are too
 *  generic to kill by image name. Best-effort; non-fatal if it fails. */
function persistChildPids(): void {
  try {
    const pids = [pythonProcess?.pid, bridgeProcess?.pid, agentProcess?.pid].filter((p): p is number => typeof p === "number" && p > 0);
    fs.writeFileSync(childPidsFilePath(), pids.join(","), "utf8");
  } catch {
    // non-critical
  }
}

/** Kill any process listening on the given TCP port (cross-platform). */
export async function killProcessOnPort(port: number): Promise<void> {
  if (IS_WIN) {
    // Use netstat to find PIDs listening EXACTLY on the target port, then
    // taskkill each. Match the Local Address column precisely (0.0.0.0:5001 /
    // [::]:5001) — a substring match like `findstr :5001` would also hit
    // :50010/:50012 and kill unrelated processes.
    try {
      const result = execSync("netstat -ano -p tcp", { encoding: "utf8", timeout: 3000 });
      const lines = result.trim().split(/\r?\n/);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        if (!parts[3].toUpperCase().includes("LISTENING")) continue;
        const localAddr = parts[1];
        if (!localAddr.endsWith(`:${port}`)) continue;
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
            console.log(`[backend] Killed stale process ${pid} on port ${port}`);
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // No process found on that port — great
    }
    return;
  }
  try {
    const result = execSync(`lsof -ti:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8", timeout: 3000 });
    const pids = result.trim().split("\n").filter(Boolean).map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`[backend] Killed stale process ${pid} on port ${port}`);
      } catch {
        // already gone
      }
    }
    // Brief wait for the killed processes to release the port
    if (pids.length > 0) await new Promise((r) => setTimeout(r, 500));
  } catch {
    // No process found on that port — great
  }
}

function resourcePath(...segments: string[]): string {
  if (isProd) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(app.getAppPath(), "..", ...segments);
}

/**
 * User-data agent-config path — same for all callers.
 * Resolves consistently so restart watcher, init, and import all agree.
 */
let _userDataAgentConfigDir: string | null = null;
export function getUserDataAgentConfigDir(): string {
  if (!_userDataAgentConfigDir) {
    _userDataAgentConfigDir = path.join(app.getPath("userData"), "agent-config");
  }
  return _userDataAgentConfigDir;
}

/** Result of initializing agent-config in userData. */
export interface AgentConfigInitResult {
  path: string;
  fromTemplates: boolean;
  created: boolean;
}

/**
 * Refresh {destDir}/.defaults/ from the bundled source when the app version
 * changes, so "restore agent defaults" yields the CURRENT shipped defaults
 * (not the ones frozen at install time). Stamps .defaults/version.json.
 * No-op on first install (initAgentConfigDir seeds below) or when versions match.
 */
function refreshAgentDefaultsIfVersionChanged(destDir: string): void {
  try {
    const versionFile = path.join(destDir, ".defaults", "version.json");
    let stamp = "";
    if (fs.existsSync(versionFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(versionFile, "utf8"));
        if (parsed && typeof parsed.version === "string") stamp = parsed.version;
      } catch {
        // ignore parse errors — refresh below
      }
    }
    if (stamp === app.getVersion()) return;

    const srcDefaults = path.join(resourcePath("agent-config"), ".defaults");
    if (!fs.existsSync(srcDefaults)) return; // nothing bundled to refresh from

    const destDefaults = path.join(destDir, ".defaults");
    fs.mkdirSync(destDefaults, { recursive: true });
    for (const name of ["pipeline.json", "tools.json", "system-prompt.md"]) {
      const s = path.join(srcDefaults, name);
      const d = path.join(destDefaults, name);
      if (fs.existsSync(s)) fs.copyFileSync(s, d);
    }
    fs.writeFileSync(versionFile, JSON.stringify({ version: app.getVersion() }, null, 2), "utf8");
    console.log(`[backend] Refreshed agent-config .defaults/ for version ${app.getVersion()}`);
  } catch (err: any) {
    console.warn(`[backend] Could not refresh agent-config defaults: ${err.message}`);
  }
}

/**
 * Initialize a writable copy of agent-config in userData on first launch.
 *
 * Bundled agent-config (in extraResources) is read-only in production.
 * This copies it to userData so the bridge can write edits and config
 * import can restore saved values after uninstall/reinstall.
 *
 * Also seeds .defaults/ in userData from the bundled .defaults/ (or from
 * live files if the bundled .defaults/ doesn't exist).
 *
 * If the bundled source has .template.* files instead of live files
 * (after a fresh clone where the live files are gitignored), copies
 * templates as the live files.
 *
 * Safe to call multiple times — only copies when userData copy is missing.
 */
export function initAgentConfigDir(): AgentConfigInitResult {
  const destDir = getUserDataAgentConfigDir();

  // Already initialized — refresh the defaults snapshot if the app version
  // changed (new keys / changed defaults after an upgrade).
  if (fs.existsSync(destDir)) {
    refreshAgentDefaultsIfVersionChanged(destDir);
    return { path: destDir, fromTemplates: false, created: false };
  }

  const srcDir = resourcePath("agent-config");
  console.log(`[backend] Initializing agent-config in userData from ${srcDir}`);

  if (!fs.existsSync(srcDir)) {
    console.warn(`[backend] Bundled agent-config not found at ${srcDir} — creating empty dir`);
    fs.mkdirSync(destDir, { recursive: true });
    return { path: destDir, fromTemplates: false, created: true };
  }

  // Hoisted so the return below can read them even after the try/catch.
  let fileMappings: { src: string; dest: string }[] = [];
  let templateMappings: { src: string; dest: string }[] = [];

  try {
    fs.mkdirSync(destDir, { recursive: true });

    fileMappings = [];
    templateMappings = [];

    // Check for live files first; fall back to .template.* files
    for (const name of ["pipeline.json", "tools.json", "system-prompt.md"]) {
      const liveSrc = path.join(srcDir, name);
      const templateSrc = path.join(srcDir, name.replace(".json", ".template.json").replace(".md", ".template.md"));
      const dest = path.join(destDir, name);

      if (fs.existsSync(liveSrc)) {
        fileMappings.push({ src: liveSrc, dest });
      } else if (fs.existsSync(templateSrc)) {
        templateMappings.push({ src: templateSrc, dest });
      }
    }

    // Copy live files
    for (const m of fileMappings) {
      fs.copyFileSync(m.src, m.dest);
      console.log(`[backend]   Copied: ${path.basename(m.src)}`);
    }

    // Copy template files as live files (fresh clone after gitignore)
    for (const m of templateMappings) {
      fs.copyFileSync(m.src, m.dest);
      console.log(`[backend]   Copied template → ${path.basename(m.dest)}`);
    }

    // Seed .defaults/ in userData
    const srcDefaults = path.join(srcDir, ".defaults");
    const destDefaults = path.join(destDir, ".defaults");
    if (fs.existsSync(srcDefaults)) {
      fs.mkdirSync(destDefaults, { recursive: true });
      for (const name of ["pipeline.json", "tools.json", "system-prompt.md"]) {
        const s = path.join(srcDefaults, name);
        const d = path.join(destDefaults, name);
        if (fs.existsSync(s)) {
          fs.copyFileSync(s, d);
        }
      }
      console.log(`[backend]   Seeded .defaults/ from bundled snapshot`);
    } else {
      // No bundled .defaults/ — snapshot the live files we just copied
      fs.mkdirSync(destDefaults, { recursive: true });
      for (const m of [...fileMappings, ...templateMappings]) {
        const name = path.basename(m.dest);
        const d = path.join(destDefaults, name);
        fs.copyFileSync(m.dest, d);
      }
      console.log(`[backend]   Seeded .defaults/ from live files (no bundled snapshot)`);
    }

    // Stamp the defaults snapshot with the current app version
    try {
      fs.writeFileSync(path.join(destDefaults, "version.json"), JSON.stringify({ version: app.getVersion() }, null, 2), "utf8");
    } catch {
      // non-fatal — snapshot just won't carry a version stamp
    }

    console.log(`[backend] ✅ Agent config initialized at ${destDir}`);
  } catch (err: any) {
    console.error(`[backend] ❌ Agent config init failed: ${err.message}`);
    // Ensure dir exists even if copy failed partially
    fs.mkdirSync(destDir, { recursive: true });
  }

  const fromTemplates = templateMappings.length > 0 && fileMappings.length === 0;
  return { path: destDir, fromTemplates, created: true };
}

/**
 * Kill a child process — SIGTERM on Unix, taskkill on Windows.
 * On Windows, SIGTERM is not supported; taskkill /pid ensures
 * the entire process tree is terminated.
 */
async function killProcess(proc: ChildProcess): Promise<void> {
  if (!proc || !proc.pid) return;
  if (IS_WIN) {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // process already gone
    }
  } else {
    proc.kill("SIGTERM");
    // Give the process 2 seconds to exit gracefully, then force-kill
    await new Promise((r) => setTimeout(r, 2000));
    try {
      // Check if still alive — SIGKILL if so
      process.kill(proc.pid, 0);
      proc.kill("SIGKILL");
      console.log(`[backend] Force-killed PID ${proc.pid} with SIGKILL (graceful shutdown timed out)`);
    } catch {
      // Process already exited — good
    }
  }
}

/** Resolve the Python backend binary path. */
function resolvePythonBin(backendDir: string): { bin: string; args: string[] } {
  // Production (packaged): use PyInstaller standalone binary
  if (isProd) {
    const ext = IS_WIN ? ".exe" : "";

    // Check both PyInstaller output layouts (varies by version/platform):
    //   Nested:  <backendDir>/main/main(.exe)   — PyInstaller >=6 with --onedir --distpath <dir>
    //   Flat:    <backendDir>/main(.exe)         — older PyInstaller or different distpath usage
    const candidates = [
      path.join(backendDir, "main", `main${ext}`), // nested
      path.join(backendDir, `main${ext}`), // flat
    ];

    for (const pyBin of candidates) {
      if (fs.existsSync(pyBin)) {
        console.log(`[backend] Using standalone Python binary: ${pyBin}`);
        return { bin: pyBin, args: [] };
      }
    }

    console.log(`[backend] Standalone binary not found (tried: ${candidates.join(", ")}) — falling back to system Python`);
  }

  // Dev: try venv first, then system Python
  const venvPython = path.join(backendDir, IS_WIN ? "venv\\Scripts\\python.exe" : "venv", "bin", PYTHON_BIN);
  if (fs.existsSync(venvPython)) {
    return { bin: venvPython, args: ["main.py"] };
  }
  return { bin: PYTHON_BIN, args: ["main.py"] };
}

// ── Python Backend ──

let pythonProcess: ChildProcess | null = null;

/** Track the last few stderr lines from the Python process for diagnostics. */
let pythonStderrTail: string[] = [];
const PYTHON_STDERR_TAIL_SIZE = 10;

async function waitForServer(url: string, timeoutMs = 15000, isAlive?: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // If the process has already exited, fail fast with the actual stderr output
    if (isAlive && !isAlive()) {
      const stderrTail = pythonStderrTail.length > 0 ? "\n  Last stderr output:\n    " + pythonStderrTail.join("\n    ") : "";
      throw new Error(`Server at ${url} did not start — process exited before becoming ready.${stderrTail}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Timed out — include stderr tail for diagnostics
  const stderrTail = pythonStderrTail.length > 0 ? "\n  Last stderr output:\n    " + pythonStderrTail.join("\n    ") : "";
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms.${stderrTail}`);
}

export async function startPythonBackend(port = 5001): Promise<void> {
  // Clear any stale process on the target port first
  await killProcessOnPort(port);

  const backendDir = resourcePath("python-backend");
  const { bin: pythonBin, args: pythonArgs } = resolvePythonBin(backendDir);

  console.log(`[backend] Starting Python backend at ${backendDir}`);
  console.log(`[backend] Using: ${pythonBin} ${pythonArgs.join(" ") || "(standalone binary)"}`);

  // Determine ffmpeg path: managed binary (userData/bin/ffmpeg) or system PATH
  const ffmpegPath = ffmpegTargetPath();
  const ffmpegEnv = fs.existsSync(ffmpegPath) ? { FFMPEG_PATH: ffmpegPath } : {};

  pythonProcess = spawn(pythonBin, pythonArgs, {
    cwd: backendDir,
    env: {
      ...getChildEnv(),
      ...ffmpegEnv,
      PYTHONUNBUFFERED: "1",
      // Force UTF-8 so the backend (which prints emoji during startup, e.g.
      // patches.py's "✅") doesn't crash with UnicodeEncodeError under the
      // Windows ANSI code page (cp1252) when stdout is piped. Also propagates
      // UTF-8 mode to backend subprocesses (whisper/diarization).
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      TRANSCRIPTION_PORT: String(port),
      TRANSCRIPTION_STORAGE: path.join(app.getPath("userData"), "storage"),
      TRANSCRIPTION_QUEUE_DIR: path.join(app.getPath("userData"), "queue"),
      TRANSCRIPTION_TRIGGER_FILE: path.join(app.getPath("userData"), "queue", ".transcription-trigger"),
      ELECTRON_LOGS_DIR: path.join(app.getPath("userData"), "logs"),
      // PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.7",
      // PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // ── Line-buffered stdout handler ──
  // The OS pipe buffer can split Python's stdout at arbitrary byte boundaries,
  // so a single print() line may arrive across multiple `data` events.  We
  // buffer chunks and split by actual newlines to guarantee each message is
  // a complete line with the [tag] prefix intact.
  let stdoutBuffer = "";

  pythonProcess.stdout?.on("data", (d: Buffer) => {
    stdoutBuffer += d.toString();
    const lines = stdoutBuffer.split("\n");
    // Keep the last (potentially incomplete) fragment in the buffer
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      const subSource = extractSubSource(msg);
      // Only strip a [tag] prefix from the message if it actually starts with
      // a word-only tag (e.g. [transcription]).  Whisper timestamp lines
      // like [01:21.560 --> ...] get a synthetic "transcription" subSource
      // but the message itself has no tag to strip.
      const cleanMsg = subSource && /^\[\w+\]/.test(msg) ? msg.replace(/^\[\w+\]\s*/, "") : msg;
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[python] ${subTag}${cleanMsg}`);
      addLog("python", "info", cleanMsg, subSource);
    }
  });

  pythonProcess.stdout?.on("end", () => {
    // Flush any remaining data on stream end
    const remaining = stdoutBuffer.trim();
    if (remaining) {
      const subSource = extractSubSource(remaining);
      const cleanMsg = subSource && /^\[\w+\]/.test(remaining) ? remaining.replace(/^\[\w+\]\s*/, "") : remaining;
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[python] ${subTag}${cleanMsg}`);
      addLog("python", "info", cleanMsg, subSource);
    }
    stdoutBuffer = "";
  });

  // ── Line-buffered stderr handler (same approach) ──
  let stderrBuffer = "";

  pythonProcess.stderr?.on("data", (d: Buffer) => {
    stderrBuffer += d.toString();
    // Keep a rolling tail of stderr for diagnostics when health check fails
    const rawLines = stderrBuffer.split("\n");
    for (const ln of rawLines.slice(0, -1)) {
      const trimmed = ln.trim();
      if (trimmed) {
        pythonStderrTail.push(trimmed);
        if (pythonStderrTail.length > PYTHON_STDERR_TAIL_SIZE) {
          pythonStderrTail.shift();
        }
      }
    }
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      const subSource = extractSubSource(msg);
      const cleanMsg = subSource ? msg.replace(/^\[\w+\]\s*/, "") : msg;
      const subTag = subSource ? `[${subSource}] ` : "";
      console.error(`[python:err] ${subTag}${cleanMsg}`);
      addLog("python", "error", cleanMsg, subSource);
    }
  });

  pythonProcess.stderr?.on("end", () => {
    const remaining = stderrBuffer.trim();
    if (remaining) {
      const subSource = extractSubSource(remaining);
      const cleanMsg = subSource ? remaining.replace(/^\[\w+\]\s*/, "") : remaining;
      addLog("python", "error", cleanMsg, subSource);
    }
    stderrBuffer = "";
  });

  pythonProcess.on("exit", (code) => {
    console.log(`[backend] Python process exited with code ${code}`);
    pythonProcess = null;
    persistChildPids();
  });

  await waitForServer(
    `http://127.0.0.1:${port}/health`,
    60000, // 60s timeout — PyInstaller binary + PyTorch init can be slow on Windows
    () => pythonProcess !== null && pythonProcess.exitCode === null,
  );
  console.log(`[backend] Python backend is ready on :${port}`);
  persistChildPids();
}

export async function stopPythonBackend(): Promise<void> {
  if (pythonProcess) {
    await killProcess(pythonProcess);
    pythonProcess = null;
  }
}

// ── Bridge Server ──

let bridgeProcess: ChildProcess | null = null;

export async function startBridgeServer(bridgePort = 5010, pythonPort = 5001): Promise<void> {
  // Clear any stale process on the target port first
  await killProcessOnPort(bridgePort);

  const bridgeDir = resourcePath("bridge-server");
  const nodeBin = resolveNodeBin();

  console.log(`[bridge] Starting bridge server at ${bridgeDir}`);

  bridgeProcess = spawn(nodeBin, ["index.js"], {
    cwd: bridgeDir,
    env: {
      ...getChildEnv(),
      BRIDGE_PORT: String(bridgePort),
      PYTHON_API_URL: `http://127.0.0.1:${pythonPort}`,
      ELECTRON_LOGS_DIR: path.join(app.getPath("userData"), "logs"),
      TRANSCRIPTION_STORAGE: path.join(app.getPath("userData"), "storage"),
      // Point the bridge at the writable userData copy of agent-config
      AGENT_CONFIG_DIR: getUserDataAgentConfigDir(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // ── Line-buffered stdout handler (same approach as python) ──
  let bridgeStdoutBuffer = "";

  bridgeProcess.stdout?.on("data", (d: Buffer) => {
    bridgeStdoutBuffer += d.toString();
    const lines = bridgeStdoutBuffer.split("\n");
    bridgeStdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      // Extract tool name from lines like "→ transcribe_models_status (job=?)" → "models_status"
      const toolMatch = msg.match(/→ (?:transcribe_)?(\w+)/);
      // Fallback: extract route from HTTP request lines like "GET /health" → "health"
      const httpMatch = !toolMatch ? msg.match(/^(GET|POST|PUT|DELETE|PATCH)\s+\/(\S+)/) : null;
      const subSource = toolMatch ? toolMatch[1] : httpMatch ? httpMatch[2].replace(/\//g, "_") : undefined;
      // Strip any [bridge] prefix the bridge server itself writes (avoid double-label)
      const cleanMsg = msg.replace(/^\[bridge\]\s*/, "");
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[bridge] ${subTag}${cleanMsg}`);
      addLog("bridge", "info", cleanMsg, subSource);
    }
  });

  bridgeProcess.stdout?.on("end", () => {
    const remaining = bridgeStdoutBuffer.trim();
    if (remaining) {
      const msg = remaining;
      const toolMatch = msg.match(/→ (?:transcribe_)?(\w+)/);
      // Fallback: extract route from HTTP request lines like "GET /health" → "health"
      const httpMatch = !toolMatch ? msg.match(/^(GET|POST|PUT|DELETE|PATCH)\s+\/(\S+)/) : null;
      const subSource = toolMatch ? toolMatch[1] : httpMatch ? httpMatch[2].replace(/\//g, "_") : undefined;
      const cleanMsg = msg.replace(/^\[bridge\]\s*/, "");
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[bridge] ${subTag}${cleanMsg}`);
      addLog("bridge", "info", cleanMsg, subSource);
    }
    bridgeStdoutBuffer = "";
  });

  bridgeProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (!msg) return;
    console.error(`[bridge:err] ${msg}`);
    addLog("bridge", "error", msg);
  });

  bridgeProcess.on("exit", (code) => {
    console.log(`[bridge] Bridge process exited with code ${code}`);
    bridgeProcess = null;
    persistChildPids();
  });

  await waitForServer(`http://127.0.0.1:${bridgePort}/health`);
  console.log(`[bridge] Bridge server is ready on :${bridgePort}`);
  persistChildPids();
}

export async function stopBridgeServer(): Promise<void> {
  if (bridgeProcess) {
    await killProcess(bridgeProcess);
    bridgeProcess = null;
  }
}

// ── Agent Runner ──

let agentProcess: ChildProcess | null = null;

/** Check if the agent child process is still alive. */
export function isAgentRunning(): boolean {
  return agentProcess !== null && agentProcess.exitCode === null;
}

// ── Ollama — Download & Install ──

/** Known Ollama install paths per platform. */
function ollamaInstallPaths(): string[] {
  if (IS_WIN) {
    return [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
      path.join(process.env.PROGRAMFILES || "", "Ollama", "ollama.exe"),
      "ollama",
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/Ollama.app/Contents/MacOS/Ollama", "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "ollama"];
  }
  // Linux
  return ["ollama"];
}

/** Check if the Ollama binary is installed on the system. */
function isOllamaInstalled(): boolean {
  const nullDevice = IS_WIN ? "nul" : "/dev/null";
  for (const p of ollamaInstallPaths()) {
    try {
      const versionOutput = execSync(`"${p}" --version 2>${nullDevice} || ${p} --version 2>${nullDevice}`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();
      addLog("main", "info", `[ollama] Binary found at "${p}": ${versionOutput}`);
      return true;
    } catch {
      continue;
    }
  }
  addLog("main", "warn", "[ollama] No Ollama binary found on system");
  return false;
}

/** Ollama download URLs per platform. */
function ollamaDownloadUrl(): string {
  if (IS_WIN) return "https://ollama.com/download/OllamaSetup.exe";
  if (process.platform === "darwin") return "https://ollama.com/download/Ollama-darwin.zip";
  return "https://ollama.com/install.sh"; // Linux
}

/**
 * Download a file from a URL to a local path using fetch + streaming.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  addLog("main", "info", `[ollama] Downloading ${url} → ${destPath}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body stream");

  const writer = fs.createWriteStream(destPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
    }
  } finally {
    writer.end();
    reader.releaseLock();
  }

  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

/**
 * Install Ollama on the current platform.
 *
 * - macOS: download .zip, unzip to /Applications/Ollama.app
 * - Windows: download .exe, run silently
 * - Linux: pipe install.sh into sh
 *
 * Throws on failure.
 */
async function installOllama(): Promise<void> {
  const tmpDir = app.getPath("temp");
  addLog("main", "info", "[ollama] Ollama not found — downloading & installing...");

  if (IS_WIN) {
    const exePath = path.join(tmpDir, "OllamaSetup.exe");
    await downloadFile("https://ollama.com/download/OllamaSetup.exe", exePath);
    addLog("main", "info", "[ollama] Running OllamaSetup.exe (silent install)...");
    const winOutput = execSync(`"${exePath}" /S`, { encoding: "utf8", stdio: "pipe", timeout: 120_000 }).trim();
    if (winOutput) addLog("main", "info", `[ollama:install] ${winOutput}`);
  } else if (process.platform === "darwin") {
    const zipPath = path.join(tmpDir, "Ollama-darwin.zip");
    await downloadFile("https://ollama.com/download/Ollama-darwin.zip", zipPath);
    addLog("main", "info", "[ollama] Extracting Ollama.app to /Applications...");
    const macOutput = execSync(`unzip -o "${zipPath}" -d /Applications && rm -f "${zipPath}"`, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    }).trim();
    if (macOutput) addLog("main", "info", `[ollama:install] ${macOutput.split("\n").slice(0, 5).join("; ")}...`);
  } else {
    // Linux — pipe install script directly into sh
    addLog("main", "info", "[ollama] Running Ollama Linux install script...");
    const linuxOutput = execSync(`curl -fsSL https://ollama.com/install.sh | sh`, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
    }).trim();
    if (linuxOutput) addLog("main", "info", `[ollama:install] ${linuxOutput.split("\n").slice(-3).join("; ")}`);
  }

  // Write a sentinel so the uninstaller knows Ollama was auto-installed
  try {
    const sentinelPath = path.join(app.getPath("userData"), ".ollama-auto-installed");
    fs.writeFileSync(sentinelPath, new Date().toISOString(), "utf8");
    addLog("main", "info", "[ollama] Marked as auto-installed for clean uninstall");
  } catch {
    // non-critical
  }

  addLog("main", "info", "[ollama] Installation complete");
}

/**
 * Check if the Ollama server is running using the CLI.
 * Runs `ollama list` — returns true (server up) or false (down/unreachable).
 */
function checkOllamaServer(): boolean {
  try {
    const output = execSync("ollama list", {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
    const lines = output.split("\n").filter((l) => l.trim());
    const modelCount = Math.max(0, lines.length - 1); // Subtract header row
    addLog("main", "info", `[ollama] Server healthy (${modelCount} model(s) pulled)`);
    if (modelCount > 0) {
      const names = lines
        .slice(1)
        .map((l) => l.trim().split(/\s{2,}/)[0])
        .filter(Boolean)
        .join(", ");
      addLog("main", "info", `[ollama] Available models: ${names}`);
    }
    return true;
  } catch (err: any) {
    addLog("main", "debug", `[ollama] Server check failed: ${err.message}`);
    return false;
  }
}

/**
 * Try to launch the Ollama server in the background.
 *
 * Uses `spawn` with `detached: true` and `.unref()` so the Ollama server
 * runs independently as a daemon — NOT as a child of execSync (which would
 * kill it on timeout, since ollama serve runs continuously).
 *
 * CLI output is routed through our logging system via pipe listeners.
 * The caller (ensureOllamaRunning) polls checkOllamaServer() to confirm
 * the server is actually ready before returning.
 */
function launchOllama(): boolean {
  const findBinary = (): string | null => {
    for (const p of ollamaInstallPaths()) {
      try {
        addLog("main", "debug", `[ollama] Checking binary at: ${p}`);
        execSync(`"${p}" --version`, { stdio: "pipe", timeout: 3000 });
        addLog("main", "info", `[ollama] Found binary at: ${p}`);
        return p;
      } catch {
        addLog("main", "debug", `[ollama] Binary not found at: ${p}`);
        continue;
      }
    }
    return null;
  };

  const bin = findBinary();
  if (!bin) {
    addLog("main", "error", "[ollama] Cannot launch — Ollama binary not found");
    return false;
  }

  addLog("main", "info", `[ollama] Launching: ${bin} serve`);

  const proc = spawn(bin, ["serve"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Inherit the current environment so OLLAMA_HOST etc. are picked up
    env: { ...process.env },
  });

  // Log stdout/stderr for debugging (don't buffer — pipe directly)
  proc.stdout?.on("data", (d: Buffer) => {
    const lines = d.toString().trim().split("\n");
    for (const line of lines) {
      if (line) addLog("main", "info", `[ollama:serve] ${line}`);
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const lines = d.toString().trim().split("\n");
    for (const line of lines) {
      if (line) addLog("main", "warn", `[ollama:serve:err] ${line}`);
    }
  });

  proc.on("error", (err) => {
    addLog("main", "error", `[ollama] Failed to spawn: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    addLog("main", "info", `[ollama] Process exited — code=${code} signal=${signal}`);
  });

  // Detach — allow parent to exit independently
  proc.unref();

  addLog("main", "info", `[ollama] Spawned PID ${proc.pid} — waiting for server to become ready...`);
  return true;
}

// ── Ollama auto-start ──

/** Tracks whether we launched Ollama ourselves (vs. it was already running). */
let _ollamaStartedByUs = false;

/** Returns true if this session started Ollama (and thus should stop it). */
export function ollamaStartedByUs(): boolean {
  return _ollamaStartedByUs;
}

/**
 * If the LLM provider is Ollama, ensure the Ollama server is running.
 *
 * Steps:
 *   1. Quick health check — if running, return
 *   2. Check installed — if not, download & install for the platform
 *   3. Launch the Ollama application/server
 *   4. Wait for health check to succeed
 *
 * Returns true if Ollama is (or became) available, false otherwise.
 * Non-blocking for the caller — the agent runner will retry on connection failure.
 */
export async function ensureOllamaRunning(force = false): Promise<boolean> {
  const env = getChildEnv();
  if (!force && env.LLM_PROVIDER !== "ollama") return true; // not using Ollama

  addLog("main", "info", `[ollama] Checking Ollama (OLLAMA_BASE_URL=${env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1"})...`);

  // ── 1. Quick health check ──
  if (checkOllamaServer()) {
    addLog("main", "info", "[ollama] Ollama is already running");
    _ollamaStartedByUs = false;
    return true;
  }

  // ── 2. Check installed; download + install if missing ──
  if (!isOllamaInstalled()) {
    addLog("main", "info", "[ollama] Ollama is not installed — will download and install");
    try {
      await installOllama();
    } catch (err: any) {
      addLog("main", "error", `[ollama] Installation failed: ${err.message}`);
      // Don't give up — the server might already be running from a previous install
    }
  }

  // ── 2b. Re-check after install ──
  // On Windows, OllamaSetup.exe /S usually auto-starts the server, so spawning
  // `ollama serve` again would fail on the port. Re-check before launching.
  if (checkOllamaServer()) {
    addLog("main", "info", "[ollama] Ollama is already running (started during install)");
    _ollamaStartedByUs = false;
    return true;
  }

  // ── 3. Launch ──
  addLog("main", "info", "[ollama] Launching Ollama...");
  launchOllama();

  // ── 4. Wait for it to come online ──
  addLog("main", "info", "[ollama] Waiting for Ollama to start...");
  const MAX_RETRIES = 12; // ~36 seconds total
  for (let i = 0; i < MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (checkOllamaServer()) {
      addLog("main", "info", "[ollama] Ollama is now running");
      _ollamaStartedByUs = true;
      return true;
    }
    addLog("main", "info", `[ollama] Still waiting... (attempt ${i + 1}/${MAX_RETRIES})`);

    // On macOS, if the app bundle binary didn't start the server,
    // try the standalone `ollama` CLI binary as a fallback.
    if (process.platform === "darwin" && i === 2) {
      const altPaths = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "ollama"];
      const cliBin = altPaths.find((p) => {
        try {
          execSync(p === "ollama" ? "ollama --version" : `"${p}" --version`, { stdio: "pipe", timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      });
      if (cliBin) {
        addLog("main", "info", `[ollama] Trying standalone CLI: ${cliBin} serve`);
        const fallbackProc = spawn(cliBin, ["serve"], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });
        fallbackProc.stdout?.on("data", (d: Buffer) => {
          for (const line of d.toString().trim().split("\n")) {
            if (line) addLog("main", "info", `[ollama:serve:fallback] ${line}`);
          }
        });
        fallbackProc.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString().trim().split("\n")) {
            if (line) addLog("main", "warn", `[ollama:serve:fallback:err] ${line}`);
          }
        });
        fallbackProc.on("error", (err) => addLog("main", "error", `[ollama] Fallback spawn failed: ${err.message}`));
        fallbackProc.on("exit", (code, signal) => {
          addLog("main", "info", `[ollama] Fallback process exited — code=${code} signal=${signal}`);
        });
        fallbackProc.unref();
        addLog("main", "info", "[ollama] Spawned fallback `ollama serve` from standalone CLI");
      } else {
        addLog("main", "warn", "[ollama] No standalone ollama CLI found — server may not be available");
      }
    }
  }

  addLog("main", "warn", "[ollama] Ollama did not start in time after " + MAX_RETRIES * 3 + "s — agent runner will retry on connection");
  return false;
}

/**
 * Stop the Ollama server process.
 * Platform-specific — uses the most reliable method per OS.
 */
export function stopOllamaServer(): void {
  addLog("main", "info", "[ollama] Stopping Ollama server...");

  // Log what processes we're about to try to kill (for diagnostics)
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const before = execSync("pgrep -ifl ollama 2>/dev/null || true", { encoding: "utf8", timeout: 3000 }).trim();
      if (before) {
        addLog("main", "info", `[ollama] Processes matching "ollama" before stop:\n${before}`);
      } else {
        addLog("main", "debug", "[ollama] No Ollama processes found before stop");
      }
    } catch {
      // pgrep not available or failed — non-critical
    }
  }

  try {
    if (IS_WIN) {
      execSync("taskkill /IM ollama.exe /F", { stdio: "pipe", timeout: 5000 });
      addLog("main", "info", "[ollama] taskkill /IM ollama.exe /F succeeded");
    } else if (process.platform === "darwin") {
      // On macOS, Ollama may run as a CLI serve process (name "ollama" or "Ollama")
      // or as a GUI app. Use case-insensitive pkill (-i) to catch both,
      // plus osascript to quit the GUI app if it's running.
      // First send SIGTERM for graceful shutdown
      const pkillOut = execSync("pkill -i ollama 2>&1; exit 0", { encoding: "utf8", timeout: 5000 }).trim();
      addLog("main", "info", `[ollama] pkill -i ollama: ${pkillOut || "no output (processes killed or none found)"}`);
      // Brief pause to let processes terminate gracefully
      syncSleep(1);
      // Then force-kill any remaining processes with SIGKILL (-9)
      const pkill9Out = execSync("pkill -i -9 ollama 2>&1; exit 0", { encoding: "utf8", timeout: 5000 }).trim();
      if (pkill9Out) addLog("main", "info", `[ollama] pkill -9 follow-up: ${pkill9Out}`);
      const osaOut = execSync("osascript -e 'quit app \"Ollama\"' 2>&1; exit 0", { encoding: "utf8", timeout: 5000 }).trim();
      if (osaOut) addLog("main", "info", `[ollama] osascript quit Ollama.app: ${osaOut}`);
    } else {
      // First send SIGTERM, then SIGKILL after a brief pause
      const pkillOut = execSync("pkill -i ollama 2>&1; exit 0", { encoding: "utf8", timeout: 5000 }).trim();
      addLog("main", "info", `[ollama] pkill -i ollama: ${pkillOut || "no output (process killed or none found)"}`);
      syncSleep(1);
      const pkill9Out = execSync("pkill -i -9 ollama 2>&1; exit 0", { encoding: "utf8", timeout: 5000 }).trim();
      if (pkill9Out) addLog("main", "info", `[ollama] pkill -9 follow-up: ${pkill9Out}`);
    }

    // Verify nothing is left
    if (!IS_WIN) {
      try {
        const remaining = execSync("pgrep -ifl ollama 2>/dev/null || true", { encoding: "utf8", timeout: 3000 }).trim();
        if (remaining) {
          addLog("main", "warn", `[ollama] Some processes may still remain:\n${remaining}`);
        } else {
          addLog("main", "info", "[ollama] No remaining Ollama processes — server stopped successfully");
        }
      } catch {
        // non-critical
      }
    } else {
      addLog("main", "info", "[ollama] Ollama stop commands completed");
    }
  } catch (err: any) {
    // Process may already be gone — not an error
    addLog("main", "debug", `[ollama] Stop command note: ${err.message}`);
  }
  _ollamaStartedByUs = false;
}
// \u2500\u2500 ffmpeg \u2014 Download & Install \u2500\u2500

/** Known ffmpeg install paths per platform. */
function ffmpegInstallPaths(): string[] {
  const managedPath = path.join(app.getPath("userData"), "bin", IS_WIN ? "ffmpeg.exe" : "ffmpeg");
  return [managedPath, "ffmpeg"];
}

/** Path where we place the managed ffmpeg binary. */
function ffmpegTargetPath(): string {
  return path.join(app.getPath("userData"), "bin", IS_WIN ? "ffmpeg.exe" : "ffmpeg");
}

/** ffmpeg download URLs per platform. */
function ffmpegDownloadUrl(): string {
  if (IS_WIN) return "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
  if (process.platform === "darwin") return "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip";
  // Linux \u2014 johnvansickle.com static build
  return "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
}

/** Check if ffmpeg is available (on PATH or already installed by us). */
function isFfmpegInstalled(): boolean {
  const nullDevice = IS_WIN ? "nul" : "/dev/null";
  for (const p of ffmpegInstallPaths()) {
    try {
      execSync(`\"${p}\" -version 2>${nullDevice} || ${p} -version 2>${nullDevice}`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Download and extract ffmpeg to userData/bin/.
 *
 * - macOS: download .zip, extract single ffmpeg binary
 * - Windows: download .zip, find ffmpeg.exe in the extracted tree
 * - Linux: download .tar.xz, find ffmpeg binary
 *
 * Throws on failure.
 */
async function installFfmpeg(): Promise<void> {
  const tmpDir = app.getPath("temp");
  const targetDir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(targetDir, { recursive: true });

  addLog("main", "info", `[ffmpeg] Not found \u2014 downloading & installing...`);

  if (IS_WIN) {
    const zipPath = path.join(tmpDir, "ffmpeg.zip");
    await downloadFile(ffmpegDownloadUrl(), zipPath);

    addLog("main", "info", "[ffmpeg] Extracting ffmpeg.zip...");
    const extractDir = path.join(tmpDir, "ffmpeg_extract");
    fs.mkdirSync(extractDir, { recursive: true });

    // Prefer the built-in bsdtar (ships with Win10 1803+/Server 2019+) — the
    // PowerShell 5.1 Expand-Archive cmdlet has a known "Length cannot be less
    // than zero" bug on large archives. Fall back to the .NET ZipFile API.
    let zipExtracted = false;
    try {
      execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: "pipe", timeout: 60_000 });
      zipExtracted = true;
    } catch (err: any) {
      addLog("main", "warn", `[ffmpeg] tar.exe extraction failed (${err.message}) — falling back to .NET ZipFile`);
    }
    if (!zipExtracted) {
      const psQuotedZip = `'${zipPath.replace(/'/g, "''")}'`;
      const psQuotedDir = `'${extractDir.replace(/'/g, "''")}'`;
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuotedZip}, ${psQuotedDir})"`,
        { stdio: "pipe", timeout: 60_000 },
      );
    }

    // Find ffmpeg.exe anywhere in the extracted tree
    const result = execSync(`where /r \"${extractDir}\" ffmpeg.exe 2>nul || dir /s /b \"${extractDir}\"\\ffmpeg.exe 2>nul`, {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const exePath = result.split(/\r?\n/)[0];
    if (!exePath) throw new Error("Could not find ffmpeg.exe in extracted archive");

    fs.copyFileSync(exePath, ffmpegTargetPath());
    addLog("main", "info", `[ffmpeg] Installed to ${ffmpegTargetPath()}`);

    // Cleanup
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  } else {
    const archivePath = path.join(tmpDir, "ffmpeg-archive");
    const extractDir = path.join(tmpDir, "ffmpeg_extract");
    fs.mkdirSync(extractDir, { recursive: true });

    if (process.platform === "darwin") {
      // macOS .zip
      await downloadFile(ffmpegDownloadUrl(), archivePath);
      addLog("main", "info", "[ffmpeg] Extracting zip...");
      execSync(`unzip -o \"${archivePath}\" -d \"${extractDir}\"`, { stdio: "pipe", timeout: 30_000 });
    } else {
      // Linux .tar.xz
      await downloadFile(ffmpegDownloadUrl(), archivePath);
      addLog("main", "info", "[ffmpeg] Extracting tar.xz...");
      execSync(`tar -xf \"${archivePath}\" -C \"${extractDir}\"`, { stdio: "pipe", timeout: 30_000 });
    }

    // Find the ffmpeg binary in the extracted tree
    const result = execSync(`find \"${extractDir}\" -name \"ffmpeg\" -type f | head -1`, { encoding: "utf8", timeout: 10_000 }).trim();
    if (!result) throw new Error("Could not find ffmpeg binary in extracted archive");

    fs.copyFileSync(result, ffmpegTargetPath());
    fs.chmodSync(ffmpegTargetPath(), 0o755);
    addLog("main", "info", `[ffmpeg] Installed to ${ffmpegTargetPath()}`);

    // Cleanup
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  // Write a sentinel so the uninstaller knows ffmpeg was auto-installed
  try {
    const sentinelPath = path.join(app.getPath("userData"), ".ffmpeg-auto-installed");
    fs.writeFileSync(sentinelPath, new Date().toISOString(), "utf8");
    addLog("main", "info", "[ffmpeg] Marked as auto-installed for clean uninstall");
  } catch {
    // non-critical
  }

  addLog("main", "info", "[ffmpeg] Installation complete");
}

/**
 * Ensure ffmpeg is available before starting the Python backend.
 *
 * Steps:
 *   1. Check if ffmpeg is on PATH or already managed
 *   2. If not, download and install to userData/bin/
 *   3. Set FFMPEG_PATH env var for the Python backend
 */
export async function ensureFfmpegAvailable(): Promise<string | null> {
  addLog("main", "info", "[ffmpeg] Checking availability...");

  if (isFfmpegInstalled()) {
    addLog("main", "info", "[ffmpeg] Already available");
    // Return the managed path if it exists, otherwise null (system PATH)
    const managed = ffmpegTargetPath();
    if (fs.existsSync(managed)) return managed;
    return null;
  }

  addLog("main", "info", "[ffmpeg] Not found on system \u2014 will download and install");
  try {
    await installFfmpeg();
    return ffmpegTargetPath();
  } catch (err: any) {
    addLog("main", "error", `[ffmpeg] Installation failed: ${err.message}`);
    addLog("main", "warn", "[ffmpeg] Audio standardization will fail \u2014 install ffmpeg manually or check internet connection");
    return null;
  }
}
export async function startAgentRunner(): Promise<void> {
  const agentDir = resourcePath("agent-runner");
  const nodeBin = resolveNodeBin();

  console.log(`[agent] Starting agent runner at ${agentDir}`);

  agentProcess = spawn(nodeBin, ["index.js"], {
    cwd: agentDir,
    env: {
      ...getChildEnv(),
      BRIDGE_URL: "http://127.0.0.1:5010",
      TRANSCRIPTION_STORAGE: path.join(app.getPath("userData"), "storage"),
      TRANSCRIPTION_QUEUE_DIR: path.join(app.getPath("userData"), "queue"),
      TRANSCRIPTION_TRIGGER_FILE: path.join(app.getPath("userData"), "queue", ".transcription-trigger"),
      TRANSCRIPTION_LOGS_DIR: path.join(app.getPath("userData"), "logs"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // ── Agent stdout handler (line-buffered) ──
  // The OS pipe buffer can split at arbitrary byte boundaries, so we
  // buffer chunks and split by newlines to guarantee each message is a
  // complete line. This lets us reliably parse [JOB_START] markers.
  let agentStdoutBuf = "";
  agentProcess.stdout?.on("data", (d: Buffer) => {
    agentStdoutBuf += d.toString();
    const lines = agentStdoutBuf.split("\n");
    agentStdoutBuf = lines.pop() || "";

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;

      // Detect job-start marker emitted by agent-runner/index.js
      //   [JOB_START] <full-uuid>
      const jobStartMatch = msg.match(/^\[JOB_START\]\s*([a-f0-9-]+)/i);
      if (jobStartMatch) {
        const jobId = jobStartMatch[1];
        setCurrentJobId(jobId);
        console.log(`[agent] Tracking job ${jobId.slice(0, 8)} for agent logs`);
        addLog("agent", "info", `Job started: ${jobId}`, "job-start");
        _onJobStarted?.(jobId);
        continue; // don't propagate the marker to normal logging
      }

      // Extract sub-source from inline [TAG] patterns like "[RUNNER]", "[MODEL]", "[EXECUTOR]", "[Step 2 Complete]"
      // These appear after emoji/whitespace, e.g. "   📊 [MODEL] Raw API — ..."
      const tagMatch = msg.match(/\[([a-zA-Z0-9 _-]+)\]/);
      const subSource = tagMatch ? tagMatch[1].toLowerCase() : undefined;
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[agent] ${subTag}${msg}`);
      addLog("agent", "info", msg, subSource);
    }
  });

  agentProcess.stdout?.on("end", () => {
    // Flush any remaining data on stream end
    const remaining = agentStdoutBuf.trim();
    if (remaining) {
      const tagMatch = remaining.match(/\[([a-zA-Z0-9 _-]+)\]/);
      const subSource = tagMatch ? tagMatch[1].toLowerCase() : undefined;
      const subTag = subSource ? `[${subSource}] ` : "";
      console.log(`[agent] ${subTag}${remaining}`);
      addLog("agent", "info", remaining, subSource);
    }
    agentStdoutBuf = "";
  });

  // ── Agent stderr handler (line-buffered, same approach) ──
  let agentStderrBuf = "";
  agentProcess.stderr?.on("data", (d: Buffer) => {
    agentStderrBuf += d.toString();
    const lines = agentStderrBuf.split("\n");
    agentStderrBuf = lines.pop() || "";

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      console.error(`[agent:err] ${msg}`);
      addLog("agent", "error", msg);
    }
  });

  agentProcess.stderr?.on("end", () => {
    const remaining = agentStderrBuf.trim();
    if (remaining) {
      console.error(`[agent:err] ${remaining}`);
      addLog("agent", "error", remaining);
    }
    agentStderrBuf = "";
  });

  agentProcess.on("exit", (code) => {
    console.log(`[agent] Agent process exited with code ${code}`);
    agentProcess = null;
    persistChildPids();
  });

  // Agent runner doesn't have an HTTP health endpoint — it
  // starts listening for trigger file changes immediately.
  // Give it a moment to initialize and check it's still alive.
  await new Promise((r) => setTimeout(r, 1000));
  if (agentProcess) {
    console.log(`[agent] Agent runner started (PID: ${agentProcess.pid})`);
    persistChildPids();
  } else {
    throw new Error("Agent runner exited immediately after starting — check agent-runner/index.js for errors");
  }
}

export async function stopAgentRunner(): Promise<void> {
  if (agentProcess) {
    await killProcess(agentProcess);
    agentProcess = null;
  }
}

// ── Per-service restart ──

export async function restartPythonBackend(): Promise<void> {
  console.log(`[backend] Restarting Python backend...`);
  await stopPythonBackend();
  await new Promise((r) => setTimeout(r, 1000));
  await startPythonBackend();
  console.log(`[backend] Python backend restarted`);
}

export async function restartBridgeServer(): Promise<void> {
  console.log(`[bridge] Restarting bridge server...`);
  await stopBridgeServer();
  await new Promise((r) => setTimeout(r, 1000));
  await startBridgeServer();
  console.log(`[bridge] Bridge server restarted`);
}

export async function restartAgentRunner(): Promise<void> {
  console.log(`[agent] Restarting agent runner...`);
  await stopAgentRunner();
  await new Promise((r) => setTimeout(r, 1000));
  await startAgentRunner();
  console.log(`[agent] Agent runner restarted`);
}

/** Get the PIDs of all three child services (useful for monitoring). */
export function getChildPids(): { python: number | null; bridge: number | null; agent: number | null } {
  return {
    python: pythonProcess?.pid ?? null,
    bridge: bridgeProcess?.pid ?? null,
    agent: agentProcess?.pid ?? null,
  };
}

// ── Combined ──

export async function startAll(): Promise<void> {
  await startPythonBackend();
  await startBridgeServer();
  await startAgentRunner();
}

export async function stopAll(): Promise<void> {
  await stopAgentRunner();
  await stopBridgeServer();
  await stopPythonBackend();
  // Always attempt to stop Ollama on quit — the server may have been started
  // by this app or independently; stopOllamaServer is idempotent if no
  // Ollama processes are found.
  stopOllamaServer();
}

/**
 * Synchronous version of stopAll — kills all child processes immediately
 * using SIGKILL (Unix) or taskkill (Windows).
 *
 * SIGKILL alone only kills the target process, not its children. To ensure
 * the entire process tree is torn down we:
 *   1. Use ChildProcess.kill(signal) which sends to the process group
 *   2. Fall back to a port-based sweep (lsof) to catch any orphans
 *      that may have taken over the backend ports
 *
 * Use this in the app quit flow (before-quit handler) where async operations
 * cannot complete before app.exit(0) terminates the process.
 */
export function stopAllSync(): void {
  const targets: Array<{ proc: ChildProcess | null; name: string; port?: number }> = [
    { proc: agentProcess, name: "agent-runner" },
    { proc: bridgeProcess, name: "bridge-server", port: 5010 },
    { proc: pythonProcess, name: "python-backend", port: 5001 },
  ];

  for (const { proc, name, port } of targets) {
    if (!proc || !proc.pid) continue;
    try {
      if (IS_WIN) {
        // taskkill /T kills the entire process tree on Windows
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
      } else {
        // ChildProcess.kill(signal) sends to the process group (negative PID)
        // which kills the process AND any children it spawned.
        proc.kill("SIGTERM");
        // Immediately follow up with SIGKILL to the process group so that
        // any process that ignores SIGTERM is still terminated.
        proc.kill("SIGKILL");
      }
      console.log(`[backend] Force-killed ${name} (PID ${proc.pid})`);
      addLog("main", "info", `Force-killed ${name} (PID ${proc.pid})`);
    } catch {
      // Process already gone — good
    }

    // Safety net: kill any leftover process on the service's port.
    // This catches orphaned children that may have been re-parented or
    // processes that took over the port after the tracked PID died.
    if (!IS_WIN && port) {
      killProcessOnPortSync(port);
    }
  }

  // Null out the references
  agentProcess = null;
  bridgeProcess = null;
  pythonProcess = null;

  // Also nuke any leftover processes on our ports
  stopOllamaServer();
}

/**
 * Synchronous version of killProcessOnPort — kills any process listening on
 * the given TCP port immediately (Unix only).
 */
function killProcessOnPortSync(port: number): void {
  try {
    const result = execSync(`lsof -ti:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8", timeout: 3000 });
    const pids = result.trim().split("\n").filter(Boolean).map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`[backend] Port sweep: killed stale PID ${pid} on port ${port}`);
        addLog("main", "info", `Port sweep: killed stale PID ${pid} on port ${port}`);
      } catch {
        // already gone
      }
    }
  } catch {
    // No process found on that port — great
  }
}

export async function restartAll(): Promise<void> {
  console.log(`[backend] Restarting all services...`);
  await stopAll();
  await new Promise((r) => setTimeout(r, 2000));
  await startAll();
  console.log(`[backend] All services restarted`);
}

// ── Health monitoring ──

let healthInterval: ReturnType<typeof setInterval> | null = null;

/** Health check a single HTTP service. Returns true if healthy. */
async function checkService(url: string, label: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return true;
    console.log(`[health] ${label} returned ${res.status}`);
    return false;
  } catch {
    return false;
  }
}

/**
 * Start periodic health monitoring of all backend services.
 * Restarts any service that is down and logs the event.
 * Call once after initial startup.
 */
export function startHealthMonitoring(): void {
  if (healthInterval) return;
  console.log(`[health] Starting periodic health monitoring (30s interval)`);
  addLog("main", "info", "Starting periodic health monitoring (30s interval)");

  healthInterval = setInterval(async () => {
    const pythonOk = await checkService("http://127.0.0.1:5001/health", "Python", 3000);
    const bridgeOk = await checkService("http://127.0.0.1:5010/health", "Bridge", 3000);

    if (!pythonOk && !pythonProcess) {
      console.log(`[health] Python backend is down — restarting...`);
      addLog("main", "warn", "Python backend is down — restarting...");
      try {
        await startPythonBackend();
        addLog("main", "info", "Python backend auto-restarted");
      } catch (err: any) {
        addLog("main", "error", `Failed to auto-restart Python: ${err.message}`);
      }
    }

    if (!bridgeOk && !bridgeProcess) {
      console.log(`[health] Bridge server is down — restarting...`);
      addLog("main", "warn", "Bridge server is down — restarting...");
      try {
        await startBridgeServer();
        addLog("main", "info", "Bridge server auto-restarted");
      } catch (err: any) {
        addLog("main", "error", `Failed to auto-restart bridge: ${err.message}`);
      }
    }

    // Agent runner has no HTTP endpoint — check if process is alive
    if (!isAgentRunning()) {
      console.log(`[health] Agent runner is down — restarting...`);
      addLog("main", "warn", "Agent runner is down — restarting...");
      try {
        await startAgentRunner();
        addLog("main", "info", "Agent runner auto-restarted");
      } catch (err: any) {
        addLog("main", "error", `Failed to auto-restart agent runner: ${err.message}`);
      }
    }
  }, 30000);
}

/** Stop health monitoring. */
export function stopHealthMonitoring(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}
