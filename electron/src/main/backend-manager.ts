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
import path from "path";
import { app } from "electron";
import { addLog } from "./logger";
import { getChildEnv } from "./config";

const isProd = app.isPackaged;
const IS_WIN = process.platform === "win32";

/** Platform-aware Python binary name */
const PYTHON_BIN = IS_WIN ? "python" : "python3";

/** Platform-aware Node binary name */
const NODE_BIN = IS_WIN ? "node.exe" : "node";

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

/** Resolve the Python binary path, preferring the project venv. */
function resolvePythonBin(backendDir: string): string {
  // Try venv first (dev, or production if venv was bundled)
  const venvPython = path.join(backendDir, IS_WIN ? "venv\\Scripts\\python.exe" : "venv", "bin", PYTHON_BIN);
  if (require("fs").existsSync(venvPython)) return venvPython;
  // Fall back to system Python (expected in production on end-user machines)
  return PYTHON_BIN;
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
  const pythonBin = resolvePythonBin(backendDir);

  console.log(`[backend] Starting Python backend at ${backendDir}`);
  console.log(`[backend] Using: ${pythonBin} main.py`);

  pythonProcess = spawn(pythonBin, ["main.py"], {
    cwd: backendDir,
    env: {
      ...getChildEnv(),
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
  const nodeBin = NODE_BIN;

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

// ── Ollama auto-start ──

/**
 * If the LLM provider is Ollama, check if the server is running.
 * If not, attempt to start it (launch the Ollama application or ollama serve).
 *
 * Returns true if Ollama is (or became) available, false otherwise.
 * Non-blocking for the caller — the agent runner will retry on connection failure.
 */
export async function ensureOllamaRunning(): Promise<boolean> {
  const env = getChildEnv();
  if (env.LLM_PROVIDER !== "ollama") return true; // not using Ollama

  const baseUrl = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  console.log(`[ollama] Checking if Ollama is running at ${baseUrl}...`);
  addLog("main", "info", `Checking Ollama at ${baseUrl}...`);

  // Try a quick health check
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`[ollama] Ollama is already running`);
      addLog("main", "info", "Ollama is already running");
      return true;
    }
  } catch {
    // Not running — will attempt to start
  }

  console.log(`[ollama] Ollama not detected — attempting to start...`);
  addLog("main", "info", "Ollama not detected — attempting to start...");

  try {
    if (IS_WIN) {
      // Try common Ollama install locations on Windows
      const possiblePaths = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
        path.join(process.env.PROGRAMFILES || "", "Ollama", "ollama.exe"),
        "ollama", // fallback to PATH
      ];
      for (const ollamaBin of possiblePaths) {
        try {
          execSync(`"${ollamaBin}" serve`, { stdio: "ignore", timeout: 2000 });
          console.log(`[ollama] Started: ${ollamaBin}`);
          addLog("main", "info", `Started Ollama: ${ollamaBin}`);
          break;
        } catch {
          continue;
        }
      }
    } else {
      // macOS / Linux: try `open -a Ollama` (macOS) or `ollama serve`
      try {
        if (process.platform === "darwin") {
          execSync("open -a Ollama", { stdio: "ignore", timeout: 3000 });
        } else {
          execSync("ollama serve", { stdio: "ignore", timeout: 3000 });
        }
        console.log(`[ollama] Ollama launch command sent`);
        addLog("main", "info", "Ollama launch command sent");
      } catch {
        // `open -a Ollama` might fail if Ollama.app isn't installed — non-fatal
        console.log(`[ollama] Could not launch Ollama — user may need to start it manually`);
        addLog("main", "warn", "Could not launch Ollama — user may need to start it manually");
        return false;
      }
    }

    // Wait a moment for Ollama to start, then check again
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log(`[ollama] Ollama is now running`);
        addLog("main", "info", "Ollama is now running");
        return true;
      }
    } catch {
      // Still not running
    }

    console.log(`[ollama] Ollama did not start in time — agent runner will retry`);
    addLog("main", "warn", "Ollama did not start in time — agent runner will retry on connection");
    return false;
  } catch (err: any) {
    console.log(`[ollama] Failed to start: ${err.message}`);
    addLog("main", "error", `Failed to start Ollama: ${err.message}`);
    return false;
  }
}

export async function startAgentRunner(): Promise<void> {
  const agentDir = resourcePath("agent-runner");
  const nodeBin = NODE_BIN;

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
