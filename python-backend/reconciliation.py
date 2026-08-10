"""Attendee reconciliation + registration helpers extracted from main.py (Phase 0).

Most of these functions are called mid-pipeline (from main.py's pipeline
orchestration, which moves out in later phases) and depend on the runtime
service singletons. They read them lazily via ``services.<name>`` (see
services.py) instead of ``from main import ...`` because main.py runs as
``__main__`` and a second ``import main`` would never get its lifespan() run.
"""

import os
import json
import traceback

from config import config
from voiceprint import VoiceprintManager
import services


def _reconcile_attendees(metadata_attendees: list, attendee_emails: list,
                         match_result: dict,
                         speaker_segments: dict) -> dict:
    """Cross-reference registered attendees against voiceprint matching results
    to determine who spoke, who didn't, and who is entirely new.

    Returns a dict:
      matched_speakers: [{name, email, speaker_id, confidence}]
      non_speaking_attendees: [{name, email}] — registered but never detected as speakers
      unknown_speakers: [{speaker_id, ...}] — detected speakers not matched to any attendee
      unregistered_speakers: [{name, email}] — speakers matched/identified but whose
          name is not in the registered attendee list. These need to be registered
          separately so they appear in delivery recipients.
    """
    matched_speakers = []
    non_speaking_attendees = []
    unknown_speakers = list(match_result.get("unknown", []))

    # Build set of all detected speaker IDs (from diarization)
    all_detected_speaker_ids = set(speaker_segments.keys())

    # Build reverse map: speaker_id → matched name from known results
    speaker_to_name = {}
    scores = match_result.get("scores", {})
    for name, segs in match_result.get("known", {}).items():
        # Use the speaker field from the segments directly
        if segs and "speaker" in segs[0]:
            speaker_to_name[segs[0]["speaker"]] = name

    # For each registered attendee, check if they were detected as a speaker
    for i, att_name in enumerate(metadata_attendees):
        att_email = attendee_emails[i] if i < len(attendee_emails) else ""

        # Check if this attendee appears in matched known speakers
        matched = False
        for name in match_result.get("known", {}):
            if name.lower() == att_name.lower():
                matched = True
                confidence = scores.get(name, 0)
                # Find which speaker_id
                spk_id = next((sid for sid, n in speaker_to_name.items() if n == name), "?")
                matched_speakers.append({
                    "name": att_name,
                    "email": att_email,
                    "speaker_id": spk_id,
                    "confidence": round(confidence, 3),
                })
                break

        if not matched:
            non_speaking_attendees.append({
                "name": att_name,
                "email": att_email,
            })

    # ── Unregistered speakers: known speakers not in the attendee list ──
    # Speakers identified via voiceprint matching or user labeling whose names
    # don't appear in metadata_attendees need to be surfaced so the caller can
    # register them and include them in delivery.
    matched_attendee_names = {s["name"].lower() for s in matched_speakers}
    unregistered_speakers = []
    for name, segs in match_result.get("known", {}).items():
        if name.lower() not in matched_attendee_names:
            unregistered_speakers.append({
                "name": name,
                "email": "",
            })
            speaker_ids_for_name = [
                sid for sid, n in speaker_to_name.items() if n == name
            ]
            print(f"[reconciliation] ⚠️  Speaker '{name}' (IDs: {speaker_ids_for_name}) "
                  f"is NOT in registered attendees — will be registered as new attendee")

    # ── Unregistered speakers from all-voiceprint cross-check ──
    # Speakers identified via the full voiceprint DB cross-check (Phase 1 fix)
    # whose names aren't in the registered attendee list. Auto-register them
    # as matched speakers so the labeling pause can be skipped.
    for name, segs in match_result.get("unregistered", {}).items():
        if name.lower() not in matched_attendee_names:
            spk_id = None
            for spk_id_candidate, spk_segs in speaker_segments.items():
                for s in spk_segs[:5]:
                    for ks in (segs or [])[:5]:
                        if abs(s.get("start", 0) - ks.get("start", 0)) < 0.5:
                            spk_id = spk_id_candidate
                            break
                    if spk_id:
                        break
                if spk_id:
                    break
            confidence = scores.get(name, 0)
            matched_speakers.append({
                "name": name,
                "email": "",
                "speaker_id": spk_id or "?",
                "confidence": round(confidence, 3),
            })
            unregistered_speakers.append({
                "name": name,
                "email": "",
            })
            print(f"[reconciliation] ⚠️  Voiceprint-matched speaker '{name}' (ID: {spk_id}) "
                  f"is NOT in registered attendees — auto-registering as new attendee")

    # ── Positional fallback: no voiceprints exist, all attendees unmatched ──
    # When there are no stored voiceprints, match_result["known"] is empty,
    # so every attendee lands in non_speaking_attendees even though the
    # detected speakers ARE those attendees. If the counts match, assign
    # each unknown speaker positionally to its corresponding attendee.
    if (not matched_speakers
            and unknown_speakers
            and len(metadata_attendees) == len(unknown_speakers)
            and len(non_speaking_attendees) == len(metadata_attendees)):
        for i, att_name in enumerate(metadata_attendees):
            spk = unknown_speakers[i]
            att_email = attendee_emails[i] if i < len(attendee_emails) else ""
            matched_speakers.append({
                "name": att_name,
                "email": att_email,
                "speaker_id": spk["speaker_id"],
                "confidence": 0.0,
            })
        non_speaking_attendees.clear()
        matched_ids = {s["speaker_id"] for s in matched_speakers}
        unknown_speakers = [u for u in unknown_speakers
                           if u["speaker_id"] not in matched_ids]

    return {
        "matched_speakers": matched_speakers,
        "non_speaking_attendees": non_speaking_attendees,
        "unknown_speakers": unknown_speakers,
        "unregistered_speakers": unregistered_speakers,
    }


def _resolve_attendee_email(name: str, email: str) -> str:
    """Resolve an attendee email, falling back to voiceprint if empty.

    If the provided email is empty, looks up the voiceprint by speaker
    name and uses the voiceprint's resolved email (even the
    ``@voiceprint.local`` fallback). This ensures the ephemeral DB
    attendee record matches the voiceprint key so the frontend can
    link them for the voice sample play button.
    """
    if email and email.strip():
        return email.strip()
    # Empty email — try to resolve from voiceprint by name
    try:
        vp = services.vp_manager.get_voiceprint(name)
        if vp and vp.get("email"):
            return vp["email"]
    except Exception:
        pass
    # No voiceprint either — derive deterministically so it still
    # matches what _make_email would produce for this name
    return VoiceprintManager._make_email(name, "")


def _split_excluded_non_speaking(non_speaking: list, excluded_non_speaking: list):
    """Partition non-speaking attendees into (kept, removed) based on an explicit
    exclusion list (A/B conflict losers + user-removed non-speaking attendees).

    Matching is case-insensitive on the attendee name. Handles both dict-style
    ({name, email}) and plain-string entries defensively.
    """
    if not excluded_non_speaking or not non_speaking:
        return non_speaking or [], []
    excluded_lower = {e.strip().lower() for e in excluded_non_speaking if e and e.strip()}
    if not excluded_lower:
        return non_speaking, []
    kept, removed = [], []
    for ns in non_speaking:
        name = ns.get("name", "") if isinstance(ns, dict) else str(ns)
        if name.strip().lower() in excluded_lower:
            removed.append(ns)
        else:
            kept.append(ns)
    return kept, removed


def _prune_excluded_emails(existing_recipients: set, removed_ns: list, retained_emails: set):
    """Remove delivery recipients belonging to excluded non-speaking attendees,
    unless the email is shared with a retained attendee."""
    if not removed_ns:
        return
    excluded_emails = {
        _resolve_attendee_email(ns["name"], ns.get("email", "")).lower()
        for ns in removed_ns
    }
    for e in list(existing_recipients):
        if e in excluded_emails and e not in retained_emails:
            existing_recipients.discard(e)


def _update_metadata_with_reconciliation(
    job_id: str, metadata: dict,
    reconciliation: dict, jlog=None, excluded_non_speaking: list = None
):
    """Update metadata.json with reconciled attendee list and delivery recipients.

    Called after labeling (both post-ASR and pre-ASR/resumed paths) to persist
    the full attendee list — including newly labeled speakers, unregistered
    speakers, and non-speaking attendees — to metadata.json. Without this,
    downstream consumers (approve_gate1, enqueue_ready, agent runner delivery)
    read stale metadata with only the original upload-form attendees.

    excluded_non_speaking: names of form entries never assigned to a speaker slot
        (A/B conflict losers + user-removed non-speaking attendees). They are
        dropped from the attendee list and their emails are pruned from the
        delivery recipients.
    """
    # Capture the original form's attendee emails BEFORE metadata["attendeeEmails"]
    # is overwritten below. Excluded form entries (A/B conflict losers + X'd
    # non-speaking attendees) are resolved to their emails from here so they can
    # be pruned from delivery recipients even when the caller (resumed pipeline)
    # already stripped them from reconciliation["non_speaking_attendees"] — which
    # would otherwise leave `removed_ns` empty and leak their emails into delivery.
    _orig_attendees = metadata.get("attendees", [])
    _orig_emails_raw = metadata.get("attendeeEmails", {})
    if isinstance(_orig_emails_raw, list):
        _orig_email_map = dict(zip(_orig_attendees, _orig_emails_raw))
    else:
        _orig_email_map = _orig_emails_raw if isinstance(_orig_emails_raw, dict) else {}

    non_speaking_full = reconciliation.get("non_speaking_attendees", [])
    kept_ns, removed_ns = _split_excluded_non_speaking(non_speaking_full, excluded_non_speaking)
    if removed_ns:
        print(f"[pipeline] 🗑️ Excluded {len(removed_ns)} non-speaking attendee(s) "
              f"({[r.get('name') for r in removed_ns]}) from metadata — "
              f"dropped from meeting record + delivery")

    all_attendee_names = list(dict.fromkeys(
        [s["name"] for s in reconciliation.get("matched_speakers", [])] +
        [ns["name"] for ns in kept_ns] +
        [us["name"] for us in reconciliation.get("unregistered_speakers", [])]
    ))
    all_attendee_emails = []
    for name in all_attendee_names:
        raw_email = next(
            (s.get("email", "") for s in reconciliation.get("matched_speakers", []) if s["name"] == name),
            next((ns.get("email", "") for ns in kept_ns if ns["name"] == name),
                 next((us.get("email", "") for us in reconciliation.get("unregistered_speakers", []) if us["name"] == name), ""))
        )
        all_attendee_emails.append(
            _resolve_attendee_email(name, raw_email)
        )

    metadata["attendees"] = all_attendee_names
    metadata["attendeeEmails"] = dict(zip(all_attendee_names, all_attendee_emails))
    # Persist kept non-speaking attendees (present but silent) so results and
    # delivery selection can annotate them. Excluded ones were already stripped
    # from `kept_ns` above.
    metadata["non_speaking_attendees"] = [ns["name"] for ns in kept_ns]
    # Only add emails from matched speakers and unregistered speakers, NOT
    # from non-speaking attendees — they were present but shouldn't auto-receive
    # delivery unless they were already in the original email_recipients.
    existing_recipients = set(e.lower() for e in metadata.get("email_recipients", []) if e)
    for s in reconciliation.get("matched_speakers", []):
        e = _resolve_attendee_email(s["name"], s.get("email", ""))
        if e and "@voiceprint.local" not in e:
            existing_recipients.add(e.lower())
    for us in reconciliation.get("unregistered_speakers", []):
        # Skip if this voiceprint no longer exists (was overwritten).
        # Defensive: an unrecoverable voiceprint-DB read should not fail the
        # whole job — log and skip the lookup (retry lives in get_voiceprint).
        try:
            existing_vp = services.vp_manager.get_voiceprint(us["name"])
        except Exception as e:
            print(f"[pipeline] ⚠️  get_voiceprint('{us.get('name', '?')}') failed: {e} — skipping")
            continue
        if existing_vp is None:
            continue
        e = _resolve_attendee_email(us["name"], us.get("email", ""))
        if e and "@voiceprint.local" not in e:
            existing_recipients.add(e.lower())
    # Prune delivery recipients for excluded non-speaking attendees.
    retained_emails = {e.lower() for e in all_attendee_emails}
    # `removed_ns` may be empty here because the caller already stripped the
    # excluded names from reconciliation["non_speaking_attendees"]. Resolve each
    # excluded form-entry name to its email from the original form metadata so
    # its email is still removed from delivery recipients (prevents excluded
    # names from leaking into email_recipients / actual deliveries).
    _covered_names = {ns["name"].lower() for ns in removed_ns}
    for _ex_name in (excluded_non_speaking or []):
        if not _ex_name or not _ex_name.strip():
            continue
        if _ex_name.strip().lower() in _covered_names:
            continue
        # Resolve this excluded name's email from the original form metadata
        # (case-insensitive, matching how the attendee names were recorded).
        _ex_email = _orig_email_map.get(_ex_name, "")
        if not _ex_email:
            _ex_lower = _ex_name.strip().lower()
            _ex_email = next(
                (v for k, v in _orig_email_map.items()
                 if isinstance(k, str) and k.strip().lower() == _ex_lower),
                "",
            )
        removed_ns.append({
            "name": _ex_name.strip(),
            "email": _ex_email,
        })
    _prune_excluded_emails(existing_recipients, removed_ns, retained_emails)
    # Deterministic email_recipients ordering: reconciled attendee order first,
    # then any remaining configured recipients (sorted). `existing_recipients` is
    # a set, so iterating it directly would produce an arbitrary order that made
    # "which recipient is first" unstable run to run.
    _recipient_set = set(e.lower() for e in existing_recipients if e)
    _ordered_recipients = []
    _seen = set()
    for _e in all_attendee_emails:
        _key = _e.lower()
        if _e and _key in _recipient_set and _key not in _seen:
            _seen.add(_key)
            _ordered_recipients.append(_e)
    for _e in sorted(existing_recipients):
        if _e not in _seen:
            _seen.add(_e)
            _ordered_recipients.append(_e)
    metadata["email_recipients"] = _ordered_recipients
    try:
        meta_path = os.path.join(config.STORAGE_PATH, job_id, "metadata.json")
        with open(meta_path, "w") as f:
            json.dump(metadata, f, indent=2)
        msg = (f"[pipeline] ✅ Updated metadata.json with {len(all_attendee_names)} reconciled attendee(s) "
               f"({len(metadata['email_recipients'])} delivery recipients)")
        if jlog:
            jlog.log(msg)
        else:
            print(msg)
    except Exception as e:
        err = f"[pipeline] ⚠️  Could not persist reconciled metadata: {e}"
        if jlog:
            jlog.log(err)
        else:
            print(err)


def _register_attendees_after_reconciliation(
    job_id: str, metadata: dict,
    reconciliation: dict, source: str = "new_job_form"
):
    """Persist reconciled attendees to the ephemeral DB attendee registry.

    Only called AFTER voiceprint matching / labeling reconciliation is
    complete, never during upload. This ensures the attendee registry
    accurately reflects who actually participated in the meeting.

    Registered:
      - matched_speakers (they spoke)
      - non_speaking_attendees (they were present but silent)
      - unregistered_speakers (identified by voiceprint/labeling but not in
        the original attendee list — come from reconciliation["unregistered_speakers"])
    """
    all_attendees = []
    all_emails = []

    # Cross-check resolved emails against email_recipients for delivery gap logging
    email_recipients = set()
    try:
        meta_recip = metadata.get("email_recipients", [])
        if isinstance(meta_recip, list):
            email_recipients = set(e.lower() for e in meta_recip if e)
    except Exception:
        pass

    for s in reconciliation.get("matched_speakers", []):
        name = s["name"]
        resolved = _resolve_attendee_email(name, s.get("email", ""))
        all_attendees.append(name)
        all_emails.append(resolved)
        # Log delivery gap
        if resolved.lower() not in email_recipients:
            print(f"[reconciliation] ⚠️  Attendee '{name}' ({resolved}) is NOT in "
                  f"email_recipients — will not receive email delivery")

    for ns in reconciliation.get("non_speaking_attendees", []):
        name = ns["name"]
        resolved = _resolve_attendee_email(name, ns.get("email", ""))
        all_attendees.append(name)
        all_emails.append(resolved)
        if resolved.lower() not in email_recipients:
            print(f"[reconciliation] ⚠️  Non-speaking attendee '{name}' ({resolved}) "
                  f"is NOT in email_recipients — will not receive email delivery")

    # Register unregistered speakers — attendees identified by voiceprint matching
    # or user labeling whose names weren't in the original upload attendee list.
    for us in reconciliation.get("unregistered_speakers", []):
        name = us["name"]
        resolved = _resolve_attendee_email(name, us.get("email", ""))
        all_attendees.append(name)
        all_emails.append(resolved)
        if resolved.lower() not in email_recipients:
            print(f"[reconciliation] ⚠️  Unregistered speaker '{name}' ({resolved}) "
                  f"is NOT in email_recipients — will not receive email delivery")

    if not all_attendees:
        return

    # ── Defer if A/B conflicts exist ──
    # When unregistered_speakers is non-empty, the user has unresolved A/B
    # conflicts (voiceprint owners not in the form). Registering both sides
    # before the user decides creates orphan records when the overwrite
    # cleanup fails. Defer to _inner_label_and_resume which runs after the
    # user resolves conflicts and is the single registration point.
    has_conflicts = bool(reconciliation.get("unregistered_speakers"))
    if has_conflicts:
        unreg_count = len(reconciliation.get("unregistered_speakers", []))
        print(f"[reconciliation] ⏸️  Deferring attendee registration for {job_id[:8]} — "
              f"{unreg_count} unregistered speaker(s) need A/B conflict resolution first")
        return

    # ── No conflicts — safe to persist now ──
    # Flag kept non-speaking attendees (present but silent) so the attendee
    # registry records who actually spoke in this meeting. Excluded names were
    # already stripped from reconciliation by the caller, so they are neither
    # registered here nor flagged.
    non_speaking_names = {ns["name"] for ns in reconciliation.get("non_speaking_attendees", [])}
    try:
        services.ephemeral_memory.register_attendees(
            all_attendees, all_emails,
            source=source, job_id=job_id,
            non_speaking=non_speaking_names,
        )
        print(f"[reconciliation] Registered {len(all_attendees)} attendee(s) "
              f"({len(reconciliation.get('matched_speakers', []))} spoke, "
              f"{len(reconciliation.get('non_speaking_attendees', []))} non-speaking) "
              f"for job {job_id[:8]} in ephemeral DB")
        # Dedup sweep: remove duplicate attendee rows by name (keep most recent)
        _dedup_attendees(job_id)
        return True
    except Exception as e:
        # Capture full traceback for disk I/O and other transient errors
        tb = traceback.format_exc()
        sqlite_code = getattr(e, 'sqlite_errorcode', 'N/A')
        print(f"[reconciliation] ⚠️  Could not register attendees for job {job_id}: "
              f"{e} (sqlite3_code={sqlite_code})")
        print(f"[reconciliation]   Traceback:\n{tb}")
        # Record the failure WITHOUT changing the current status — registration
        # runs at review-gate points (paused_for_labeling / pending_raw_review),
        # so overwriting status here would strand the job at the gate. The
        # warning is merged into status.json (survives to completion) and is
        # checked by complete_job() / the startup sweep, which refuse to mark
        # the job "complete" until the attendees are repaired (Fix 1).
        try:
            services.uploader.update_status(job_id, {
                "warnings": [f"attendee registration failed: {e}"],
            })
        except Exception as _se:
            print(f"[reconciliation] ⚠️  Could not persist attendee warning: {_se}")
        try:
            services.ephemeral_memory.upsert_job(job_id, {
                "error_message": f"Attendee registration failed: {e}",
            })
        except Exception as _ue:
            print(f"[reconciliation] ⚠️  Could not persist warning to jobs table: {_ue}")
        return False


# ── Attendee dedup helper ──

def _dedup_attendees(job_id: str = ""):
    """Remove duplicate attendee rows per name, keeping only the most recent.

    Called after every attendee registration to clean up any stale duplicates
    that may have accumulated from registration paths with different ``source``
    values or from earlier versions of the dedup logic.

    Args:
        job_id: Optional job ID for logging context.
    """
    try:
        conn = services.ephemeral_memory._get_conn()
        tag = job_id[:8] if job_id else "?"
        deleted = conn.execute("""
            DELETE FROM attendees WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id, name,
                           ROW_NUMBER() OVER (
                               PARTITION BY name ORDER BY last_seen DESC
                           ) AS rn
                    FROM attendees
                ) WHERE rn = 1
            )
        """).rowcount
        conn.commit()
        if deleted:
            print(f"[reconciliation] 🧹 Dedup sweep for {tag}: removed {deleted} duplicate attendee row(s)")
    except Exception as e:
        print(f"[reconciliation] ⚠️  Dedup sweep failed for {tag}: {e}")


# ── Attendee repair helper (self-healing guarantee) ──

def _ensure_job_attendees_registered(job_id: str, source: str = "manual_labeling") -> bool:
    """Idempotent repair: rebuild a job's attendee records from metadata.json.

    metadata.json is the durable, post-reconciliation source of truth for who
    attended a meeting. This upserts those names/emails into the ephemeral DB
    attendee registry so the projection always converges even if the original
    registration write failed (e.g. transient SQLite "disk I/O error").

    Safe to re-run: ``register_attendees()`` is an idempotent SELECT-then-UPSERT
    and the dedup sweep removes stale duplicates.

    Returns True iff the job's registered attendees are present in the DB.
    """
    meta = services.uploader.get_metadata(job_id)
    if not meta:
        return False
    names = meta.get("attendees", []) or []
    if not names:
        return True  # nothing to register

    emails_raw = meta.get("attendeeEmails", {})
    if isinstance(emails_raw, list):
        emails = list(emails_raw)
    elif isinstance(emails_raw, dict):
        emails = [emails_raw.get(n, "") for n in names]
    else:
        emails = []
    # Pad/truncate to align with names, then resolve empties so registry keys
    # match voiceprint keys (same as the normal registration path).
    emails = (emails + [""] * len(names))[:len(names)]
    emails = [_resolve_attendee_email(n, e) for n, e in zip(names, emails)]

    try:
        services.ephemeral_memory.register_attendees(
            names, emails, source=source, job_id=job_id,
            non_speaking=set(meta.get("non_speaking_attendees", []) or []),
        )
        _dedup_attendees(job_id)
        return True
    except Exception as e:
        print(f"[reconciliation] ⚠️  Repair failed for job {job_id}: {e}")
        return False


def _job_attendee_shortfall(job_id: str) -> list:
    """Return metadata attendee names missing from the registry that are still
    "current" (i.e. still have an enrolled voiceprint).

    Used by the startup sweep to detect silently-short registries (registration
    deferred on A/B conflicts leaves the DB short with no warning flag) without
    bumping ``last_seen`` for healthy jobs and without resurrecting attendees
    that a later job overwrote/replaced — those names no longer have a
    voiceprint (e.g. Sags replaced by smart mike). Read-only and idempotent.
    """
    meta = services.uploader.get_metadata(job_id)
    if not meta:
        return []
    names = [n for n in (meta.get("attendees", []) or []) if n]
    if not names:
        return []
    placeholders = ",".join("?" for _ in names)
    try:
        conn = services.ephemeral_memory._get_conn()
        rows = conn.execute(
            f"SELECT name FROM attendees WHERE name IN ({placeholders})",
            names,
        ).fetchall()
        present = {r[0].lower() for r in rows}
    except Exception:
        present = set()
    missing = [n for n in names if n.lower() not in present]
    if not missing:
        return []
    # Only names that still have an enrolled voiceprint are "current" and safe
    # to re-register. Overwritten/replaced names no longer have a voiceprint.
    try:
        conn = services.vp_manager._get_conn()
        vp_rows = conn.execute(
            f"SELECT speaker_name FROM voiceprints WHERE speaker_name IN "
            f"({','.join('?' for _ in missing)})",
            missing,
        ).fetchall()
        current = {r[0].lower() for r in vp_rows}
    except Exception:
        current = set()
    return [n for n in missing if n.lower() in current]
