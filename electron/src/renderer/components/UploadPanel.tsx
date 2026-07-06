/**
 * Upload Panel — drag-and-drop or file-picker for audio upload.
 */

import React, { useState, useRef, useCallback } from "react";

interface Props {
  onUpload: (file: File, title: string, attendees: string[], skipSteps: string[]) => void;
  uploading: boolean;
  disabled?: boolean;
}

export default function UploadPanel({ onUpload, uploading, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState("");
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

  const handleSubmit = () => {
    if (!file) return;
    const steps: string[] = [];
    if (skipAnalysis) steps.push("transcribe_analyze");
    if (skipDelivery) {
      steps.push("transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items");
    }
    onUpload(
      file,
      title || file.name,
      attendees
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      steps,
    );
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
    return `${(bytes / 1e6).toFixed(1)} MB`;
  };

  return (
    <div className={`panel upload-panel ${disabled ? "upload-panel--disabled" : ""}`}>
      <h2>Upload Meeting Audio</h2>
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
        style={disabled ? { pointerEvents: "none", opacity: 0.5 } : undefined}>
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
        />
      </div>

      <div className="form-fields" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <label>
          Meeting Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Q4 Budget Review" disabled={disabled} />
        </label>
        <label>
          Attendees (comma-separated emails)
          <input type="text" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="john@co.com, mary@co.com" disabled={disabled} />
        </label>
      </div>

      <div className="skip-options" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <label className="skip-checkbox">
          <input type="checkbox" checked={skipAnalysis} onChange={(e) => setSkipAnalysis(e.target.checked)} disabled={disabled} />
          <span>Skip analysis</span>
          <span className="skip-hint">(topics, sentiment, entity extraction)</span>
        </label>
        <label className="skip-checkbox">
          <input type="checkbox" checked={skipDelivery} onChange={(e) => setSkipDelivery(e.target.checked)} disabled={disabled} />
          <span>Skip delivery</span>
          <span className="skip-hint">(no email, Trello, or Drive — saves LLM tokens)</span>
        </label>
      </div>

      <button className="btn-primary" disabled={!file || uploading || disabled} onClick={handleSubmit}>
        {uploading ? "Uploading..." : disabled ? "Job Running — Form Disabled" : "Start Transcription"}
      </button>
    </div>
  );
}
