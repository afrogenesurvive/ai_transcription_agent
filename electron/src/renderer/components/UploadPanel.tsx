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
import Tooltip from "./Tooltip";

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
  onUpload: (file: File, title: string, attendees: string[], emailRecipients: string[], skipSteps: string[], attendeeEmails?: string[]) => void;
  uploading: boolean;
  disabled?: boolean;
  /** Initial set of tool names to skip, derived from disabled pipeline steps in agent config. */
  initialSkipSteps?: string[];
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
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
  const [formError, setFormError] = useState<string | null>(null);
  const [attendeeConflict, setAttendeeConflict] = useState<string | null>(null);
  const [skipSteps, setSkipSteps] = useState<string[]>(initialSkipSteps ?? DEFAULT_SKIP_STEPS);
  const [savedAttendees, setSavedAttendees] = useState<AttendeeEntry[]>(loadSavedAttendees);
  const [registeredAttendees, setRegisteredAttendees] = useState<AttendeeEntry[]>([]);
  const [voiceprintEmails, setVoiceprintEmails] = useState<Set<string>>(new Set());
  const [voiceprintNames, setVoiceprintNames] = useState<Set<string>>(new Set());
  /** Map from lowercased voiceprint name → email, for resolving audio URLs
   *  when the attendee record has an empty email but a voiceprint exists. */
  const [voiceprintEmailByName, setVoiceprintEmailByName] = useState<Map<string, string>>(new Map());
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [showEmailSuggestions, setShowEmailSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [playingVp, setPlayingVp] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const nameSuggestRef = useRef<HTMLDivElement>(null);
  const emailSuggestRef = useRef<HTMLDivElement>(null);

  // Sync skipSteps when initialSkipSteps changes (e.g. agent config loaded after mount)
  useEffect(() => {
    if (initialSkipSteps) setSkipSteps(initialSkipSteps);
  }, [initialSkipSteps]);

  // ── Fetch registered attendees + voiceprints from bridge on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [attendeesRes, vpRes] = await Promise.all([
          fetch("http://127.0.0.1:5010/tools/call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_list_attendees", args: { limit: 100 } }),
            signal: AbortSignal.timeout(3000),
          }),
          fetch("http://127.0.0.1:5010/tools/call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_list_voiceprints", args: {} }),
            signal: AbortSignal.timeout(3000),
          }),
        ]);

        if (!cancelled && attendeesRes.ok) {
          const data = await attendeesRes.json();
          const attendees: AttendeeEntry[] = ((data as any).attendees || (data as any).results || []).map((a: any) => ({
            name: a.name || "",
            email: a.email || "",
          }));
          setRegisteredAttendees(attendees.filter((a: AttendeeEntry) => a.name));
        }

        if (!cancelled && vpRes.ok) {
          const vpData = await vpRes.json();
          const vps: any[] = vpData.voiceprints || [];
          const vpsWithSample = vps.filter((vp) => vp.sample_job_id);
          const emails = new Set<string>(
            vpsWithSample.map((vp) => vp.email).filter(Boolean),
          );
          setVoiceprintEmails(emails);
          // Build name-based lookups so attendees without an email
          // (but who have a voiceprint) can still show the play button
          const names = new Set<string>();
          const nameToEmail = new Map<string, string>();
          for (const vp of vpsWithSample) {
            const nameLower = (vp.name || "").toLowerCase();
            if (nameLower) {
              names.add(nameLower);
              if (vp.email) nameToEmail.set(nameLower, vp.email);
            }
          }
          setVoiceprintNames(names);
          setVoiceprintEmailByName(nameToEmail);
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
  const registeredNames = useMemo(() => new Set(registeredAttendees.map((ra) => ra.name.toLowerCase())), [registeredAttendees]);

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
      // Check each suggestion dropdown independently so clicking one input
      // dismisses the other's suggestions even when the other dropdown isn't
      // rendered yet (ref would be null in a combined && chain).
      if (nameSuggestRef.current && !nameSuggestRef.current.contains(e.target as Node)) {
        setShowNameSuggestions(false);
      }
      if (emailSuggestRef.current && !emailSuggestRef.current.contains(e.target as Node)) {
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

  const addAttendee = useCallback(
    async (name?: string, email?: string) => {
      const isManualEntry = name === undefined;
      const resolvedName = isManualEntry ? attendeeName.trim() : name.trim();
      if (!resolvedName) return;
      // Prevent duplicate names
      if (attendeeList.some((a) => a.name.toLowerCase() === resolvedName.toLowerCase())) {
        setFormError(`"${resolvedName}" is already in the attendee list.`);
        return;
      }
      // Validate email — required and must match format
      const resolvedEmail = email !== undefined ? email : attendeeEmail.trim();
      if (!resolvedEmail || !validateEmail(resolvedEmail)) {
        setFormError(resolvedEmail ? `Invalid email address: "${resolvedEmail}"` : "Email is required.");
        return;
      }

      // Server-side conflict check: verify name+email against attendee registry + voiceprints
      if (isManualEntry) {
        try {
          const conflictRes = await fetch("http://127.0.0.1:5010/tools/call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool: "attendees_check_conflicts",
              args: { entries: [{ name: resolvedName, email: resolvedEmail }] },
            }),
            signal: AbortSignal.timeout(3000),
          });
          if (conflictRes.ok) {
            const conflictData = await conflictRes.json();
            const conflicts = (conflictData as any).conflicts || [];
            if (conflicts.length > 0) {
              const messages = conflicts.map((c: any) => c.message).join(" ");
              setAttendeeConflict(messages);
              return; // Don't add — conflicts need user attention
            }
          }
        } catch {
          // Backend unavailable — proceed without conflict check (fail-open)
        }
      }

      setFormError(null);
      setAttendeeConflict(null);
      const entry: AttendeeEntry = { name: resolvedName, email: resolvedEmail };
      setAttendeeList((prev) => [...prev, entry]);
      setAttendeeName("");
      setAttendeeEmail("");
      setShowNameSuggestions(false);
      setShowEmailSuggestions(false);

      // Persist this entry for future autocomplete (skip for quick-add from registered attendees)
      if (isManualEntry) {
        setSavedAttendees((prev) => {
          const updated = [entry, ...prev];
          saveAttendees(updated);
          return updated;
        });
      }
    },
    [attendeeName, attendeeEmail, attendeeList, savedAttendees],
  );

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
    setFormError(null);
  };

  /** Resolve the voiceprint email for a registered attendee, falling back
   *  to name-based lookup when the attendee record has no email. */
  const resolveVpEmail = useCallback(
    (ra: AttendeeEntry): string | null => {
      if (ra.email && voiceprintEmails.has(ra.email)) return ra.email;
      if (voiceprintNames.has(ra.name.toLowerCase())) {
        return voiceprintEmailByName.get(ra.name.toLowerCase()) || null;
      }
      return null;
    },
    [voiceprintEmails, voiceprintNames, voiceprintEmailByName],
  );

  const handlePlayVoiceprint = useCallback(
    (email: string) => {
      setPlaybackError(null);
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
      audio.onerror = () => {
        setPlayingVp(null);
        setPlaybackError("Voice sample unavailable — no recording found for this attendee");
      };
      audio.play().catch(() => {
        setPlayingVp(null);
        setPlaybackError("Could not play voice sample — the audio may be missing");
      });
      audioRef.current = audio;
      setPlayingVp(email);
    },
    [playingVp],
  );

  // Auto-clear playback error after 4 seconds
  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => setPlaybackError(null), 4000);
    return () => clearTimeout(timer);
  }, [playbackError]);

  const handleSubmit = () => {
    if (!file) return;
    if (attendeeList.length === 0) return; // attendees is required
    const nameList = attendeeList.map((a) => a.name);
    const attendeeEmails = attendeeList.map((a) => a.email); // keep alignment with names (all now have validated emails)
    const deliveryRecipients = attendeeEmails.filter(Boolean);
    // Persist all submitted attendees for future autocomplete
    const updated = [...savedAttendees];
    for (const a of attendeeList) {
      if (!updated.some((s) => s.name.toLowerCase() === a.name.toLowerCase())) {
        updated.unshift(a);
      }
    }
    setSavedAttendees(updated);
    saveAttendees(updated);
    onUpload(file, title || file.name, nameList, deliveryRecipients, skipSteps, attendeeEmails);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
    return `${(bytes / 1e6).toFixed(1)} MB`;
  };

  return (
    <div className={`panel upload-panel ${disabled ? "upload-panel--disabled" : ""}`}>
      <Tooltip content="Upload audio files and configure meeting details for transcription">
        <h2>Upload Meeting Audio</h2>
      </Tooltip>
      {disabled && (
        <p className="upload-disabled-notice">
          <Icon name="hourglass_top" size="12" /> A job is currently running. Start a new transcription after it finishes.
        </p>
      )}

      <Tooltip content={file ? "Click to select a different audio file" : "Drag and drop an audio file here, or click to browse"}>
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
          title={file ? "Click to change file" : "Click to browse or drag and drop an audio file"}>
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
      </Tooltip>

      <div className="form-fields" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <label>
          Meeting Title
          <Tooltip content="Give your meeting a descriptive title — auto-filled from the audio filename">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q4 Budget Review"
              disabled={disabled}
              title="Give your meeting a descriptive title — auto-filled from filename"
            />
          </Tooltip>
        </label>
        <div className="attendee-section">
          <Tooltip
            content="List of meeting participants — names map to speakers, emails are required for voiceprint matching and delivery"
            position="right">
            <label className="attendee-section-label">
              Meeting Attendees <span className="required">*</span>
            </label>
          </Tooltip>
          <span className="field-hint">
            Names map positionally to detected speakers for labeling. Email is required for every attendee (voiceprint matching and delivery).
          </span>

          {attendeeConflict && (
            <div className="attendee-conflict-banner">
              <span className="attendee-conflict-icon">⚠️</span>
              <span className="attendee-conflict-text">{attendeeConflict}</span>
            </div>
          )}

          <div className="attendee-input-row">
            <div className="attendee-autocomplete-wrap">
              <Tooltip content="Enter attendee name — maps positionally to a detected speaker">
                <input
                  ref={nameInputRef}
                  type="text"
                  className="attendee-name-input"
                  value={attendeeName}
                  onChange={(e) => {
                    setAttendeeName(e.target.value);
                    setAttendeeConflict(null);
                    setFormError(null);
                    if (e.target.value || !disabled) setShowNameSuggestions(true);
                  }}
                  onFocus={() => setShowNameSuggestions(true)}
                  onKeyDown={handleNameKeyDown}
                  placeholder="Name (e.g. Alice Johnson)"
                  disabled={disabled}
                  autoComplete="off"
                  title="Enter attendee name — maps positionally to a detected speaker"
                />
              </Tooltip>
              {showNameSuggestions && nameSuggestions.length > 0 && !disabled && (
                <div className="attendee-suggestions" ref={nameSuggestRef}>
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
              <Tooltip content="Email is required — used for voiceprint matching and delivery notifications">
                <input
                  ref={emailInputRef}
                  type="email"
                  className={`attendee-email-input${formError ? " attendee-email-input--error" : ""}`}
                  value={attendeeEmail}
                  onChange={(e) => {
                    setAttendeeEmail(e.target.value);
                    setAttendeeConflict(null);
                    setFormError(null);
                    if (e.target.value || !disabled) setShowEmailSuggestions(true);
                  }}
                  onFocus={() => setShowEmailSuggestions(true)}
                  onKeyDown={handleEmailKeyDown}
                  placeholder="Email (required)"
                  disabled={disabled}
                  autoComplete="off"
                  title="Email is required for voiceprint matching and delivery notifications"
                />
              </Tooltip>
              {showEmailSuggestions && emailSuggestions.length > 0 && !disabled && (
                <div className="attendee-suggestions" ref={emailSuggestRef}>
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
            <Tooltip content="Add this attendee to the meeting participant list">
              <button
                className="btn-attendee-add"
                onClick={() => addAttendee()}
                disabled={disabled || !attendeeName.trim()}
                title="Add this attendee to the list">
                + Add
              </button>
            </Tooltip>
          </div>
          {formError && (
            <span className="field-error" style={{ marginTop: 4 }}>
              {formError}
            </span>
          )}

          {attendeeList.length === 0 && <span className="field-error">At least one attendee is required</span>}

          {attendeeList.length > 0 && (
            <ul className="attendee-list">
              {attendeeList.map((a, i) => (
                <li key={i} className={`attendee-list-item${registeredNames.has(a.name.toLowerCase()) ? " attendee-list-item--registered" : ""}`}>
                  <span className="attendee-list-name">{a.name}</span>
                  {a.email && <span className="attendee-list-email">{a.email}</span>}
                  {registeredNames.has(a.name.toLowerCase()) && (
                    <Tooltip content="This attendee is in the registered attendees list">
                      <span className="attendee-list-badge">Registered</span>
                    </Tooltip>
                  )}
                  <Tooltip content="Remove this attendee from the list">
                    <button className="btn-text attendee-remove-btn" onClick={() => removeAttendee(i)} title="Remove this attendee from the list">
                      <Icon name="close" size="12" />
                    </button>
                  </Tooltip>
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
                        {(() => {
                          const vpEmail = resolveVpEmail(ra);
                          if (vpEmail) {
                            return (
                              <Tooltip content={playingVp === vpEmail ? "Stop playback" : "Hear a 3-second voice sample of this attendee"}>
                                <button
                                  className="btn-text attendee-play-btn"
                                  onClick={() => handlePlayVoiceprint(vpEmail)}
                                  title={playingVp === vpEmail ? "Stop playback" : "Play voice sample"}>
                                  <Icon name={playingVp === vpEmail ? "stop" : "play_arrow"} size="14" color="accent" />
                                </button>
                              </Tooltip>
                            );
                          }
                          // No voiceprint for this attendee at all
                          return ra.email ? (
                            <Tooltip content="This attendee does not have an enrolled voiceprint with a sample recording">
                              <span className="btn-text attendee-play-btn attendee-play-btn--disabled" title="No voice sample available">
                                <Icon name="play_arrow" size="14" color="muted" />
                              </span>
                            </Tooltip>
                          ) : null;
                        })()}
                        <Tooltip content={`Click to add ${ra.name} to the meeting participant list`}>
                          <button
                            className="btn-text attendee-add-btn"
                            onClick={() => addAttendee(ra.name, ra.email)}
                            title={`Add ${ra.name} to attendee list`}>
                            <Icon name="add" size="14" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Playback error toast */}
          {playbackError && (
            <div
              className="rv-playback-error"
              style={{ marginTop: 8, fontSize: 11, color: "var(--orange)", display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="warning" size="12" color="orange" />
              <span>{playbackError}</span>
            </div>
          )}
        </div>
      </div>

      {/* <div className="skip-options" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        {Object.entries(SKIPPABLE_STEPS).map(([toolName, { label, hint }]) => (
          <Tooltip content={`${label} — ${hint.replace(/[()]/g, "")}`} position="bottom">
            <label key={toolName} className="skip-checkbox">
              <input type="checkbox" checked={skipSteps.includes(toolName)} onChange={() => toggleSkip(toolName)} disabled={disabled} />
              <span>{label}</span>
              <span className="skip-hint">{hint}</span>
            </label>
          </Tooltip>
        ))}
      </div> */}

      <Tooltip
        content={
          uploading
            ? "Uploading audio file to the server…"
            : disabled
              ? "Wait for the current job to finish before starting a new one"
              : "Upload audio and start the transcription pipeline"
        }>
        <button
          className="btn-primary"
          disabled={!file || attendeeList.length === 0 || uploading || disabled}
          onClick={handleSubmit}
          title={uploading ? "Upload in progress" : disabled ? "A job is already running" : "Submit audio and begin transcription"}>
          {uploading ? "Uploading..." : disabled ? "Job Running — Form Disabled" : "Start Transcription"}
        </button>
      </Tooltip>
    </div>
  );
}
