/**
 * SystemRecordingPanel — record meeting audio live from system audio.
 *
 * Windows: uses Chromium's built-in WASAPI loopback (getDisplayMedia with
 * chromeMediaSource 'desktop') — audio-only, no driver, no video. The renderer
 * records a WebM and sends the blob to main to persist.
 *
 * macOS: requires the BlackHole driver; the bundled ffmpeg captures
 * `BlackHole 2ch` to an M4A (started/stopped in the main process).
 *
 * When a capture completes, the user fills the shared job form and starts
 * transcription (submits through the existing upload_by_path pipeline).
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useUiStateValue } from "../hooks/useUiState";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import JobFormFields, { type AttendeeEntry, type JobFormFieldsHandle } from "./JobFormFields";
import type { CaptureDeviceStatus, CaptureSource } from "../types.d";
import type { NewJobSubmitParams } from "./NewJobPanel";

const DEFAULT_SKIP_STEPS = [
  "transcribe_analyze",
  "transcribe_prepare_delivery",
  "send_delivery_email",
  "save_to_drive",
  "create_trello_action_items",
];

interface Props {
  onTranscribe: (params: NewJobSubmitParams) => void;
  uploading: boolean;
  disabled?: boolean;
  initialSkipSteps?: string[];
  refreshTrigger?: number;
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function SystemRecordingPanel({ onTranscribe, uploading, disabled, initialSkipSteps, refreshTrigger }: Props) {
  const [device, setDevice] = useState<CaptureDeviceStatus | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  // Persisted so the panel reopens on the last-selected capture source (validated against the fetched list below).
  const [selectedSourceId, setSelectedSourceId] = useUiStateValue<string>("newForm.recording.source", "");
  // macOS: persisted avfoundation input device. Defaults to BlackHole 2ch (system
  // audio only); an Aggregate Device (BlackHole + your mic) captures both sides.
  const [selectedMacDevice, setSelectedMacDevice] = useUiStateValue<string>("newForm.recording.macDevice", "BlackHole 2ch");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const [title, setTitle] = useState("");
  const [attendeeList, setAttendeeList] = useState<AttendeeEntry[]>([]);
  const [skipSteps, setSkipSteps] = useState<string[]>(initialSkipSteps ?? DEFAULT_SKIP_STEPS);
  const formRef = useRef<JobFormFieldsHandle>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isMac = device?.platform === "darwin";
  const isWin = device?.platform === "win32";

  // Live refs so the unmount cleanup always sees the current capture state.
  const isMacRef = useRef(false);
  const recordingRef = useRef(false);
  useEffect(() => {
    isMacRef.current = isMac;
  }, [isMac]);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // Re-run capture-capability detection (BlackHole on macOS, screen sources on
  // Windows). Used on mount and from the manual "Refresh" button so users don't
  // have to switch views after installing BlackHole or connecting audio devices.
  const refreshDetection = useCallback(async () => {
    setChecking(true);
    try {
      const dev = await window.electronAPI?.captureDevice();
      setDevice(dev ?? null);
      if (dev?.platform === "win32") {
        const srcs = (await window.electronAPI?.captureSources()) || [];
        setSources(srcs);
        // Keep the persisted source only if it still exists in the fresh list; otherwise fall back to the first.
        setSelectedSourceId((prev) => (srcs.some((s) => s.id === prev) ? prev : (srcs[0]?.id ?? "")));
      } else if (dev?.platform === "darwin") {
        const macDevs = dev.macAudioDevices ?? [];
        // Keep the persisted device if it still exists; otherwise prefer BlackHole, else the first audio device.
        setSelectedMacDevice((prev) => {
          if (macDevs.some((d) => d.name === prev)) return prev;
          return macDevs.find((d) => /\bBlackHole\b/i.test(d.name))?.name ?? macDevs[0]?.name ?? "BlackHole 2ch";
        });
      }
    } catch {
      setError("Could not re-check capture support. Please try again.");
    } finally {
      setChecking(false);
    }
  }, [setSelectedSourceId, setSelectedMacDevice]);

  // Detect platform capture capability on mount (and when refreshTrigger changes).
  useEffect(() => {
    refreshDetection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  // Elapsed timer while recording.
  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [recording]);

  // Cleanup on unmount: stop any renderer recorder / mac ffmpeg capture.
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (window.electronAPI && isMacRef.current && recordingRef.current) {
        window.electronAPI.captureStop().catch(() => {});
      }
    };
  }, []);

  /** Windows: persist a recorded WebM blob to disk via main. */
  const saveWindowsBlob = useCallback(async (blob: Blob) => {
    setBusy(true);
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const res = await window.electronAPI?.captureSave(buf);
      if (res?.ok && res.filePath) {
        setFilePath(res.filePath);
        setError(null);
      } else {
        setError(res?.error || "Could not save the recording.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the recording.");
    } finally {
      setBusy(false);
    }
  }, []);

  const startWindowsCapture = useCallback(
    async (sourceId: string) => {
      if (!sourceId) {
        setError("No screen source available for system-audio capture.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // Chromium desktop capture: request video to get the WASAPI loopback
        // audio track; we only keep the audio (no video is recorded/saved).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId },
          },
          video: {
            mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId },
          },
        } as MediaStreamConstraints);

        const audioStream = new MediaStream(stream.getAudioTracks());
        stream.getVideoTracks().forEach((t) => t.stop());
        streamRef.current = stream;

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const recorder = new MediaRecorder(audioStream, { mimeType });
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          audioStream.getTracks().forEach((t) => t.stop());
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
          }
          mediaRecorderRef.current = null;
          setRecording(false);
          if (blob.size > 0) await saveWindowsBlob(blob);
          else setError("No audio was captured — is the meeting playing audio?");
        };
        recorder.onerror = () => {
          setRecording(false);
          setError("Recording failed — the system-audio source may be unavailable.");
        };
        mediaRecorderRef.current = recorder;
        recorder.start(1000);
        setRecording(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start system-audio capture.");
      } finally {
        setBusy(false);
      }
    },
    [saveWindowsBlob],
  );

  const stopWindowsCapture = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      setRecording(false);
    }
  }, []);

  const startMacCapture = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI?.captureStart(selectedMacDevice);
      if (res?.ok && res.filePath) {
        setFilePath(res.filePath);
        setRecording(true);
      } else {
        setError(res?.error || "Could not start BlackHole capture.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start capture.");
    } finally {
      setBusy(false);
    }
  }, [selectedMacDevice]);

  const stopMacCapture = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI?.captureStop();
      if (res?.ok && res.filePath) {
        setFilePath(res.filePath);
        setError(null);
      } else {
        setError(res?.error || "Could not stop capture.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop capture.");
    } finally {
      setBusy(false);
      setRecording(false);
    }
  }, []);

  const handleStart = () => {
    if (isMac) startMacCapture();
    else if (isWin) startWindowsCapture(selectedSourceId);
  };

  const handleStop = () => {
    if (isMac) stopMacCapture();
    else if (isWin) stopWindowsCapture();
  };

  const handleSubmit = async () => {
    if (!filePath) return;
    if (attendeeList.length === 0) return;
    const valid = (await formRef.current?.validateDelivery()) ?? true;
    if (!valid) return;
    const names = attendeeList.map((a) => a.name);
    const emails = attendeeList.map((a) => a.email);
    onTranscribe({
      filePath,
      title: title || "System Recording",
      attendees: names,
      emailRecipients: emails.filter(Boolean),
      skipSteps,
      attendeeEmails: emails,
      source: "capture",
    });
  };

  const canStart = (isMac ? !!device?.blackholeInstalled : isWin ? sources.length > 0 : false) && !recording && !busy && !uploading && !disabled;
  const canStop = recording && !busy;

  return (
    <div className="system-recording-panel">
      <Tooltip content="Record meeting audio from system output — works with Teams, Zoom, and any other app playing audio">
        <h3>Record System Audio</h3>
      </Tooltip>

      {!device && <p className="upload-disabled-notice">Checking capture support…</p>}

      {device && device.platform === "other" && (
        <p className="upload-disabled-notice">{device.hint || "System-audio capture is unsupported on this platform."}</p>
      )}

      {device && isWin && (
        <div className="capture-status-banner">
          <Icon name="check_circle" size="14" color="accent" />
          <span>
            {device.hint ||
              "Uses the built-in Windows system-audio capture (WASAPI loopback) — no driver or Stereo Mix needed. Whatever your computer is playing (both sides of a Teams/Zoom call) is recorded."}
          </span>
        </div>
      )}
      {device && isWin && sources.length === 0 && (
        <div className="capture-status-banner capture-status-banner--warn">
          <Icon name="info" size="14" color="accent" />
          <span>
            No screen source detected — Windows captures audio via a display loopback. Make sure at least one screen is available (Settings → System →
            Display), then switch tabs and back to refresh.
          </span>
        </div>
      )}

      {device && isMac && !device.blackholeInstalled && (
        <div className="capture-status-banner capture-status-banner--warn capture-status-banner--setup">
          <div className="capture-banner-head">
            <Icon name="warning" size="14" color="orange" />
            <span>BlackHole not detected — system-audio capture is unavailable on macOS.</span>
            <button
              className="config-update-status-btn"
              onClick={() => window.electronAPI?.openExternal("https://github.com/ExistentialAudio/BlackHole")}
              type="button">
              <Icon name="download" size="12" /> Download BlackHole
            </button>
          </div>
          <details className="capture-setup-details">
            <summary className="capture-setup-summary">How to set up BlackHole (step by step)</summary>
            <ol className="capture-setup-steps">
              <li>
                Install the free <strong>BlackHole 2ch</strong> virtual audio driver from the link above (or <code>brew install blackhole-2ch</code>).
              </li>
              <li>
                Open <strong>Audio MIDI Setup</strong> (in <code>/Applications/Utilities/</code>).
              </li>
              <li>
                Click <strong>+</strong> (bottom-left) → <strong>Create Multi-Output Device</strong>.
              </li>
              <li>
                Add <strong>BlackHole 2ch</strong> <em>and</em> your speakers/headphones to the Multi-Output Device.
              </li>
              <li>
                Set it as the <strong>default output</strong> (System Settings → Sound → Output) — audio goes to BlackHole (capture) <em>and</em> your
                speakers (so you can still hear).
              </li>
              <li>
                Return here and click <strong>Start Recording</strong>.
              </li>
            </ol>
          </details>
        </div>
      )}
      {device && isMac && device.blackholeInstalled && (
        <div className="capture-status-banner">
          <Icon name="check_circle" size="14" color="accent" />
          <span>BlackHole detected — meeting audio will be captured to an M4A.</span>
        </div>
      )}

      {device && isWin && sources.length > 0 && !recording && (
        <label className="capture-source-row">
          <span className="field-hint">Screen source (used for system-audio capture):</span>
          <select value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)} disabled={disabled}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {device && isMac && (device.macAudioDevices?.length ?? 0) > 0 && !recording && (
        <label className="capture-source-row">
          <span className="field-hint">Capture input (macOS):</span>
          <select value={selectedMacDevice} onChange={(e) => setSelectedMacDevice(e.target.value)} disabled={disabled}>
            {device.macAudioDevices?.map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          {!/\bBlackHole\b/i.test(selectedMacDevice) && (
            <span className="field-hint">Aggregate / other input — records this device's audio in addition to system audio routed to BlackHole.</span>
          )}
        </label>
      )}

      <div className="capture-controls">
        <button
          className="btn-primary"
          onClick={refreshDetection}
          disabled={recording || busy || checking || disabled}
          title="Re-check capture support (BlackHole / audio devices)"
          type="button">
          {checking ? <span className="updates-spinner updates-spinner--small" /> : <Icon name="refresh" size="14" />}
          {checking ? "Checking…" : "Refresh"}
        </button>
        {!recording ? (
          <button className="btn-primary" onClick={handleStart} disabled={!canStart} title={canStart ? "Start recording system audio" : undefined}>
            {busy ? (
              <>
                <span className="updates-spinner updates-spinner--small" /> Starting…
              </>
            ) : (
              <>
                <Icon name="mic" size="14" /> Start Recording
              </>
            )}
          </button>
        ) : (
          <button className="btn-primary btn-danger" onClick={handleStop} disabled={!canStop}>
            <Icon name="stop" size="14" /> Stop Recording — {formatElapsed(elapsed)}
          </button>
        )}
      </div>

      {error && (
        <div className="capture-error">
          <Icon name="error" size="13" color="red" /> {error}
        </div>
      )}

      {filePath && !recording && (
        <div className="file-info file-info--captured">
          <span className="file-icon">
            <Icon name="audio_file" size="24" color="accent" />
          </span>
          <span className="file-name">{filePath.split(/[\\/]/).pop()}</span>
          <button className="btn-text" onClick={() => setFilePath(null)} title="Discard this recording">
            Discard
          </button>
        </div>
      )}

      {filePath && !recording && (
        <JobFormFields
          ref={formRef}
          title={title}
          onTitleChange={setTitle}
          attendeeList={attendeeList}
          onAttendeeListChange={setAttendeeList}
          skipSteps={skipSteps}
          onSkipStepsChange={setSkipSteps}
          disabled={disabled}
          refreshTrigger={refreshTrigger}
        />
      )}

      {filePath && !recording && <div className="upload-form-divider" />}

      {filePath && !recording && (
        <div className="upload-form-actions">
          <Tooltip content="Submit the recorded audio and start the transcription pipeline">
            <button
              className="btn-primary"
              disabled={attendeeList.length === 0 || uploading || disabled}
              onClick={handleSubmit}
              title={uploading ? "Starting…" : "Transcribe this recording"}>
              {uploading ? "Starting…" : "Start Transcription"}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
