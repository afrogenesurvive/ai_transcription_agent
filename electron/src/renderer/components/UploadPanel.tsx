/**
 * Upload Panel — drag-and-drop or file-picker for audio upload.
 *
 * Attendee autocomplete: previously entered attendees are saved to localStorage
 * and suggested as the user types in the name or email fields. Clicking a
 * suggestion fills both fields at once, making repeated entries much faster.
 * The suggestion list is capped at 50 entries (most recent first).
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Icon from "./Icon";

interface AttendeeEntry {
  name: string;
  email: string;
}

/** Known non-essential pipeline steps that can be skipped in the upload form. */
const SKIPPABLE_STEPS: Record<string, { label: string; hint: string }> = {
  transcribe_refine: { label: "Skip refine", hint: "(filler word removal, PII redaction)" },
  transcribe_analyze: { label: "Skip analysis", hint: "(topics, sentiment, entity extraction)" },
  transcribe_prepare_delivery: { label: "Skip delivery prep", hint: "(prepare email, Drive, Trello)" },
  send_delivery_email: { label: "Skip email", hint: "(no email delivery)" },
  save_to_drive: { label: "Skip Drive", hint: "(no Google Drive save)" },
  create_trello_action_items: { label: "Skip Trello", hint: "(no Trello cards)" },
};

interface Props {
  onUpload: (file: File, title: string, attendees: string[], emailRecipients: string[], skipSteps: string[]) => void;
  uploading: boolean;
  disabled?: boolean;
  /** Initial set of tool names to skip, derived from disabled pipeline steps in agent config. */
  initialSkipSteps?: string[];
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  if (!email.trim()) return true; // empty is allowed (optional)
  return EMAIL_RE.test(email);
}

// ── Saved attendee persistence (localStorage) ──

const STORAGE_KEY = "transcription_agent_saved_attendees";
const MAX_SAVED = 50;

function loadSavedAttendees(): AttendeeEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AttendeeEntry[];
  } catch {
    return [];
  }
}

function saveAttendees(attendees: AttendeeEntry[]): void {
  try {
    // Deduplicate by name (case-insensitive), keep most recent first
    const seen = new Set<string>();
    const deduped: AttendeeEntry[] = [];
    for (const a of attendees) {
      const key = a.name.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(a);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped.slice(0, MAX_SAVED)));
  } catch {
    /* localStorage full or unavailable — non-fatal */
  }
}

/** Default initial skip steps when agent config is unavailable. */
const DEFAULT_SKIP_STEPS = [
  "transcribe_analyze",
  "transcribe_prepare_delivery",
  "send_delivery_email",
  "save_to_drive",
  "create_trello_action_items",
];

export default function UploadPanel({ onUpload, uploading, disabled, initialSkipSteps }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [attendeeList, setAttendeeList] = useState<AttendeeEntry[]>([]);
  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [skipSteps, setSkipSteps] = useState<string[]>(initialSkipSteps ?? DEFAULT_SKIP_STEPS);
  const [savedAttendees, setSavedAttendees] = useState<AttendeeEntry[]>(loadSavedAttendees);
  const [registeredAttendees, setRegisteredAttendees] = useState<AttendeeEntry[]>([]);
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [showEmailSuggestions, setShowEmailSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [playingVp, setPlayingVp] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);

  // Sync skipSteps when initialSkipSteps changes (e.g. agent config loaded after mount)
  useEffect(() => {
    if (initialSkipSteps) setSkipSteps(initialSkipSteps);
  }, [initialSkipSteps]);

  // ── Fetch registered attendees from bridge on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("http://127.0.0.1:5010/tools/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "transcribe_list_attendees", args: { limit: 100 } }),
          signal: AbortSignal.timeout(3000),
        });
        if (!cancelled && res.ok) {
          const data = await res.json();
          const attendees: AttendeeEntry[] = ((data as any).attendees || (data as any).results || []).map((a: any) => ({
            name: a.name || "",
            email: a.email || "",
          }));
          setRegisteredAttendees(attendees.filter((a: AttendeeEntry) => a.name));
        }
      } catch {
        // Bridge unavailable — use only saved attendees
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Toggle a tool name in/out of the skip list. */
  const toggleSkip = useCallback((toolName: string) => {
    setSkipSteps((prev) => (prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName]));
  }, []);

  /** Check whether the "delivery" group is fully skipped. */
  const deliveryTools = ["transcribe_prepare_delivery", "send_delivery_email", "save_to_drive", "create_trello_action_items"];
  const deliveryFullySkipped = deliveryTools.every((t) => skipSteps.includes(t));
  const anyDeliverySkipped = deliveryTools.some((t) => skipSteps.includes(t));

  // Set of registered attendee names (lowercase) for UI highlighting
  const registeredNames = useMemo(
    () => new Set(registeredAttendees.map((ra) => ra.name.toLowerCase())),
    [registeredAttendees],
  );

  // Merge saved attendees with registered attendees from bridge, deduped by name
  const allKnownAttendees = useMemo(() => {
    const map = new Map<string, AttendeeEntry>();
    for (const a of savedAttendees) if (a.name) map.set(a.name.toLowerCase(), a);
    for (const a of registeredAttendees) if (a.name && !map.has(a.name.toLowerCase())) map.set(a.name.toLowerCase(), a);
    return Array.from(map.values());
  }, [savedAttendees, registeredAttendees]);

  // Filter known attendees that aren't already in the current list
  const unusedSaved = useMemo(
    () => allKnownAttendees.filter((a) => !attendeeList.some((cur) => cur.name.toLowerCase() === a.name.toLowerCase())),
    [allKnownAttendees, attendeeList],
  );

  // Suggestions matching the current text input
  const nameSuggestions = useMemo(() => {
    if (!attendeeName.trim()) return unusedSaved;
    const q = attendeeName.toLowerCase();
    return unusedSaved.filter((a) => a.name.toLowerCase().includes(q));
  }, [attendeeName, unusedSaved]);

  const emailSuggestions = useMemo(() => {
    if (!attendeeEmail.trim()) return unusedSaved.filter((a) => a.email);
    const q = attendeeEmail.toLowerCase();
    return unusedSaved.filter((a) => a.email && a.email.toLowerCase().includes(q));
  }, [attendeeEmail, unusedSaved]);

  // Reset active suggestion index when suggestions list changes
  useEffect(() => {
    setActiveSuggestionIndex(-1);
  }, [nameSuggestions.length, emailSuggestions.length]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) {
        setShowNameSuggestions(false);
        setShowEmailSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

  const addAttendee = (name?: string, email?: string) => {
    const isManualEntry = name === undefined;
    const resolvedName = isManualEntry ? attendeeName.trim() : name.trim();
    if (!resolvedName) return;
    // Prevent duplicate names
    if (attendeeList.some((a) => a.name.toLowerCase() === resolvedName.toLowerCase())) return;
    // Only for manual entry: if this name matches a registered attendee, reject it
    if (isManualEntry && registeredAttendees.some((ra) => ra.name.toLowerCase() === resolvedName.toLowerCase())) {
      setEmailError(`"${resolvedName}" is a registered attendee — use the + Add button below to add them`);
      setAttendeeName("");
      setAttendeeEmail("");
      setShowNameSuggestions(false);
      setShowEmailSuggestions(false);
      return;
    }
    // Validate email if provided
    const resolvedEmail = email !== undefined ? email : attendeeEmail.trim();
    if (resolvedEmail && !validateEmail(resolvedEmail)) {
      setEmailError(`Invalid email address: "${resolvedEmail}"`);
      return;
    }
    setEmailError(null);
    const entry: AttendeeEntry = { name: resolvedName, email: resolvedEmail };
    setAttendeeList([...attendeeList, entry]);
    setAttendeeName("");
    setAttendeeEmail("");
    setShowNameSuggestions(false);
    setShowEmailSuggestions(false);

    // Persist this entry for future autocomplete
    const updated = [entry, ...savedAttendees];
    setSavedAttendees(updated);
    saveAttendees(updated);
  };

  // Select a suggestion: fill name + email, then focus the email field
  const selectSuggestion = (entry: AttendeeEntry) => {
    setAttendeeName(entry.name);
    setAttendeeEmail(entry.email || "");
    setShowNameSuggestions(false);
    setShowEmailSuggestions(false);
    setActiveSuggestionIndex(-1);
    // Focus the email input if there's an email, otherwise the Add button
    setTimeout(() => {
      if (entry.email) {
        emailInputRef.current?.focus();
      } else {
        // Move focus to Add button or name input
        nameInputRef.current?.focus();
      }
    }, 0);
  };

  // Keyboard navigation for name suggestions
  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeSuggestionIndex >= 0 && activeSuggestionIndex < nameSuggestions.length) {
        selectSuggestion(nameSuggestions[activeSuggestionIndex]);
      } else {
        addAttendee();
      }
      return;
    }
    if (!showNameSuggestions || nameSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.min(i + 1, nameSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Escape") {
      setShowNameSuggestions(false);
      setActiveSuggestionIndex(-1);
    }
  };

  // Keyboard navigation for email suggestions
  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeSuggestionIndex >= 0 && activeSuggestionIndex < emailSuggestions.length) {
        selectSuggestion(emailSuggestions[activeSuggestionIndex]);
      } else {
        addAttendee();
      }
      return;
    }
    if (!showEmailSuggestions || emailSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.min(i + 1, emailSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Escape") {
      setShowEmailSuggestions(false);
      setActiveSuggestionIndex(-1);
    }
  };

  const removeAttendee = (index: number) => {
    setAttendeeList(attendeeList.filter((_, i) => i !== index));
    setEmailError(null);
  };

  const handlePlayVoiceprint = useCallback(
    (email: string) => {
      if (playingVp === email) {
        audioRef.current?.pause();
        setPlayingVp(null);
        return;
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(`http://127.0.0.1:5010/agent/voiceprints/sample/${encodeURIComponent(email)}`);
      audio.onended = () => setPlayingVp(null);
      audio.onerror = () => setPlayingVp(null);
      audio.play().catch(() => setPlayingVp(null));
      audioRef.current = audio;
      setPlayingVp(email);
    },
    [playingVp],
  );

  const handleSubmit = () => {
    if (!file) return;
    if (attendeeList.length === 0) return; // attendees is required
    const nameList = attendeeList.map((a) => a.name);
    const emailList = attendeeList.map((a) => a.email).filter(Boolean);
    // Persist all submitted attendees for future autocomplete
    const updated = [...savedAttendees];
    for (const a of attendeeList) {
      if (!updated.some((s) => s.name.toLowerCase() === a.name.toLowerCase())) {
        updated.unshift(a);
      }
    }
    setSavedAttendees(updated);
    saveAttendees(updated);
    onUpload(file, title || file.name, nameList, emailList, skipSteps);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
    return `${(bytes / 1e6).toFixed(1)} MB`;
  };

  return (
    <div className={`panel upload-panel ${disabled ? "upload-panel--disabled" : ""}`}>
      <h2 data-tooltip="Upload audio files and configure meeting details for transcription">Upload Meeting Audio</h2>
      {disabled && (
        <p className="upload-disabled-notice">
          <Icon name="hourglass_top" size="12" /> A job is currently running. Start a new transcription after it finishes.
        </p>
      )}

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
            <span className="file-icon">
              <Icon name="audio_file" size="32" color="accent" />
            </span>
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
            <span className="drop-icon">
              <Icon name="folder_open" size="32" color="accent" />
            </span>
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
            Meeting Attendees <span className="required">*</span>
          </label>
          <span className="field-hint">Names map positionally to detected speakers for labeling. Emails are used for delivery.</span>

          <div className="attendee-input-row">
            <div className="attendee-autocomplete-wrap">
              <input
                ref={nameInputRef}
                type="text"
                className="attendee-name-input"
                value={attendeeName}
                onChange={(e) => {
                  setAttendeeName(e.target.value);
                  if (e.target.value || !disabled) setShowNameSuggestions(true);
                }}
                onFocus={() => setShowNameSuggestions(true)}
                onKeyDown={handleNameKeyDown}
                placeholder="Name (e.g. Alice Johnson)"
                disabled={disabled}
                autoComplete="off"
                title="Enter attendee name — maps positionally to a detected speaker"
                data-tooltip="Enter attendee name — maps positionally to a detected speaker"
              />
              {showNameSuggestions && nameSuggestions.length > 0 && !disabled && (
                <div className="attendee-suggestions" ref={suggestRef}>
                  {nameSuggestions.map((entry, i) => (
                    <button
                      key={entry.name}
                      className={`attendee-suggestion-item ${i === activeSuggestionIndex ? "attendee-suggestion-item--active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectSuggestion(entry);
                      }}
                      type="button">
                      <span className="attendee-suggestion-name">{entry.name}</span>
                      {entry.email && <span className="attendee-suggestion-email">{entry.email}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="attendee-autocomplete-wrap">
              <input
                ref={emailInputRef}
                type="email"
                className={`attendee-email-input${emailError ? " attendee-email-input--error" : ""}`}
                value={attendeeEmail}
                onChange={(e) => {
                  setAttendeeEmail(e.target.value);
                  if (e.target.value || !disabled) setShowEmailSuggestions(true);
                }}
                onFocus={() => setShowEmailSuggestions(true)}
                onKeyDown={handleEmailKeyDown}
                placeholder="Email (optional)"
                disabled={disabled}
                autoComplete="off"
                title="Optional email address for delivery notifications"
                data-tooltip="Optional email address — used for sending delivery notifications"
              />
              {showEmailSuggestions && emailSuggestions.length > 0 && !disabled && (
                <div className="attendee-suggestions" ref={suggestRef}>
                  {emailSuggestions.map((entry, i) => (
                    <button
                      key={entry.name}
                      className={`attendee-suggestion-item ${i === activeSuggestionIndex ? "attendee-suggestion-item--active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectSuggestion(entry);
                      }}
                      type="button">
                      <span className="attendee-suggestion-name">{entry.name}</span>
                      <span className="attendee-suggestion-email">{entry.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="btn-attendee-add"
              onClick={() => addAttendee()}
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
                <li
                  key={i}
                  className={`attendee-list-item${registeredNames.has(a.name.toLowerCase()) ? " attendee-list-item--registered" : ""}`}>
                  <span className="attendee-list-name">{a.name}</span>
                  {a.email && <span className="attendee-list-email">{a.email}</span>}
                  {registeredNames.has(a.name.toLowerCase()) && (
                    <span className="attendee-list-badge" data-tooltip="This attendee is in the registered attendees list">Registered</span>
                  )}
                  <button
                    className="btn-text attendee-remove-btn"
                    onClick={() => removeAttendee(i)}
                    title="Remove this attendee from the list"
                    data-tooltip="Remove this attendee from the list">
                    <Icon name="close" size="12" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Registered attendee quick-add list */}
          {registeredAttendees.length > 0 && (
            <div className="registered-attendees">
              <span className="registered-attendees-label">
                <Icon name="badge" size="12" color="accent" /> Registered attendees:
              </span>
              <div className="registered-attendees-list">
                {registeredAttendees
                  .filter((ra) => !attendeeList.some((a) => a.name.toLowerCase() === ra.name.toLowerCase()))
                  .map((ra) => (
                    <div key={ra.name} className="registered-attendee-row">
                      <span className="registered-attendee-name">{ra.name}</span>
                      {ra.email && <span className="registered-attendee-email">{ra.email}</span>}
                      <div className="registered-attendee-actions">
                        {ra.email && (
                          <button
                            className="btn-text attendee-play-btn"
                            onClick={() => handlePlayVoiceprint(ra.email)}
                            title={playingVp === ra.email ? "Stop playback" : "Play voice sample"}
                            data-tooltip={playingVp === ra.email ? "Stop playback" : "Hear a 3-second voice sample of this attendee"}>
                            <Icon name={playingVp === ra.email ? "stop" : "play_arrow"} size="14" color="accent" />
                          </button>
                        )}
                        <button
                          className="btn-text attendee-add-btn"
                          onClick={() => addAttendee(ra.name, ra.email)}
                          title={`Add ${ra.name} to attendee list`}
                          data-tooltip={`Click to add ${ra.name} to the meeting participant list`}>
                          <Icon name="add" size="14" />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* <div className="skip-options" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        {Object.entries(SKIPPABLE_STEPS).map(([toolName, { label, hint }]) => (
          <label key={toolName} className="skip-checkbox" data-tooltip={`${label} — ${hint.replace(/[()]/g, "")}`}>
            <input type="checkbox" checked={skipSteps.includes(toolName)} onChange={() => toggleSkip(toolName)} disabled={disabled} />
            <span>{label}</span>
            <span className="skip-hint">{hint}</span>
          </label>
        ))}
      </div> */}

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
