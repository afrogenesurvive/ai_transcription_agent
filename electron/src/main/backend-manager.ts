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
import { addLog } from "./logger";
import { getChildEnv } from "./config";

const isProd = app.isPackaged;
const IS_WIN = process.platform === "win32";

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

/** Kill any process listening on the given TCP port (macOS/Linux only). */
export async function killProcessOnPort(port: number): Promise<void> {
  if (IS_WIN) return; // taskkill-based cleanup in killProcess handles this
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
    const pyBin = path.join(backendDir, IS_WIN ? "main.exe" : "main");
    if (fs.existsSync(pyBin)) {
      console.log(`[backend] Using standalone Python binary: ${pyBin}`);
      return { bin: pyBin, args: [] };
    }
    console.log(`[backend] Standalone binary not found at ${pyBin} — falling back to system Python`);
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

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
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
      TRANSCRIPTION_PORT: String(port),
      TRANSCRIPTION_STORAGE: path.join(app.getPath("userData"), "storage"),
      TRANSCRIPTION_QUEUE_DIR: path.join(app.getPath("userData"), "queue"),
      ELECTRON_LOGS_DIR: path.join(app.getPath("userData"), "logs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  pythonProcess.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.log(`[python] ${msg}`);
    addLog("python", "info", msg);
  });

  pythonProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.error(`[python:err] ${msg}`);
    addLog("python", "error", msg);
  });

  pythonProcess.on("exit", (code) => {
    console.log(`[backend] Python process exited with code ${code}`);
    pythonProcess = null;
  });

  await waitForServer(`http://127.0.0.1:${port}/health`);
  console.log(`[backend] Python backend is ready on :${port}`);
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridgeProcess.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.log(`[bridge] ${msg}`);
    addLog("bridge", "info", msg);
  });

  bridgeProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.error(`[bridge:err] ${msg}`);
    addLog("bridge", "error", msg);
  });

  bridgeProcess.on("exit", (code) => {
    console.log(`[bridge] Bridge process exited with code ${code}`);
    bridgeProcess = null;
  });

  await waitForServer(`http://127.0.0.1:${bridgePort}/health`);
  console.log(`[bridge] Bridge server is ready on :${bridgePort}`);
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
      path.join(process.env.PROGRAMFILES || "", "Ollama", "ollama.exe"),
      "ollama",
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/Ollama.app/Contents/MacOS/Ollama", "ollama"];
  }
  // Linux
  return ["ollama"];
}

/** Check if the Ollama binary is installed on the system. */
function isOllamaInstalled(): boolean {
  for (const p of ollamaInstallPaths()) {
    try {
      const versionOutput = execSync(`"${p}" --version 2>/dev/null || ${p} --version`, {
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
 * Try to fetch the Ollama server health endpoint using the REST API.
 *
 * Uses Ollama's REST API directly (no SDK) — the HTTP endpoint at /api/tags
 * returns all pulled models if the server is running. This is the same API
 * surfaced by the `ollama list` CLI command.
 *
 * The response is logged so users can see what models Ollama reports.
 */
async function checkOllamaServer(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const data = await res.json();
      const modelCount = (data.models || []).length;
      addLog("main", "info", `[ollama] Server healthy at ${baseUrl} (${modelCount} model(s) pulled)`);
      if (modelCount > 0) {
        const names = data.models.map((m: any) => m.name).join(", ");
        addLog("main", "info", `[ollama] Available models: ${names}`);
      }
    } else {
      addLog("main", "warn", `[ollama] Server at ${baseUrl} returned status ${res.status}`);
    }
    return res.ok;
  } catch (err: any) {
    addLog("main", "debug", `[ollama] Server check failed for ${baseUrl}: ${err.message}`);
    return false;
  }
}

/**
 * Try to launch the Ollama app/server.
 *
 * Uses raw CLI commands (ollama serve, open -a Ollama, etc.) rather than an
 * Ollama SDK. The Ollama server exposes its own REST API on :11434 which the
 * app uses for model management (list, pull) and the OpenAI-compatible endpoint
 * for LLM inference (via the openai npm package).
 *
 * CLI output is captured and routed through our logging system so users can
 * see Ollama's own log messages in the DevPanel.
 */
function launchOllama(): boolean {
  try {
    if (IS_WIN) {
      const installedPath = ollamaInstallPaths().find((p) => {
        try {
          execSync(`"${p}" --version`, { stdio: "pipe", timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      });
      const bin = installedPath || "ollama";
      addLog("main", "info", `[ollama] Launching: ${bin} serve`);
      // Use spawn so we can capture output — but for the launch we use
      // execSync to start it. On Windows the server detaches.
      const output = execSync(`"${bin}" serve`, { encoding: "utf8", stdio: "pipe", timeout: 3000 }).trim();
      if (output) addLog("main", "info", `[ollama:serve] ${output}`);
    } else if (process.platform === "darwin") {
      addLog("main", "info", "[ollama] Launching: open -a Ollama");
      // On macOS, Ollama runs as a GUI app (menu bar icon). We launch it via
      // `open` which doesn't return server output. The server logs are
      // accessible through the Ollama menu bar app or via the REST API.
      // We cannot directly capture the server daemon's stdout/stderr here
      // because it's launched by the GUI process, not by us.
      const output = execSync("open -a Ollama", { encoding: "utf8", stdio: "pipe", timeout: 3000 }).trim();
      if (output) addLog("main", "info", `[ollama:open] ${output}`);
    } else {
      addLog("main", "info", "[ollama] Launching: ollama serve");
      // On Linux, ollama serve runs in the foreground. We capture its initial
      // output to confirm it started, then the process continues in background.
      const output = execSync("ollama serve", { encoding: "utf8", stdio: "pipe", timeout: 3000 }).trim();
      if (output) addLog("main", "info", `[ollama:serve] ${output}`);
    }
    addLog("main", "info", "[ollama] Launch command sent");
    return true;
  } catch (err: any) {
    // execSync throws on non-zero exit OR timeout. On macOS, `open` exits
    // immediately and the Ollama server starts as a background daemon —
    // its stdout/stderr are not captured by our execSync. The catch is
    // expected for short-lived commands that exit before the Ollama server
    // is fully ready. We rely on checkOllamaServer() for actual readiness.
    // Log the error but don't treat it as a failure.
    if (err.stdout) addLog("main", "info", `[ollama:launch:stdout] ${err.stdout.toString().trim()}`);
    if (err.stderr) addLog("main", "warn", `[ollama:launch:stderr] ${err.stderr.toString().trim()}`);
    addLog("main", "warn", `[ollama] Launch process exited: ${err.message}`);
    return false;
  }
}

// ── Ollama auto-start ──

/**
 * If the LLM provider is Ollama, ensure the Ollama server is running.
 *
 * Steps:
 *   1. Quick health check — if running, return
 *   2. Check if installed — if not, download & install for the platform
 *   3. Launch the Ollama application/server
 *   4. Wait for health check to succeed
 *
 * Returns true if Ollama is (or became) available, false otherwise.
 * Non-blocking for the caller — the agent runner will retry on connection failure.
 */
export async function ensureOllamaRunning(): Promise<boolean> {
  const env = getChildEnv();
  if (env.LLM_PROVIDER !== "ollama") return true; // not using Ollama

  const baseUrl = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  addLog("main", "info", `[ollama] Checking Ollama at ${baseUrl}...`);

  // ── 1. Quick health check ──
  if (await checkOllamaServer(baseUrl)) {
    addLog("main", "info", "[ollama] Ollama is already running");
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

  // ── 3. Launch ──
  addLog("main", "info", "[ollama] Launching Ollama...");
  launchOllama();

  // ── 4. Wait for it to come online ──
  addLog("main", "info", "[ollama] Waiting for Ollama to start...");
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await checkOllamaServer(baseUrl, 3000)) {
      addLog("main", "info", "[ollama] Ollama is now running");
      return true;
    }
    addLog("main", "info", `[ollama] Still waiting... (attempt ${i + 1}/6)`);
  }

  addLog("main", "warn", "[ollama] Ollama did not start in time — agent runner will retry on connection");
  return false;
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
  for (const p of ffmpegInstallPaths()) {
    try {
      execSync(`\"${p}\" -version 2>/dev/null || ${p} -version`, {
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

    // Use PowerShell to expand the zip
    execSync(`powershell -Command \"Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force\"`, { stdio: "pipe", timeout: 60_000 });

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
      TRANSCRIPTION_QUEUE_DIR: path.join(app.getPath("userData"), "queue"),
      TRANSCRIPTION_LOGS_DIR: path.join(app.getPath("userData"), "logs"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  agentProcess.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.log(`[agent] ${msg}`);
    addLog("agent", "info", msg);
  });

  agentProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    console.error(`[agent:err] ${msg}`);
    addLog("agent", "error", msg);
  });

  agentProcess.on("exit", (code) => {
    console.log(`[agent] Agent process exited with code ${code}`);
    agentProcess = null;
  });

  // Agent runner doesn't have an HTTP health endpoint — it
  // starts listening for trigger file changes immediately.
  // Give it a moment to initialize and check it's still alive.
  await new Promise((r) => setTimeout(r, 1000));
  if (agentProcess) {
    console.log(`[agent] Agent runner started (PID: ${agentProcess.pid})`);
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
    if (!agentProcess && !isAgentRunning()) {
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
