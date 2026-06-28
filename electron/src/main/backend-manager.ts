/**
 * Backend Manager — spawns and manages Python backend + bridge server
 * as child processes from the Electron main process.
 *
 * In development, assumes Python and Node are available on PATH.
 * In production (packaged), binaries are in extraResources.
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import { app } from "electron";

const isProd = app.isPackaged;

function resourcePath(...segments: string[]): string {
  if (isProd) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(app.getAppPath(), "..", ...segments);
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
  const backendDir = resourcePath("python-backend");
  const venvPython = path.join(backendDir, "venv", "bin", "python3");

  // In dev, use system python if no venv
  const pythonBin = isProd ? venvPython : "python3";

  console.log(`[backend] Starting Python backend at ${backendDir}`);
  console.log(`[backend] Using: ${pythonBin} main.py`);

  pythonProcess = spawn(pythonBin, ["main.py"], {
    cwd: backendDir,
    env: { ...process.env, TRANSCRIPTION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  pythonProcess.stdout?.on("data", (d: Buffer) => {
    console.log(`[python] ${d.toString().trim()}`);
  });

  pythonProcess.stderr?.on("data", (d: Buffer) => {
    console.error(`[python:err] ${d.toString().trim()}`);
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
    pythonProcess.kill("SIGTERM");
    pythonProcess = null;
    // Give it a moment to shut down
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Bridge Server ──

let bridgeProcess: ChildProcess | null = null;

export async function startBridgeServer(bridgePort = 5010, pythonPort = 5001): Promise<void> {
  const bridgeDir = resourcePath("bridge-server");
  const nodeBin = isProd ? path.join(bridgeDir, "node_modules", ".bin", "node") : "node";

  console.log(`[bridge] Starting bridge server at ${bridgeDir}`);

  bridgeProcess = spawn(nodeBin, ["index.js"], {
    cwd: bridgeDir,
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      PYTHON_API_URL: `http://127.0.0.1:${pythonPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridgeProcess.stdout?.on("data", (d: Buffer) => {
    console.log(`[bridge] ${d.toString().trim()}`);
  });

  bridgeProcess.stderr?.on("data", (d: Buffer) => {
    console.error(`[bridge:err] ${d.toString().trim()}`);
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
    bridgeProcess.kill("SIGTERM");
    bridgeProcess = null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Agent Runner ──

let agentProcess: ChildProcess | null = null;

/** Check if the agent child process is still alive. */
export function isAgentRunning(): boolean {
  return agentProcess !== null && agentProcess.exitCode === null;
}

export async function startAgentRunner(): Promise<void> {
  const agentDir = resourcePath("agent-runner");
  const nodeBin = isProd ? path.join(agentDir, "node_modules", ".bin", "node") : "node";

  console.log(`[agent] Starting agent runner at ${agentDir}`);

  agentProcess = spawn(nodeBin, ["index.js"], {
    cwd: agentDir,
    env: {
      ...process.env,
      BRIDGE_URL: "http://127.0.0.1:5010",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  agentProcess.stdout?.on("data", (d: Buffer) => {
    console.log(`[agent] ${d.toString().trim()}`);
  });

  agentProcess.stderr?.on("data", (d: Buffer) => {
    console.error(`[agent:err] ${d.toString().trim()}`);
  });

  agentProcess.on("exit", (code) => {
    console.log(`[agent] Agent process exited with code ${code}`);
    agentProcess = null;
  });

  // Agent runner doesn't have an HTTP health endpoint — it
  // starts listening for trigger file changes immediately.
  // Give it a moment to initialize.
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[agent] Agent runner started (PID: ${agentProcess.pid})`);
}

export async function stopAgentRunner(): Promise<void> {
  if (agentProcess) {
    agentProcess.kill("SIGTERM");
    agentProcess = null;
    await new Promise((r) => setTimeout(r, 1000));
  }
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
