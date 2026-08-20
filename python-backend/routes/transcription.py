"""Transcription route handlers — Phase 3a extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by services/lifespan.py before any request), and
pipeline state via the shared ``state`` singleton from pipeline_state.py.
"""

import json
import os
from pathlib import Path

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from config import config
from constants import ML_UPLOAD_BLOCKING_STATUSES
from models import UploadByPathRequest
from pipeline_state import state

import services

router = APIRouter()


# ── Config snapshot helper ──

def _build_config_snapshot(metadata: dict) -> dict:
    """Build a JSON-serializable config snapshot from current system config + per-job metadata.

    Captures everything from the Config Panel at the time the job was created.
    Sensitive values (API keys, tokens) are intentionally excluded — shown as
    "[set]" / "[not set]" in the UI.
    """
    # Helper: check if an env var is set without revealing its value
    def check(key: str) -> str:
        val = os.getenv(key, "")
        return "[set]" if val and val.strip() else "[not set]"

    snapshot = {
        # ── Python backend config (from config.py) ──
        "whisper_model_size": config.WHISPER_MODEL_SIZE,
        "diarization_model": config.DIARIZATION_MODEL,
        "embedding_model": config.EMBEDDING_MODEL,
        "embedding_provider": config.EMBEDDING_PROVIDER,
        "device": config.DEVICE,
        "platform": config.PLATFORM,
        "voiceprint_threshold": config.VOICEPRINT_THRESHOLD,
        "keep_transcript_timestamps": config.KEEP_TRANSCRIPT_TIMESTAMPS,
        "max_concurrent_pipelines": config.MAX_CONCURRENT_PIPELINES,
        "default_skip_steps": config.DEFAULT_SKIP_STEPS,

        # ── Python env vars (config panel values, redacted) ──
        "hugging_face_token_set": check("HUGGING_FACE_TOKEN") != "[not set]",
        "whisper_initial_prompt_enabled": config.WHISPER_INITIAL_PROMPT_ENABLED,
        "keep_models_warm": config.KEEP_MODELS_WARM,
        "gate_raw_review_enabled": config.GATE_RAW_REVIEW_ENABLED,
        "gate_delivery_review_enabled": config.GATE_DELIVERY_REVIEW_ENABLED,
        "custom_delivery_per_meeting": config.CUSTOM_DELIVERY_PER_MEETING,

        # ── Per-job metadata ──
        "title": metadata.get("title", ""),
        "attendees": metadata.get("attendees", []),
        "event_type": metadata.get("event_type", ""),
        "skip_steps": metadata.get("skip_steps", []),
    }
    return snapshot


@router.post("/transcribe/upload")
async def upload_audio(
    file: UploadFile = File(...),
    title: str = Form("Untitled Meeting"),
    attendees: str = Form("[]"),
    attendee_emails: str = Form("[]"),
    email_recipients: str = Form("[]"),
    event_type: str = Form("internal"),
    source: str = Form("upload"),
    skip_steps: str = Form(""),
):
    # Reject new uploads while ML pipeline jobs or review-gated jobs exist
    for info in state._active_jobs.values():
        if info.get("status") in ML_UPLOAD_BLOCKING_STATUSES:
            raise HTTPException(409, "A transcription job is already running — wait for it to finish before starting a new one")

    ext = (os.path.splitext(file.filename or "audio.wav")[1] or ".wav").lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format: {ext}. Allowed: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}")
    temp_dir = os.path.join(config.STORAGE_PATH, "uploads")
    os.makedirs(temp_dir, exist_ok=True)
    temp_path = os.path.join(temp_dir, f"upload_{os.urandom(4).hex()}{ext}")

    content = await file.read()
    with open(temp_path, "wb") as f:
        f.write(content)

    parsed_skip = json.loads(skip_steps) if skip_steps else config.DEFAULT_SKIP_STEPS
    parsed_emails = json.loads(email_recipients) if email_recipients else []
    parsed_attendee_emails = json.loads(attendee_emails) if attendee_emails else []
    metadata = {
        "title": title,
        "original_filename": file.filename,
        "attendees": json.loads(attendees),
        "attendeeEmails": parsed_attendee_emails,
        "email_recipients": parsed_emails,
        "event_type": event_type,
        "source": source,
        "skip_steps": parsed_skip,
    }
    try:
        result = services.uploader.upload(temp_path, metadata)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    job_id = result["job_id"]
    print(f"[upload] Received file '{file.filename}' ({len(content)} bytes) → job_id={job_id}")
    print(f"[upload] Metadata: title='{title}', attendees={attendees}, event_type='{event_type}'")
    print(f"[upload] skip_steps={parsed_skip}")

    # Persist job record in ephemeral DB
    try:
        config_snapshot = _build_config_snapshot(metadata)
        services.ephemeral_memory.upsert_job(job_id, {
            "title": title,
            "original_filename": file.filename,
            "attendees": attendees,
            "email_recipients": json.dumps(parsed_emails),
            "audio_url": temp_path if os.path.exists(temp_path) else None,
            "audio_size_bytes": len(content),
            "event_type": event_type,
            "source": source,
            "result": "pending",
            "config_snapshot": json.dumps(config_snapshot),
        })
        print(f"[upload] Job record persisted to ephemeral DB (config_snapshot: {len(json.dumps(config_snapshot))} chars)")
    except Exception as e:
        print(f"[upload] Warning: could not persist job record: {e}")

    state.start_pipeline_async(job_id)
    return {"job_id": job_id, "status": "uploaded"}


@router.post("/transcribe/upload_by_path")
async def upload_audio_by_path(req: UploadByPathRequest):
    """Upload an audio file by local filesystem path.

    Accepts a file path instead of multipart upload. Handles both
    POSIX (macOS/Linux) and Windows paths via os.path.
    """
    # Reject new uploads while ML pipeline jobs or review-gated jobs exist
    for info in state._active_jobs.values():
        if info.get("status") in ML_UPLOAD_BLOCKING_STATUSES:
            raise HTTPException(409, "A transcription job is already running — wait for it to finish before starting a new one")

    file_path = os.path.abspath(os.path.expanduser(req.file_path))

    if not os.path.exists(file_path):
        raise HTTPException(404, f"File not found: {file_path}")
    if not os.path.isfile(file_path):
        raise HTTPException(400, f"Path is not a file: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format: {ext}. Allowed: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}")

    # Use the provided skip_steps list as-is.  An empty list [] means "skip nothing"
    # and must NOT fall through to DEFAULT_SKIP_STEPS — [] is falsy in Python.
    skip_steps = req.skip_steps if req.skip_steps is not None else config.DEFAULT_SKIP_STEPS
    metadata = {
        "title": req.title,
        "attendees": req.attendees,
        "attendeeEmails": req.attendee_emails,
        "email_recipients": req.email_recipients,
        "event_type": req.event_type,
        "source": req.source,
        "skip_steps": skip_steps,
    }
    try:
        result = services.uploader.upload(file_path, metadata)
    except ValueError as e:
        raise HTTPException(400, str(e))

    job_id = result["job_id"]
    file_size = os.path.getsize(file_path)
    print(f"[upload_by_path] File '{file_path}' ({file_size} bytes) → job_id={job_id}")
    print(f"[upload_by_path] Metadata: title='{req.title}', attendees={req.attendees}")

    # Persist job record in ephemeral DB
    try:
        config_snapshot = _build_config_snapshot(metadata)
        services.ephemeral_memory.upsert_job(job_id, {
            "title": req.title,
            "attendees": json.dumps(req.attendees),
            "email_recipients": json.dumps(req.email_recipients),
            "audio_url": file_path,
            "audio_size_bytes": file_size,
            "event_type": req.event_type,
            "source": req.source,
            "result": "pending",
            "config_snapshot": json.dumps(config_snapshot),
        })
        print(f"[upload_by_path] Job record persisted to ephemeral DB (config_snapshot: {len(json.dumps(config_snapshot))} chars)")
    except Exception as e:
        print(f"[upload_by_path] Warning: could not persist job record: {e}")

    state.start_pipeline_async(job_id)
    return {"job_id": job_id, "status": "uploaded", "file_path": file_path}


@router.get("/transcribe/status/{job_id}")
async def get_status(job_id: str):
    s = services.uploader.get_status(job_id)
    if s["status"] == "not_found":
        print(f"[api] GET /transcribe/status/{job_id} → not_found")
        raise HTTPException(404, "Job not found")
    print(f"[api] GET /transcribe/status/{job_id} → {s['status']} (progress={s.get('progress', '?')})")
    return s


@router.post("/transcribe/step_message/{job_id}")
async def add_step_message(job_id: str, body: dict = Body(...)):
    """Append a simplified step message to the job's live log (agent runner)."""
    message = body.get("message", "")
    if not message:
        raise HTTPException(400, "message is required")
    state.add_step_message(job_id, message)
    return {"ok": True}


@router.get("/transcribe/active")
async def get_active_jobs():
    """List jobs actively running in the ML pipeline.

    Only returns jobs whose status indicates the ML pipeline thread is
    actively executing (diarization, ASR, alignment). Jobs that have
    moved past the pipeline stage (refined, summarized, analyzed,
    delivered, transcribed) or were never started (labeling_needed)
    are not returned — they're handled by the agent runner separately.
    """
    active = [
        {
            "job_id": job_id,
            "status": info["status"],
            "progress": info.get("progress", 0.0),
            "title": info.get("title", "Untitled"),
        }
        for job_id, info in state._active_jobs.items()
        if info.get("status") in ML_UPLOAD_BLOCKING_STATUSES
    ]
    active.sort(key=lambda j: j.get("progress", 0), reverse=True)
    print(f"[api] GET /transcribe/active → {len(active)} active ML job(s) (in-memory)")
    return {"active_jobs": active}


@router.get("/transcribe/history")
async def get_job_history():
    """List all jobs (including completed/failed) with metadata, newest first."""
    jobs = []
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir() or entry.name == "chroma" or entry.name == "logs" or entry.name == "uploads":
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        with open(status_path) as f:
            status = json.load(f)
        metadata = {}
        meta_path = os.path.join(entry.path, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                metadata = json.load(f)
        # Get transcript segment count
        transcript_path = os.path.join(entry.path, "transcript.json")
        has_transcript = os.path.exists(transcript_path)
        # Use file mtime as a proxy for recency
        mtime = os.path.getmtime(status_path)
        # Pipeline stage info: capture the final stage snapshot
        pipeline_stage = status.get("status", "unknown")
        pipeline_progress = status.get("progress", 0.0)
        pipeline_error = status.get("error", None)
        # LLM provider/model used for this job (from usage.json if present)
        llm_provider = "unknown"
        llm_model = "unknown"
        usage_path = os.path.join(entry.path, "usage.json")
        if os.path.exists(usage_path):
            try:
                with open(usage_path) as f:
                    usage = json.load(f)
                llm_provider = usage.get("provider", "unknown")
                llm_model = usage.get("model", "unknown")
            except (json.JSONDecodeError, IOError):
                pass

        jobs.append({
            "job_id": status.get("job_id", entry.name),
            "status": pipeline_stage,
            "progress": pipeline_progress,
            "error": pipeline_error,
            "warnings": status.get("warnings", []),
            "title": metadata.get("title", "Untitled"),
            "event_type": metadata.get("event_type", ""),
            "attendees": metadata.get("attendees", []),
            "has_transcript": has_transcript,
            "llm_provider": llm_provider,
            "llm_model": llm_model,
            "mtime": mtime,
        })
    jobs.sort(key=lambda j: j["mtime"], reverse=True)
    print(f"[api] GET /transcribe/history → {len(jobs)} job(s)")
    return {"jobs": jobs}


@router.get("/transcribe/transcript/{job_id}")
async def get_transcript(job_id: str, format: str = "json"):
    s = services.uploader.get_status(job_id)
    p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/transcript/{job_id} → not_found")
        raise HTTPException(404, "Transcript not ready")
    with open(p) as f:
        transcript = json.load(f)
    print(f"[api] GET /transcribe/transcript/{job_id} → {len(transcript)} segments (format={format})")
    if format == "text":
        lines = [f"[{s.get('start', 0.0):.1f}s] {s['speaker']}: {s['text']}" for s in transcript]
        return {"text": "\n".join(lines)}
    return {"transcript": transcript}


@router.get("/transcribe/summary/{job_id}")
async def get_summary(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/summary/{job_id} → not_found")
        raise HTTPException(404, "Summary not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/summary/{job_id} → OK")
    return data


@router.get("/transcribe/raw_transcript/{job_id}")
async def get_raw_transcript(job_id: str):
    """Return the raw/unrefined ASR transcript text (before any LLM refinement).

    The raw transcript is saved during the ML pipeline as a plain-text file.
    If not available, falls back to the existing transcript text.
    """
    # First try the dedicated raw transcript file
    raw_path = os.path.join(config.STORAGE_PATH, job_id, "raw_transcript.txt")
    if os.path.exists(raw_path):
        with open(raw_path) as f:
            text = f.read()
        print(f"[api] GET /transcribe/raw_transcript/{job_id} → OK ({len(text)} chars)")
        return {"text": text}

    # Fallback: use the pre-refinement transcript.txt (may have speaker labels)
    txt_path = os.path.join(config.STORAGE_PATH, job_id, "transcript.txt")
    if os.path.exists(txt_path):
        with open(txt_path) as f:
            text = f.read()
        print(f"[api] GET /transcribe/raw_transcript/{job_id} → fallback transcript.txt ({len(text)} chars)")
        return {"text": text}

    print(f"[api] GET /transcribe/raw_transcript/{job_id} → not_found")
    raise HTTPException(404, "Raw transcript not available for this job")


@router.get("/transcribe/analysis/{job_id}")
async def get_analysis(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "analysis.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/analysis/{job_id} → not_found")
        raise HTTPException(404, "Analysis not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/analysis/{job_id} → OK")
    return data


@router.get("/transcribe/attendees/{job_id}")
async def get_job_attendees(job_id: str):
    """Get attendees registered for a specific job, cross-referenced with voiceprint status.

    Reads the job's metadata.json to retrieve registered attendee names and emails,
    then cross-references each attendee against enrolled voiceprints to determine
    whether they have a matching voiceprint and audio sample available.
    """
    meta = services.uploader.get_metadata(job_id)
    if not meta:
        raise HTTPException(404, f"Job {job_id} metadata not found")

    registered = meta.get("attendees", [])
    attendee_emails = meta.get("attendeeEmails", [])
    # Normalize: handle both list (positional) and dict ({name: email}) formats.
    # After label_and_resume updates metadata, attendeeEmails is stored as a dict
    # to preserve name→email alignment. Convert back to positional list for the
    # downstream loop which indexes by position.
    if isinstance(attendee_emails, dict):
        attendee_emails = [attendee_emails.get(name, "") for name in registered]

    # Non-speaking attendees (present but silent) — annotated from the persisted
    # reconciliation so the results UI can show who actually spoke.
    non_speaking_set = {n.strip().lower() for n in (meta.get("non_speaking_attendees", []) or [])}

    # Fetch all enrolled voiceprints
    vps = services.vp_manager.list_voiceprints()
    vp_by_email = {vp["email"].lower(): vp for vp in vps}
    vp_by_name = {vp["name"].lower(): vp for vp in vps}

    attendees = []
    seen = set()

    for i, name in enumerate(registered):
        email = attendee_emails[i] if i < len(attendee_emails) else ""
        key = email.lower() or name.lower()
        vp = vp_by_email.get(key) or vp_by_name.get(key)
        # Don't fall back to voiceprint email — registered attendee email
        # from the upload form takes priority even when empty. Voiceprint
        # emails are often @voiceprint.local placeholders that shouldn't
        # appear in the UI for registered attendees.
        attendees.append({
            "name": name,
            "email": email,
            "has_voiceprint": bool(vp),
            "has_sample": bool(vp and vp.get("sample_job_id")),
            "sample_job_id": vp.get("sample_job_id") if vp else None,
            "sample_start": vp.get("sample_start") if vp else None,
            "sample_end": vp.get("sample_end") if vp else None,
            "is_non_speaking": name.strip().lower() in non_speaking_set,
        })
        if key:
            seen.add(key)

    # Also add any voiceprint-only attendees linked to this job
    for vp in vps:
        if vp.get("sample_job_id") == job_id:
            key = (vp.get("email") or vp.get("name", "")).lower()
            if key not in seen:
                attendees.append({
                    "name": vp.get("name", ""),
                    "email": vp.get("email", ""),
                    "has_voiceprint": True,
                    "has_sample": bool(vp.get("sample_job_id")),
                    "sample_job_id": vp.get("sample_job_id"),
                    "sample_start": vp.get("sample_start"),
                    "sample_end": vp.get("sample_end"),
                    "is_non_speaking": False,
                })
                seen.add(key)

    print(f"[api] GET /transcribe/attendees/{job_id} → {len(attendees)} attendee(s)")
    return {"job_id": job_id, "attendees": attendees}


@router.get("/transcribe/delivery/{job_id}")
async def get_delivery_results(job_id: str):
    """Get delivery results for a job (email, Drive, Trello success/failure data)."""
    p = os.path.join(config.STORAGE_PATH, job_id, "delivery-results.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/delivery/{job_id} → not_found")
        raise HTTPException(404, "Delivery results not available")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/delivery/{job_id} → OK ({data.get('summary', {}).get('total', 0)} deliveries)")
    return data


@router.get("/transcribe/usage/aggregate")
async def get_aggregate_usage(provider: str = None):
    """Aggregate token usage across all jobs. Scans storage dir for usage.json files."""
    results = []
    totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    storage = config.STORAGE_PATH
    if not os.path.isdir(storage):
        print(f"[api] GET /transcribe/usage/aggregate → empty (no storage dir)")
        return {"jobs": [], "totals": totals, "by_provider": {}, "job_count": 0}

    for entry in os.listdir(storage):
        job_dir = os.path.join(storage, entry)
        usage_path = os.path.join(job_dir, "usage.json")
        if not os.path.isdir(job_dir) or not os.path.exists(usage_path):
            continue
        try:
            with open(usage_path) as f:
                data = json.load(f)
            job_totals = data.get("totals", {})
            results.append({
                "job_id": entry,
                "title": data.get("title", entry),
                "provider": data.get("provider", "unknown"),
                "model": data.get("model", "unknown"),
                "step_count": len(data.get("steps", [])),
                "totals": {
                    "prompt_tokens": job_totals.get("prompt_tokens", 0),
                    "completion_tokens": job_totals.get("completion_tokens", 0),
                    "total_tokens": job_totals.get("total_tokens", 0),
                },
                "costs": data.get("costs", {}),
                "saved_at": data.get("saved_at", ""),
            })
            totals["prompt_tokens"] += job_totals.get("prompt_tokens", 0)
            totals["completion_tokens"] += job_totals.get("completion_tokens", 0)
            totals["total_tokens"] += job_totals.get("total_tokens", 0)
        except (json.JSONDecodeError, IOError):
            continue

    # Compute aggregate costs from per-job cost fields
    total_costs = {"input_cost": 0.0, "output_cost": 0.0, "total_cost": 0.0}
    for r in results:
        jc = r.get("costs", {})
        total_costs["input_cost"] += jc.get("input_cost", 0)
        total_costs["output_cost"] += jc.get("output_cost", 0)
        total_costs["total_cost"] += jc.get("total_cost", 0)
    total_costs = {k: round(v, 6) for k, v in total_costs.items()}

    # Group jobs + totals by provider (for the per-provider usage tabs)
    by_provider: dict = {}
    for r in results:
        prov = r.get("provider", "unknown")
        g = by_provider.setdefault(
            prov,
            {
                "job_count": 0,
                "totals": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "costs": {"input_cost": 0.0, "output_cost": 0.0, "total_cost": 0.0},
            },
        )
        g["job_count"] += 1
        g["totals"]["prompt_tokens"] += r["totals"]["prompt_tokens"]
        g["totals"]["completion_tokens"] += r["totals"]["completion_tokens"]
        g["totals"]["total_tokens"] += r["totals"]["total_tokens"]
        jc = r.get("costs", {})
        g["costs"]["input_cost"] += jc.get("input_cost", 0)
        g["costs"]["output_cost"] += jc.get("output_cost", 0)
        g["costs"]["total_cost"] += jc.get("total_cost", 0)
    for g in by_provider.values():
        g["costs"] = {k: round(v, 6) for k, v in g["costs"].items()}

    # Optional per-provider filter — recompute totals/costs for the filtered set
    if provider:
        results = [r for r in results if r.get("provider") == provider]
        totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        for r in results:
            jt = r["totals"]
            totals["prompt_tokens"] += jt["prompt_tokens"]
            totals["completion_tokens"] += jt["completion_tokens"]
            totals["total_tokens"] += jt["total_tokens"]
        total_costs = {"input_cost": 0.0, "output_cost": 0.0, "total_cost": 0.0}
        for r in results:
            jc = r.get("costs", {})
            total_costs["input_cost"] += jc.get("input_cost", 0)
            total_costs["output_cost"] += jc.get("output_cost", 0)
            total_costs["total_cost"] += jc.get("total_cost", 0)
        total_costs = {k: round(v, 6) for k, v in total_costs.items()}
        by_provider = {prov: g for prov, g in by_provider.items() if prov == provider}

    # Sort by saved_at descending
    results.sort(key=lambda r: r.get("saved_at", ""), reverse=True)
    print(f"[USAGE] Aggregate token usage: {len(results)} jobs, {totals['total_tokens']} total tokens (${total_costs['total_cost']:.4f})")
    return {"jobs": results, "totals": totals, "costs": total_costs, "by_provider": by_provider, "job_count": len(results)}


@router.get("/transcribe/usage/{job_id}")
async def get_token_usage(job_id: str):
    """Return token usage data recorded by the agent runner during LLM processing."""
    p = os.path.join(config.STORAGE_PATH, job_id, "usage.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/usage/{job_id} → not_found")
        raise HTTPException(404, "Token usage not available (job may have been processed before tracking was added)")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/usage/{job_id} → OK ({data.get('totals', {}).get('total_tokens', '?')} tokens)")
    return data


@router.get("/transcribe/audio/{job_id}")
async def get_audio(job_id: str):
    """Serve the audio file for playback in the UI.

    Tries in order:
      1. standardized.wav (16kHz mono — preferred for processing)
      2. Any original.* file (raw uploaded format)
    """
    try:
        job_dir = os.path.join(config.STORAGE_PATH, job_id)
        if not os.path.isdir(job_dir):
            raise HTTPException(404, f"Job directory not found: {job_id}")

        # Try standardized.wav first, then fall back to original file
        wav_path = os.path.join(job_dir, "standardized.wav")
        if os.path.exists(wav_path):
            audio_path = wav_path
            media_type = "audio/wav"
        else:
            # Fall back to any original.* file
            orig_files = sorted(Path(job_dir).glob("original.*"))
            if not orig_files:
                raise HTTPException(404, "No audio file found for this job")
            audio_path = str(orig_files[0])
            ext = os.path.splitext(audio_path)[1].lower()
            mime_map = {
                ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
                ".flac": "audio/flac", ".ogg": "audio/ogg", ".webm": "audio/webm",
            }
            media_type = mime_map.get(ext, "audio/wav")

        print(f"[api] GET /transcribe/audio/{job_id} → serving {audio_path} ({media_type})")
        return FileResponse(audio_path, media_type=media_type, filename=f"{job_id}{os.path.splitext(audio_path)[1]}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to serve audio: {e}")


@router.get("/transcribe/job_logs/{job_id}")
async def get_job_logs(job_id: str, max_lines: int = 0):
    """Return job-specific log files listing.

    Searches ``storage/{job_id}/`` for per-job log files (pipeline.log, actions.jsonl, etc.).

    All logs are stored in user storage (not the repo), organized by job ID.
    Pass ``max_lines=0`` (default) to return ALL matching lines (no truncation).
    Pass a positive number to limit to the last N lines.
    """
    matched_lines = []

    # ── Source: Per-job files (storage/{job_id}/) ──
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    job_logs = []
    if os.path.exists(job_dir):
        for fname in os.listdir(job_dir):
            # Include .log, .txt, and .jsonl files; skip large audio/binary files
            if any(fname.endswith(ext) for ext in (".log", ".txt", ".jsonl")):
                fpath = os.path.join(job_dir, fname)
                try:
                    with open(fpath) as f:
                        content = f.read()
                    job_logs.append({"file": fname, "content": content})
                except Exception:
                    continue
    if max_lines <= 0:
        return {"logs": matched_lines, "job_logs": job_logs}
    return {"logs": matched_lines[-max_lines:], "job_logs": job_logs}


@router.get("/transcribe/job_files/{job_id}")
async def get_job_files(job_id: str):
    """List all files in a job's storage directory."""
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    if not os.path.exists(job_dir):
        raise HTTPException(404, "Job directory not found")
    files = []
    for fname in os.listdir(job_dir):
        fpath = os.path.join(job_dir, fname)
        try:
            stat = os.stat(fpath)
            files.append({
                "name": fname,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "type": "json" if fname.endswith(".json") else
                        "audio" if fname.endswith((".wav", ".mp3", ".m4a")) else
                        "text" if fname.endswith(".txt") else "other",
            })
        except Exception:
            continue
    files.sort(key=lambda f: f["name"])
    return {"job_id": job_id, "files": files}


@router.get("/transcribe/pipeline_log/{job_id}")
async def get_pipeline_log(job_id: str, max_lines: int = 0):
    """Return the per-job log content.

    Reads ``pipeline.log`` which now contains ALL log entries from every
    source (Python backend, bridge server, agent runner, Electron main).
    Entries are written by the Electron main process's ``addLog()`` function,
    which captures stdout from all child processes.

    Also reads ``actions.jsonl`` (per-action log entries from the agent runner)
    and formats them as readable text lines prefixed with ``[actions]``.

    Pass ``max_lines=0`` (default) to return ALL lines.
    When the pipeline completes or fails, the per-job log is closed and no
    more entries are written.
    """
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    all_lines = []
    pipeline_count = actions_count = 0

    # ── Source 1: pipeline.log (everything — Python, bridge, agent, main) ──
    p = os.path.join(job_dir, "pipeline.log")
    if os.path.exists(p):
        try:
            with open(p) as f:
                for line in f:
                    s = line.rstrip("\n")
                    if s:
                        all_lines.append(s)
                        pipeline_count += 1
        except Exception:
            pass

    # ── Source 2: actions.jsonl (per-action log) ──
    p = os.path.join(job_dir, "actions.jsonl")
    if os.path.exists(p):
        try:
            with open(p) as f:
                for line in f:
                    s = line.strip()
                    if not s:
                        continue
                    try:
                        entry = json.loads(s)
                        level = entry.get("level", "info")
                        msg = entry.get("message", entry.get("text", ""))
                        tool = entry.get("tool", "")
                        if isinstance(msg, dict):
                            msg = json.dumps(msg)
                        if len(str(msg)) > 300:
                            msg = str(msg)[:300] + "..."
                        prefix = f"[actions] [{tool}]" if tool else "[actions]"
                        all_lines.append(f"{prefix} [{level}] {msg}")
                        actions_count += 1
                    except json.JSONDecodeError:
                        all_lines.append(f"[actions] {s[:300]}")
                        actions_count += 1
        except Exception:
            pass

    if max_lines > 0:
        all_lines = all_lines[-max_lines:]

    return {
        "job_id": job_id,
        "lines": all_lines,
        "total_lines": pipeline_count + actions_count,
        "returned_lines": len(all_lines),
        "from_pipeline_log": pipeline_count,
        "from_actions": actions_count,
    }
