"""Agent-facing routes — Phase 3d extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by main.lifespan() before any request).
"""

import json
import os
import subprocess as _sp
import tempfile as _tf

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from config import config
from models import RefineRequest, SummarizeRequest, AnalysisRequest, Deliverable
from refinement import _auto_refine
from upload import resolve_ffmpeg

import services

router = APIRouter()


# ── Agent-facing endpoints ──

@router.post("/agent/refine")
async def agent_refine(req: RefineRequest):
    print(f"[api] POST /agent/refine job_id={req.job_id} rules={req.rules} keep_timestamps={req.keep_timestamps}")
    # If no transcript was passed in the request (e.g. the LLM tool schema
    # doesn't include it), read the existing stored transcript instead.
    if req.transcript:
        transcript = [s.dict() for s in req.transcript]
    else:
        p = os.path.join(config.STORAGE_PATH, req.job_id, "transcript.json")
        if os.path.exists(p):
            with open(p) as f:
                transcript = json.load(f)
        else:
            transcript = []

    refined = _auto_refine(transcript, req.rules, req.keep_timestamps)

    services.uploader.save_transcript(req.job_id, refined)
    services.uploader.update_status(req.job_id, {"status": "refined"})
    print(f"[api] POST /agent/refine → refined {len(refined)} segments " +
          ("" if req.keep_timestamps else "(timestamps stripped, ") +
          f"fillers removed, PII redacted" +
          (f", +{len(req.rules)} custom rule(s)" if req.rules else "") + ")")
    return {"transcript": refined}


@router.post("/agent/summarize")
async def agent_summarize(req: SummarizeRequest):
    print(f"[api] POST /agent/summarize job_id={req.job_id}")
    services.uploader.save_summary(req.job_id, req.summary)
    services.uploader.update_status(req.job_id, {"status": "summarized"})
    summary_type = type(req.summary).__name__
    items = len(req.summary.get("action_items", [])) if isinstance(req.summary, dict) else 0
    print(f"[api] POST /agent/summarize → summary saved ({summary_type}, {items} action items)")
    return {"summary": req.summary}


@router.post("/agent/analyze")
async def agent_analyze(req: AnalysisRequest):
    """Store LLM-generated analysis of the transcript.

    The analysis can include:
      - topics: list of topics discussed
      - sentiment: overall sentiment or per-speaker sentiment
      - key_entities: names, dates, amounts mentioned
      - effectiveness: meeting effectiveness score/notes
      - follow_ups: questions or items that need future discussion
    """
    print(f"[api] POST /agent/analyze job_id={req.job_id}")
    services.uploader.save_analysis(req.job_id, req.analysis)
    services.uploader.update_status(req.job_id, {"status": "analyzed"})
    topics = req.analysis.get("topics", [])
    print(f"[api] POST /agent/analyze → analysis saved (topics: {len(topics)})")
    return {"analysis": req.analysis}


@router.get("/agent/voiceprints")
async def agent_list_voiceprints():
    vps = services.vp_manager.list_voiceprints()
    print(f"[api] GET /agent/voiceprints → {len(vps)} enrolled")
    return {"voiceprints": vps}


@router.delete("/agent/voiceprints/{email}")
async def agent_delete_voiceprint(email: str):
    """Delete a voiceprint by email. Returns success even if not found."""
    print(f"[api] DELETE /agent/voiceprints/{email}")
    services.vp_manager.delete_voiceprint(email)
    return {"success": True, "email": email}


@router.get("/agent/voiceprints/sample/{email}")
async def agent_voiceprint_sample(email: str):
    """Serve a sample audio clip for a voiceprint.

    Looks up the voiceprint's stored sample_job_id + sample_start/end,
    extracts the clip from that job's audio file using ffmpeg, and returns
    it as a WAV for in-browser playback.
    """
    vps = services.vp_manager.list_voiceprints()
    vp = next((v for v in vps if v["email"] == email), None)
    if not vp or not vp.get("sample_job_id"):
        raise HTTPException(404, "No sample audio available for this voiceprint")

    job_id = vp["sample_job_id"]
    seg_start = vp["sample_start"]
    seg_end = vp["sample_end"]

    audio_path = services.uploader.get_audio_path(job_id)
    if not os.path.exists(audio_path):
        raise HTTPException(404, "Source audio file not found")

    clip_duration = min(8.0, seg_end - seg_start)
    clip_start = seg_start

    with _tf.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        _sp.run([
            resolve_ffmpeg(), "-y",
            "-ss", str(clip_start),
            "-t", str(clip_duration),
            "-i", audio_path,
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            tmp_path,
        ], capture_output=True, timeout=30, check=True)

        with open(tmp_path, "rb") as f:
            wav_data = f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return Response(
        content=wav_data,
        media_type="audio/wav",
        headers={"Content-Disposition": f"inline; filename=\"{email}_sample.wav\""},
    )


@router.post("/agent/deliver")
async def agent_deliver(req: Deliverable):
    print(f"[api] POST /agent/deliver job_id={req.job_id} destinations={req.destinations} emails={req.email_recipients}")

    # Merge job-specific email recipients with config-level default recipients.
    # Config recipients come from DELIVERY_RECIPIENT_EMAILS env var (set via ConfigPanel).
    config_recipients = os.environ.get("DELIVERY_RECIPIENT_EMAILS", "")
    config_emails = [e.strip() for e in config_recipients.split(",") if e.strip()] if config_recipients else []

    # Also try to read job-level data from stored metadata
    title = req.title
    attendees = req.attendees
    job_emails = req.email_recipients or []
    recipient_source = "llm + metadata"
    try:
        meta_path = os.path.join(config.STORAGE_PATH, req.job_id, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)
            if not title:
                title = meta.get("title", "")
            if not attendees:
                attendees = meta.get("attendees", [])
            stored_emails = meta.get("email_recipients", [])
            if stored_emails:
                job_emails = list(set(list(job_emails) + stored_emails))
    except Exception:
        pass

    # ── Custom delivery per meeting ──
    # When CUSTOM_DELIVERY_PER_MEETING is enabled, the user selected which attendees
    # receive the email at the delivery review (Gate 2). That selection is persisted
    # to recipient-selection.json and takes precedence over the LLM-chosen recipients
    # and the upload-time attendee emails. Config default recipients
    # (DELIVERY_RECIPIENT_EMAILS) are ALWAYS appended regardless of the selection.
    if config.CUSTOM_DELIVERY_PER_MEETING:
        selection_path = os.path.join(config.STORAGE_PATH, req.job_id, "recipient-selection.json")
        if os.path.exists(selection_path):
            try:
                with open(selection_path) as f:
                    selection = json.load(f)
                selected = selection.get("recipients", []) or []
                if isinstance(selected, list):
                    job_emails = [str(e).strip() for e in selected if str(e).strip()]
                    recipient_source = "recipient-selection.json (Gate 2)"
            except Exception as e:
                print(f"[api] ⚠️  Could not read recipient-selection.json: {e} — falling back to all attendees")
    print(f"[api] POST /agent/deliver recipient_source={recipient_source}")

    # Deduplicate while preserving order
    seen = set()
    all_recipients = []
    for email in config_emails + job_emails:
        if email.lower() not in seen:
            seen.add(email.lower())
            all_recipients.append(email)

    package = {
        "job_id": req.job_id, "title": title,
        "attendees": attendees, "destinations": req.destinations,
        "email_recipients": all_recipients,
        "email_subject": os.environ.get("DELIVERY_EMAIL_SUBJECT", "Meeting Summary: {title}"),
        "email_additional_content": os.environ.get("DELIVERY_EMAIL_ADDITIONAL_CONTENT", ""),
        "drive_folder": os.environ.get("DELIVERY_DRIVE_FOLDER", "Meeting Transcripts"),
        "status": "ready_for_delivery",
    }
    with open(os.path.join(config.STORAGE_PATH, req.job_id, "delivery.json"), "w") as f:
        json.dump(package, f, indent=2)
    print(f"[api] POST /agent/deliver → delivery.json written (merged {len(all_recipients)} recipients: {config_emails} config + {job_emails} job)")
    return package
