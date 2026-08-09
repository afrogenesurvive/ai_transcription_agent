/**
 * Node resolver — resolves the Node.js binary used to run the bridge server,
 * agent runner, and bot test scripts from the Electron main process.
 *
 * The Windows installer bundles TWO node binaries:
 *   - `node.exe`   = Node 24 LTS (primary, for native Windows)
 *   - `node20.exe` = Node 20.18.0 (fallback)
 *
 * The fallback exists because Node 22+/24 crash at process startup under
 * CrossOver/Wine on Apple Silicon (exit code 0x300 / rc=768, empty output — the
 * signature captured in crossover.cxlog). Node 20.18.0 is the only version proven
 * to run under that environment. Native Windows works fine with Node 24. macOS
 * bundles Node 24 only and never needs the fallback.
 *
 * At startup we probe the primary once (in-memory cache); on the Wine crash
 * signature we fall back to node20.exe. In dev, dist-resources/node-bin/ is
 * preferred, then the system PATH.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { addLog } from "./logger";

const IS_WIN = process.platform === "win32";
const NODE_PROBE_TIMEOUT_MS = 5000;

let cachedNodeBin: string | null = null;

/** Probe a node binary: it must exit 0 AND print a version to stdout.
 *  Under Wine, Node 22+/24 crash at startup (rc=0x300/768, empty output) → false. */
function probeNode(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: NODE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return r.status === 0 && (r.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

/** Path to the bundled Node binary (no probe), or null if not found.
 *  Packaged: resources/node-bin/. Dev: dist-resources/node-bin/. */
export function getBundledNodePath(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "node-bin", IS_WIN ? "node.exe" : "node");
    return fs.existsSync(bundled) ? bundled : null;
  }
  const devPath = path.join(app.getAppPath(), "..", "dist-resources", "node-bin", IS_WIN ? "node.exe" : "node");
  return fs.existsSync(devPath) ? devPath : null;
}

/** Candidate binaries, primary first. Windows appends node20.exe (if bundled). */
function nodeCandidates(): string[] {
  const candidates: string[] = [];
  const bundled = getBundledNodePath();
  if (bundled) candidates.push(bundled);
  if (IS_WIN) {
    const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "..", "dist-resources");
    const fallback = path.join(resourcesDir, "node-bin", "node20.exe");
    if (fs.existsSync(fallback) && fallback !== bundled) candidates.push(fallback);
  }
  // Always end with the system PATH fallback.
  candidates.push(IS_WIN ? "node.exe" : "node");
  return candidates;
}

/** Resolve the Node binary, probing candidates and caching the result. */
export function resolveNodeBin(): string {
  if (cachedNodeBin) return cachedNodeBin;

  const candidates = nodeCandidates();
  for (let i = 0; i < candidates.length; i++) {
    const bin = candidates[i];
    if (probeNode(bin)) {
      if (i > 0) {
        console.log(`[node] Primary bundled Node failed here — using fallback: ${bin}`);
      } else {
        console.log(`[node] Using Node.js: ${bin}`);
      }
      cachedNodeBin = bin;
      return bin;
    }
    if (i < candidates.length - 1) {
      console.log(`[node] Node probe failed for ${bin} — trying next candidate`);
    }
  }
  // Last resort: return the first candidate so a startup failure is visible.
  cachedNodeBin = candidates[0];
  return cachedNodeBin;
}

/** Spawn spec for running a Node.js script (command + args + extra env). */
export interface NodeSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Resolve how to run a Node.js script.
 *
 * PACKAGED: run it on Electron's OWN embedded Node via ELECTRON_RUN_AS_NODE.
 * Electron provably runs under CrossOver/Wine (the app itself runs there),
 * whereas a standalone bundled node.exe fails to launch under Wine with
 * rc=768 — for EVERY version tested (20.18, 22.23, 24.19). Running the
 * bridge/agent on Electron's embedded Node removes the node.exe dependency
 * entirely, so no Wine-incompatible binary is ever spawned.
 *
 * DEV: use the system/dist-resources node via resolveNodeBin().
 */
export function nodeSpawnSpec(scriptPath: string): NodeSpawnSpec {
  if (app.isPackaged) {
    addLog("main", "info", `[node] Packaged: ${scriptPath} via Electron embedded Node (ELECTRON_RUN_AS_NODE)`);
    return {
      command: process.execPath,
      args: [scriptPath],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: resolveNodeBin(), args: [scriptPath], env: {} };
}
