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
  form_entry_name?: string;
  form_entry_email?: string;
  voiceprint_confidence?: number;
  voiceprint_matches?: VoiceMatchConflict[];
}

interface VoiceMatchConflict {
  name: string;
  email: string;
  similarity: number;
  sample_job_id?: string;
}

interface VoiceDriftConflict {
  name: string;
  email?: string;
  similarity: number;
  sample_job_id?: string;
}

interface LabelVerification {
  speaker_id: string;
  assigned_name: string;
  assigned_email: string;
  voice_match_conflicts: VoiceMatchConflict[];
  voice_drift_conflicts?: VoiceDriftConflict[];
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

interface KnownAttendee {
  name: string;
  email?: string;
  sample_job_id?: string;
  in_form?: boolean;
}

interface Props {
  jobId: string;
  speakers: SpeakerInfo[];
  suggestedEmails?: string[];
  onConfirm: (
    labels: Array<{ speaker_id: string; name: string; email?: string }>,
    options?: { overwriteNames?: string[]; excludedNonSpeaking?: string[] },
  ) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  nonSpeakingAttendees?: NonSpeakingInfo[];
  knownAttendees?: {
    with_voiceprint: KnownAttendee[];
    without_voiceprint: KnownAttendee[];
  };
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
  knownAttendees,
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

  // ── Per-speaker A/B conflict choice ──
  // Tracks which option the user selected in the A/B conflict selector.
  // 'form_entry' = use the name/email from the new job form (overwrite)
  // 'voice_owner' = use the matched voiceprint owner's name/email (keep existing)
  const [conflictChoices, setConflictChoices] = useState<Record<string, 'form_entry' | 'voice_owner'>>({});

  // ── Non-speaking attendee manual removal (X buttons) ──
  // Lowercased names the user removed from the "Also present but did not speak"
  // section. They are excluded from the persisted attendee list + delivery.
  const [removedNonSpeaking, setRemovedNonSpeaking] = useState<Set<string>>(new Set());

  // ── Own-print voice-drift notices (advisory) ──
  // Keyed by speaker_id. When the assigned name has an enrolled voiceprint but
  // the current meeting's voice doesn't match it, verifyLabels returns a
  // voice_drift_conflicts entry and we show an inline notice. It is advisory,
  // not a gate: the user can explicitly overwrite (adds to perSpeakerOverwrite),
  // dismiss it (accepting the overwrite on save), or edit the name (which clears
  // it). The user has full visibility into what exists and where the mismatch is.
  const [driftNotices, setDriftNotices] = useState<Record<string, VoiceDriftConflict>>({});
  // ── Proactive voiceprint-overwrite warnings ──
  // Set when the user picks an existing attendee that already has an enrolled
  // voiceprint (the "Voiceprint owners" dropdown bucket). Confirming that label
  // will OVERWRITE the existing voiceprint with this meeting's voice, so we show
  // a warning border + message until the user edits the name or confirms.
  const [vpOverwriteWarnings, setVpOverwriteWarnings] = useState<
    Record<string, { name: string; email: string; sample_job_id?: string }>
  >({});

  // A registered attendee already assigned to a speaker slot is disabled in
  // every dropdown (the app rejects duplicate speaker names anyway).
  const usedAttendeeNames = new Set(
    Object.values(labels)
      .map((n) => (n || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const isAttendeeUsed = (name: string) => usedAttendeeNames.has(name.trim().toLowerCase());

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

    // Keep only the best match per speaker (defense-in-depth)
    for (const spkId of Object.keys(grouped)) {
      const matches = grouped[spkId].voice_match_conflicts;
      if (matches.length > 1) {
        matches.sort((a, b) => b.similarity - a.similarity);
        grouped[spkId].voice_match_conflicts = [matches[0]];
      }
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
    const conflictSpeakerIdsOnMount = new Set<string>();
    // First pass: detect conflicts so we can skip pre-fill for them
    for (let i = 0; i < speakers.length; i++) {
      const spk = speakers[i];
      const vpms = spk.voiceprint_matches;
      if (vpms && vpms.length > 0) {
        const best = vpms[0];
        const suggested = (spk.suggested_name || "").toLowerCase();
        if (best.name.toLowerCase() !== suggested) {
          conflictSpeakerIdsOnMount.add(spk.speaker_id);
        }
      }
    }
    for (let i = 0; i < speakers.length; i++) {
      const spk = speakers[i];
      // Skip pre-fill for conflicted speakers — A/B selector handles them
      if (conflictSpeakerIdsOnMount.has(spk.speaker_id)) continue;
      if (spk.suggested_name) {
        initialNames[spk.speaker_id] = spk.suggested_name;
      }
      // Use backend-resolved email (matched by voiceprint identity in Pass 2)
      // Falls back to positional alignment only when form_entry_email is empty.
      if (spk.form_entry_email) {
        initialEmails[spk.speaker_id] = spk.form_entry_email;
      } else if (i < suggestedEmails.length && suggestedEmails[i]) {
        initialEmails[spk.speaker_id] = suggestedEmails[i];
      }
    }
    setLabels(initialNames);
    setEmails(initialEmails);

    // ── Proactive conflict seeding from voiceprint_matches ──
    // Only seed for speakers where name wasn't pre-filled (conflict detected).
    // The backend already suppressed suggested_name for these, but we also
    // skipped the positional email above to keep name+email in sync.
    const proactive: typeof proactiveConflicts = [];
    const conflictEntries: Record<string, LabelVerification> = {};
    for (const spk of speakers) {
      // Use the form_entry data for the "assigned" side of the conflict
      const formName = spk.form_entry_name || "";
      const formEmail = spk.form_entry_email || "";
      const vpms = spk.voiceprint_matches;
      if (!vpms || vpms.length === 0) continue;
      const best = vpms[0];
      // Only seed a conflict if the best match name differs from the form
      // entry name (or form entry is blank). If they match, no conflict.
      // Additionally, if the backend already verified the match by setting
      // suggested_name to the voiceprint owner, suppress the false conflict
      // (defense-in-depth for edge cases where positional form data doesn't
      // align with voiceprint identity after fix A).
      const suggestedMatch = (spk.suggested_name || "").toLowerCase();
      if (
        best.name.toLowerCase() !== formName.toLowerCase() &&
        best.name.toLowerCase() !== suggestedMatch
      ) {
        conflictEntries[spk.speaker_id] = {
          speaker_id: spk.speaker_id,
          assigned_name: formName,
          assigned_email: formEmail,
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

  // ── Conflict losers: form entries that lost an A/B conflict ("use voice owner") ──
  // The user kept the existing voiceprint owner, so the form entry was never
  // assigned to a speaker slot and was not in the audio. These names are hidden
  // from the non-speaking section and excluded from the persisted attendee list.
  const conflictLoserNames = new Set<string>();
  for (const [spkId, choice] of Object.entries(conflictChoices)) {
    if (choice !== "voice_owner") continue;
    const spk = speakers.find((s) => s.speaker_id === spkId);
    const formName = spk?.form_entry_name?.trim();
    if (formName) conflictLoserNames.add(formName.toLowerCase());
  }

  // Non-speaking attendees still visible (not removed via X, not a conflict loser,
  // not currently assigned to a speaker slot — e.g. promoted via the dropdown).
  const labeledNames = new Set(
    Object.values(labels)
      .map((n) => (n || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const visibleNonSpeaking = nonSpeakingAttendees.filter((ns) => {
    const key = (ns.name || "").toLowerCase();
    if (removedNonSpeaking.has(key) || conflictLoserNames.has(key)) return false;
    if (labeledNames.has(key)) return false;
    return true;
  });

  /** Names to exclude from the persisted non-speaking attendee list.
   *  = A/B conflict losers (form entry lost to an existing voice owner)
   *    ∪ non-speaking attendees removed via the X button
   *    − any name actually assigned to a speaker slot. */
  const buildExcludedNonSpeaking = (
    result: Array<{ speaker_id: string; name: string; email?: string }>,
  ): string[] => {
    const excluded = new Set<string>(conflictLoserNames);
    for (const n of removedNonSpeaking) excluded.add(n);
    const labeled = new Set(result.map((l) => l.name.trim().toLowerCase()).filter(Boolean));
    return Array.from(excluded).filter((n) => !labeled.has(n));
  };

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

    // ── Step 0: Reject duplicate speaker names ──
    // Two speakers cannot share the same name — the backend would lose
    // one speaker's segment data in the `known` dict during label application.
    const nameCounts = new Map<string, number>();
    for (const l of result) {
      const key = l.name.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    const duplicateNames = Array.from(nameCounts.entries())
      .filter(([_, count]) => count > 1)
      .map(([name]) => name);
    if (duplicateNames.length > 0) {
      const dup = duplicateNames[0];
      setEmailErrors((prev) => {
        const next = { ...prev };
        for (const s of speakers) {
          if (labels[s.speaker_id]?.trim().toLowerCase() === dup) {
            next[s.speaker_id] = `Name "${labels[s.speaker_id]?.trim()}" is already assigned to another speaker`;
          }
        }
        return next;
      });
      setCheckingConflicts(false);
      return;
    }

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
          const verifications = vResult.verifications || [];
          const voiceConflicts = verifications.filter((v: LabelVerification) => (v.voice_match_conflicts?.length || 0) > 0);
          const unregistered = vResult.unregistered_names || [];

          // Populate inline own-print drift notices from this verification pass.
          const drift: Record<string, VoiceDriftConflict> = {};
          for (const v of verifications) {
            if (v?.voice_drift_conflicts?.length) {
              drift[v.speaker_id] = v.voice_drift_conflicts[0];
            }
          }
          if (Object.keys(drift).length > 0) {
            setDriftNotices((prev) => ({ ...prev, ...drift }));
          }

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
    const excludedNonSpeaking = buildExcludedNonSpeaking(result);
    await onConfirm(
      result,
      overwriteNames.length > 0 || excludedNonSpeaking.length > 0
        ? { overwriteNames, excludedNonSpeaking }
        : undefined,
    );
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
    const excludedNonSpeaking = buildExcludedNonSpeaking(result);
    setConflicts([]);
    await onConfirm(result, { overwriteNames, excludedNonSpeaking });
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
    const excludedNonSpeaking = buildExcludedNonSpeaking(result);
    await onConfirm(result, { overwriteNames, excludedNonSpeaking });
  };

  /** Accept selected matches and/or keep per-speaker names, then proceed.
   *  - Accepted conflicts → labels are renamed to the existing voiceprint name
   *  - Speakers with "Keep my name" checked → their typed name is passed as
   *    overwrite_names so the drift audit skips them. */
  const handleVoiceWarningAcceptSelected = async () => {
    const result = buildResult();
    const buildOverwriteNames: string[] = [];
    // Form entries replaced by accepted voiceprint owners ("use voice owner" in
    // the voice-match dialog) — they lose their speaker slot and must be
    // excluded from the meeting record + delivery.
    const conflictLosers: string[] = [];

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
            // Voice owner wins — the replaced form entry is a conflict loser
            // (never assigned to a speaker slot), so exclude it from the
            // meeting record + delivery, matching the A/B "use voice owner"
            // behavior.
            const replacedName = found.name?.trim();
            if (replacedName && replacedName.toLowerCase() !== (mc.name || "").toLowerCase()) {
              conflictLosers.push(replacedName);
            }
            found.name = mc.name;
            // Use existing voiceprint email only if it's a real address;
            // otherwise keep the user's typed email so it reaches delivery.
            found.email = mc.email && !mc.email.includes("@voiceprint.local") ? mc.email : found.email;
          }
        }
      }
    }

    setShowVoiceWarnings(false);
    setVerificationDone(true);
    setCheckingConflicts(false);
    const excludedNonSpeaking = buildExcludedNonSpeaking(result);
    // Merge the voice-match-dialog conflict losers into the exclusion list
    // (minus any name that still ended up assigned to a speaker slot).
    const labeled = new Set(result.map((l) => l.name.trim().toLowerCase()).filter(Boolean));
    const mergedExcluded = Array.from(new Set([
      ...excludedNonSpeaking,
      ...conflictLosers.map((n) => n.toLowerCase()).filter((n) => !labeled.has(n)),
    ]));
    await onConfirm(
      result,
      buildOverwriteNames.length > 0 || mergedExcluded.length > 0
        ? { overwriteNames: buildOverwriteNames, excludedNonSpeaking: mergedExcluded }
        : undefined,
    );
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
          if (v?.voice_drift_conflicts?.length > 0) {
            setDriftNotices((prev) => ({ ...prev, [speakerId]: v.voice_drift_conflicts[0] }));
          } else {
            setDriftNotices((prev) => {
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

  /** Run a single-label verify with an explicit name/email (NOT handleNameBlur,
   *  which reads labels from a stale closure). Routes results into either the
   *  existing inline A/B conflict or the new own-print drift notice. */
  const verifySingleSpeaker = useCallback(
    async (speakerId: string, name: string, email: string) => {
      try {
        const res = await (window as any).electronAPI?.verifyLabels({
          jobId,
          labels: [{ speaker_id: speakerId, name, email }],
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
        if (v?.voice_drift_conflicts?.length > 0) {
          setDriftNotices((prev) => ({ ...prev, [speakerId]: v.voice_drift_conflicts[0] }));
        } else {
          setDriftNotices((prev) => {
            const next = { ...prev };
            delete next[speakerId];
            return next;
          });
        }
      } catch {
        // Backend unavailable — ignore
      }
    },
    [jobId],
  );

  /** Fill a speaker's name/email from a known-attendee dropdown selection, then
   *  verify the assignment for cross-match conflicts and own-print drift. */
  const handleAttendeeSelect = useCallback(
    (speakerId: string, attendee: KnownAttendee) => {
      const spk = speakers.find((s) => s.speaker_id === speakerId);
      // Email-fill rule: prefer the job-form email when this attendee is in the
      // form (the backend's email-mismatch correction forces it anyway); else
      // use the enrolled email so the voiceprint join key is preserved.
      const email = attendee.in_form
        ? spk?.form_entry_email || attendee.email || ""
        : attendee.email || "";
      setLabels((prev) => ({ ...prev, [speakerId]: attendee.name }));
      setEmails((prev) => ({ ...prev, [speakerId]: email }));
      setEmailErrors((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
      // Reset per-speaker conflict/drift/overwrite so the fresh verify decides.
      setPerSpeakerConflicts((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
      setDriftNotices((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
      setPerSpeakerOverwrite((prev) => {
        const next = new Set(prev);
        next.delete(speakerId);
        return next;
      });
      // Proactive overwrite warning: if the picked attendee already has an
      // enrolled voiceprint (with_voiceprint bucket), surface that confirming
      // this assignment will overwrite it. No voiceprint → clear any warning.
      if (attendee.sample_job_id) {
        setVpOverwriteWarnings((prev) => ({
          ...prev,
          [speakerId]: {
            name: attendee.name,
            email,
            sample_job_id: attendee.sample_job_id,
          },
        }));
      } else {
        setVpOverwriteWarnings((prev) => {
          const next = { ...prev };
          delete next[speakerId];
          return next;
        });
      }
      onClearError?.();
      void verifySingleSpeaker(speakerId, attendee.name, email);
    },
    [speakers, onClearError, verifySingleSpeaker],
  );

  /** Explicitly overwrite the enrolled voiceprint with this meeting's voice. */
  const handleDriftOverwrite = (speakerId: string) => {
    setPerSpeakerOverwrite((prev) => new Set(prev).add(speakerId));
    setDriftNotices((prev) => {
      const next = { ...prev };
      delete next[speakerId];
      return next;
    });
  };

  /** Dismiss the drift notice — keeps the assignment as-is (the overwrite will
   *  happen on save; the user was informed of the mismatch and can edit the name
   *  to change their mind). Advisory, not a gate. */
  const handleDriftDismiss = (speakerId: string) => {
    setDriftNotices((prev) => {
      const next = { ...prev };
      delete next[speakerId];
      return next;
    });
  };

  /** Handle A/B conflict choice: fill the speaker's name/email and track the decision. */
  const handleConflictChoice = useCallback(
    (speakerId: string, choice: 'form_entry' | 'voice_owner', match: VoiceMatchConflict) => {
      setConflictChoices((prev) => ({ ...prev, [speakerId]: choice }));

      const spk = speakers.find((s) => s.speaker_id === speakerId);
      if (!spk) return;

      if (choice === 'voice_owner') {
        // Fill inputs with voiceprint match data (use the matched name/email)
        setLabels((prev) => ({ ...prev, [speakerId]: match.name }));
        const resolvedEmail = match.email && !match.email.includes("@voiceprint.local")
          ? match.email : match.email;
        setEmails((prev) => ({ ...prev, [speakerId]: resolvedEmail }));
        // Remove from overwrite set — name matches voiceprint, no overwrite needed
        setPerSpeakerOverwrite((prev) => {
          const next = new Set(prev);
          next.delete(speakerId);
          return next;
        });
      } else {
        // Fill inputs with form entry data (the name/email from the new job form)
        setLabels((prev) => ({ ...prev, [speakerId]: spk.form_entry_name || '' }));
        setEmails((prev) => ({ ...prev, [speakerId]: spk.form_entry_email || '' }));
        // Add to overwrite set — form entry name differs from voiceprint, need to overwrite
        setPerSpeakerOverwrite((prev) => new Set(prev).add(speakerId));
      }

      // Clear errors for this speaker
      setEmailErrors((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
      // Dismiss the A/B selector for this speaker
      setPerSpeakerConflicts((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
      // An explicit A/B choice resolves the assignment — clear any stale drift
      // notice for this speaker.
      setDriftNotices((prev) => {
        const next = { ...prev };
        delete next[speakerId];
        return next;
      });
    },
    [speakers],
  );

  const handleSkip = () => {
    // Use default speaker IDs for any unnamed speakers
    const defaultLabels = speakers.map((s) => ({
      speaker_id: s.speaker_id,
      name: labels[s.speaker_id]?.trim() || s.speaker_id,
      email: emails[s.speaker_id]?.trim() || "",
    }));
    const excludedNonSpeaking = buildExcludedNonSpeaking(defaultLabels);
    onConfirm(defaultLabels, excludedNonSpeaking.length > 0 ? { excludedNonSpeaking } : undefined);
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
                      {" · "}
                      <span className="speaker-post-conflict-similarity">{(c.similarity * 100).toFixed(0)}% match</span>
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
                      {" · "}
                      <span className="speaker-post-conflict-similarity">{(c.similarity * 100).toFixed(0)}% match</span>
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
            const drift = driftNotices[spk.speaker_id];
            const vpOverwrite = vpOverwriteWarnings[spk.speaker_id];
            return (
              <div
                key={spk.speaker_id}
                className={`speaker-item ${hasName ? "speaker-item--labeled" : ""} ${conflictSpeakerIds.has(spk.speaker_id) ? "speaker-item--conflict" : ""} ${vpOverwrite ? "speaker-item--vp-overwrite" : ""}`}>
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
                        // A name edit invalidates any prior drift notice for this speaker.
                        setDriftNotices((prev) => {
                          const next = { ...prev };
                          delete next[spk.speaker_id];
                          return next;
                        });
                        // A name edit also clears any proactive voiceprint-overwrite
                        // warning (the assignment is no longer that attendee).
                        setVpOverwriteWarnings((prev) => {
                          const next = { ...prev };
                          delete next[spk.speaker_id];
                          return next;
                        });
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
                {/* ── Assign known attendee (dropdown) ── */}
                <div className="speaker-attendee-picker">
                  <Tooltip content="Pick a registered attendee to auto-fill this speaker's name and email">
                    <select
                      className="speaker-attendee-select"
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        e.target.value = "";
                        if (!val) return;
                        const [bucket, idxStr] = val.split(":");
                        const idx = Number(idxStr);
                        const attendee =
                          bucket === "vp"
                            ? knownAttendees?.with_voiceprint?.[idx]
                            : knownAttendees?.without_voiceprint?.[idx];
                        if (attendee) handleAttendeeSelect(spk.speaker_id, attendee);
                      }}
                      title="Assign a registered attendee to this speaker">
                      <option value="">Assign known attendee…</option>
                      {knownAttendees && knownAttendees.with_voiceprint.length > 0 && (
                        <optgroup label={`Voiceprint owners — selecting overwrites (${knownAttendees.with_voiceprint.length})`}>
                          {knownAttendees.with_voiceprint.map((a, i) => (
                            <option key={`vp-${i}`} value={`vp:${i}`} disabled={isAttendeeUsed(a.name)}>
                              {a.name}
                              {a.email ? ` <${a.email}>` : " (no email)"}
                              {a.sample_job_id ? ` · vp from ${a.sample_job_id.slice(0, 8)}` : ""}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {knownAttendees && knownAttendees.without_voiceprint.length > 0 && (
                        <optgroup label={`Registered, no voiceprint (${knownAttendees.without_voiceprint.length})`}>
                          {knownAttendees.without_voiceprint.map((a, i) => (
                            <option key={`novp-${i}`} value={`novp:${i}`} disabled={isAttendeeUsed(a.name)}>
                              {a.name}
                              {a.email ? ` <${a.email}>` : " (no email)"}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {!knownAttendees ||
                      (knownAttendees.with_voiceprint.length === 0 && knownAttendees.without_voiceprint.length === 0) ? (
                        <option value="" disabled>
                          No registered attendees
                        </option>
                      ) : null}
                    </select>
                  </Tooltip>
                </div>
                {/* ── Proactive voiceprint-overwrite warning ── */}
                {vpOverwrite && (
                  <div className="speaker-vp-overwrite-warning">
                    <Icon name="warning" size="13" color="orange" />
                    <span>
                      <strong>{vpOverwrite.name}</strong> already has an enrolled voiceprint
                      {vpOverwrite.sample_job_id ? <> from job {vpOverwrite.sample_job_id.slice(0, 8)}</> : ""}.
                      Confirming this label will <strong>overwrite</strong> it with this recording.
                    </span>
                  </div>
                )}
                {/* ── A/B conflict choice selector ── */}
                {perSpeakerConflicts[spk.speaker_id]?.voice_match_conflicts?.map((mc, ci) => {
                  const chosen = conflictChoices[spk.speaker_id];
                  const formName = spk.form_entry_name || labels[spk.speaker_id] || "";
                  const formEmail = spk.form_entry_email || emails[spk.speaker_id] || "";
                  return (
                    <div key={ci} className="speaker-ab-conflict">
                      <div className="speaker-ab-conflict-header">
                        <Icon name="warning" size="13" color="orange" />
                        <span>
                          Voice matches <strong>{mc.name}</strong>
                          {mc.email ? <> &lt;{mc.email}&gt;</> : ""} ({(mc.similarity * 100).toFixed(0)}% match)
                          {mc.sample_job_id ? <> from job {mc.sample_job_id.slice(0, 8)}</> : ""}
                        </span>
                      </div>
                      <div className="speaker-ab-conflict-options">
                        <label
                          className={`speaker-ab-option ${chosen === 'form_entry' ? 'speaker-ab-option--selected' : ''}`}
                          onClick={() => handleConflictChoice(spk.speaker_id, 'form_entry', mc)}>
                          <input
                            type="radio"
                            name={`conflict-${spk.speaker_id}`}
                            checked={chosen === 'form_entry'}
                            onChange={() => handleConflictChoice(spk.speaker_id, 'form_entry', mc)}
                          />
                          <div className="speaker-ab-option-content">
                            <span className="speaker-ab-option-label">Use form entry:</span>
                            <span className="speaker-ab-option-value">
                              {formName || <em>(no name)</em>}{formEmail ? <> &lt;{formEmail}&gt;</> : ""}
                            </span>
                          </div>
                        </label>
                        <label
                          className={`speaker-ab-option ${chosen === 'voice_owner' ? 'speaker-ab-option--selected' : ''}`}
                          onClick={() => handleConflictChoice(spk.speaker_id, 'voice_owner', mc)}>
                          <input
                            type="radio"
                            name={`conflict-${spk.speaker_id}`}
                            checked={chosen === 'voice_owner'}
                            onChange={() => handleConflictChoice(spk.speaker_id, 'voice_owner', mc)}
                          />
                          <div className="speaker-ab-option-content">
                            <span className="speaker-ab-option-label">Use voice owner:</span>
                            <span className="speaker-ab-option-value">
                              {mc.name}{mc.email ? <> &lt;{mc.email}&gt;</> : ""}
                            </span>
                          </div>
                        </label>
                      </div>
                    </div>
                  );
                })}
                {/* ── Own-print voice-drift notice ── */}
                {drift && (
                  <div className="speaker-drift-notice">
                    <div className="speaker-drift-notice-header">
                      <Icon name="warning" size="13" color="orange" />
                      <span>
                        <strong>{drift.name}</strong> has an enrolled voiceprint
                        {drift.sample_job_id ? <> from job {drift.sample_job_id.slice(0, 8)}</> : ""}, but this voice doesn't match it (
                        {(drift.similarity * 100).toFixed(0)}% similarity).
                      </span>
                    </div>
                    <p className="speaker-drift-notice-desc">
                      Saving will overwrite {drift.name}'s enrolled voiceprint with this recording.
                    </p>
                    <div className="speaker-drift-notice-actions">
                      <button className="btn-primary speaker-drift-btn" onClick={() => handleDriftOverwrite(spk.speaker_id)}>
                        Use “{drift.name}” &amp; overwrite voiceprint
                      </button>
                      <button className="btn-secondary speaker-drift-btn" onClick={() => handleDriftDismiss(spk.speaker_id)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Non-speaking attendees ── */}
        {visibleNonSpeaking.length > 0 && (
          <div className="speaker-non-speaking-section">
            <h3 className="speaker-non-speaking-heading">
              <Icon name="visibility_off" size="14" color="muted" /> Also present but did not speak
            </h3>
            <p className="speaker-non-speaking-desc">
              These registered attendees had no detected speech segments. No voiceprint is needed — they are included in the meeting record unless you remove them.
            </p>
            <ul className="speaker-non-speaking-list">
              {visibleNonSpeaking.map((ns, i) => (
                <li key={i} className="speaker-non-speaking-item">
                  <span className="speaker-non-speaking-name">{ns.name}</span>
                  {ns.email ? (
                    <span className="speaker-non-speaking-email">{ns.email}</span>
                  ) : (
                    <span className="speaker-non-speaking-email-missing">(no email)</span>
                  )}
                  <button
                    className="speaker-non-speaking-remove"
                    title="Remove from meeting record"
                    onClick={() =>
                      setRemovedNonSpeaking((prev) =>
                        new Set(prev).add((ns.name || "").toLowerCase()),
                      )
                    }>
                    <Icon name="close" size="14" />
                  </button>
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
                const hasAcceptedAny = vc.voice_match_conflicts.some((mc) => acceptedConflicts.has(`${vc.speaker_id}:${mc.name}`));
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
                        <input type="checkbox" checked={isKeeping} onChange={() => toggleVoiceMatchKeep(vc.speaker_id)} />
                        <span>
                          <strong>Keep my name &ldquo;{vc.assigned_name}&rdquo;</strong>
                          <br />
                          <span className="vp-conflict-hint-sub">Overwrites the existing voiceprint with this recording</span>
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
                This person&apos;s voice matches an existing enrolled voiceprint under a different name. Check the inline conflict notice for each
                speaker above, or use the <strong>Use "ExistingName"</strong> button to accept the existing registration.
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
