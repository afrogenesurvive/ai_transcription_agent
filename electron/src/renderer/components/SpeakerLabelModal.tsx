/**
 * Speaker Label Modal — appears when pipeline pauses after diarization.
 *
 * Shows each detected speaker with a playable audio clip and a name input.
 * User must label ALL detected speakers before continuing. Every speaker
 * must have a non-empty name — the Confirm button stays disabled until all
 * are filled in.
 * Once confirmed, voiceprints are saved and the pipeline resumes.
 *
 * When the user enters a name that already has a voiceprint enrolled, a
 * conflict dialog appears asking whether to overwrite or keep the existing.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";

interface SpeakerInfo {
  speaker_id: string;
  segment_count: number;
  total_duration: number;
  sample_clip_url: string;
  sample_start: number;
  sample_end: number;
  suggested_name: string;
  suggested_email?: string;
  voiceprint_confidence?: number;
}

interface VoiceMatchConflict {
  name: string;
  email: string;
  similarity: number;
  sample_job_id?: string;
}

interface LabelVerification {
  speaker_id: string;
  assigned_name: string;
  assigned_email: string;
  voice_match_conflicts: VoiceMatchConflict[];
}

interface ConflictInfo {
  name: string;
  email: string;
  existing_name: string;
  existing_email: string;
  sample_job_id?: string;
}

interface NonSpeakingInfo {
  name: string;
  email?: string;
}

interface Props {
  jobId: string;
  speakers: SpeakerInfo[];
  suggestedEmails?: string[];
  onConfirm: (labels: Array<{ speaker_id: string; name: string; email?: string }>) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  nonSpeakingAttendees?: NonSpeakingInfo[];
}

export default function SpeakerLabelModal({
  jobId,
  speakers,
  suggestedEmails = [],
  onConfirm,
  onCancel,
  submitting,
  nonSpeakingAttendees = [],
}: Props) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [overwriteSet, setOverwriteSet] = useState<Set<string>>(new Set());
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [emailErrors, setEmailErrors] = useState<Record<string, string>>({});

  // ── Voice match verification (Mitigation 1) ──
  const [voiceMatchConflicts, setVoiceMatchConflicts] = useState<LabelVerification[]>([]);
  const [showVoiceWarnings, setShowVoiceWarnings] = useState(false);
  const [verificationDone, setVerificationDone] = useState(false);

  // ── Unregistered name warning (Mitigation 3) ──
  const [unregisteredNames, setUnregisteredNames] = useState<string[]>([]);
  const [dismissedUnregistered, setDismissedUnregistered] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const initializedRef = useRef(false);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validateEmail = useCallback((email: string): boolean => {
    return EMAIL_RE.test(email);
  }, []);

  // Initialize labels with suggested names from attendees list.
  // Only runs once on mount — subsequent prop changes (from polling) must NOT
  // clear user input. The useJobStatus hook keeps polling during paused_for_labeling,
  // which causes jobMetadata to update on every poll, creating new suggestedEmails
  // array references. Without this guard, those re-renders reset all typed labels.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const initialNames: Record<string, string> = {};
    const initialEmails: Record<string, string> = {};
    for (let i = 0; i < speakers.length; i++) {
      const spk = speakers[i];
      if (spk.suggested_name) {
        initialNames[spk.speaker_id] = spk.suggested_name;
      }
      // Positional alignment: speaker[i] gets suggestedEmails[i]
      if (i < suggestedEmails.length && suggestedEmails[i]) {
        initialEmails[spk.speaker_id] = suggestedEmails[i];
      }
    }
    setLabels(initialNames);
    setEmails(initialEmails);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop playback when switching speakers
  const playClip = useCallback(
    (speakerId: string, clipUrl: string) => {
      if (playing === speakerId) {
        audioRef.current?.pause();
        setPlaying(null);
        return;
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(`http://127.0.0.1:5010${clipUrl}`);
      audio.onended = () => setPlaying(null);
      audio.onerror = () => setPlaying(null);
      audio.play().catch(() => setPlaying(null));
      audioRef.current = audio;
      setPlaying(speakerId);
    },
    [playing],
  );

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  // Every speaker must have a non-empty name and a valid email
  const allLabeled = speakers.every((s) => {
    const name = labels[s.speaker_id]?.trim() ?? "";
    const email = emails[s.speaker_id]?.trim() ?? "";
    return name.length > 0 && email.length > 0 && validateEmail(email);
  });

  // ── Build label result from current state ──
  const buildResult = () =>
    speakers.map((s) => ({
      speaker_id: s.speaker_id,
      name: labels[s.speaker_id]?.trim() || s.speaker_id,
      email: emails[s.speaker_id]?.trim() || "",
    }));

  // ── Voiceprint + voice-match conflict checking ──
  const handleConfirm = async () => {
    // Re-validate all emails before proceeding
    const invalid: string[] = [];
    for (const s of speakers) {
      const email = emails[s.speaker_id]?.trim() || "";
      if (!email || !validateEmail(email)) {
        invalid.push(labels[s.speaker_id]?.trim() || s.speaker_id);
      }
    }
    if (invalid.length > 0) {
      setEmailErrors((prev) => {
        const next = { ...prev };
        for (const s of speakers) {
          const email = emails[s.speaker_id]?.trim() || "";
          if (!email) next[s.speaker_id] = "Email is required";
          else if (!validateEmail(email)) next[s.speaker_id] = "Invalid email address";
        }
        return next;
      });
      return;
    }

    const result = buildResult();

    // Step 1: Check for existing voiceprints with these names (name/email conflicts)
    const namesToCheck = result.map((l) => ({ name: l.name }));
    setCheckingConflicts(true);
    try {
      const response = await (window as any).electronAPI?.checkVoiceprintConflicts(namesToCheck);
      const foundConflicts = response?.conflicts || [];
      if (foundConflicts.length > 0) {
        setConflicts(foundConflicts);
        setOverwriteSet(new Set());
        setCheckingConflicts(false);
        return; // Show name conflict dialog, don't submit yet
      }
    } catch {
      // Backend unavailable — proceed without checking
    }

    // Step 2: Voice-match verification (Mitigation 1)
    // Call the backend to compare proposed labels against enrolled voiceprints.
    if (!verificationDone) {
      try {
        const vResult = await (window as any).electronAPI?.verifyLabels({
          jobId,
          labels: result,
        });
        if (vResult) {
          const voiceConflicts = (vResult.verifications || []).filter(
            (v: LabelVerification) => v.voice_match_conflicts.length > 0,
          );
          const unregistered = vResult.unregistered_names || [];

          if (voiceConflicts.length > 0) {
            setVoiceMatchConflicts(voiceConflicts);
            setShowVoiceWarnings(true);
            setCheckingConflicts(false);
            return; // Show voice match dialog
          }

          if (unregistered.length > 0) {
            setUnregisteredNames(unregistered);
          }
        }
      } catch {
        // Backend unavailable — proceed without voice verification
      }
      setVerificationDone(true);
    }

    setCheckingConflicts(false);
    await onConfirm(result);
  };

  /** Toggle whether a conflicting voiceprint should be overwritten. */
  const toggleOverwrite = (name: string) => {
    setOverwriteSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /** Not overwriting any entries → keep existing voiceprints, don't save new ones for those names. */
  const handleConflictConfirm = async () => {
    const result = buildResult();
    setConflicts([]);
    await onConfirm(result);
  };

  /** Continue despite voice match warnings (Mitigation 1 override). */
  const handleVoiceWarningContinue = async () => {
    setShowVoiceWarnings(false);
    setVerificationDone(true);
    setCheckingConflicts(false);
    const result = buildResult();
    await onConfirm(result);
  };

  const handleSkip = () => {
    // Use default speaker IDs for any unnamed speakers
    const defaultLabels = speakers.map((s) => ({
      speaker_id: s.speaker_id,
      name: labels[s.speaker_id]?.trim() || s.speaker_id,
      email: emails[s.speaker_id]?.trim() || "",
    }));
    onConfirm(defaultLabels);
  };

  return (
    <div className="modal-overlay">
      <div className="modal speaker-label-modal">
        <div className="modal-header">
          <h2>
            <Icon name="mic" size="18" color="accent" /> Identify Speakers
          </h2>
          <p className="modal-subtitle">
            {speakers.length} speaker{speakers.length !== 1 ? "s" : ""} detected. Listen to each clip and enter a name for every speaker. All must be
            labeled before continuing.
          </p>
        </div>

        <div className="speaker-list">
          {speakers.map((spk, idx) => {
            const hasName = (labels[spk.speaker_id]?.trim() ?? "").length > 0;
            return (
              <div key={spk.speaker_id} className={`speaker-item ${hasName ? "speaker-item--labeled" : ""}`}>
                <div className="speaker-header">
                  <span className="speaker-number">#{idx + 1}</span>
                  <span className="speaker-stats">
                    {spk.segment_count} segment{spk.segment_count !== 1 ? "s" : ""} · {spk.total_duration.toFixed(0)}s total
                  </span>
                  {/* ── Voiceprint confidence badge (Mitigation 4) ── */}
                  {spk.voiceprint_confidence && spk.voiceprint_confidence > 0 && (
                    <span className="speaker-vp-badge" title={`Auto-detected from voiceprint (${(spk.voiceprint_confidence * 100).toFixed(0)}% confidence)`}>
                      <Icon name="mic" size="12" color="accent" /> {(spk.voiceprint_confidence * 100).toFixed(0)}%
                    </span>
                  )}
                  <button
                    className="btn-icon speaker-play-btn"
                    onClick={() => playClip(spk.speaker_id, spk.sample_clip_url)}
                    title={playing === spk.speaker_id ? "Stop" : "Play clip"}>
                    {playing === spk.speaker_id ? <Icon name="stop" size="14" color="red" /> : <Icon name="play_arrow" size="14" color="accent" />}
                  </button>
                </div>
                <div className="speaker-name-row">
                  <Tooltip content="Type the speaker's name — this maps the detected voice to a person">
                    <input
                      type="text"
                      className="speaker-name-input"
                      placeholder={`Name for ${spk.speaker_id}`}
                      value={labels[spk.speaker_id] ?? ""}
                      onChange={(e) => setLabels((prev) => ({ ...prev, [spk.speaker_id]: e.target.value }))}
                      autoFocus={idx === 0 && !spk.suggested_name}
                      title="Enter a name for this speaker"
                    />
                  </Tooltip>
                  {hasName && <span className="speaker-label-check">✓</span>}
                </div>
                <div className="speaker-email-row">
                  <Tooltip content="Email is required — used as the unique key for voiceprint storage and matching across meetings">
                    <input
                      type="email"
                      className={`speaker-email-input${emailErrors[spk.speaker_id] ? " speaker-email-input--error" : ""}`}
                      placeholder="Email (required — enables voiceprint matching)"
                      value={emails[spk.speaker_id] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEmails((prev) => ({ ...prev, [spk.speaker_id]: val }));
                        if (!val) {
                          setEmailErrors((prev) => ({ ...prev, [spk.speaker_id]: "Email is required" }));
                        } else if (!validateEmail(val)) {
                          setEmailErrors((prev) => ({ ...prev, [spk.speaker_id]: "Invalid email address" }));
                        } else {
                          setEmailErrors((prev) => {
                            const next = { ...prev };
                            delete next[spk.speaker_id];
                            return next;
                          });
                        }
                      }}
                      title="Enter an email for this speaker (required)"
                    />
                  </Tooltip>
                  {emailErrors[spk.speaker_id] && <span className="speaker-email-error">{emailErrors[spk.speaker_id]}</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Non-speaking attendees ── */}
        {nonSpeakingAttendees.length > 0 && (
          <div className="speaker-non-speaking-section">
            <h3 className="speaker-non-speaking-heading">
              <Icon name="visibility_off" size="14" color="muted" /> Also present but did not speak
            </h3>
            <p className="speaker-non-speaking-desc">
              These registered attendees had no detected speech segments. No voiceprint is needed — they are included in the meeting record.
            </p>
            <ul className="speaker-non-speaking-list">
              {nonSpeakingAttendees.map((ns, i) => (
                <li key={i} className="speaker-non-speaking-item">
                  <span className="speaker-non-speaking-name">{ns.name}</span>
                  {ns.email && <span className="speaker-non-speaking-email">{ns.email}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Voiceprint conflict dialog ── */}
        {conflicts.length > 0 && (
          <div className="vp-conflict-overlay">
            <div className="vp-conflict-dialog">
              <h3>
                <Icon name="warning" size="16" color="orange" /> Voiceprint Conflicts
              </h3>
              <p className="vp-conflict-desc">
                Some names you entered already have voiceprints from previous jobs. Choose whether to overwrite each one with this recording or keep
                the existing voiceprint.
              </p>
              {conflicts.map((c) => (
                <div key={c.name} className="vp-conflict-row">
                  <div className="vp-conflict-row-info">
                    <strong>{c.name}</strong>
                    {c.existing_name !== c.name && (
                      <span className="vp-conflict-existing">
                        {" "}
                        ← currently enrolled as <strong>{c.existing_name}</strong>
                      </span>
                    )}
                  </div>
                  {c.sample_job_id && (
                    <span className="vp-conflict-hint">
                      <Icon name="info" size="12" /> Existing sample from job {c.sample_job_id.slice(0, 8)}
                    </span>
                  )}
                  <label className="vp-conflict-checkbox">
                    <input type="checkbox" checked={overwriteSet.has(c.name)} onChange={() => toggleOverwrite(c.name)} />
                    Overwrite with this recording
                  </label>
                </div>
              ))}
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="btn-secondary" onClick={() => setConflicts([])}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={handleConflictConfirm}>
                  Confirm Labels
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Voice match warning dialog (Mitigation 1) ── */}
        {showVoiceWarnings && voiceMatchConflicts.length > 0 && (
          <div className="vp-conflict-overlay">
            <div className="vp-conflict-dialog">
              <h3>
                <Icon name="warning" size="16" color="orange" /> Voice Match Detected
              </h3>
              <p className="vp-conflict-desc">
                The following speakers have voices that closely match someone already enrolled under a different name. Please review each match
                before continuing.
              </p>
              {voiceMatchConflicts.map((vc) => (
                <div key={vc.speaker_id} className="vp-conflict-row">
                  <div className="vp-conflict-row-info">
                    <strong>{vc.speaker_id}</strong> → <strong>{vc.assigned_name}</strong>
                  </div>
                  {vc.voice_match_conflicts.map((mc, i) => (
                    <div key={i} className="vp-conflict-hint" style={{ marginTop: 4 }}>
                      <Icon name="info" size="12" /> This voice matches{' '}
                      <strong>{mc.name}</strong> ({(mc.similarity * 100).toFixed(0)}% similar)
                      {mc.sample_job_id && <> from job {mc.sample_job_id.slice(0, 8)}</>}
                    </div>
                  ))}
                </div>
              ))}
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="btn-secondary" onClick={() => { setShowVoiceWarnings(false); setVerificationDone(false); }}>
                  Go Back
                </button>
                <button className="btn-primary" onClick={handleVoiceWarningContinue}>
                  Continue Anyway
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Unregistered name warning banner (Mitigation 3) ── */}
        {unregisteredNames.length > 0 && !dismissedUnregistered && !showVoiceWarnings && conflicts.length === 0 && (
          <div className="speaker-unregistered-banner">
            <Icon name="warning" size="14" color="orange" />
            <span>
              <strong>Not registered:</strong> {unregisteredNames.join(", ")}{" "}
              {unregisteredNames.length === 1 ? "wasn't" : "weren't"} registered as{" "}
              {unregisteredNames.length === 1 ? "an attendee" : "attendees"} for this meeting.
              They will be added to the attendee list.
            </span>
            <button className="btn-icon speaker-unregistered-dismiss" onClick={() => setDismissedUnregistered(true)} title="Dismiss">
              <Icon name="close" size="12" color="muted" />
            </button>
          </div>
        )}

        <div className="modal-actions">
          <Tooltip content="Cancel the entire job without saving speaker labels">
            <button className="btn-secondary" onClick={onCancel} disabled={submitting} title="Cancel the entire transcription job">
              Cancel Job
            </button>
          </Tooltip>
          <Tooltip content="Skip naming — speakers will use their auto-generated IDs (Speaker_1, etc.)">
            <button className="btn-secondary" onClick={handleSkip} disabled={submitting} title="Use auto-generated speaker IDs instead of names">
              Use Default Names
            </button>
          </Tooltip>
          <Tooltip content="Save all speaker names and continue the transcription pipeline">
            <button className="btn-primary" onClick={handleConfirm} disabled={submitting || !allLabeled} title="Save labels and resume pipeline">
              {submitting ? "Saving & Resuming..." : `Confirm & Continue (${speakers.length} speaker${speakers.length !== 1 ? "s" : ""})`}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
