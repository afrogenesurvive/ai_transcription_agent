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
  voiceprint_matches?: VoiceMatchConflict[];
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
  onConfirm: (
    labels: Array<{ speaker_id: string; name: string; email?: string }>,
    options?: { overwriteNames?: string[] },
  ) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  nonSpeakingAttendees?: NonSpeakingInfo[];
  error?: string | null;
  onClearError?: () => void;
  postSubmitConflicts?: Array<{
    speaker_id: string;
    assigned_name: string;
    assigned_email: string;
    matched_name: string;
    matched_email: string;
    similarity: number;
    matched_sample_job_id?: string;
  }> | null;
}

export default function SpeakerLabelModal({
  jobId,
  speakers,
  suggestedEmails = [],
  onConfirm,
  onCancel,
  submitting,
  nonSpeakingAttendees = [],
  error,
  onClearError,
  postSubmitConflicts,
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

  // ── Per-speaker live conflict detection (Phase C) ──
  // Keyed by speaker_id; stores inline conflict info from onBlur verification.
  const [perSpeakerConflicts, setPerSpeakerConflicts] = useState<Record<string, LabelVerification | null>>({});
  const blurTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Per-speaker overwrite tracking (Phase D) ──
  // Set of speaker_ids where the user chose to keep their typed name
  // instead of accepting an existing voiceprint match. These names will
  // be passed as overwrite_names to the drift audit so it skips them.
  const [perSpeakerOverwrite, setPerSpeakerOverwrite] = useState<Set<string>>(new Set());

  // ── Derive which speakers have active conflicts (for highlighting) ──
  const conflictSpeakerIds = new Set<string>();
  for (const [spkId, v] of Object.entries(perSpeakerConflicts)) {
    if (v?.voice_match_conflicts?.length) {
      conflictSpeakerIds.add(spkId);
    }
  }

  // ── Proactive voiceprint matches (seeded from speaker data on mount) ──
  const [proactiveConflicts, setProactiveConflicts] = useState<Array<{
    speaker_id: string;
    matched_name: string;
    matched_email: string;
    similarity: number;
    sample_job_id?: string;
  }> | null>(null);

  // ── Unregistered name warning (Mitigation 3) ──
  const [unregisteredNames, setUnregisteredNames] = useState<string[]>([]);
  const [dismissedUnregistered, setDismissedUnregistered] = useState(false);

  // ── Populate inline conflicts from post-submit drift audit ──
  // When the backend returns voice match conflicts during label_and_resume,
  // map them into the perSpeakerConflicts format so inline notices appear.
  const prevConflictsRef = useRef<Props["postSubmitConflicts"]>(null);
  useEffect(() => {
    const conflicts = postSubmitConflicts;
    if (!conflicts || conflicts.length === 0) {
      prevConflictsRef.current = null;
      return;
    }
    // Avoid re-processing the same conflicts
    if (prevConflictsRef.current === conflicts) return;
    prevConflictsRef.current = conflicts;

    // Group conflicts by speaker_id and build LabelVerification entries
    const grouped: Record<string, LabelVerification> = {};
    for (const c of conflicts) {
      if (!grouped[c.speaker_id]) {
        grouped[c.speaker_id] = {
          speaker_id: c.speaker_id,
          assigned_name: c.assigned_name,
          assigned_email: c.assigned_email,
          voice_match_conflicts: [],
        };
      }
      grouped[c.speaker_id].voice_match_conflicts.push({
        name: c.matched_name,
        email: c.matched_email,
        similarity: c.similarity,
        sample_job_id: c.matched_sample_job_id,
      });
    }

    setPerSpeakerConflicts((prev) => ({ ...prev, ...grouped }));
    onClearError?.();
  }, [postSubmitConflicts, onClearError]);
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

    // ── Proactive conflict seeding from voiceprint_matches ──
    // When get_speaker_clips found voiceprint matches for speakers whose
    // matched names aren't in the attendee list, the backend includes them
    // in voiceprint_matches. Seed perSpeakerConflicts proactively so the
    // inline conflict UI appears on mount — not just after onBlur or submit.
    const proactive: typeof proactiveConflicts = [];
    const conflictEntries: Record<string, LabelVerification> = {};
    for (const spk of speakers) {
      const vpms = spk.voiceprint_matches;
      if (!vpms || vpms.length === 0) continue;
      const best = vpms[0];
      // Only seed a conflict if the best match name differs from the
      // suggested_name (or suggested_name is blank / came from positional
      // fallback). If suggested_name already matches, no conflict to show.
      const suggested = (initialNames[spk.speaker_id] || "").toLowerCase();
      if (best.name.toLowerCase() !== suggested) {
        conflictEntries[spk.speaker_id] = {
          speaker_id: spk.speaker_id,
          assigned_name: initialNames[spk.speaker_id] || "",
          assigned_email: initialEmails[spk.speaker_id] || "",
          voice_match_conflicts: vpms.map((m) => ({
            name: m.name,
            email: m.email,
            similarity: m.similarity,
            sample_job_id: m.sample_job_id,
          })),
        };
        proactive.push({
          speaker_id: spk.speaker_id,
          matched_name: best.name,
          matched_email: best.email,
          similarity: best.similarity,
          sample_job_id: best.sample_job_id,
        });
      }
    }
    if (Object.keys(conflictEntries).length > 0) {
      setPerSpeakerConflicts(conflictEntries);
      setProactiveConflicts(proactive);
    }
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
    // Skip labels for speakers in perSpeakerOverwrite — user already opted to
    // keep their typed name and overwrite the existing voiceprint.
    const verifyLabels = result.filter((l) => !perSpeakerOverwrite.has(l.speaker_id));
    const remaining = verifyLabels.filter((l) => l.name.trim());
    if (!verificationDone && remaining.length > 0) {
      try {
        const vResult = await (window as any).electronAPI?.verifyLabels({
          jobId,
          labels: remaining,
        });
        if (vResult) {
          const voiceConflicts = (vResult.verifications || []).filter((v: LabelVerification) => v.voice_match_conflicts.length > 0);
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
    // Pass perSpeakerOverwrite names as overwrite_names so the drift audit
    // skips them (user already chose to keep their typed name inline).
    const overwriteNames = Array.from(perSpeakerOverwrite)
      .map((sid) => labels[sid]?.trim())
      .filter(Boolean) as string[];
    await onConfirm(result, overwriteNames.length > 0 ? { overwriteNames } : undefined);
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

  /** Confirm labels from the VP conflict dialog, passing overwriteSet to force overwrite. */
  const handleConflictConfirm = async () => {
    const result = buildResult();
    const overwriteNames = Array.from(overwriteSet);
    setConflicts([]);
    await onConfirm(result, { overwriteNames });
  };

  /** Per-conflict accept/reject toggles (Phase C3). */
  const [acceptedConflicts, setAcceptedConflicts] = useState<Set<string>>(new Set());

  /** Toggle whether a specific voice-match conflict is accepted. */
  const toggleAcceptedConflict = (key: string) => {
    setAcceptedConflicts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Per-speaker overwrite in voice match dialog (Phase D2) ──
  // Set of speaker_ids where the user checked "Keep my name" in the
  // voice match dialog, meaning they want to overwrite the existing
  // voiceprint with their typed name.
  const [voiceMatchKeepSet, setVoiceMatchKeepSet] = useState<Set<string>>(new Set());

  /** Toggle per-speaker "Keep my name" in the voice match dialog.
   *  Mutually exclusive with accepting specific matches for that speaker:
   *  if you keep your name, all conflict checkboxes for that speaker clear. */
  const toggleVoiceMatchKeep = (speakerId: string) => {
    setVoiceMatchKeepSet((prev) => {
      const next = new Set(prev);
      if (next.has(speakerId)) {
        next.delete(speakerId);
      } else {
        next.add(speakerId);
        // Clear any accepted conflicts for this speaker
        setAcceptedConflicts((accepted) => {
          const cleared = new Set(accepted);
          for (const key of cleared) {
            if (key.startsWith(`${speakerId}:`)) {
              cleared.delete(key);
            }
          }
          return cleared;
        });
      }
      return next;
    });
  };

  /** Continue despite voice match warnings — submits with original names as overwrite_names. */
  const handleVoiceWarningForceOverwrite = async () => {
    setShowVoiceWarnings(false);
    setVerificationDone(true);
    setCheckingConflicts(false);
    // Collect all originally-typed names as overwrite targets
    const result = buildResult();
    const overwriteNames = result.map((l) => l.name).filter(Boolean);
    await onConfirm(result, { overwriteNames });
  };

  /** Accept selected matches and/or keep per-speaker names, then proceed.
   *  - Accepted conflicts → labels are renamed to the existing voiceprint name
   *  - Speakers with "Keep my name" checked → their typed name is passed as
   *    overwrite_names so the drift audit skips them. */
  const handleVoiceWarningAcceptSelected = async () => {
    const result = buildResult();
    const buildOverwriteNames: string[] = [];

    for (const vc of voiceMatchConflicts) {
      const spkId = vc.speaker_id;

      // If the user checked "Keep my name" for this speaker, add to overwrite set
      if (voiceMatchKeepSet.has(spkId)) {
        const label = result.find((l) => l.speaker_id === spkId);
        if (label && label.name.trim()) {
          buildOverwriteNames.push(label.name.trim());
        }
        continue; // Skip acceptance logic — keeping typed name
      }

      // Otherwise, apply accepted conflict renames
      for (const mc of vc.voice_match_conflicts || []) {
        const key = `${spkId}:${mc.name}`;
        if (acceptedConflicts.has(key)) {
          const found = result.find((l) => l.speaker_id === spkId);
          if (found) {
            found.name = mc.name;
            // Use existing voiceprint email only if it's a real address;
            // otherwise keep the user's typed email so it reaches delivery.
            found.email =
              mc.email && !mc.email.includes("@voiceprint.local")
                ? mc.email
                : found.email;
          }
        }
      }
    }

    setShowVoiceWarnings(false);
    setVerificationDone(true);
    setCheckingConflicts(false);
    await onConfirm(result, buildOverwriteNames.length > 0 ? { overwriteNames: buildOverwriteNames } : undefined);
  };

  // ── Live per-speaker conflict detection on name blur (Phase C) ──
  const handleNameBlur = useCallback(
    async (speakerId: string) => {
      const name = labels[speakerId]?.trim();
      if (!name) return;

      // Clear previous timer
      if (blurTimersRef.current[speakerId]) {
        clearTimeout(blurTimersRef.current[speakerId]);
      }

      // Debounce: wait 500ms after blur before checking
      blurTimersRef.current[speakerId] = setTimeout(async () => {
        try {
          const res = await (window as any).electronAPI?.verifyLabels({
            jobId,
            labels: [{ speaker_id: speakerId, name, email: emails[speakerId] || "" }],
          });
          const v = res?.verifications?.[0];
          if (v?.voice_match_conflicts?.length > 0) {
            setPerSpeakerConflicts((prev) => ({ ...prev, [speakerId]: v }));
          } else {
            setPerSpeakerConflicts((prev) => {
              const next = { ...prev };
              delete next[speakerId];
              return next;
            });
          }
        } catch {
          // Backend unavailable — ignore
        }
      }, 500);
    },
    [jobId, labels, emails],
  );

  /** Resolve an inline voice-match conflict: accept the existing name. */
  const resolveInlineConflict = useCallback((speakerId: string, existingName: string, existingEmail: string) => {
    setLabels((prev) => ({ ...prev, [speakerId]: existingName }));
    // Use existing voiceprint email only if it's a real address (not a
    // @voiceprint.local placeholder). Otherwise keep the user's typed email
    // so it flows through to email_recipients for delivery.
    const userEmail = emails[speakerId]?.trim();
    const resolvedEmail =
      existingEmail && !existingEmail.includes("@voiceprint.local")
        ? existingEmail
        : userEmail || existingEmail;
    setEmails((prev) => ({ ...prev, [speakerId]: resolvedEmail }));
    setPerSpeakerConflicts((prev) => {
      const next = { ...prev };
      delete next[speakerId];
      return next;
    });
    // Clear any error for this speaker
    setEmailErrors((prev) => {
      const next = { ...prev };
      delete next[speakerId];
      return next;
    });
  }, [emails]);

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

        {/* ── Post-submit conflict banner ── */}
        {postSubmitConflicts && postSubmitConflicts.length > 0 && (
          <div className="speaker-post-conflict-banner">
            <Icon name="warning" size="16" color="orange" />
            <div className="speaker-post-conflict-banner-content">
              <strong>Voice match conflict detected</strong>
              <span>
                {postSubmitConflicts.length === 1
                  ? "1 speaker's voice matches an existing enrolled voiceprint under a different name."
                  : `${postSubmitConflicts.length} speakers' voices match existing enrolled voiceprints under different names.`}
              </span>
              {/* ── Existing attendee details ── */}
              <div className="speaker-post-conflict-details">
                {postSubmitConflicts.map((c, i) => (
                  <div key={i} className="speaker-post-conflict-detail-row">
                    <Icon name="person" size="13" color="muted" />
                    <span>
                      Already registered: <strong>{c.matched_name}</strong>
                      {c.matched_email ? <> &lt;{c.matched_email}&gt;</> : ""}
                      {" · "}You labeled: <strong>{c.assigned_name}</strong>
                      {c.assigned_email ? <> &lt;{c.assigned_email}&gt;</> : ""}
                      {" · "}<span className="speaker-post-conflict-similarity">{(c.similarity * 100).toFixed(0)}% match</span>
                      {c.matched_sample_job_id ? <> from job {c.matched_sample_job_id.slice(0, 8)}</> : ""}
                    </span>
                  </div>
                ))}
              </div>
              <span>
                Review the inline notices below and choose <strong>Use "ExistingName"</strong> to overwrite, or keep your typed name.
              </span>
            </div>
          </div>
        )}

        {/* ── Proactive voiceprint match banner (seeded from speaker data on mount) ── */}
        {proactiveConflicts && proactiveConflicts.length > 0 && !postSubmitConflicts && (
          <div className="speaker-proactive-conflict-banner">
            <Icon name="info" size="16" color="accent" />
            <div className="speaker-post-conflict-banner-content">
              <strong>Voiceprint match detected</strong>
              <span>
                {proactiveConflicts.length === 1
                  ? "1 speaker's voice matches an existing enrolled voiceprint under a different name. Review and resolve below."
                  : `${proactiveConflicts.length} speakers' voices match existing enrolled voiceprints under different names. Review and resolve each below.`}
              </span>
              <div className="speaker-post-conflict-details">
                {proactiveConflicts.map((c, i) => (
                  <div key={i} className="speaker-post-conflict-detail-row">
                    <Icon name="person" size="13" color="muted" />
                    <span>
                      Voice matches: <strong>{c.matched_name}</strong>
                      {c.matched_email ? <> &lt;{c.matched_email}&gt;</> : ""}
                      {" · "}<span className="speaker-post-conflict-similarity">{(c.similarity * 100).toFixed(0)}% match</span>
                      {c.sample_job_id ? <> from job {c.sample_job_id.slice(0, 8)}</> : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="speaker-list">
          {speakers.map((spk, idx) => {
            const hasName = (labels[spk.speaker_id]?.trim() ?? "").length > 0;
            return (
              <div
                key={spk.speaker_id}
                className={`speaker-item ${hasName ? "speaker-item--labeled" : ""} ${conflictSpeakerIds.has(spk.speaker_id) ? "speaker-item--conflict" : ""}`}>
                <div className="speaker-header">
                  <span className="speaker-number">#{idx + 1}</span>
                  <span className="speaker-stats">
                    {spk.segment_count} segment{spk.segment_count !== 1 ? "s" : ""} · {spk.total_duration.toFixed(0)}s total
                  </span>
                  {/* ── Voiceprint confidence badge (Mitigation 4) ── */}
                  {spk.voiceprint_confidence && spk.voiceprint_confidence > 0 && (
                    <span
                      className="speaker-vp-badge"
                      title={`Auto-detected from voiceprint (${(spk.voiceprint_confidence * 100).toFixed(0)}% confidence)`}>
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
                      onChange={(e) => {
                        setLabels((prev) => ({ ...prev, [spk.speaker_id]: e.target.value }));
                        onClearError?.();
                      }}
                      onBlur={() => handleNameBlur(spk.speaker_id)}
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
                        onClearError?.();
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
                {/* ── Inline voice-match conflict widget (Phase C) ── */}
                {perSpeakerConflicts[spk.speaker_id]?.voice_match_conflicts?.map((mc, ci) => (
                  <div key={ci} className="speaker-inline-conflict">
                    <div className="speaker-inline-conflict-body">
                      <Icon name="warning" size="13" color="orange" />
                      <span className="speaker-inline-conflict-text">
                        This voice matches <strong>{mc.name}</strong>
                        {mc.email ? <> &lt;{mc.email}&gt;</> : ""}
                        {" "}({(mc.similarity * 100).toFixed(0)}% similarity)
                        {mc.sample_job_id ? <> from job {mc.sample_job_id.slice(0, 8)}</> : ""}
                      </span>
                    </div>
                    <div className="speaker-inline-conflict-actions">
                      <button
                        className="speaker-conflict-btn speaker-conflict-btn--accept"
                        onClick={() => resolveInlineConflict(spk.speaker_id, mc.name, mc.email)}
                        title={`Use "${mc.name}" instead`}>
                        Use &ldquo;{mc.name}&rdquo;
                      </button>
                      <button
                        className="speaker-conflict-btn speaker-conflict-btn--dismiss"
                        onClick={() => {
                          setPerSpeakerOverwrite((prev) => new Set(prev).add(spk.speaker_id));
                          setPerSpeakerConflicts((prev) => {
                            const next = { ...prev };
                            delete next[spk.speaker_id];
                            return next;
                          });
                        }}
                        title="Keep current name — overwrite existing voiceprint">
                      Keep &ldquo;{labels[spk.speaker_id] || spk.speaker_id}&rdquo;
                      </button>
                    </div>
                  </div>
                ))}
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
                  {ns.email ? (
                    <span className="speaker-non-speaking-email">{ns.email}</span>
                  ) : (
                    <span className="speaker-non-speaking-email-missing">(no email)</span>
                  )}
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

        {/* ── Voice match warning dialog (Phase C3: per-conflict accept/reject) ── */}
        {showVoiceWarnings && voiceMatchConflicts.length > 0 && (
          <div className="vp-conflict-overlay">
            <div className="vp-conflict-dialog">
              <h3>
                <Icon name="warning" size="16" color="orange" /> Voice Match Detected
              </h3>
              <p className="vp-conflict-desc">
                The following speakers have voices that closely match someone already enrolled under a different name. For each speaker, either accept
                a match (uses the existing name) or keep your typed name (overwrites the existing voiceprint).
              </p>
              {voiceMatchConflicts.map((vc) => {
                const hasAcceptedAny = vc.voice_match_conflicts.some((mc) =>
                  acceptedConflicts.has(`${vc.speaker_id}:${mc.name}`)
                );
                const isKeeping = voiceMatchKeepSet.has(vc.speaker_id);
                return (
                  <div key={vc.speaker_id} className="vp-conflict-row">
                    <div className="vp-conflict-row-info">
                      <strong>{vc.speaker_id}</strong> → <strong>{vc.assigned_name}</strong>
                    </div>
                    {vc.voice_match_conflicts.map((mc, i) => {
                      const key = `${vc.speaker_id}:${mc.name}`;
                      return (
                        <div key={i} className="vp-conflict-hint vp-conflict-hint--with-checkbox" style={{ marginTop: 4 }}>
                          <label className="vp-conflict-checkbox" style={{ opacity: isKeeping ? 0.5 : 1 }}>
                            <input
                              type="checkbox"
                              checked={acceptedConflicts.has(key)}
                              onChange={() => {
                                if (!isKeeping) {
                                  toggleAcceptedConflict(key);
                                  // Uncheck "keep" if accepting a match
                                  if (voiceMatchKeepSet.has(vc.speaker_id)) {
                                    setVoiceMatchKeepSet((prev) => {
                                      const next = new Set(prev);
                                      next.delete(vc.speaker_id);
                                      return next;
                                    });
                                  }
                                }
                              }}
                              disabled={isKeeping}
                            />
                            <span>
                              This voice matches <strong>{mc.name}</strong> ({(mc.similarity * 100).toFixed(0)}% similar)
                              {mc.sample_job_id && <> from job {mc.sample_job_id.slice(0, 8)}</>}
                              <br />
                              <span className="vp-conflict-hint-sub">
                                Tick to use &ldquo;{mc.name}&rdquo; instead of &ldquo;{vc.assigned_name}&rdquo;
                              </span>
                            </span>
                          </label>
                        </div>
                      );
                    })}
                    {/* ── Per-speaker "Keep my name" toggle ── */}
                    <div className="vp-conflict-hint vp-conflict-hint--with-checkbox" style={{ marginTop: 8 }}>
                      <label className="vp-conflict-checkbox vp-conflict-checkbox--keep">
                        <input
                          type="checkbox"
                          checked={isKeeping}
                          onChange={() => toggleVoiceMatchKeep(vc.speaker_id)}
                        />
                        <span>
                          <strong>Keep my name &ldquo;{vc.assigned_name}&rdquo;</strong>
                          <br />
                          <span className="vp-conflict-hint-sub">
                            Overwrites the existing voiceprint with this recording
                          </span>
                        </span>
                      </label>
                    </div>
                  </div>
                );
              })}
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setShowVoiceWarnings(false);
                    setVerificationDone(false);
                    setAcceptedConflicts(new Set());
                    setVoiceMatchKeepSet(new Set());
                  }}>
                  Go Back
                </button>
                <button
                  className="btn-primary"
                  onClick={handleVoiceWarningAcceptSelected}
                  disabled={acceptedConflicts.size === 0 && voiceMatchKeepSet.size === 0}>
                  Confirm Choices
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
              <strong>Not registered:</strong> {unregisteredNames.join(", ")} {unregisteredNames.length === 1 ? "wasn't" : "weren't"} registered as{" "}
              {unregisteredNames.length === 1 ? "an attendee" : "attendees"} for this meeting. They will be added to the attendee list.
            </span>
            <button className="btn-icon speaker-unregistered-dismiss" onClick={() => setDismissedUnregistered(true)} title="Dismiss">
              <Icon name="close" size="12" color="muted" />
            </button>
          </div>
        )}

        {/* ── Backend error banner ── */}
        {error && (
          <div className="speaker-label-error-banner">
            <Icon name="error" size="18" color="red" />
            <div className="speaker-label-error-content">
              <strong className="speaker-label-error-title">Could not save labels</strong>
              <span className="speaker-label-error-text">{error}</span>
              {/* ── Existing registered attendee details ── */}
              {postSubmitConflicts && postSubmitConflicts.length > 0 && (
                <div className="speaker-label-existing-attendees">
                  <strong>Already registered under this voice:</strong>
                  {postSubmitConflicts.map((c, i) => (
                    <div key={i} className="speaker-label-existing-attendee-row">
                      <Icon name="person" size="13" color="muted" />
                      <span>
                        <strong>{c.matched_name}</strong>
                        {c.matched_email ? <> &lt;{c.matched_email}&gt;</> : ""}
                      </span>
                      <span className="speaker-label-conflict-from">
                        ({(c.similarity * 100).toFixed(0)}% match
                        {c.matched_sample_job_id ? <> from job {c.matched_sample_job_id.slice(0, 8)}</> : ""})
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="speaker-label-error-hint">
                This person&apos;s voice matches an existing enrolled voiceprint under a different name.
                Check the inline conflict notice for each speaker above, or use the
                {" "}<strong>Use "ExistingName"</strong> button to accept the existing registration.
              </p>
            </div>
            <button className="btn-icon speaker-label-error-dismiss" onClick={() => onClearError?.()} title="Dismiss">
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
