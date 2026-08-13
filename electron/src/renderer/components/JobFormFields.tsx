/**
 * JobFormFields — shared new-job detail form: meeting title, the voiceprint-
 * aware attendee editor, and the Google delivery-connect row.
 *
 * Used by all three New Job tabs (Upload / System Recording / Teams-Zoom).
 * Controlled via props; the parent owns `title`, `attendeeList`, and
 * `skipSteps`. Delivery validation is exposed through a ref handle so the
 * parent's submit path can fail fast before starting the pipeline.
 */

import React, { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import LoadingModal from "./LoadingModal";

export interface AttendeeEntry {
  name: string;
  email: string;
}

export interface JobFormFieldsProps {
  title: string;
  onTitleChange: (title: string) => void;
  attendeeList: AttendeeEntry[];
  onAttendeeListChange: (list: AttendeeEntry[]) => void;
  skipSteps: string[];
  onSkipStepsChange: (steps: string[]) => void;
  disabled?: boolean;
  /** Bumped by the parent when the panel is opened — re-checks dynamic state (e.g. Gmail connection). */
  refreshTrigger?: number;
}

export interface JobFormFieldsHandle {
  /** Validate the Google delivery integration (no-op when delivery is skipped). */
  validateDelivery: () => Promise<boolean>;
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

const JobFormFields = forwardRef<JobFormFieldsHandle, JobFormFieldsProps>(function JobFormFields(
  { title, onTitleChange, attendeeList, onAttendeeListChange, skipSteps, onSkipStepsChange, disabled, refreshTrigger }: JobFormFieldsProps,
  ref,
) {
  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [attendeeConflict, setAttendeeConflict] = useState<string | null>(null);
  const [attendeeWarnings, setAttendeeWarnings] = useState<string[]>([]);
  const [addingAttendee, setAddingAttendee] = useState(false);
  const [savedAttendees, setSavedAttendees] = useState<AttendeeEntry[]>(loadSavedAttendees);
  const [registeredAttendees, setRegisteredAttendees] = useState<AttendeeEntry[]>([]);
  const [voiceprintEmails, setVoiceprintEmails] = useState<Set<string>>(new Set());
  const [voiceprintNames, setVoiceprintNames] = useState<Set<string>>(new Set());
  const [voiceprintEmailByName, setVoiceprintEmailByName] = useState<Map<string, string>>(new Map());
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [showEmailSuggestions, setShowEmailSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [playingVp, setPlayingVp] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const nameSuggestRef = useRef<HTMLDivElement>(null);
  const emailSuggestRef = useRef<HTMLDivElement>(null);

  // ── Gmail "Connect with Google" (only surfaced when a delivery step is enabled) ──
  const [gmailAuthPending, setGmailAuthPending] = useState(false);
  const [gmailAuthFeedback, setGmailAuthFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailUser, setGmailUser] = useState("");
  const [validatingGmail, setValidatingGmail] = useState(false);
  const [gmailDisconnected, setGmailDisconnected] = useState(false);

  // Detect whether Google is already connected (a refresh token is saved).
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      window.electronAPI?.getConfig().then((cfg) => {
        if (cancelled) return;
        const token = (cfg?.GMAIL_REFRESH_TOKEN || "").trim();
        setGmailConnected(!!token);
        setGmailDisconnected(false);
        setGmailUser((cfg?.GMAIL_USER || "").trim());
      });
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [refreshTrigger]);

  // Cancel any pending Gmail OAuth flow when the form unmounts.
  useEffect(() => {
    return () => {
      window.electronAPI?.cancelGmailOAuth();
    };
  }, []);

  const connectGmail = useCallback(async () => {
    if (gmailAuthPending || disabled) return;
    setGmailAuthPending(true);
    setGmailAuthFeedback(null);
    try {
      const res = await window.electronAPI?.startGmailOAuth();
      if (res?.ok) {
        await window.electronAPI?.saveConfig({
          GMAIL_CLIENT_ID: res.clientId ?? "",
          GMAIL_CLIENT_SECRET: res.clientSecret ?? "",
          GMAIL_REFRESH_TOKEN: res.refreshToken ?? "",
          GMAIL_USER: res.user ?? "",
        });
        setGmailConnected(!!res.refreshToken);
        setGmailDisconnected(false);
        setGmailUser(res.user || "");
        setGmailAuthFeedback({ type: "ok", text: res.user ? `Google connected: ${res.user}` : "Google connected — ready to deliver." });
      } else {
        setGmailAuthFeedback({ type: "err", text: res?.error || "Google authorization failed or was cancelled — try again." });
      }
    } catch {
      setGmailAuthFeedback({ type: "err", text: "Google authorization failed — try again." });
    } finally {
      setGmailAuthPending(false);
    }
  }, [gmailAuthPending, disabled]);

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
          const emails = new Set<string>(vpsWithSample.map((vp) => vp.email).filter(Boolean));
          setVoiceprintEmails(emails);
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

  const googleDeliveryEnabled = !skipSteps.includes("send_delivery_email") || !skipSteps.includes("save_to_drive");

  /** Validate the Google integration when a delivery step is enabled. */
  useImperativeHandle(ref, () => ({
    validateDelivery: async (): Promise<boolean> => {
      if (!googleDeliveryEnabled) return true;
      setValidatingGmail(true);
      let valid = false;
      try {
        const res = await window.electronAPI?.validateGmailOAuth();
        valid = !!res?.ok;
      } catch {
        valid = false;
      } finally {
        setValidatingGmail(false);
      }
      if (!valid) {
        setGmailConnected(false);
        setGmailDisconnected(true);
        return false;
      }
      return true;
    },
  }));

  const registeredNames = useMemo(() => new Set(registeredAttendees.map((ra) => ra.name.toLowerCase())), [registeredAttendees]);

  const allKnownAttendees = useMemo(() => {
    const map = new Map<string, AttendeeEntry>();
    for (const a of savedAttendees) if (a.name) map.set(a.name.toLowerCase(), a);
    for (const a of registeredAttendees) if (a.name && !map.has(a.name.toLowerCase())) map.set(a.name.toLowerCase(), a);
    return Array.from(map.values());
  }, [savedAttendees, registeredAttendees]);

  const unusedSaved = useMemo(
    () => allKnownAttendees.filter((a) => !attendeeList.some((cur) => cur.name.toLowerCase() === a.name.toLowerCase())),
    [allKnownAttendees, attendeeList],
  );

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

  useEffect(() => {
    setActiveSuggestionIndex(-1);
  }, [nameSuggestions.length, emailSuggestions.length]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
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

  const addAttendee = useCallback(
    async (name?: string, email?: string) => {
      if (addingAttendee) return;
      const isManualEntry = name === undefined;
      const resolvedName = isManualEntry ? attendeeName.trim() : name.trim();
      if (!resolvedName) return;
      if (attendeeList.some((a) => a.name.toLowerCase() === resolvedName.toLowerCase())) {
        setFormError(`"${resolvedName}" is already in the attendee list.`);
        return;
      }
      const resolvedEmail = email !== undefined ? email : attendeeEmail.trim();
      if (!resolvedEmail || !validateEmail(resolvedEmail)) {
        setFormError(resolvedEmail ? `Invalid email address: "${resolvedEmail}"` : "Email is required.");
        return;
      }

      setAddingAttendee(true);
      try {
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
              const warnings = (conflictData as any).warnings || [];
              if (conflicts.length > 0) {
                const messages = conflicts.map((c: any) => c.message).join(" ");
                setAttendeeConflict(messages);
                setAttendeeWarnings([]);
                return;
              }
              if (warnings.length > 0) {
                setAttendeeWarnings(warnings.map((w: any) => w.message));
              } else {
                setAttendeeWarnings([]);
              }
            }
          } catch {
            // Backend unavailable — proceed without conflict check (fail-open)
          }
        }

        setFormError(null);
        setAttendeeConflict(null);
        const entry: AttendeeEntry = { name: resolvedName, email: resolvedEmail };
        onAttendeeListChange([...attendeeList, entry]);
        setAttendeeName("");
        setAttendeeEmail("");
        setShowNameSuggestions(false);
        setShowEmailSuggestions(false);

        if (isManualEntry) {
          setSavedAttendees((prev) => {
            const updated = [entry, ...prev];
            saveAttendees(updated);
            return updated;
          });
        }
      } finally {
        setAddingAttendee(false);
      }
    },
    [attendeeName, attendeeEmail, attendeeList, savedAttendees, addingAttendee, onAttendeeListChange],
  );

  const selectSuggestion = (entry: AttendeeEntry) => {
    setAttendeeName(entry.name);
    setAttendeeEmail(entry.email || "");
    setShowNameSuggestions(false);
    setShowEmailSuggestions(false);
    setActiveSuggestionIndex(-1);
    setTimeout(() => {
      if (entry.email) {
        emailInputRef.current?.focus();
      } else {
        nameInputRef.current?.focus();
      }
    }, 0);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (addingAttendee) return;
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

  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (addingAttendee) return;
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
    onAttendeeListChange(attendeeList.filter((_, i) => i !== index));
    setFormError(null);
    setAttendeeWarnings([]);
  };

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

  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => setPlaybackError(null), 4000);
    return () => clearTimeout(timer);
  }, [playbackError]);

  return (
    <div className="form-fields" style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
      <label>
        Meeting Title
        <Tooltip content="Give your meeting a descriptive title — auto-filled from the audio filename">
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
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

        {attendeeWarnings.length > 0 && (
          <div className="attendee-warning-banner">
            <span className="attendee-warning-icon">ℹ️</span>
            <span className="attendee-warning-text">{attendeeWarnings.join(" ")}</span>
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
                  setAttendeeWarnings([]);
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
                  setAttendeeWarnings([]);
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
          <Tooltip content={addingAttendee ? "Checking attendee conflicts…" : "Add this attendee to the meeting participant list"}>
            <button
              className="btn-attendee-add"
              onClick={() => addAttendee()}
              disabled={disabled || addingAttendee || !attendeeName.trim()}
              title={addingAttendee ? "Checking attendee conflicts…" : "Add this attendee to the list"}>
              {addingAttendee ? (
                <>
                  <Icon name="hourglass_top" size="14" /> Checking…
                </>
              ) : (
                "+ Add"
              )}
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
                        return ra.email ? (
                          <Tooltip content="This attendee does not have an enrolled voiceprint with a sample recording">
                            <span className="btn-text attendee-play-btn attendee-play-btn--disabled" title="No voice sample available">
                              <Icon name="play_arrow" size="14" color="muted" />
                            </span>
                          </Tooltip>
                        ) : null;
                      })()}
                      <Tooltip content={addingAttendee ? "Checking attendee conflicts…" : `Click to add ${ra.name} to the meeting participant list`}>
                        <button
                          className="btn-text attendee-add-btn"
                          onClick={() => addAttendee(ra.name, ra.email)}
                          disabled={addingAttendee}
                          title={addingAttendee ? "Checking attendee conflicts…" : `Add ${ra.name} to attendee list`}>
                          {addingAttendee ? <Icon name="hourglass_top" size="14" /> : <Icon name="add" size="14" />}
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

      {/* ── Google delivery status (shown only when a Google-dependent delivery step is enabled) ── */}
      {googleDeliveryEnabled && (
        <div className="delivery-connect">
          <div className="delivery-connect-row">
            <Icon name="email" size="14" color="accent" />
            <span className="delivery-connect-label">Delivery</span>
            {gmailDisconnected ? (
              <>
                <span className="delivery-connect-feedback delivery-connect-feedback--err">Google disconnected — reconnect to enable delivery</span>
                <button
                  className="config-update-status-btn config-update-status-btn--accent"
                  onClick={connectGmail}
                  disabled={gmailAuthPending || disabled}
                  title="Reconnect Google to enable delivery"
                  type="button">
                  {gmailAuthPending ? (
                    <>
                      <span className="updates-spinner updates-spinner--small" /> Connecting…
                    </>
                  ) : (
                    <>
                      <Icon name="link" size="14" /> Reconnect
                    </>
                  )}
                </button>
              </>
            ) : gmailConnected ? (
              <>
                <span className="delivery-connect-feedback delivery-connect-feedback--ok">Google connected: {gmailUser || "your account"}</span>
                <button
                  className="config-update-status-btn"
                  onClick={connectGmail}
                  disabled={gmailAuthPending || disabled}
                  title="Reconnect Google (needed about weekly while the app is unverified)"
                  type="button">
                  {gmailAuthPending ? (
                    <>
                      <span className="updates-spinner updates-spinner--small" /> Connecting…
                    </>
                  ) : (
                    <>Reconnect</>
                  )}
                </button>
              </>
            ) : (
              <>
                <span className="delivery-connect-feedback">Delivery is enabled but Google isn&apos;t connected yet.</span>
                <button
                  className="config-update-status-btn config-update-status-btn--accent"
                  onClick={connectGmail}
                  disabled={gmailAuthPending || disabled}
                  title="Connect your Google account to enable email and Drive delivery"
                  type="button">
                  {gmailAuthPending ? (
                    <>
                      <span className="updates-spinner updates-spinner--small" /> Waiting for Google authorization…
                    </>
                  ) : (
                    <>
                      <Icon name="link" size="14" /> Connect with Google
                    </>
                  )}
                </button>
              </>
            )}
          </div>
          {gmailAuthFeedback && (
            <div className={`delivery-connect-feedback delivery-connect-feedback--${gmailAuthFeedback.type}`}>{gmailAuthFeedback.text}</div>
          )}
        </div>
      )}

      <LoadingModal visible={validatingGmail} message="Checking Google integration…" />
    </div>
  );
});

export default JobFormFields;
