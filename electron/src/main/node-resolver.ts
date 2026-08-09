/**
 * Node resolver — how to run Node.js scripts (bridge server, agent runner, bot
 * tests) from the Electron main process.
 *
 * PACKAGED: run the script on Electron's OWN embedded Node via ELECTRON_RUN_AS_NODE.
 * Electron provably runs under CrossOver/Wine (the app itself runs there), whereas
 * a standalone node.exe fails to launch under Wine (rc=768) for EVERY version tested
 * (20.18, 22.23, 24.19) — so no standalone node is bundled anymore. Using Electron's
 * embedded Node removes the node.exe dependency entirely.
 *
 * DEV: use the system Node on PATH.
 */

import { app } from "electron";
import { addLog } from "./logger";

/** Spawn spec for running a Node.js script (command + args + extra env). */
export interface NodeSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Resolve how to run a Node.js script. */
export function nodeSpawnSpec(scriptPath: string): NodeSpawnSpec {
  if (app.isPackaged) {
    addLog("main", "info", `[node] Packaged: ${scriptPath} via Electron embedded Node (ELECTRON_RUN_AS_NODE)`);
    return {
      command: process.execPath,
      args: [scriptPath],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  // Dev: system Node on PATH (no bundled node anymore)
  const sys = process.platform === "win32" ? "node.exe" : "node";
  return { command: sys, args: [scriptPath], env: {} };
}
