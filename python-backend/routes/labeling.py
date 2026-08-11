"""Speaker labeling + verification routes — Phase 3b extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by services/lifespan.py before any request), and
pipeline state via the shared ``state`` singleton from pipeline_state.py.
"""

import asyncio
import json
import os
import re
import subprocess as _sp
import tempfile as _tf
import traceback
from datetime import datetime

import numpy as np

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response

from config import config
from models import LabelRequest
from pipeline_state import state
from upload import resolve_ffmpeg
from helpers import _dump_all_voiceprints
from reconciliation import (
    _split_excluded_non_speaking, _resolve_attendee_email,
    _prune_excluded_emails, _dedup_attendees,
)

import services

router = APIRouter()


@router.post("/agent/label_speakers")
async def agent_label_speakers(req: LabelRequest):
    names = [f"{l.name} ({l.speaker_id})" for l in req.labels]
    print(f"[api] POST /agent/label_speakers job_id={req.job_id} labels={names}")

    # Try to extract real embeddings from audio before saving voiceprints
    audio_path = None
    transcript_data = None
    p = os.path.join(config.STORAGE_PATH, req.job_id, "transcript.json")
    if os.path.exists(p):
        with open(p) as f:
            transcript_data = json.load(f)
        try:
            audio_path = services.uploader.get_audio_path(req.job_id)
        except Exception:
            audio_path = None

    pending_voiceprints = []  # Accumulate embeddings in-memory; persist only after drift audit passes
    for label in req.labels:
        emb = None
        sample_start = None
        sample_end = None
        if audio_path and transcript_data:
            speaker_segs = [s for s in transcript_data if s.get("speaker") == label.speaker_id]
            if speaker_segs:
                # Multi-clip enrollment: average N evenly-spaced embeddings
                MAX_ENROLL_SEGMENTS = 5
                step = max(1, len(speaker_segs) // MAX_ENROLL_SEGMENTS)
                sampled_embs = []
                for i in range(0, len(speaker_segs), step):
                    if len(sampled_embs) >= MAX_ENROLL_SEGMENTS:
                        break
                    s = speaker_segs[i]
                    try:
                        seg_emb = await asyncio.to_thread(
                            services.vp_manager.extract_embedding, audio_path,
                            segment=(s["start"], s["end"]),
                        )
                        sampled_embs.append(seg_emb)
                    except Exception as e:
                        print(f"[api]   ⚠️  Could not extract embedding from segment: {e}")
                        continue
                if sampled_embs:
                    # Average and re-normalize
                    emb = np.mean(sampled_embs, axis=0)
                    emb = emb / np.linalg.norm(emb)
                    # Reference the middle segment for playback
                    mid_idx = len(sampled_embs) // 2
                    mid_seg = speaker_segs[min(mid_idx * step, len(speaker_segs) - 1)]
                    sample_start = mid_seg["start"]
                    sample_end = min(mid_seg["end"], sample_start + 3.0)
                    print(f"[api]   ✅ Extracted embedding for '{label.name}' ({label.speaker_id}) "
                          f"— averaged over {len(sampled_embs)} segment(s)")
                else:
                    # Fallback: try the longest segment
                    longest = max(speaker_segs, key=lambda s: s["end"] - s["start"])
                    sample_start = longest["start"]
                    sample_end = longest["end"]
                    try:
                        emb = await asyncio.to_thread(
                            services.vp_manager.extract_embedding, audio_path,
                            segment=(sample_start, sample_end),
                        )
                        print(f"[api]   ✅ Extracted embedding (fallback) for '{label.name}' ({label.speaker_id})")
                    except Exception as e:
                        print(f"[api]   ⚠️  Could not extract embedding for '{label.name}': {e}")

        pending_voiceprints.append({
            "name": label.name.strip(),
            "email": label.email or "",
            "embedding": emb,
            "spk": label.speaker_id,
            "sample_start": sample_start,
            "sample_end": sample_end,
        })

    # ── Drift audit: check for voice match conflicts across ALL jobs ──
    # Runs against EXISTING voiceprints in the DB — nothing from this
    # request is persisted yet, so re-submit after a rejection starts fresh.
    drift_entries = []
    for pvp in pending_voiceprints:
        spk = pvp["spk"]
        name = pvp["name"]
        email = pvp["email"]
        emb = pvp["embedding"]
        if emb is None:
            continue
        email_key = services.vp_manager._make_email(name, email)
        all_matches = await asyncio.to_thread(
            services.vp_manager.find_matching_voiceprints, emb,
            threshold=config.VOICEPRINT_THRESHOLD,
        )
        for m in all_matches:
            if m["name"].lower() == name.lower():
                continue
            drift_entries.append({
                "timestamp": datetime.utcnow().isoformat(),
                "job_id": req.job_id,
                "assigned_name": name,
                "assigned_email": email_key,
                "speaker_id": spk,
                "matched_name": m["name"],
                "matched_email": m["email"],
                "similarity": m["similarity"],
                "matched_sample_job_id": m.get("sample_job_id"),
            })

    if drift_entries:
        drift_log_path = os.path.join(config.STORAGE_PATH, req.job_id, "label-drift-audit.jsonl")
        try:
            with open(drift_log_path, "w") as f:
                for entry in drift_entries:
                    f.write(json.dumps(entry) + "\n")
            print(f"[api] ❌ Drift audit: {len(drift_entries)} conflict(s) — rejecting labels")
        except Exception as e:
            print(f"[api] ⚠️  Could not write drift audit log: {e}")
        first = drift_entries[0]
        raise HTTPException(
            409,
            detail={
                "error": "voice_match_conflict",
                "message": (
                    f"'{first['assigned_name']}' ({first['speaker_id']}) matches the enrolled "
                    f"voiceprint of '{first['matched_name']}' "
                    f"(similarity: {first['similarity']:.3f}, "
                    f"from job {first.get('matched_sample_job_id', '?')[:8]}). "
                    "Resolve the conflict and re-submit."
                ),
                "conflicts": drift_entries,
            },
        )

    # ── Batch-save voiceprints: audit passed, persist all pending embeddings ──
    for pvp in pending_voiceprints:
        services.vp_manager.save_voiceprint(
            pvp["name"], pvp["email"], pvp["embedding"],
            sample_job_id=req.job_id,
            sample_start=pvp["sample_start"],
            sample_end=pvp["sample_end"],
        )
        if pvp["embedding"] is not None:
            print(f"[api]   ✅ Saved voiceprint for '{pvp['name']}' ({pvp['spk']})")
        else:
            print(f"[api]   ✅ Saved voiceprint metadata for '{pvp['name']}' ({pvp['spk']}) — no embedding")

    if transcript_data:
        mapping = {l.speaker_id: l.name for l in req.labels}
        for seg in transcript_data:
            if seg["speaker"] in mapping:
                seg["speaker"] = mapping[seg["speaker"]]
        services.uploader.save_transcript(req.job_id, transcript_data)
        print(f"[api] Applied {len(names)} speaker label(s) to transcript")

    services.uploader.update_status(req.job_id, {"status": "labeled", "unknown_speakers": []})
    print(f"[api] POST /agent/label_speakers → done")
    return {"success": True, "applied_labels": len(req.labels)}


# ── Label Verification (Mitigation 1: voiceprint-backed label verification) ──

def _normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).lower()


def _build_voiceprint_reuse_warnings(entries, current_job_id, voiceprints):
    """Return advisory warnings for attendees whose voiceprint belongs to another job.

    This is intentionally non-blocking. It warns when an attendee entry matches an
    enrolled voiceprint whose sample reference comes from a different job than the
    current one, which indicates the person is being reused across meetings.
    """
    warnings = []
    normalized_entries = []
    for entry in (entries or []):
        name = (entry.get("name") if isinstance(entry, dict) else entry) or ""
        email = entry.get("email", "") if isinstance(entry, dict) else ""
        normalized_entries.append((name.strip(), email.strip()))

    for name, email in normalized_entries:
        if not name and not email:
            continue
        for vp in (voiceprints or []):
            vp_name = (vp.get("name") or "").strip()
            vp_email = (vp.get("email") or "").strip()
            sample_job_id = (vp.get("sample_job_id") or "").strip()
            if not sample_job_id:
                continue
            if sample_job_id == current_job_id:
                continue
            if not vp_name and not vp_email:
                continue
            if name and vp_name and _normalize_name(vp_name) == _normalize_name(name):
                warnings.append({
                    "type": "voiceprint_reused_from_other_job",
                    "name": name,
                    "email": email,
                    "existing_name": vp_name,
                    "existing_email": vp_email,
                    "sample_job_id": sample_job_id,
                    "message": (
                        f"'{name}' already has an enrolled voiceprint from job {sample_job_id[:8]} "
                        "and may be a reused attendee from another meeting."
                    ),
                })
                break
            if email and vp_email and _normalize_name(vp_email) == _normalize_name(email):
                warnings.append({
                    "type": "voiceprint_reused_from_other_job",
                    "name": name,
                    "email": email,
                    "existing_name": vp_name,
                    "existing_email": vp_email,
                    "sample_job_id": sample_job_id,
                    "message": (
                        f"'{email}' already has an enrolled voiceprint from job {sample_job_id[:8]} "
                        "and may be a reused attendee from another meeting."
                    ),
                })
                break
    return warnings


def _build_attendee_presence_warning(registered_attendees, speaker_labels):
    """Return a warning if an attendee was listed for the job but no label in the
    current audio matches them. This is advisory only and never blocks submission."""
    normalized_labels = {
        _normalize_name(label)
        for label in (speaker_labels or [])
        if _normalize_name(label)
    }
    for attendee in (registered_attendees or []):
        attendee_name = (attendee or "").strip()
        normalized_attendee = _normalize_name(attendee_name)
        if not normalized_attendee:
            continue
        if normalized_attendee not in normalized_labels:
            return {
                "type": "attendee_not_present_in_audio",
                "name": attendee_name,
                "message": (
                    f"'{attendee_name}' was listed as an attendee for this meeting, "
                    "but no speaker label in the current audio matched them."
                ),
            }
    return None


@router.post("/agent/verify-labels")
async def verify_labels(payload: dict = Body(...)):
    """Verify proposed speaker labels against enrolled voiceprints.

    Accepts {job_id, labels: [{speaker_id, name, email}]} and returns
    any voiceprint conflicts — i.e. labels whose assigned name doesn't
    match the voice of an existing enrolled voiceprint.

    The frontend uses this to show warnings before the user confirms.
    This endpoint does NOT save anything — it's purely advisory.

    Returns:
      {
        "verifications": [
          {speaker_id, assigned_name, voice_match_conflicts: [...],
           voice_drift_conflicts: [...]}
        ],
        "unregistered_names": [...],
        "registered_attendees": [...]
      }
    """
    job_id = payload.get("job_id", "")
    labels = payload.get("labels", [])

    if not job_id or not labels:
        raise HTTPException(400, "job_id and labels are required")

    print(f"[api] POST /agent/verify-labels job_id={job_id} labels={[l.get('name', '?') for l in labels]}")

    # Load diarization data to extract embeddings for verification
    diar_data = services.uploader.load_diarization(job_id)
    audio_path = None
    if diar_data and "speaker_segments" in diar_data:
        try:
            audio_path = services.uploader.get_audio_path(job_id)
        except Exception:
            audio_path = None

    # Load registered attendees for the job
    metadata = services.uploader.get_metadata(job_id)
    registered_attendees = metadata.get("attendees", [])

    verifications = []
    unregistered_names = []
    attendee_presence_warnings = []

    for label in labels:
        spk = label.get("speaker_id", "")
        name = label.get("name", "").strip()
        email = label.get("email", "").strip()
        if not spk or not name:
            continue

        # Check if name is registered
        if registered_attendees:
            is_registered = any(
                a.lower() == name.lower() for a in registered_attendees
            )
            if not is_registered:
                unregistered_names.append(name)

    warning = _build_attendee_presence_warning(
        registered_attendees,
        [label.get("name", "").strip() for label in labels if label.get("name", "").strip()],
    )
    if warning:
        attendee_presence_warnings.append(warning)

    for label in labels:
        spk = label.get("speaker_id", "")
        name = label.get("name", "").strip()
        email = label.get("email", "").strip()
        if not spk or not name:
            continue

        # Extract embedding and match against ALL voiceprints
        voice_match_conflicts = []
        voice_drift_conflicts = []
        if audio_path and diar_data and spk in diar_data.get("speaker_segments", {}):
            segs = diar_data["speaker_segments"][spk]
            MAX_ENROLL_SEGMENTS = 5
            step = max(1, len(segs) // MAX_ENROLL_SEGMENTS)
            sampled_embs = []
            for i in range(0, len(segs), step):
                if len(sampled_embs) >= MAX_ENROLL_SEGMENTS:
                    break
                s = segs[i]
                try:
                    seg_emb = await asyncio.to_thread(
                        services.vp_manager.extract_embedding, audio_path,
                        segment=(s["start"], s["end"]),
                    )
                    sampled_embs.append(seg_emb)
                except Exception:
                    continue

            if sampled_embs:
                emb = np.mean(sampled_embs, axis=0)
                emb = emb / np.linalg.norm(emb)

                # Find matches against ALL enrolled voiceprints
                matches = await asyncio.to_thread(
                    services.vp_manager.find_matching_voiceprints, emb,
                    threshold=config.VOICEPRINT_THRESHOLD,
                )

                # Report any match where the existing name differs from the assigned
                # name. If the names match (e.g. user clicked "Use ExistingName" via
                # inline resolution), always allow — it's an intentional adoption even
                # if the name isn't in this job's attendee list.
                #
                # If ANY enrolled voiceprint has the same name as the assigned name
                # (above threshold), the speaker is already correctly identified.
                # Short-circuit all other cross-match conflicts to avoid false
                # positives from secondary matches within the same audio.
                has_exact_name_match = any(
                    m["name"].lower() == name.lower()
                    for m in matches
                )
                if not has_exact_name_match and matches:
                    # Only the best match — secondary matches are cross-speaker noise
                    voice_match_conflicts.append(matches[0])

                # ── Own-print voice-drift detection ──
                # If the assigned name/email already has an enrolled voiceprint but
                # this meeting's voice does NOT match it (below threshold), flag it.
                # Otherwise label_and_resume would silently overwrite the enrolled
                # print on batch-save. This complements the cross-match check above:
                # that one reports "the voice is someone ELSE", this one reports
                # "this person's own enrolled print doesn't match the current voice".
                own_sim = services.vp_manager.similarity_to(name, emb)
                if own_sim is None and email:
                    own_sim = services.vp_manager.similarity_to(email, emb)
                if own_sim is not None and own_sim["similarity"] < config.VOICEPRINT_THRESHOLD:
                    voice_drift_conflicts.append({
                        "name": name,
                        "email": email,
                        "similarity": own_sim["similarity"],
                        "sample_job_id": own_sim["sample_job_id"],
                    })

        verifications.append({
            "speaker_id": spk,
            "assigned_name": name,
            "assigned_email": email,
            "voice_match_conflicts": voice_match_conflicts,
            "voice_drift_conflicts": voice_drift_conflicts,
        })

    print(f"[api] POST /agent/verify-labels → {len(verifications)} verifications, "
          f"{sum(len(v['voice_match_conflicts']) for v in verifications)} conflict(s), "
          f"{sum(len(v['voice_drift_conflicts']) for v in verifications)} drift(s), "
          f"{len(unregistered_names)} unregistered name(s)")
    return {
        "verifications": verifications,
        "unregistered_names": unregistered_names,
        "registered_attendees": registered_attendees,
        "attendee_presence_warnings": attendee_presence_warnings,
        "voiceprint_reuse_warnings": _build_voiceprint_reuse_warnings(
            labels,
            job_id,
            services.vp_manager.list_voiceprints(),
        ),
    }


@router.post("/voiceprints/check-conflicts")
async def check_voiceprint_conflicts(names: list = Body(...)):
    """Check if any of the given attendee names/emails already have voiceprints enrolled.

    Body: JSON array of {name, email?} objects
    Returns: {conflicts: [{name, email, existing_name, existing_email, sample_job_id}]}
    """
    conflicts = []
    for entry in names:
        name = entry.get("name", "").strip()
        email = entry.get("email", "").strip()
        if not name:
            continue
        existing = services.vp_manager.get_voiceprint(name)
        if not existing and email:
            existing = services.vp_manager.get_voiceprint(email)
        if existing:
            if existing["name"] != name:
                conflicts.append({
                    "name": name,
                    "email": email,
                    "existing_name": existing["name"],
                    "existing_email": existing["email"],
                    "sample_job_id": existing.get("sample_job_id"),
                })
    print(f"[api] POST /voiceprints/check-conflicts → {len(conflicts)} conflict(s)")
    return {"conflicts": conflicts}


@router.post("/attendees/check-conflicts")
async def check_attendee_conflicts(entries: list = Body(...)):
    """Check if any of the given attendee name/email combos conflict with
    existing entries in the attendee registry or voiceprint table.

    Body: JSON array of {name, email?} objects
    Returns: {conflicts: [{type, name, email, existing_name, existing_email, message}]}

    Conflict types detected:
      - attendee_name_mismatch: email exists under a different name
      - attendee_email_mismatch: name exists with a different email
      - voiceprint_name_mismatch: voiceprint exists under a different name (delegated)
    """
    conflicts = []
    warnings = []
    voiceprints = services.vp_manager.list_voiceprints()
    for entry in entries:
        name = entry.get("name", "").strip()
        email = entry.get("email", "").strip()
        if not name:
            continue

        # 1. Check attendee registry for email collisions
        if email:
            existing_atts = services.ephemeral_memory.query_attendees(name=email, limit=5)
            for att in existing_atts:
                if att["name"].lower() != name.lower() and att["email"].lower() == email.lower():
                    conflicts.append({
                        "type": "attendee_name_mismatch",
                        "name": name,
                        "email": email,
                        "existing_name": att["name"],
                        "existing_email": att["email"],
                        "message": f"Email {email} is registered under '{att['name']}', not '{name}'.",
                    })

        # 2. Check attendee registry for name with different email
        if name:
            existing_atts = services.ephemeral_memory.query_attendees(name=name, limit=5)
            for att in existing_atts:
                if att["name"].lower() == name.lower() and att["email"] and att["email"].lower() != email.lower():
                    # Only flag if they're entering a different email
                    if email and att["email"].lower() != email.lower():
                        conflicts.append({
                            "type": "attendee_email_mismatch",
                            "name": name,
                            "email": email,
                            "existing_name": att["name"],
                            "existing_email": att["email"],
                            "message": f"'{name}' is already registered with email '{att['email']}', not '{email}'.",
                        })

        # 3. Check voiceprint table (delegate to existing logic)
        existing_vp = services.vp_manager.get_voiceprint(name)
        if not existing_vp and email:
            existing_vp = services.vp_manager.get_voiceprint(email)
        if existing_vp and existing_vp["name"] != name:
            conflicts.append({
                "type": "voiceprint_name_mismatch",
                "name": name,
                "email": email,
                "existing_name": existing_vp["name"],
                "existing_email": existing_vp["email"],
                "message": f"Voiceprint for '{existing_vp['name']}' already exists with email '{existing_vp['email'] or 'none'}'. Entering as '{name}' will create a new voiceprint record.",
            })

    for entry in entries:
        warnings.extend(_build_voiceprint_reuse_warnings([entry], entry.get("current_job_id") or "", voiceprints))

    print(f"[api] POST /attendees/check-conflicts → {len(conflicts)} conflict(s)")
    return {"conflicts": conflicts, "warnings": warnings}


# ── Speaker Labeling (pause & resume) ──

@router.get("/transcribe/speaker_clips/{job_id}")
async def get_speaker_clips(job_id: str):
    """Return detected speakers with audio clip URLs for manual labeling.

    Only available when status is 'paused_for_labeling'. Returns each
    detected speaker with a playable audio clip URL so the user can
    hear who they are and assign a name.
    """
    s = services.uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] != "paused_for_labeling":
        raise HTTPException(409, f"Job is not paused for labeling (status={s['status']})")

    diar_data = services.uploader.load_diarization(job_id)
    if not diar_data or "speaker_segments" not in diar_data:
        raise HTTPException(500, "Diarization data not found for this job")

    speaker_segments = diar_data["speaker_segments"]
    audio_path = services.uploader.get_audio_path(job_id)
    metadata = services.uploader.get_metadata(job_id)
    attendee_names = metadata.get("attendees", [])
    attendee_emails_list = metadata.get("attendeeEmails", [])

    # ── Pass 1: Process all speakers, collecting voiceprint matches ──
    # We defer form-entry assignment to Pass 2 so we can match by voiceprint
    # identity rather than iteration order (which causes false A/B conflicts
    # when the diarization order doesn't match the attendee order).
    pending: list[dict] = []
    for spk, segs in speaker_segments.items():
        # Find the longest segment for a good sample clip
        longest = max(segs, key=lambda s: s["duration"])
        clip_duration = min(3.0, longest["duration"])
        clip_start = longest["start"]
        clip_end = clip_start + clip_duration

        # ── Use pre-computed voiceprint matches from pipeline if available ──
        suggested_name = ""
        suggested_email = ""
        voiceprint_confidence = 0.0
        voiceprint_matches = []  # All matches — exposed to frontend for proactive conflict display
        precomputed = s.get("voiceprint_matches_by_speaker", {})
        if spk in precomputed:
            voiceprint_matches = precomputed[spk]
            if voiceprint_matches:
                best = voiceprint_matches[0]
                if any(a.lower() == best["name"].lower() for a in attendee_names):
                    suggested_name = best["name"]
                    suggested_email = best.get("email", "")
                    voiceprint_confidence = best.get("similarity", 0.0)
        else:
            try:
                # Multi-clip average for robust embedding
                MAX_SAMPLE = 5
                step = max(1, len(segs) // MAX_SAMPLE)
                sampled_embs = []
                for i in range(0, len(segs), step):
                    if len(sampled_embs) >= MAX_SAMPLE:
                        break
                    s = segs[i]
                    seg_emb = await asyncio.to_thread(
                        services.vp_manager.extract_embedding, audio_path,
                        segment=(s["start"], s["end"]),
                    )
                    sampled_embs.append(seg_emb)
                if sampled_embs:
                    emb = np.mean(sampled_embs, axis=0)
                    emb = emb / np.linalg.norm(emb)
                    matches = await asyncio.to_thread(
                        services.vp_manager.find_matching_voiceprints, emb,
                        threshold=config.VOICEPRINT_THRESHOLD,
                    )
                    voiceprint_matches = [
                        {
                            "name": m["name"],
                            "email": m.get("email", ""),
                            "similarity": m["similarity"],
                            "sample_job_id": m.get("sample_job_id"),
                        }
                        for m in matches[:1]  # Only the best match — secondary matches are cross-speaker noise
                    ] if matches else []
                    if matches:
                        best = matches[0]
                        # Only pre-fill if the matched name is in this job's
                        # attendee list — otherwise it's a cross-context conflict
                        # that the user should resolve manually.
                        if any(a.lower() == best["name"].lower() for a in attendee_names):
                            suggested_name = best["name"]
                            suggested_email = best.get("email", "")
                            voiceprint_confidence = best["similarity"]
            except Exception as e:
                print(f"[speaker_clips] ⚠️  Voiceprint matching failed for {spk}: {e}")

        pending.append({
            "spk": spk,
            "segs": segs,
            "clip_start": clip_start,
            "clip_end": clip_end,
            "clip_duration": clip_duration,
            "longest": longest,
            "suggested_name": suggested_name,
            "suggested_email": suggested_email,
            "voiceprint_confidence": voiceprint_confidence,
            "voiceprint_matches": voiceprint_matches,
            # Tentative form entry — will be reassigned in Pass 2
            "form_entry_name": "",
            "form_entry_email": "",
        })

    # ── Pass 2: Assign form entries by voiceprint identity ──
    # For speakers whose voiceprint matched a registered attendee, use that
    # attendee's form entry (name + email) — this avoids false A/B conflicts
    # when the diarization iteration order differs from the attendee list order.
    used_form_indices: set[int] = set()
    for ps in pending:
        sn = ps["suggested_name"]
        if not sn:
            continue
        for fi, fn in enumerate(attendee_names):
            if fn.lower() == sn.lower() and fi not in used_form_indices:
                ps["form_entry_name"] = attendee_names[fi]
                ps["form_entry_email"] = attendee_emails_list[fi] if fi < len(attendee_emails_list) else ""
                used_form_indices.add(fi)
                break

    # ── Pass 3: Positional fallback for unmatched speakers ──
    # For speakers with no voiceprint match (or unregistered match), assign
    # remaining unused form entries positionally (preserving iteration order).
    free_indices = [i for i in range(len(attendee_names)) if i not in used_form_indices]
    fi_next = 0
    for ps in pending:
        if ps["form_entry_name"]:
            continue  # Already assigned by voiceprint identity
        if fi_next < len(free_indices):
            fi = free_indices[fi_next]
            ps["form_entry_name"] = attendee_names[fi]
            ps["form_entry_email"] = attendee_emails_list[fi] if fi < len(attendee_emails_list) else ""
            fi_next += 1
        # If no voiceprint match at all, use form entry as suggested name
        if not ps["suggested_name"] and ps["form_entry_name"]:
            ps["suggested_name"] = ps["form_entry_name"]
            ps["suggested_email"] = ps["form_entry_email"]

    # ── Pass 4: Build final output ──
    speakers = []
    for ps in pending:
        spk = ps["spk"]
        segs = ps["segs"]
        speakers.append({
            "speaker_id": spk,
            "segment_count": len(segs),
            "total_duration": sum(s["duration"] for s in segs),
            "sample_clip_url": f"/transcribe/audio/speaker_clip/{job_id}/{spk}/0",
            "sample_start": ps["clip_start"],
            "sample_end": ps["clip_end"],
            "suggested_name": ps["suggested_name"],
            "suggested_email": ps["suggested_email"],
            "form_entry_name": ps["form_entry_name"],
            "form_entry_email": ps["form_entry_email"],
            "voiceprint_confidence": round(ps["voiceprint_confidence"], 3),
            "voiceprint_matches": ps["voiceprint_matches"],
        })

    # Include non-speaking attendees from reconciliation data (if available)
    reconciliation = s.get("reconciliation", {})
    non_speaking = reconciliation.get("non_speaking_attendees", [])

    # ── Pre-ASR fallback: reconciliation hasn't run yet ──
    # The pipeline pauses for labeling right after diarization, BEFORE voiceprint
    # matching/reconciliation is computed. In that state the saved reconciliation
    # is empty, so derive non-speaking candidates from the form entries that were
    # NOT consumed by any detected speaker in Pass 2/3 above. This is a positional
    # heuristic (voiceprint identity isn't known until matching runs) — the modal's
    # keep/remove X buttons let the user correct it. When reconciliation IS saved
    # (post-ASR pause), that identity-based list wins and this fallback is skipped.
    if not non_speaking and attendee_names:
        leftover_indices = free_indices[fi_next:]
        non_speaking = [
            {
                "name": attendee_names[i],
                "email": attendee_emails_list[i] if i < len(attendee_emails_list) else "",
            }
            for i in leftover_indices
        ]

    attendee_emails = metadata.get("attendeeEmails", [])

    # Build full non-speaking attendee info with emails
    non_speaking_full = []
    for ns in non_speaking:
        ns_name = ns.get("name", ns) if isinstance(ns, dict) else ns
        ns_email = ""
        if isinstance(ns, dict):
            ns_email = ns.get("email", "")
        elif metadata.get("attendees"):
            idx = metadata["attendees"].index(ns_name) if ns_name in metadata["attendees"] else -1
            if idx >= 0 and idx < len(attendee_emails):
                ns_email = attendee_emails[idx]
        non_speaking_full.append({"name": ns_name, "email": ns_email})

    # ── Known-attendee registry (for the modal's "assign known attendee" dropdowns) ──
    # Two mutually-exclusive buckets:
    #   with_voiceprint    — registered attendees that have an enrolled voiceprint
    #   without_voiceprint — registered attendees with no enrolled voiceprint
    # Each entry is tagged `in_form` when the attendee is in this job's form,
    # so the modal can prefer the form email (the backend's email-mismatch
    # correction will force it anyway) over the enrolled email key.
    form_names_lower = {a.lower() for a in attendee_names}
    vp_rows = services.vp_manager.list_voiceprints()  # [{name, email, sample_job_id, ...}]
    vp_emails_lower = {v.get("email", "").lower() for v in vp_rows if v.get("email")}
    vp_names_lower = {v.get("name", "").lower() for v in vp_rows if v.get("name")}
    known_with_vp = [
        {
            "name": v.get("name", "").strip(),
            "email": v.get("email", ""),
            "sample_job_id": v.get("sample_job_id"),
            "in_form": v.get("name", "").strip().lower() in form_names_lower,
        }
        for v in vp_rows
        if v.get("name", "").strip()
    ]
    known_without_vp = []
    seen_no_vp = set()
    for att in services.ephemeral_memory.list_attendees(limit=500):
        aname = att.get("name", "").strip()
        if not aname:
            continue
        aemail = (att.get("email") or "").strip()
        if aemail.lower() in vp_emails_lower or aname.lower() in vp_names_lower:
            continue  # Already surfaced in the with_voiceprint bucket
        key = (aname.lower(), aemail.lower())
        if key in seen_no_vp:
            continue
        seen_no_vp.add(key)
        known_without_vp.append({
            "name": aname,
            "email": aemail,
            "in_form": aname.lower() in form_names_lower,
        })

    return {
        "job_id": job_id,
        "speakers": speakers,
        "total_speakers": len(speakers),
        "non_speaking_attendees": non_speaking_full,
        "known_attendees": {
            "with_voiceprint": known_with_vp,
            "without_voiceprint": known_without_vp,
        },
    }


@router.get("/transcribe/audio/speaker_clip/{job_id}/{speaker_id}/{clip_index}")
async def serve_speaker_clip(job_id: str, speaker_id: str, clip_index: int):
    """Serve a short audio clip for a detected speaker.

    Extracts ~3 seconds from the middle of the speaker's longest segment
    using ffmpeg, served as a WAV for in-browser playback.
    """
    diar_data = services.uploader.load_diarization(job_id)
    if not diar_data or "speaker_segments" not in diar_data:
        raise HTTPException(404, "Diarization data not found")

    speaker_segments = diar_data["speaker_segments"]
    if speaker_id not in speaker_segments:
        raise HTTPException(404, f"Speaker {speaker_id} not found")

    segs = speaker_segments[speaker_id]
    longest = max(segs, key=lambda s: s["duration"])
    audio_path = services.uploader.get_audio_path(job_id)

    clip_duration = min(3.0, longest["duration"])
    clip_start = longest["start"]
    clip_end = clip_start + clip_duration

    # Extract clip via ffmpeg to a temp file, serve it, then clean up
    fd, clip_path = _tf.mkstemp(suffix=f"_{speaker_id}.wav")
    os.close(fd)
    try:
        cmd = [
            resolve_ffmpeg(), "-y",
            "-i", audio_path,
            "-ss", str(clip_start),
            "-to", str(clip_end),
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", "16000",
            clip_path,
        ]
        _sp.run(cmd, check=True, capture_output=True, timeout=30)

        with open(clip_path, "rb") as f:
            wav_data = f.read()
    finally:
        try:
            os.unlink(clip_path)
        except OSError:
            pass

    return Response(content=wav_data, media_type="audio/wav",
                    headers={"Content-Disposition": f"inline; filename=\"{speaker_id}_clip.wav\""})


@router.post("/transcribe/label_and_resume/{job_id}")
async def label_and_resume(job_id: str, payload: dict = Body(...)):
    """Accept speaker labels from the user and resume the pipeline.

    Body: {labels: [{speaker_id, name, email?}], overwrite_names?: [str],
           excluded_non_speaking?: [str]}
    Saves voiceprints with actual audio embeddings, remaps speaker IDs,
    then continues the pipeline from diarization → ASR → alignment → agent.

    When overwrite_names is provided, the drift audit is skipped for those
    names, allowing the user to assign a different name to a known voice.

    excluded_non_speaking is a list of form-entry names that were never assigned
    to a speaker slot (A/B conflict losers the user resolved toward the existing
    voice owner, plus any non-speaking attendees the user removed in the labeling
    modal). Those names are dropped from the persisted attendee list, delivery
    recipients, and agent context.
    """
    try:
        s = services.uploader.get_status(job_id)
        if s["status"] == "not_found":
            raise HTTPException(404, "Job not found")
        if s["status"] != "paused_for_labeling":
            raise HTTPException(409, f"Job is not paused for labeling (status={s['status']})")

        labels = payload.get("labels", [])
        overwrite_names = payload.get("overwrite_names", [])
        excluded_non_speaking = payload.get("excluded_non_speaking", [])

        if not labels or not isinstance(labels, list):
            raise HTTPException(400, "Body must contain a 'labels' array of {speaker_id, name} objects")

        await _inner_label_and_resume(job_id, labels, overwrite_names, excluded_non_speaking)
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[api]   ❌ label_and_resume failed with exception:\n{tb}")
        raise HTTPException(500, f"label_and_resume failed: {e}")


async def _inner_label_and_resume(job_id: str, labels: list, overwrite_names: list = None,
                                  excluded_non_speaking: list = None):
    """Inner function — all the actual work, extracted so the async route
    handler has a clean try/except wrapper. Runs on the event loop; the heavy
    embedding extraction/matching is offloaded to worker threads via
    ``asyncio.to_thread`` so the loop stays responsive during labeling.

    Args:
        job_id: The job ID
        labels: List of {speaker_id, name, email} dicts
        overwrite_names: Optional list of names to skip drift audit for.
            When a name is in this list, the drift audit will not report
            conflicts for that label, allowing the user to assign a
            different name to a known voice.
        excluded_non_speaking: Optional list of form-entry names that were never
            assigned to a speaker slot (A/B conflict losers + user-removed
            non-speaking attendees). They are dropped from the persisted attendee
            list, delivery recipients, and agent context.
    """
    if overwrite_names is None:
        overwrite_names = []
    if excluded_non_speaking is None:
        excluded_non_speaking = []

    s = services.uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] != "paused_for_labeling":
        raise HTTPException(409, f"Job is not paused for labeling (status={s['status']})")

    if not labels or not isinstance(labels, list):
        raise HTTPException(400, "Body must be a JSON array of {speaker_id, name} objects")

    print(f"[api] POST /transcribe/label_and_resume/{job_id} labels={[l.get('name', '?') for l in labels]}")

    # Save voiceprints with actual audio embeddings
    diar_data = services.uploader.load_diarization(job_id)
    audio_path = services.uploader.get_audio_path(job_id)
    label_map = {}
    pending_voiceprints = []  # Accumulate embeddings in-memory; persist only after drift audit passes
    for label in labels:
        spk = label.get("speaker_id", "")
        name = label.get("name", "").strip()
        email = label.get("email", "").strip()
        if not spk or not name:
            continue
        label_map[spk] = {"name": name, "email": email}

        # Extract an actual embedding from this speaker's audio (don't persist yet)
        emb = None
        sample_start = None
        sample_end = None
        if diar_data and spk in diar_data.get("speaker_segments", {}):
            segs = diar_data["speaker_segments"][spk]
            # Multi-clip enrollment: average N evenly-spaced embeddings
            MAX_ENROLL_SEGMENTS = 5
            step = max(1, len(segs) // MAX_ENROLL_SEGMENTS)
            sampled_embs = []
            for i in range(0, len(segs), step):
                if len(sampled_embs) >= MAX_ENROLL_SEGMENTS:
                    break
                s = segs[i]
                try:
                    seg_emb = await asyncio.to_thread(
                        services.vp_manager.extract_embedding, audio_path,
                        segment=(s["start"], s["end"]),
                    )
                    sampled_embs.append(seg_emb)
                except Exception as e:
                    print(f"[api]   ⚠️  Could not extract embedding from segment: {e}")
                    continue
            if sampled_embs:
                # Average and re-normalize for a robust composite embedding
                emb = np.mean(sampled_embs, axis=0)
                emb = emb / np.linalg.norm(emb)
                # Reference the middle segment for playback
                mid_idx = len(sampled_embs) // 2
                mid_seg = segs[min(mid_idx * step, len(segs) - 1)]
                sample_start = mid_seg["start"]
                sample_end = min(mid_seg["end"], sample_start + 3.0)
                print(f"[api]   ✅ Extracted embedding for '{name}' ({spk}) — "
                      f"averaged over {len(sampled_embs)} segment(s)")
            else:
                # Fallback: use the longest segment
                longest = max(segs, key=lambda s: s["duration"])
                try:
                    emb = await asyncio.to_thread(
                        services.vp_manager.extract_embedding, audio_path,
                        segment=(longest["start"], longest["end"]),
                    )
                    sample_start = longest["start"]
                    sample_end = min(longest["end"], sample_start + 3.0)
                    print(f"[api]   ✅ Extracted embedding (fallback) for '{name}' ({spk})")
                except Exception as e:
                    print(f"[api]   ⚠️  Could not extract embedding for '{name}': {e}")

        pending_voiceprints.append({
            "name": name,
            "email": email,
            "embedding": emb,
            "spk": spk,
            "sample_start": sample_start,
            "sample_end": sample_end,
        })

    # ── Cross-job drift audit (Mitigation 2: detect labeling inconsistencies) ──
    # Run the audit against EXISTING voiceprints in the DB — nothing from this
    # request has been persisted yet, so there are no stale prints to cause
    # false-positive conflicts on re-submit after a rejection.
    # Load saved reconciliation to identify unregistered voiceprints that may
    # need cleanup during overwrite — prevents accidental deletion of
    # non-conflicting speakers' voiceprints (Bug C guard).
    saved_reconciliation = s.get("reconciliation", {})
    saved_vp_matches = s.get("voiceprint_matches_by_speaker", {})
    drift_entries = []
    for pvp in pending_voiceprints:
        spk = pvp["spk"]
        name = pvp["name"]
        email = pvp["email"]
        emb = pvp["embedding"]
        if emb is None:
            print(f"[drift] ⚠️  '{name}' ({spk}) has no embedding — skipping")
            continue

        # Skip drift audit for names the user explicitly wants to overwrite
        if name in overwrite_names:
            print(f"[drift] ➡️  '{name}' ({spk}) in overwrite_names — skipping drift audit")
            # ── Deterministic overwrite cleanup ──
            # When the user chose "Use form entry", the old voiceprint (from a
            # previous job) for this speaker slot must be deleted unconditionally.
            # Uses saved pipeline match data (voiceprint_matches_by_speaker) when
            # available; falls back to re-running embedding comparison when the
            # pipeline paused pre-ASR (before voiceprint matching ran).
            spk_matches = saved_vp_matches.get(spk, [])
            print(f"[drift] 🔎 Cleanup for '{name}': saved_vp_matches for "
                  f"{spk} returned {len(spk_matches)} match(es)")

            # Resolve the old voiceprint to delete: either from saved match data
            # or by re-running embedding comparison.
            old_matches = list(spk_matches)  # shallow copy
            if not old_matches and emb is not None:
                old_matches = await asyncio.to_thread(
                    services.vp_manager.find_matching_voiceprints, emb,
                    threshold=config.VOICEPRINT_THRESHOLD,
                )

            deleted_any = False
            for old_match in old_matches:
                old_name = old_match.get("name", "")
                if not old_name or old_name.lower() == name.lower():
                    continue
                # Delete voiceprint unconditionally — user chose to overwrite
                deleted_rows = services.vp_manager.delete_voiceprint_by_name(old_name)
                if deleted_rows == 0 and old_match.get("email"):
                    print(f"[drift] ⚠️  delete by name '{old_name}' "
                          f"returned 0 rows — falling back to email "
                          f"'{old_match['email']}'")
                    services.vp_manager.delete_voiceprint(old_match["email"])
                # Also clean up the stale attendee record
                try:
                    services.ephemeral_memory.delete_attendee_by_name(old_name)
                except Exception as e:
                    print(f"[drift] ⚠️  Could not delete attendee "
                          f"'{old_name}': {e}")
                source = "pipeline match" if spk_matches else "fallback match"
                print(f"[drift] 🗑️  Deleted old voiceprint '{old_name}' — "
                      f"re-labeled as '{name}' ({source})")
                deleted_any = True
                break  # Only the first (best) match

            if not deleted_any:
                print(f"[drift] ℹ️  No old voiceprint deleted for '{name}' — "
                      f"no conflicting match found")
            continue

        email_key = services.vp_manager._make_email(name, email)
        # Match against ALL existing enrolled voiceprints
        all_matches = await asyncio.to_thread(
            services.vp_manager.find_matching_voiceprints, emb,
            threshold=config.VOICEPRINT_THRESHOLD,
        )
        # If ANY enrolled voiceprint has the same name as the assigned name
        # (above threshold), the speaker is already correctly identified.
        # Short-circuit all drift checks to avoid false positives from
        # secondary cross-matches within the same audio.
        has_exact_name_match = any(
            m["name"].lower() == name.lower()
            for m in all_matches
        )
        if has_exact_name_match:
            cross_count = sum(1 for m in all_matches if m["name"].lower() != name.lower())
            print(f"[drift] ✅ '{name}' ({spk}) matches its own voiceprint — "
                  f"no drift (suppressed {cross_count} cross-match(es))")
            continue

        for m in all_matches:
            if m["name"].lower() == name.lower():
                # Same name — user is intentionally adopting the existing
                # voiceprint name, even if it wasn't in the original job's
                # attendee list. Always allow this — no drift.
                continue
            entry = {
                "timestamp": datetime.utcnow().isoformat(),
                "job_id": job_id,
                "assigned_name": name,
                "assigned_email": email_key,
                "speaker_id": spk,
                "matched_name": m["name"],
                "matched_email": m["email"],
                "similarity": m["similarity"],
                "matched_sample_job_id": m.get("sample_job_id"),
            }
            drift_entries.append(entry)
            print(f"[drift] ⚠️  '{name}' ({spk}) matches voice of '{m['name']}' "
                  f"(sim={m['similarity']:.3f}) from job "
                  f"{m.get('sample_job_id', '?')[:8]})")
            break  # Only the best different-name match — secondary matches are cross-speaker noise

    if drift_entries:
        drift_log_path = os.path.join(config.STORAGE_PATH, job_id, "label-drift-audit.jsonl")
        try:
            with open(drift_log_path, "w") as f:
                for entry in drift_entries:
                    f.write(json.dumps(entry) + "\n")
            print(f"[drift] ✅ Drift audit written ({len(drift_entries)} entry/entries) to {drift_log_path}")
        except Exception as e:
            print(f"[drift] ⚠️  Could not write drift audit log: {e}")

        # ❌ Gating: reject conflicting labels instead of silently proceeding.
        # The caller (bot or UI) must resolve the conflict and re-submit.
        # Nothing was persisted to the DB — re-submit will start fresh.
        first = drift_entries[0]
        raise HTTPException(
            409,
            detail={
                "error": "voice_match_conflict",
                "message": (
                    f"'{first['assigned_name']}' ({first['speaker_id']}) matches the enrolled "
                    f"voiceprint of '{first['matched_name']}' "
                    f"(similarity: {first['similarity']:.3f}, "
                    f"from job {first.get('matched_sample_job_id', '?')[:8]}). "
                    "Resolve the conflict and re-submit."
                ),
                "conflicts": drift_entries,
            },
        )

    # ── Cross-check label emails against metadata attendeeEmails ──
    # If a label has an email that differs from what the job metadata knows
    # for that attendee, the frontend likely assigned the wrong email via
    # positional alignment. Use the metadata-correct value instead to prevent
    # email collisions in the voiceprint DB.
    metadata = services.uploader.get_metadata(job_id)
    attendee_email_map = metadata.get("attendeeEmails", {})
    if isinstance(attendee_email_map, list):
        # Initial upload stores attendeeEmails as a list positionally aligned
        # with attendees[]. Convert to dict keyed by name for lookup.
        names = metadata.get("attendees", [])
        attendee_email_map = dict(zip(names, attendee_email_map))
    for pvp in pending_voiceprints:
        expected_email = attendee_email_map.get(pvp["name"], "")
        if expected_email and pvp["email"] and pvp["email"] != expected_email:
            print(f"[label_and_resume] ⚠️  Email mismatch for '{pvp['name']}': "
                  f"label says '{pvp['email']}', metadata has '{expected_email}'. "
                  f"Using metadata value.")
            pvp["email"] = expected_email

    # ── Batch-save voiceprints: audit passed, persist all pending embeddings ──
    # Note: save_voiceprint() internally calls conn.commit() for each save,
    # so SQLite savepoints are NOT used here — they'd be immediately
    # committed away. Each save is atomic on its own.
    #
    # Voiceprint enrollment is EXCLUSIVELY for labeled speakers (pending_voiceprints
    # is built only from the `labels` payload). Non-speaking attendees are never
    # passed to save_voiceprint, so they cannot end up in the voiceprint DB.
    print(f"[drift] 💾 Batch-saving {len(pending_voiceprints)} voiceprint(s)...")
    _dump_all_voiceprints("BEFORE batch save")
    for pvp in pending_voiceprints:
        # DIAGNOSTIC: check if a row already exists for this name/email
        try:
            _conn2 = services.vp_manager._get_conn()
            _before = _conn2.execute(
                "SELECT id, speaker_name, email FROM voiceprints "
                "WHERE speaker_name=? OR email=?",
                (pvp["name"], pvp["email"])
            ).fetchall()
            if _before:
                print(f"[drift]   🔎 Pre-save check '{pvp['name']}': "
                      f"existing row(s) = {[dict(id=r[0], name=r[1], email=r[2]) for r in _before]}")
            else:
                print(f"[drift]   🔎 Pre-save check '{pvp['name']}': no existing row — will INSERT")
        except Exception as e:
            print(f"[drift]   ⚠️  Pre-save check error: {e}")

        services.vp_manager.save_voiceprint(
            pvp["name"], pvp["email"], pvp["embedding"],
            sample_job_id=job_id,
            sample_start=pvp["sample_start"],
            sample_end=pvp["sample_end"],
        )
        if pvp["embedding"] is not None:
            print(f"[api]   ✅ Saved voiceprint for '{pvp['name']}' ({pvp['spk']})")
        else:
            print(f"[api]   ✅ Saved voiceprint metadata for '{pvp['name']}' ({pvp['spk']}) — no embedding")

    # Log final voiceprint count in DB after batch save
    try:
        final_count = services.vp_manager._get_conn().execute(
            "SELECT COUNT(*) FROM voiceprints"
        ).fetchone()[0]
        print(f"[drift] 📊 Voiceprint DB record count after save: {final_count}")
    except Exception as e:
        print(f"[drift] ⚠️  Could not read voiceprint count: {e}")

    _dump_all_voiceprints("AFTER batch save")

    # Determine how to proceed based on labeling phase
    labeling_phase = s.get("labeling_phase", "pre_asr")

    if labeling_phase == "post_asr":
        # ASR + alignment already done — just remap speaker names in the
        # existing transcript and enqueue for the agent runner.
        p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
        if os.path.exists(p):
            with open(p) as f:
                transcript = json.load(f)
            mapping = {spk: info["name"] for spk, info in label_map.items()}
            for seg in transcript:
                if seg["speaker"] in mapping:
                    seg["speaker"] = mapping[seg["speaker"]]
            services.uploader.save_transcript(job_id, transcript)
            services.uploader.save_transcript_text(job_id, transcript)
            aligned = transcript
        else:
            aligned = []

        metadata = services.uploader.get_metadata(job_id)
        skip = metadata.get("skip_steps")
        state.update_active(job_id, "ready_for_agent", 0.95)

        # Build reconciliation from user labels + saved pre-labeling state
        # At this point all speakers should be known (user labeled them all)
        saved_reconciliation = s.get("reconciliation", {})
        matched_speakers = saved_reconciliation.get("matched_speakers", [])
        non_speaking = saved_reconciliation.get("non_speaking_attendees", [])
        saved_unregistered = saved_reconciliation.get("unregistered_speakers", [])

        # Add newly labeled speakers to the matched list
        for spk, info in label_map.items():
            matched_speakers.append({
                "name": info["name"],
                "email": info.get("email", ""),
                "speaker_id": spk,
                "confidence": 1.0,  # User-confirmed
            })

        # Remove newly-labeled speakers from the non-speaking list,
        # since they were just identified as speakers by the user.
        # Without this, the agent runner receives them as "present but
        # did not speak" even though the transcript has their segments
        # (Bug A fix).
        labeled_names = {info["name"].lower() for info in label_map.values()}
        non_speaking = [ns for ns in non_speaking if ns["name"].lower() not in labeled_names]

        # Drop form entries the user excluded (A/B conflict losers + X'd
        # non-speaking attendees). These names were never assigned to a speaker
        # slot, so they were not in the audio — they must not appear in the
        # meeting record or delivery recipients.
        kept_ns, removed_ns = _split_excluded_non_speaking(non_speaking, excluded_non_speaking)
        if removed_ns:
            print(f"[label_and_resume] 🗑️ Excluded {len(removed_ns)} non-speaking attendee(s) "
                  f"({[r.get('name') for r in removed_ns]}) — dropped from meeting record + delivery")
        non_speaking = kept_ns

        # Build the consolidated attendee list:
        # 1. All matched speakers (from reconciled labels + user labels)
        # 2. Non-speaking attendees (from form, silent)
        # 3. Unregistered voiceprint owners who were kept via "Use voice owner"
        #    and aren't already in the list from steps 1-2.
        # The dedup via dict.fromkeys preserves insertion order and removes
        # duplicates that arise when the same name appears in both the saved
        # reconciliation and the user's labels.
        all_attendee_names = list(dict.fromkeys(
            [s["name"] for s in matched_speakers] +
            [ns["name"] for ns in non_speaking]
        ))

        # ── Remove overwritten unregistered speakers from the attendee list ──
        # The saved reconciliation includes old voiceprint owners (e.g. A, C) in
        # matched_speakers when unregistered voiceprint matches were found during
        # the pipeline. When the user chooses "Use form entry" for a conflicted
        # speaker, the overwrite cleanup deletes the old voiceprint + attendee
        # record, but the old name STILL appears in `all_attendee_names` because
        # it was baked into `matched_speakers` before the cleanup ran.
        # Without this filter, the attendee registry ends up with both the old
        # and new names side by side — giving 6 records instead of 4 (Bug D fix).
        overwritten_unregistered = set()
        for us in saved_unregistered:
            existing_vp = services.vp_manager.get_voiceprint(us["name"])
            if existing_vp is None:
                overwritten_unregistered.add(us["name"])
        if overwritten_unregistered:
            print(f"[label_and_resume] 🧹 Removing overwritten unregistered "
                  f"speakers from attendee list: {overwritten_unregistered}")
            all_attendee_names = [
                n for n in all_attendee_names
                if n not in overwritten_unregistered
            ]

        # Include unregistered speakers kept via "Use voice owner" choice.
        # These names were in voiceprints from previous jobs but NOT in the
        # new job form. If the user chose to keep them, add them to the
        # attendee list so they appear in the meeting record and delivery.
        # Uses voiceprint-exists check instead of overwrite_names containment
        # because overwrite_names contains form names, not voiceprint owner
        # names (Bug B fix).
        all_attendee_names_lower = {n.lower() for n in all_attendee_names}
        for us in saved_unregistered:
            if us["name"].lower() not in all_attendee_names_lower:
                # Check if this voiceprint was deleted by the overwrite cleanup.
                # If the user chose "Use form entry" for a conflicting speaker,
                # their old voiceprint was removed — don't re-add them.
                existing_vp = services.vp_manager.get_voiceprint(us["name"])
                if existing_vp is None:
                    print(f"[label_and_resume] Skipping '{us['name']}' — "
                          f"voiceprint was deleted via overwrite cleanup")
                    continue
                all_attendee_names.append(us["name"])
                all_attendee_names_lower.add(us["name"].lower())

        all_attendee_emails = []
        for name in all_attendee_names:
            raw_email = next(
                (s.get("email", "") for s in matched_speakers if s["name"] == name),
                next((ns.get("email", "") for ns in non_speaking if ns["name"] == name),
                     next((us.get("email", "") for us in saved_unregistered if us["name"] == name), ""))
            )
            # Resolve empty email against voiceprint so the attendee
            # registry key matches the voiceprint key
            all_attendee_emails.append(
                _resolve_attendee_email(name, raw_email)
            )

        try:
            services.ephemeral_memory.register_attendees(
                all_attendee_names, all_attendee_emails,
                source="manual_labeling", job_id=job_id,
                non_speaking={ns["name"] for ns in non_speaking},
            )
            print(f"[label_and_resume] Registered {len(all_attendee_names)} attendee(s) "
                  f"({len(matched_speakers)} spoke, {len(non_speaking)} non-speaking) "
                  f"after labeling")
            # Dedup sweep: remove duplicate attendee rows by name (keep most recent)
            _dedup_attendees(job_id)
        except Exception as e:
            print(f"[label_and_resume] ⚠️  Could not register attendees: {e}")

        # ── Persist reconciled attendee list back to metadata.json ──
        # The original metadata.json (from upload) only has the pre-labeling
        # attendee list. After labeling, unknown speakers become named attendees
        # with real emails. Without this update, enqueue_ready, approve_gate1,
        # and /agent/deliver all read the stale metadata — missing newly labeled
        # attendees. The result: they never get an email delivery.
        metadata["attendees"] = all_attendee_names
        metadata["attendeeEmails"] = dict(zip(all_attendee_names, all_attendee_emails))
        # Persist kept non-speaking attendees (present but silent) so results and
        # delivery selection can annotate them. Excluded ones were already dropped
        # from `non_speaking` above.
        metadata["non_speaking_attendees"] = [ns["name"] for ns in non_speaking]
        # Merge new real emails into email_recipients (skip @voiceprint.local
        # placeholders — those are voiceprint-only keys, not delivery addresses)
        # Only add emails from matched speakers and unregistered speakers, NOT
        # from non-speaking attendees — they were present but shouldn't auto-receive
        # delivery unless they were already in the original email_recipients.
        existing_recipients = set(e.lower() for e in metadata.get("email_recipients", []) if e)
        for s in matched_speakers:
            e = _resolve_attendee_email(s["name"], s.get("email", ""))
            if e and "@voiceprint.local" not in e:
                existing_recipients.add(e.lower())
        for us in saved_reconciliation.get("unregistered_speakers", []):
            # Skip if this voiceprint was deleted (overwritten by user choice)
            existing_vp = services.vp_manager.get_voiceprint(us["name"])
            if existing_vp is None:
                continue
            e = _resolve_attendee_email(us["name"], us.get("email", ""))
            if e and "@voiceprint.local" not in e:
                existing_recipients.add(e.lower())
        # Prune delivery recipients for excluded non-speaking attendees — their
        # emails were captured in the original form email_recipients, but they
        # were never in the audio, so they must not receive the summary.
        retained_emails = {e.lower() for e in all_attendee_emails}
        _prune_excluded_emails(existing_recipients, removed_ns, retained_emails)
        # Deterministic email_recipients ordering (same as _update_metadata_with_reconciliation).
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
            print(f"[label_and_resume] ✅ Updated metadata.json with {len(all_attendee_names)} reconciled attendee(s) "
                  f"({len(metadata['email_recipients'])} delivery recipients)")
        except Exception as e:
            print(f"[label_and_resume] ⚠️  Could not persist reconciled metadata: {e}")

        # Persist ML pipeline completion stats
        try:
            total_chars = sum(len(s.get("text", "")) for s in aligned)
            services.ephemeral_memory.upsert_job(job_id, {
                "transcript_segment_count": len(aligned),
                "transcript_char_count": total_chars,
                "audio_duration_sec": aligned[-1]["end"] if aligned else None,
            })
        except Exception as e:
            print(f"[label_and_resume] Warning: could not update job record: {e}")

        non_speaking_names = [ns["name"] for ns in non_speaking]

        # ── Gate 1: Raw Transcript Review (after labeling, before enqueue) ──
        if config.GATE_RAW_REVIEW_ENABLED:
            services.uploader.update_status(job_id, {"status": "pending_raw_review", "progress": 0.95})
            print(f"[label_and_resume] ⏸️  Gate 1 active — pausing for raw transcript review after labeling")
            state.update_active(job_id, "pending_raw_review", 0.95)
            return {"job_id": job_id, "status": "pending_raw_review", "applied_labels": len(label_map)}

        services.agent_bridge.enqueue_ready(
            job_id, aligned, metadata, skip_steps=skip,
            non_speaking_attendees=non_speaking_names,
        )
        result = {"job_id": job_id, "status": "ready_for_agent", "applied_labels": len(label_map)}
        if drift_entries:
            result["voice_match_conflicts"] = drift_entries
        return result
    else:
        # Pre-ASR (diarization only) — run full resumed pipeline (ASR → alignment → agent)
        state.start_resumed_pipeline(job_id, label_map, excluded_non_speaking)
        result = {"job_id": job_id, "status": "resuming", "applied_labels": len(label_map)}
        if drift_entries:
            result["voice_match_conflicts"] = drift_entries
        return result
