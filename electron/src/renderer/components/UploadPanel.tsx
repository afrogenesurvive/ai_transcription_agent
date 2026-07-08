/**
 * Upload Panel — drag-and-drop or file-picker for audio upload.
 */

import React, { useState, useRef, useCallback } from "react";

interface AttendeeEntry {
  name: string;
  email: string;
}

interface Props {
  onUpload: (file: File, title: string, attendees: string[], emailRecipients: string[], skipSteps: string[]) => void;
  uploading: boolean;
  disabled?: boolean;
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  if (!email.trim()) return true; // empty is allowed (optional)
  return EMAIL_RE.test(email);
}

export default function UploadPanel({ onUpload, uploading, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [attendeeList, setAttendeeList] = useState<AttendeeEntry[]>([]);
  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [skipAnalysis, setSkipAnalysis] = useState(true);
  const [skipDelivery, setSkipDelivery] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (f: File) => {
      setFile(f);
      if (!title) {
        // Derive title from filename
        setTitle(f.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "));
      }
    },
    [title],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const addAttendee = () => {
    const name = attendeeName.trim();
    if (!name) return;
    // Prevent duplicate names
    if (attendeeList.some((a) => a.name.toLowerCase() === name.toLowerCase())) return;
    // Validate email if provided
    const email = attendeeEmail.trim();
    if (email && !validateEmail(email)) {
      setEmailError(`Invalid email address: "${email}"`);
      return;
    }
    setEmailError(null);
    setAttendeeList([...attendeeList, { name, email }]);
    setAttendeeName("");
    setAttendeeEmail("");
  };

  const removeAttendee = (index: number) => {
    setAttendeeList(attendeeList.filter((_, i) => i !== index));
    setEmailError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addAttendee();
    }
  };

  const handleSubmit = () => {
    if (!file) return;
    if (attendeeList.length === 0) return; // attendees is required
    const nameList = attendeeList.map((a) => a.name);
    const emailList = attendeeList.map((a) => a.email).filter(Boolean);
    const steps: string[] = [];
    if (skipAnalysis) steps.push("transcribe_analyze");
    if (skipDelivery) {
      steps.push("transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items");
    }
    onUpload(file, title || file.name, nameList, emailList, steps);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
    return `${(bytes / 1e6).toFixed(1)} MB`;
  };

  return (
    <div className={`panel upload-panel ${disabled ? "upload-panel--disabled" : ""}`}>
      <h2 data-tooltip="Upload audio files and configure meeting details for transcription">Upload Meeting Audio</h2>
      {disabled && <p className="upload-disabled-notice">⏳ A job is currently running. Start a new transcription after it finishes.</p>}

      <div
        className={`drop-zone ${dragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={disabled ? undefined : handleDrop}
        onClick={disabled ? undefined : () => fileInputRef.current?.click()}
        style={disabled ? { pointerEvents: "none", opacity: 0.5 } : undefined}
        title={file ? "Click to change file" : "Click to browse or drag and drop an audio file"}
        data-tooltip={file ? "Click to select a different audio file" : "Drag and drop an audio file here, or click to browse"}>
        {file ? (
          <div className="file-info">
            <span className="file-icon">🎵</span>
            <span className="file-name">{file.name}</span>
            <span className="file-size">{formatSize(file.size)}</span>
            <button
              className="btn-text"
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
              }}>
              Remove
            </button>
          </div>
        ) : (
          <div className="drop-hint">
            <span className="drop-icon">📂</span>
            <p>Drop an audio file here, or click to browse</p>
            <p className="hint">Supports WAV, MP3, M4A, FLAC, OGG, WebM</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.flac,.ogg,.webm"
          hidden
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
          title="Browse audio files — supports WAV, MP3, M4A, FLAC, OGG, WebM"
        />
      </div>

      <div className="form-fields" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <label>
          Meeting Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Q4 Budget Review"
            disabled={disabled}
            title="Give your meeting a descriptive title — auto-filled from filename"
            data-tooltip="Give your meeting a descriptive title — auto-filled from the audio filename"
          />
        </label>

        <div className="attendee-section">
          <label
            className="attendee-section-label"
            data-tooltip="List of meeting participants — names map to speakers, emails are used for delivery"
            data-tooltip-pos="right">
            Attendees <span className="required">*</span>
          </label>
          <span className="field-hint">Names map positionally to detected speakers for labeling. Emails are used for delivery.</span>

          <div className="attendee-input-row">
            <input
              type="text"
              className="attendee-name-input"
              value={attendeeName}
              onChange={(e) => setAttendeeName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Name (e.g. Alice Johnson)"
              disabled={disabled}
              title="Enter attendee name — maps positionally to a detected speaker"
              data-tooltip="Enter attendee name — maps positionally to a detected speaker"
            />
            <input
              type="email"
              className={`attendee-email-input${emailError ? " attendee-email-input--error" : ""}`}
              value={attendeeEmail}
              onChange={(e) => {
                setAttendeeEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Email (optional)"
              disabled={disabled}
              title="Optional email address for delivery notifications"
              data-tooltip="Optional email address — used for sending delivery notifications"
            />
            <button
              className="btn-attendee-add"
              onClick={addAttendee}
              disabled={disabled || !attendeeName.trim()}
              title="Add this attendee to the list"
              data-tooltip="Add this attendee to the meeting participant list">
              + Add
            </button>
          </div>
          {emailError && (
            <span className="field-error" style={{ marginTop: 4 }}>
              {emailError}
            </span>
          )}

          {attendeeList.length === 0 && <span className="field-error">At least one attendee is required</span>}

          {attendeeList.length > 0 && (
            <ul className="attendee-list">
              {attendeeList.map((a, i) => (
                <li key={i} className="attendee-list-item">
                  <span className="attendee-list-name">{a.name}</span>
                  {a.email && <span className="attendee-list-email">{a.email}</span>}
                  <button
                    className="btn-text attendee-remove-btn"
                    onClick={() => removeAttendee(i)}
                    title="Remove this attendee from the list"
                    data-tooltip="Remove this attendee from the list">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="skip-options" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <label className="skip-checkbox" data-tooltip="Skip AI analysis (topics, sentiment, entities) to speed up processing and save tokens">
          <input type="checkbox" checked={skipAnalysis} onChange={(e) => setSkipAnalysis(e.target.checked)} disabled={disabled} />
          <span>Skip analysis</span>
          <span className="skip-hint">(topics, sentiment, entity extraction)</span>
        </label>
        <label className="skip-checkbox" data-tooltip="Skip email, Trello, and Google Drive delivery steps to save LLM tokens and time">
          <input type="checkbox" checked={skipDelivery} onChange={(e) => setSkipDelivery(e.target.checked)} disabled={disabled} />
          <span>Skip delivery</span>
          <span className="skip-hint">(no email, Trello, or Drive — saves LLM tokens)</span>
        </label>
      </div>

      <button
        className="btn-primary"
        disabled={!file || attendeeList.length === 0 || uploading || disabled}
        onClick={handleSubmit}
        title={uploading ? "Upload in progress" : disabled ? "A job is already running" : "Submit audio and begin transcription"}
        data-tooltip={
          uploading
            ? "Uploading audio file to the server…"
            : disabled
              ? "Wait for the current job to finish before starting a new one"
              : "Upload audio and start the transcription pipeline"
        }>
        {uploading ? "Uploading..." : disabled ? "Job Running — Form Disabled" : "Start Transcription"}
      </button>
    </div>
  );
}
