/**
 * NewJobPanel — 3-tab container for starting a transcription job:
 *   Upload / System Recording / Teams-Zoom.
 *
 * All tabs stay mounted (visibility toggled) so a live system recording or a
 * loaded meeting list survives switching tabs. Tab 1 embeds the existing
 * UploadPanel unchanged.
 */

import React from "react";
import { useUiStateValue } from "../hooks/useUiState";
import UploadPanel from "./UploadPanel";
import SystemRecordingPanel from "./SystemRecordingPanel";
import MeetingsPanel from "./MeetingsPanel";
import Icon from "./Icon";

export type NewJobTab = "upload" | "recording" | "meetings";

export interface NewJobSubmitParams {
  filePath: string;
  title: string;
  attendees: string[];
  emailRecipients?: string[];
  skipSteps?: string[];
  attendeeEmails?: string[];
  /** Audio provenance: "upload" | "capture" | "teams" | "zoom". */
  source?: string;
}

interface Props {
  /** Live File selected this session — hoisted to App so it survives panel switches. */
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** File-based upload (Upload tab). */
  onUpload: (file: File, title: string, attendees: string[], emailRecipients: string[], skipSteps: string[], attendeeEmails?: string[]) => void;
  /** Path-based upload (recording / meetings tabs) — mirrors App.handleUploadByPath. */
  onUploadByPath: (params: NewJobSubmitParams) => void;
  uploading: boolean;
  disabled?: boolean;
  initialSkipSteps?: string[];
  refreshTrigger?: number;
}

const TABS: Array<{ id: NewJobTab; label: string; icon: string; hint: string }> = [
  { id: "upload", label: "Upload", icon: "upload_file", hint: "Upload a recorded audio file" },
  { id: "recording", label: "System Recording", icon: "mic", hint: "Record meeting audio live from system audio" },
  { id: "meetings", label: "Teams/Zoom", icon: "videocam", hint: "Pull recordings + attendees from Teams or Zoom" },
];

export default function NewJobPanel(props: Props) {
  const { file, onFileChange, onUpload, onUploadByPath, uploading, disabled, initialSkipSteps, refreshTrigger } = props;
  // Persisted so the panel reopens on the last-used tab (cleared on submit via App.clearScope("newForm")).
  const [tab, setTab] = useUiStateValue<NewJobTab>("newForm.tab", "upload");

  return (
    <div className={`panel upload-panel ${disabled ? "upload-panel--disabled" : ""}`}>
      <h2>New Transcription</h2>
      <div className="newjob-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`newjob-tab ${tab === t.id ? "newjob-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
            type="button">
            <Icon name={t.icon} size="14" color={tab === t.id ? "accent" : "muted"} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div style={{ display: tab === "upload" ? undefined : "none" }}>
        <UploadPanel
          file={file}
          onFileChange={onFileChange}
          onUpload={onUpload}
          onUploadByPath={onUploadByPath}
          uploading={uploading}
          disabled={disabled}
          initialSkipSteps={initialSkipSteps}
          refreshTrigger={refreshTrigger}
        />
      </div>

      <div style={{ display: tab === "recording" ? undefined : "none" }}>
        <SystemRecordingPanel
          onTranscribe={onUploadByPath}
          uploading={uploading}
          disabled={disabled}
          initialSkipSteps={initialSkipSteps}
          refreshTrigger={refreshTrigger}
        />
      </div>

      <div style={{ display: tab === "meetings" ? undefined : "none" }}>
        <MeetingsPanel
          onTranscribe={onUploadByPath}
          uploading={uploading}
          disabled={disabled}
          initialSkipSteps={initialSkipSteps}
          refreshTrigger={refreshTrigger}
        />
      </div>
    </div>
  );
}
