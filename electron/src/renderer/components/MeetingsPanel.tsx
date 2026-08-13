/**
 * MeetingsPanel — pull meeting data (recordings + attendees) from Microsoft
 * Teams and Zoom, then transcribe through the shared job form.
 *
 * Each provider uses an OAuth web-consent flow (mirroring the Gmail connect
 * row) and a REST API for meetings/recordings. Attendees populate the shared
 * form so voiceprint matching (email-keyed) works as usual.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useUiStateValue } from "../hooks/useUiState";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import JobFormFields, { type AttendeeEntry, type JobFormFieldsHandle } from "./JobFormFields";
import type { MeetingInfo } from "../types.d";
import type { NewJobSubmitParams } from "./NewJobPanel";

const DEFAULT_SKIP_STEPS = [
  "transcribe_analyze",
  "transcribe_prepare_delivery",
  "send_delivery_email",
  "save_to_drive",
  "create_trello_action_items",
];

type Provider = "teams" | "zoom";

interface Props {
  onTranscribe: (params: NewJobSubmitParams) => void;
  uploading: boolean;
  disabled?: boolean;
  initialSkipSteps?: string[];
  refreshTrigger?: number;
}

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: "teams", label: "Microsoft Teams" },
  { id: "zoom", label: "Zoom" },
];

export default function MeetingsPanel({ onTranscribe, uploading, disabled, initialSkipSteps, refreshTrigger }: Props) {
  // Persisted so the panel reopens on the last-used provider (cleared on submit via App.clearScope("newForm")).
  const [provider, setProvider] = useUiStateValue<Provider>("newForm.meetings.provider", "teams");

  const [connected, setConnected] = useState<{ teams: boolean; zoom: boolean }>({ teams: false, zoom: false });
  const [connectedUser, setConnectedUser] = useState<{ teams: string; zoom: string }>({ teams: "", zoom: "" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [loadingMeetings, setLoadingMeetings] = useState(false);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>("");

  const [fetchingRecording, setFetchingRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [attendeeList, setAttendeeList] = useState<AttendeeEntry[]>([]);
  const [skipSteps, setSkipSteps] = useState<string[]>(initialSkipSteps ?? DEFAULT_SKIP_STEPS);
  const formRef = useRef<JobFormFieldsHandle>(null);

  // Detect connection state from saved tokens.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.getConfig().then((cfg) => {
      if (cancelled) return;
      setConnected({
        teams: !!(cfg?.MS_REFRESH_TOKEN || "").trim(),
        zoom: !!(cfg?.ZOOM_REFRESH_TOKEN || "").trim(),
      });
      setConnectedUser({ teams: (cfg?.MS_USER || "").trim(), zoom: (cfg?.ZOOM_USER || "").trim() });
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTrigger]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      if (provider === "teams") {
        const res = await window.electronAPI?.teamsConnect();
        if (res?.ok) {
          await window.electronAPI?.saveConfig({
            MS_CLIENT_ID: res.clientId ?? "",
            MS_REFRESH_TOKEN: res.refreshToken ?? "",
            MS_USER: res.user ?? "",
          });
          setConnected((c) => ({ ...c, teams: true }));
          setConnectedUser((c) => ({ ...c, teams: res.user || "" }));
        } else {
          setConnectError(res?.error || "Teams authorization failed or was cancelled.");
        }
      } else {
        const res = await window.electronAPI?.zoomConnect();
        if (res?.ok) {
          await window.electronAPI?.saveConfig({
            ZOOM_CLIENT_ID: res.clientId ?? "",
            ZOOM_CLIENT_SECRET: res.clientSecret ?? "",
            ZOOM_REFRESH_TOKEN: res.refreshToken ?? "",
            ZOOM_USER: res.user ?? "",
          });
          setConnected((c) => ({ ...c, zoom: true }));
          setConnectedUser((c) => ({ ...c, zoom: res.user || "" }));
        } else {
          setConnectError(res?.error || "Zoom authorization failed or was cancelled.");
        }
      }
    } catch {
      setConnectError("Authorization failed — try again.");
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const refreshMeetings = useCallback(async () => {
    if (!connected[provider]) return;
    setLoadingMeetings(true);
    setMeetingsError(null);
    try {
      const res = provider === "teams" ? await window.electronAPI?.teamsList() : await window.electronAPI?.zoomList();
      if (res?.ok) {
        setMeetings(res.meetings ?? []);
      } else {
        setMeetingsError(res?.error || "Could not load meetings.");
      }
    } catch {
      setMeetingsError("Could not load meetings.");
    } finally {
      setLoadingMeetings(false);
    }
  }, [provider, connected]);

  // Auto-refresh when a provider becomes connected or is switched to.
  useEffect(() => {
    setMeetings([]);
    setSelectedMeetingId("");
    setFilePath(null);
    setRecordingError(null);
    if (connected[provider]) refreshMeetings();
  }, [provider, connected, refreshMeetings]);

  const fetchRecording = useCallback(async () => {
    if (!selectedMeetingId) return;
    setFetchingRecording(true);
    setRecordingError(null);
    try {
      const res =
        provider === "teams"
          ? await window.electronAPI?.teamsFetchRecording(selectedMeetingId)
          : await window.electronAPI?.zoomFetchRecording(selectedMeetingId);
      if (res?.ok && res.filePath) {
        setFilePath(res.filePath);
        setTitle(res.title || "");
        setAttendeeList((res.attendees || []).map((a) => ({ name: a.name, email: a.email || "" })));
      } else {
        setRecordingError(res?.error || "Could not fetch the recording.");
      }
    } catch {
      setRecordingError("Could not fetch the recording.");
    } finally {
      setFetchingRecording(false);
    }
  }, [provider, selectedMeetingId]);

  const handleSubmit = async () => {
    if (!filePath) return;
    if (attendeeList.length === 0) return;
    const valid = (await formRef.current?.validateDelivery()) ?? true;
    if (!valid) return;
    const names = attendeeList.map((a) => a.name);
    const emails = attendeeList.map((a) => a.email);
    onTranscribe({
      filePath,
      title: title || "Meeting",
      attendees: names,
      emailRecipients: emails.filter(Boolean),
      skipSteps,
      attendeeEmails: emails,
      source: provider === "teams" ? "teams" : "zoom",
    });
  };

  const isConnected = connected[provider];

  return (
    <div className="meetings-panel">
      <h3>Pull a Meeting from Teams / Zoom</h3>

      <div className="meetings-provider-tabs" role="tablist">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={provider === p.id}
            className={`meetings-provider-tab ${provider === p.id ? "meetings-provider-tab--active" : ""}`}
            onClick={() => setProvider(p.id)}
            type="button">
            {p.label}
            {connected[p.id] && <Icon name="check_circle" size="12" color="accent" />}
          </button>
        ))}
      </div>

      <div className="meetings-connect-row">
        {isConnected ? (
          <>
            <span className="delivery-connect-feedback delivery-connect-feedback--ok">
              {provider === "teams" ? "Teams" : "Zoom"} connected: {connectedUser[provider] || "your account"}
            </span>
            <button className="config-update-status-btn" onClick={connect} disabled={connecting || disabled} type="button">
              {connecting ? "Connecting…" : "Reconnect"}
            </button>
            {connecting && (
              <button
                className="config-update-status-btn"
                onClick={() => {
                  if (provider === "teams") window.electronAPI?.teamsCancel();
                  else window.electronAPI?.zoomCancel();
                  setConnecting(false);
                  setConnectError("Authorization cancelled.");
                }}
                title="Cancel authorization"
                type="button">
                <Icon name="close" size="14" /> Cancel
              </button>
            )}
          </>
        ) : (
          <>
            <span className="delivery-connect-feedback">
              {provider === "teams"
                ? "Connect your work/school Microsoft account to pull Teams meetings."
                : "Connect your Zoom account to pull recorded meetings."}
            </span>
            <button
              className="config-update-status-btn config-update-status-btn--accent"
              onClick={connect}
              disabled={connecting || disabled}
              type="button">
              {connecting ? (
                <>
                  <span className="updates-spinner updates-spinner--small" /> Waiting for authorization…
                </>
              ) : (
                <>
                  <Icon name="link" size="14" /> Connect {provider === "teams" ? "Microsoft Teams" : "Zoom"}
                </>
              )}
            </button>
            {connecting && (
              <button
                className="config-update-status-btn"
                onClick={() => {
                  if (provider === "teams") window.electronAPI?.teamsCancel();
                  else window.electronAPI?.zoomCancel();
                  setConnecting(false);
                  setConnectError("Authorization cancelled.");
                }}
                title="Cancel authorization"
                type="button">
                <Icon name="close" size="14" /> Cancel
              </button>
            )}
          </>
        )}
      </div>

      {connectError && (
        <div className="capture-error">
          <Icon name="error" size="13" color="red" /> {connectError}
        </div>
      )}

      {isConnected && (
        <div className="meetings-list-section">
          <div className="meetings-list-toolbar">
            <span className="field-hint">
              {provider === "zoom" ? "Zoom meetings with cloud recordings (last 30 days)" : "Your Teams online meetings"}
            </span>
            <button className="btn-text" onClick={refreshMeetings} disabled={loadingMeetings || disabled} type="button">
              <Icon name="refresh" size="13" /> Refresh
            </button>
          </div>

          {loadingMeetings && <p className="upload-disabled-notice">Loading meetings…</p>}
          {meetingsError && (
            <div className="capture-error">
              <Icon name="error" size="13" color="red" /> {meetingsError}
            </div>
          )}

          {!loadingMeetings && !meetingsError && meetings.length === 0 && (
            <p className="upload-disabled-notice">No meetings with recordings found. Record a meeting (cloud recording) and refresh.</p>
          )}

          {meetings.length > 0 && (
            <select
              className="meetings-select"
              value={selectedMeetingId}
              onChange={(e) => setSelectedMeetingId(e.target.value)}
              disabled={disabled || fetchingRecording}>
              <option value="">Select a meeting…</option>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} {m.hasRecording ? "●" : "(no recording)"}
                  {m.startTime ? ` — ${new Date(m.startTime).toLocaleString()}` : ""}
                </option>
              ))}
            </select>
          )}

          <button
            className="btn-primary meetings-fetch-btn"
            onClick={fetchRecording}
            disabled={!selectedMeetingId || fetchingRecording || disabled || uploading}>
            {fetchingRecording ? (
              <>
                <span className="updates-spinner updates-spinner--small" /> Downloading recording…
              </>
            ) : (
              <>
                <Icon name="download" size="14" /> Fetch Recording &amp; Attendees
              </>
            )}
          </button>

          {recordingError && (
            <div className="capture-error">
              <Icon name="error" size="13" color="red" /> {recordingError}
            </div>
          )}

          {provider === "zoom" && (
            <p className="field-hint" style={{ marginTop: 6 }}>
              Note: Zoom often hides participant emails — attendees are pre-filled with names; add missing emails so voiceprint matching works.
            </p>
          )}
        </div>
      )}

      {filePath && (
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

      {filePath && (
        <>
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
          <div className="upload-form-divider" />
          <div className="upload-form-actions">
            <Tooltip content="Submit this meeting's recording and start the transcription pipeline">
              <button
                className="btn-primary"
                disabled={attendeeList.length === 0 || uploading || disabled}
                onClick={handleSubmit}
                title={uploading ? "Starting…" : "Transcribe this recording"}>
                {uploading ? "Starting…" : "Start Transcription"}
              </button>
            </Tooltip>
          </div>
        </>
      )}
    </div>
  );
}
