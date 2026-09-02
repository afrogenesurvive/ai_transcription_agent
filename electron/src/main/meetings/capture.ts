/**
 * System-audio capture for the "System Recording" meeting source.
 *
 * Windows: uses Chromium's built-in WASAPI loopback — the renderer calls
 * getUserMedia with `chromeMediaSource: 'desktop'` (the same mechanism Windows'
 * own recorder uses), records audio-only to WebM, then sends the blob here to
 * be written to disk. No third-party driver required. No video is recorded.
 *
 * macOS: macOS has NO driver-free system-audio capture. Requires the free
 * BlackHole virtual driver; the bundled ffmpeg captures `BlackHole 2ch` via
 * avfoundation to an M4A. This module detects BlackHole, spawns/stops ffmpeg.
 */

import { app, desktopCapturer } from "electron";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { addLog } from "../logger";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/** Resolve an ffmpeg binary: managed copy first, then system PATH. */
function resolveFfmpeg(): string {
  const managed = path.join(app.getPath("userData"), "bin", IS_WIN ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(managed)) return managed;
  return IS_WIN ? "ffmpeg.exe" : "ffmpeg";
}

function capturesDir(): string {
  const dir = path.join(app.getPath("userData"), "captures");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let ffmpegProc: ChildProcess | null = null;
let activeCapturePath: string | null = null;

export interface CaptureSource {
  id: string;
  name: string;
}

/** Windows: enumerate screen sources for audio-only loopback capture. */
export async function listCaptureSources(): Promise<CaptureSource[]> {
  if (!IS_WIN) return [];
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  } catch (err) {
    addLog("main", "error", `[capture] listSources failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export interface CaptureDeviceStatus {
  platform: "win32" | "darwin" | "other";
  /** macOS: whether the BlackHole driver is installed and capturable. */
  blackholeInstalled: boolean;
  /** macOS: whether the bundled/system ffmpeg binary is available. */
  ffmpegAvailable: boolean;
  /** Windows: the built-in loopback path is always available. */
  windowsLoopbackAvailable: boolean;
  /** macOS: avfoundation audio capture devices (BlackHole, Aggregate Devices, built-in mic, …). */
  macAudioDevices?: CaptureSource[];
  /** macOS: human-readable setup hint when BlackHole is missing. */
  hint?: string;
}

/** Detect capture capabilities for the current platform. */
export async function detectCaptureDevice(): Promise<CaptureDeviceStatus> {
  if (IS_MAC) {
    const ffmpegAvailable = fs.existsSync(resolveFfmpeg()) || true; // PATH fallback always "exists"
    const blackholeInstalled = await isBlackholeInstalled();
    const macAudioDevices = await listMacAudioDevices();
    return {
      platform: "darwin",
      blackholeInstalled,
      ffmpegAvailable,
      windowsLoopbackAvailable: false,
      macAudioDevices,
      hint: blackholeInstalled
        ? undefined
        : "Install the free BlackHole driver and set up a Multi-Output Device in Audio MIDI Setup so meeting audio is routed to BlackHole while you can still hear it.",
    };
  }
  if (IS_WIN) {
    return {
      platform: "win32",
      blackholeInstalled: false,
      ffmpegAvailable: true,
      windowsLoopbackAvailable: true,
      hint: "Uses the built-in Windows system-audio capture — no driver needed.",
    };
  }
  return {
    platform: "other",
    blackholeInstalled: false,
    ffmpegAvailable: false,
    windowsLoopbackAvailable: false,
    hint: "System-audio capture is only supported on Windows and macOS.",
  };
}

/** macOS: probe ffmpeg for an avfoundation device whose name contains "BlackHole". */
async function isBlackholeInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(resolveFfmpeg(), ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", () => resolve(/\bBlackHole\b/i.test(stderr)));
    proc.on("error", () => resolve(false));
  });
}

/**
 * macOS: list avfoundation AUDIO capture devices (BlackHole, Aggregate Devices,
 * the built-in mic, etc.) by parsing `ffmpeg -f avfoundation -list_devices`.
 * Only the "audio devices:" section is parsed; entries look like "[0] Name".
 */
async function listMacAudioDevices(): Promise<CaptureSource[]> {
  const devices: CaptureSource[] = [];
  try {
    const proc = spawn(resolveFfmpeg(), ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    await new Promise<void>((resolve) => {
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
    let inAudio = false;
    for (const raw of stderr.split(/\r?\n/)) {
      const line = raw.trim();
      if (/AVFoundation audio devices:/i.test(line)) {
        inAudio = true;
        continue;
      }
      if (/AVFoundation video devices:/i.test(line)) {
        inAudio = false;
        continue;
      }
      if (inAudio) {
        // ffmpeg prefixes every line ("[AVFoundation indev @ 0x...] [0] Name"),
        // so match "[N] Name" anywhere in the line, not just at the start.
        const m = line.match(/\[\d+\]\s+(.+)$/);
        if (m) {
          const name = m[1].trim();
          if (name) devices.push({ id: name, name });
        }
      }
    }
  } catch {
    /* return whatever we parsed */
  }
  return devices;
}

/**
 * macOS: start ffmpeg capturing the BlackHole device to an M4A.
 * Returns the output path immediately (recording runs in the background).
 */
export function startFfmpegCapture(deviceName?: string): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  return new Promise((resolve) => {
    if (ffmpegProc) {
      resolve({ ok: false, error: "A capture is already in progress." });
      return;
    }
    if (!IS_MAC) {
      resolve({ ok: false, error: "ffmpeg capture is only used on macOS." });
      return;
    }
    // avfoundation inputs are "<video>:<audio>". A bare device name with no
    // colon is treated as a VIDEO device (ffmpeg fails with "Video device not
    // found"), so audio-only capture must use ":<device>" — empty video slot,
    // named audio device. Defaults to BlackHole 2ch (system audio); an
    // Aggregate Device (BlackHole + your mic) captures both sides.
    const dev = (deviceName ?? "BlackHole 2ch").trim() || "BlackHole 2ch";
    const filePath = path.join(capturesDir(), `meeting-${Date.now()}.m4a`);
    const args = ["-f", "avfoundation", "-i", `:${dev}`, "-c:a", "aac", "-y", filePath];
    addLog("main", "info", `[capture] starting ffmpeg → ${filePath}`);

    const proc = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    // Accumulate ffmpeg's stderr so we can surface the real failure reason
    // (e.g. macOS mic-permission denial, device-open error) instead of a
    // generic "exited immediately" message.
    let errOut = "";
    proc.stderr?.on("data", (d) => {
      const text = d.toString();
      if (text.trim()) {
        errOut += text;
        addLog("main", "debug", `[capture:ffmpeg] ${text.trim()}`);
      }
    });
    proc.on("error", (err) => {
      ffmpegProc = null;
      activeCapturePath = null;
      addLog("main", "error", `[capture] ffmpeg spawn error: ${err.message}`);
      resolve({ ok: false, error: `Could not start ffmpeg: ${err.message}` });
    });
    proc.on("exit", (code) => {
      const wasActive = ffmpegProc === proc;
      ffmpegProc = null;
      if (wasActive) activeCapturePath = null;
      addLog("main", "info", `[capture] ffmpeg exited (code ${code})`);
    });

    ffmpegProc = proc;
    activeCapturePath = filePath;
    // Give ffmpeg a moment to fail fast on a bad device name before declaring success.
    setTimeout(() => {
      if (proc.exitCode !== null) {
        const lastLine = errOut.trim().split(/\r?\n/).pop() || "";
        const detail = lastLine ? `Capture failed: ${lastLine}` : "ffmpeg exited immediately — is the BlackHole device available?";
        addLog("main", "error", `[capture] ${detail}`);
        resolve({ ok: false, error: detail });
        return;
      }
      resolve({ ok: true, filePath });
    }, 1500);
  });
}

/** macOS: stop the running ffmpeg capture and return the recorded file path. */
export function stopFfmpegCapture(): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = ffmpegProc;
    const filePath = activeCapturePath;
    if (!proc || !filePath) {
      resolve({ ok: false, error: "No capture is running." });
      return;
    }
    const onExit = () => {
      ffmpegProc = null;
      activeCapturePath = null;
      if (fs.existsSync(filePath)) resolve({ ok: true, filePath });
      else resolve({ ok: false, error: "Recording file was not produced." });
    };
    proc.once("exit", onExit);
    proc.kill("SIGTERM");
    // Safety: if SIGTERM doesn't land, force-kill.
    setTimeout(() => {
      if (ffmpegProc === proc) proc.kill("SIGKILL");
    }, 3000);
  });
}

/**
 * Windows: persist an audio-only WebM blob (recorded in the renderer via
 * getDisplayMedia) to the captures directory.
 */
export async function saveCaptureRecording(data: Uint8Array): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  try {
    if (!data || data.byteLength === 0) return { ok: false, error: "No audio recorded." };
    const filePath = path.join(capturesDir(), `meeting-${Date.now()}.webm`);
    fs.writeFileSync(filePath, Buffer.from(data));
    addLog("main", "info", `[capture] saved ${data.byteLength} bytes → ${filePath}`);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not save recording." };
  }
}

/** Abort any in-progress capture (app quit). */
export function stopAllCapture(): void {
  if (ffmpegProc) {
    try {
      ffmpegProc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    ffmpegProc = null;
    activeCapturePath = null;
  }
}
