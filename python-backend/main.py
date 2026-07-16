"""
FastAPI application — transcription backend

Endpoints:
  ML Pipeline: /transcribe/upload, /transcribe/status/{id}, /transcribe/transcript/{id}
  Agent-facing: /agent/refine, /agent/summarize, /agent/label_speakers, /agent/deliver
  Memory:       /memory/search, /memory/ephemeral/query, /memory/ephemeral/save, /memory/save_context
"""

import os
import json
import time
import asyncio
import numpy as np
from datetime import datetime

# ── MPS memory limit workaround (Apple Silicon) ──
# PyTorch's MPS backend enforces a high-water mark (~90% of available VRAM).
# When running large models (whisper-medium + pyannote diarization), the combined
# allocation can exceed this limit and crash with "MPS backend out of memory".
# Disabling the limit lets macOS gracefully handle memory pressure via
# unified memory architecture (RAM swapping if needed).
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

# ── Apply third-party compatibility patches FIRST (before any pyannote imports) ──
import patches  # noqa: F401  (monkey-patches speechbrain + torchaudio + pyannote)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from config import config
from utils import is_network_error

from upload import AudioUploader
from voiceprint import VoiceprintManager
from transcription import TranscriptionEngine, detect_device
from models import (
    RefineRequest, SummarizeRequest, LabelRequest, AnalysisRequest, Deliverable,
    MemorySearchRequest,
    EphemeralMemoryItem, EphemeralMemoryQuery,
    RegisterAttendeesRequest, SaveMeetingContextRequest, UploadByPathRequest,
)
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

uploader: AudioUploader = None
vp_manager: VoiceprintManager = None
engine: TranscriptionEngine = None
agent_bridge: AgentBridge = None
semantic_memory: SemanticMemory = None
ephemeral_memory: EphemeralMemory = None

# ── Async pipeline management ──
# Instead of threading.Thread, we use asyncio tasks with a semaphore to
# limit concurrent ML pipeline runs. This allows clean integration with
# FastAPI's event loop, proper cancellation, and in-memory job tracking.
_pipeline_tasks: dict[str, asyncio.Task] = {}
_pipeline_cancel: set[str] = set()
_pipeline_semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_PIPELINES)

# In-memory active job tracking (replaces disk-scanning in /transcribe/active)
# Keyed by job_id; values are {status, progress, title}
_active_jobs: dict[str, dict] = {}

# ML pipeline statuses that indicate a job is actively running in the pipeline.
# Shared across upload endpoints, active job listing, and cleanup logic.
ML_PIPELINE_STATUSES = frozenset({
    "uploaded", "initializing", "processing_diarization",
    "matching_voiceprints", "processing_transcription", "aligning",
})


@asynccontextmanager
async def lifespan(app: FastAPI):
    global uploader, vp_manager, agent_bridge, semantic_memory, ephemeral_memory
    uploader = AudioUploader()
    vp_manager = VoiceprintManager(provider=config.EMBEDDING_PROVIDER)
    agent_bridge = AgentBridge()
    semantic_memory = SemanticMemory()
    ephemeral_memory = EphemeralMemory()
    os.makedirs(config.STORAGE_PATH, exist_ok=True)
    os.makedirs(config.QUEUE_DIR, exist_ok=True)
    print(f"[startup] Backend on {config.HOST}:{config.PORT} | device={detect_device()}")
    print(f"[startup] Semantic memory: {semantic_memory.persist_dir}")
    print(f"[startup] Ephemeral memory: {ephemeral_memory.db_path}")

    # ── Startup cleanup: reset orphaned pipeline statuses ──
    # Jobs that were mid-pipeline when the process was killed (crash,
    # force-quit, restart) leave stale status.json files behind. The
    # /transcribe/active endpoint reads these from disk and would
    # incorrectly report them as running. Reset any in-flight status
    # to "failed" so the system starts with a clean slate and users
    # aren't blocked by "active jobs" guards.
    cleaned = 0
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir() or entry.name in ("chroma", "logs", "uploads"):
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        try:
            with open(status_path) as f:
                status = json.load(f)
            job_status = status.get("status", "")
            if job_status in ML_PIPELINE_STATUSES:
                status["status"] = "failed"
                status["error"] = "Processing interrupted by restart — job was in-flight when the backend shut down"
                status["progress"] = 0.0
                status["failed_at"] = datetime.utcnow().isoformat()
                with open(status_path, "w") as f:
                    json.dump(status, f, indent=2)
                job_id = status.get("job_id", entry.name)
                print(f"   🧹 [startup] Reset orphaned job {job_id} ({job_status} → failed)")
                cleaned += 1
        except (json.JSONDecodeError, OSError) as e:
            print(f"   ⚠️  [startup] Could not read status for {entry.name}: {e}")
    if cleaned:
        print(f"   🧹 [startup] Cleaned {cleaned} orphaned job(s)")
    else:
        print(f"   ✅ [startup] No orphaned jobs found")
    yield

    # ── Shutdown: close SQLite connections to prevent leaks ──
    vp_manager.close()
    ephemeral_memory.close()


app = FastAPI(title="Meeting Transcription Backend", version="1.0.0", lifespan=lifespan)

# Allow cross-origin requests from the Electron renderer (Vite dev server on :5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── ML Pipeline ──

@app.post("/transcribe/upload")
async def upload_audio(
    file: UploadFile = File(...),
    title: str = Form("Untitled Meeting"),
    attendees: str = Form("[]"),
    attendee_emails: str = Form("[]"),
    email_recipients: str = Form("[]"),
    event_type: str = Form("internal"),
    skip_steps: str = Form(""),
):
    # Reject new uploads while ML pipeline jobs are actively running
    for info in _active_jobs.values():
        if info.get("status") in ML_PIPELINE_STATUSES:
            raise HTTPException(409, "A transcription job is already running — wait for it to finish before starting a new one")

    ext = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
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
        "attendees": json.loads(attendees),
        "attendeeEmails": parsed_attendee_emails,
        "email_recipients": parsed_emails,
        "event_type": event_type,
        "skip_steps": parsed_skip,
    }
    try:
        result = uploader.upload(temp_path, metadata)
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
        ephemeral_memory.upsert_job(job_id, {
            "title": title,
            "attendees": attendees,
            "email_recipients": json.dumps(parsed_emails),
            "audio_url": temp_path if os.path.exists(temp_path) else None,
            "audio_size_bytes": len(content),
            "event_type": event_type,
            "result": "pending",
            "config_snapshot": json.dumps(config_snapshot),
        })
        print(f"[upload] Job record persisted to ephemeral DB (config_snapshot: {len(json.dumps(config_snapshot))} chars)")
    except Exception as e:
        print(f"[upload] Warning: could not persist job record: {e}")

    _start_pipeline_async(job_id)
    return {"job_id": job_id, "status": "uploaded"}


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

        # ── Per-job metadata ──
        "title": metadata.get("title", ""),
        "attendees": metadata.get("attendees", []),
        "event_type": metadata.get("event_type", ""),
        "skip_steps": metadata.get("skip_steps", []),
    }
    return snapshot


@app.post("/transcribe/upload_by_path")
async def upload_audio_by_path(req: UploadByPathRequest):
    """Upload an audio file by local filesystem path.

    Accepts a file path instead of multipart upload. Handles both
    POSIX (macOS/Linux) and Windows paths via os.path.
    """
    # Reject new uploads while ML pipeline jobs are actively running
    for info in _active_jobs.values():
        if info.get("status") in ML_PIPELINE_STATUSES:
            raise HTTPException(409, "A transcription job is already running — wait for it to finish before starting a new one")

    file_path = os.path.abspath(os.path.expanduser(req.file_path))

    if not os.path.exists(file_path):
        raise HTTPException(404, f"File not found: {file_path}")
    if not os.path.isfile(file_path):
        raise HTTPException(400, f"Path is not a file: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format: {ext}. Allowed: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}")

    skip_steps = req.skip_steps or config.DEFAULT_SKIP_STEPS
    metadata = {
        "title": req.title,
        "attendees": req.attendees,
        "email_recipients": req.email_recipients,
        "event_type": req.event_type,
        "skip_steps": skip_steps,
    }
    try:
        result = uploader.upload(file_path, metadata)
    except ValueError as e:
        raise HTTPException(400, str(e))

    job_id = result["job_id"]
    file_size = os.path.getsize(file_path)
    print(f"[upload_by_path] File '{file_path}' ({file_size} bytes) → job_id={job_id}")
    print(f"[upload_by_path] Metadata: title='{req.title}', attendees={req.attendees}")

    # Persist job record in ephemeral DB
    try:
        config_snapshot = _build_config_snapshot(metadata)
        ephemeral_memory.upsert_job(job_id, {
            "title": req.title,
            "attendees": json.dumps(req.attendees),
            "email_recipients": json.dumps(req.email_recipients),
            "audio_url": file_path,
            "audio_size_bytes": file_size,
            "event_type": req.event_type,
            "result": "pending",
            "config_snapshot": json.dumps(config_snapshot),
        })
        print(f"[upload_by_path] Job record persisted to ephemeral DB (config_snapshot: {len(json.dumps(config_snapshot))} chars)")
    except Exception as e:
        print(f"[upload_by_path] Warning: could not persist job record: {e}")

    _start_pipeline_async(job_id)
    return {"job_id": job_id, "status": "uploaded", "file_path": file_path}


@app.get("/transcribe/status/{job_id}")
async def get_status(job_id: str):
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        print(f"[api] GET /transcribe/status/{job_id} → not_found")
        raise HTTPException(404, "Job not found")
    print(f"[api] GET /transcribe/status/{job_id} → {s['status']} (progress={s.get('progress', '?')})")
    return s


@app.get("/transcribe/active")
async def get_active_jobs():
    """List jobs actively running in the ML pipeline.

    Only returns jobs whose status indicates the ML pipeline thread is
    actively executing (diarization, ASR, alignment). Jobs that have
    moved past the pipeline stage (refined, summarized, analyzed,
    delivered, transcribed) or were never started (labeling_needed)
    are not returned — they're handled by the agent runner separately.
    """
    """List jobs actively running in the ML pipeline (uses in-memory tracking)."""
    active = [
        {
            "job_id": job_id,
            "status": info["status"],
            "progress": info.get("progress", 0.0),
            "title": info.get("title", "Untitled"),
        }
        for job_id, info in _active_jobs.items()
        if info.get("status") in ML_PIPELINE_STATUSES
    ]
    active.sort(key=lambda j: j.get("progress", 0), reverse=True)
    print(f"[api] GET /transcribe/active → {len(active)} active ML job(s) (in-memory)")
    return {"active_jobs": active}


@app.get("/transcribe/history")
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
        jobs.append({
            "job_id": status.get("job_id", entry.name),
            "status": pipeline_stage,
            "progress": pipeline_progress,
            "error": pipeline_error,
            "title": metadata.get("title", "Untitled"),
            "event_type": metadata.get("event_type", ""),
            "attendees": metadata.get("attendees", []),
            "has_transcript": has_transcript,
            "mtime": mtime,
        })
    jobs.sort(key=lambda j: j["mtime"], reverse=True)
    print(f"[api] GET /transcribe/history → {len(jobs)} job(s)")
    return {"jobs": jobs}


@app.get("/transcribe/transcript/{job_id}")
async def get_transcript(job_id: str, format: str = "json"):
    s = uploader.get_status(job_id)
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


@app.get("/transcribe/summary/{job_id}")
async def get_summary(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/summary/{job_id} → not_found")
        raise HTTPException(404, "Summary not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/summary/{job_id} → OK")
    return data


@app.get("/transcribe/raw_transcript/{job_id}")
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


# ── Agent-facing endpoints ──

@app.post("/agent/refine")
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

    uploader.save_transcript(req.job_id, refined)
    uploader.update_status(req.job_id, {"status": "refined"})
    print(f"[api] POST /agent/refine → refined {len(refined)} segments " +
          ("" if req.keep_timestamps else "(timestamps stripped, ") +
          f"fillers removed, PII redacted" +
          (f", +{len(req.rules)} custom rule(s)" if req.rules else "") + ")")
    return {"transcript": refined}


@app.post("/agent/summarize")
async def agent_summarize(req: SummarizeRequest):
    print(f"[api] POST /agent/summarize job_id={req.job_id}")
    uploader.save_summary(req.job_id, req.summary)
    uploader.update_status(req.job_id, {"status": "summarized"})
    summary_type = type(req.summary).__name__
    items = len(req.summary.get("action_items", [])) if isinstance(req.summary, dict) else 0
    print(f"[api] POST /agent/summarize → summary saved ({summary_type}, {items} action items)")
    return {"summary": req.summary}


@app.post("/agent/analyze")
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
    uploader.save_analysis(req.job_id, req.analysis)
    uploader.update_status(req.job_id, {"status": "analyzed"})
    topics = req.analysis.get("topics", [])
    print(f"[api] POST /agent/analyze → analysis saved (topics: {len(topics)})")
    return {"analysis": req.analysis}


@app.get("/transcribe/analysis/{job_id}")
async def get_analysis(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "analysis.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/analysis/{job_id} → not_found")
        raise HTTPException(404, "Analysis not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/analysis/{job_id} → OK")
    return data


@app.get("/transcribe/attendees/{job_id}")
async def get_job_attendees(job_id: str):
    """Get attendees registered for a specific job, cross-referenced with voiceprint status.

    Reads the job's metadata.json to retrieve registered attendee names and emails,
    then cross-references each attendee against enrolled voiceprints to determine
    whether they have a matching voiceprint and audio sample available.
    """
    meta = uploader.get_metadata(job_id)
    if not meta:
        raise HTTPException(404, f"Job {job_id} metadata not found")

    registered = meta.get("attendees", [])
    attendee_emails = meta.get("attendeeEmails", [])

    # Fetch all enrolled voiceprints
    vps = vp_manager.list_voiceprints()
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
                })
                seen.add(key)

    print(f"[api] GET /transcribe/attendees/{job_id} → {len(attendees)} attendee(s)")
    return {"job_id": job_id, "attendees": attendees}


@app.get("/transcribe/delivery/{job_id}")
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


@app.get("/transcribe/usage/aggregate")
async def get_aggregate_usage():
    """Aggregate token usage across all jobs. Scans storage dir for usage.json files."""
    results = []
    totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    storage = config.STORAGE_PATH
    if not os.path.isdir(storage):
        print(f"[api] GET /transcribe/usage/aggregate → empty (no storage dir)")
        return {"jobs": [], "totals": totals, "job_count": 0}

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

    # Sort by saved_at descending
    results.sort(key=lambda r: r.get("saved_at", ""), reverse=True)
    print(f"[USAGE] Aggregate token usage: {len(results)} jobs, {totals['total_tokens']} total tokens (${total_costs['total_cost']:.4f})")
    return {"jobs": results, "totals": totals, "costs": total_costs, "job_count": len(results)}


@app.get("/transcribe/usage/{job_id}")
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


@app.post("/agent/label_speakers")
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
            audio_path = uploader.get_audio_path(req.job_id)
        except Exception:
            audio_path = None

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
                        seg_emb = vp_manager.extract_embedding(
                            audio_path, segment=(s["start"], s["end"])
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
                        emb = vp_manager.extract_embedding(
                            audio_path, segment=(sample_start, sample_end)
                        )
                        print(f"[api]   ✅ Extracted embedding (fallback) for '{label.name}' ({label.speaker_id})")
                    except Exception as e:
                        print(f"[api]   ⚠️  Could not extract embedding for '{label.name}': {e}")
        vp_manager.save_voiceprint(
            label.name, label.email or "", emb,
            sample_job_id=req.job_id,
            sample_start=sample_start,
            sample_end=sample_end,
        )

    if transcript_data:
        mapping = {l.speaker_id: l.name for l in req.labels}
        for seg in transcript_data:
            if seg["speaker"] in mapping:
                seg["speaker"] = mapping[seg["speaker"]]
        uploader.save_transcript(req.job_id, transcript_data)
        print(f"[api] Applied {len(names)} speaker label(s) to transcript")

    uploader.update_status(req.job_id, {"status": "labeled", "unknown_speakers": []})
    print(f"[api] POST /agent/label_speakers → done")
    return {"success": True, "applied_labels": len(req.labels)}


@app.get("/agent/voiceprints")
async def agent_list_voiceprints():
    vps = vp_manager.list_voiceprints()
    print(f"[api] GET /agent/voiceprints → {len(vps)} enrolled")
    return {"voiceprints": vps}


@app.post("/voiceprints/check-conflicts")
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
        existing = vp_manager.get_voiceprint(name)
        if not existing and email:
            existing = vp_manager.get_voiceprint(email)
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


@app.post("/attendees/check-conflicts")
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
    for entry in entries:
        name = entry.get("name", "").strip()
        email = entry.get("email", "").strip()
        if not name:
            continue

        # 1. Check attendee registry for email collisions
        if email:
            existing_atts = ephemeral_memory.query_attendees(name=email, limit=5)
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
            existing_atts = ephemeral_memory.query_attendees(name=name, limit=5)
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
        existing_vp = vp_manager.get_voiceprint(name)
        if not existing_vp and email:
            existing_vp = vp_manager.get_voiceprint(email)
        if existing_vp and existing_vp["name"] != name:
            conflicts.append({
                "type": "voiceprint_name_mismatch",
                "name": name,
                "email": email,
                "existing_name": existing_vp["name"],
                "existing_email": existing_vp["email"],
                "message": f"Voiceprint for '{existing_vp['name']}' already exists with email '{existing_vp['email'] or 'none'}'. Entering as '{name}' will create a new voiceprint record.",
            })

    print(f"[api] POST /attendees/check-conflicts → {len(conflicts)} conflict(s)")
    return {"conflicts": conflicts}


@app.delete("/agent/voiceprints/{email}")
async def agent_delete_voiceprint(email: str):
    """Delete a voiceprint by email. Returns success even if not found."""
    print(f"[api] DELETE /agent/voiceprints/{email}")
    vp_manager.delete_voiceprint(email)
    return {"success": True, "email": email}


@app.get("/agent/voiceprints/sample/{email}")
async def agent_voiceprint_sample(email: str):
    """Serve a sample audio clip for a voiceprint.

    Looks up the voiceprint's stored sample_job_id + sample_start/end,
    extracts the clip from that job's audio file using ffmpeg, and returns
    it as a WAV for in-browser playback.
    """
    from fastapi.responses import Response
    import subprocess as _sp
    import tempfile as _tf

    vps = vp_manager.list_voiceprints()
    vp = next((v for v in vps if v["email"] == email), None)
    if not vp or not vp.get("sample_job_id"):
        raise HTTPException(404, "No sample audio available for this voiceprint")

    job_id = vp["sample_job_id"]
    seg_start = vp["sample_start"]
    seg_end = vp["sample_end"]

    audio_path = uploader.get_audio_path(job_id)
    if not os.path.exists(audio_path):
        raise HTTPException(404, "Source audio file not found")

    clip_duration = min(8.0, seg_end - seg_start)
    clip_start = seg_start

    with _tf.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        _sp.run([
            "ffmpeg", "-y",
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


@app.post("/agent/deliver")
async def agent_deliver(req: Deliverable):
    print(f"[api] POST /agent/deliver job_id={req.job_id} destinations={req.destinations} emails={req.email_recipients}")

    # Merge job-specific email recipients with config-level default recipients.
    # Config recipients come from DELIVERY_RECIPIENT_EMAILS env var (set via ConfigPanel).
    config_recipients = os.environ.get("DELIVERY_RECIPIENT_EMAILS", "")
    config_emails = [e.strip() for e in config_recipients.split(",") if e.strip()] if config_recipients else []

    # Also try to read job-level email_recipients from stored metadata
    job_emails = req.email_recipients or []
    try:
        meta_path = os.path.join(config.STORAGE_PATH, req.job_id, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)
            stored_emails = meta.get("email_recipients", [])
            if stored_emails:
                job_emails = list(set(list(job_emails) + stored_emails))
    except Exception:
        pass

    # Deduplicate while preserving order
    seen = set()
    all_recipients = []
    for email in config_emails + job_emails:
        if email.lower() not in seen:
            seen.add(email.lower())
            all_recipients.append(email)

    package = {
        "job_id": req.job_id, "title": req.title,
        "attendees": req.attendees, "destinations": req.destinations,
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


# ── Memory Endpoints ──

@app.post("/memory/search")
async def memory_search(req: MemorySearchRequest):
    """Semantic search across past meeting transcripts and summaries."""
    print(f"[api] POST /memory/search query='{req.query}' n_results={req.n_results}")
    try:
        results = semantic_memory.search(req.query, n_results=req.n_results)
        print(f"[api] POST /memory/search → {len(results)} result(s)")
        return {"results": results}
    except Exception as e:
        print(f"[api] POST /memory/search ERROR: {e}")
        raise HTTPException(500, f"Memory search failed: {e}")


@app.post("/memory/ephemeral/save")
async def memory_ephemeral_save(req: EphemeralMemoryItem):
    """Save an item to ephemeral memory (action_items, contacts, budgets, decisions, notes)."""
    print(f"[api] POST /memory/ephemeral/save table={req.table}")
    try:
        table = req.table
        data = req.data
        if table == "action_items":
            items = data.get("items", [])
            ephemeral_memory.save_action_items(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} action items to ephemeral memory")
        elif table == "contacts":
            ephemeral_memory.upsert_contact(
                data.get("name", ""), data.get("email", ""), data.get("org", ""),
                data.get("role", ""), data.get("phone", ""), data.get("meeting", ""),
            )
            print(f"[api] Upserted contact '{data.get('name')}'")
        elif table == "budgets":
            items = data.get("items", [])
            ephemeral_memory.save_budgets(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} budget items")
        elif table == "decisions":
            items = data.get("items", [])
            ephemeral_memory.save_decisions(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} decisions")
        elif table == "notes":
            ephemeral_memory.save_note(
                data.get("job_id", ""), data.get("topic", ""), data.get("content", "")
            )
            print(f"[api] Saved note topic='{data.get('topic')}'")
        else:
            raise HTTPException(400, f"Unknown table: {table}")
        return {"success": True}
    except Exception as e:
        print(f"[api] POST /memory/ephemeral/save ERROR: {e}")
        raise HTTPException(500, f"Ephemeral memory save failed: {e}")


@app.post("/memory/ephemeral/query")
async def memory_ephemeral_query(req: EphemeralMemoryQuery):
    """Query ephemeral memory by table and optional keyword."""
    print(f"[api] POST /memory/ephemeral/query table={req.table} query='{req.query}' limit={req.limit}")
    try:
        data = ephemeral_memory.query_all(req.table, req.query, req.limit)
        print(f"[api] POST /memory/ephemeral/query → {len(data)} result(s)")
        return {"results": data}
    except Exception as e:
        print(f"[api] POST /memory/ephemeral/query ERROR: {e}")
        raise HTTPException(500, f"Ephemeral memory query failed: {e}")


@app.post("/memory/save_context")
async def memory_save_context(req: SaveMeetingContextRequest):
    """Save full meeting context to both semantic and ephemeral memory at once.
    Called by the agent runner after summarization completes."""
    print(f"[api] POST /memory/save_context job_id={req.job_id} title='{req.title}'")
    try:
        # Semantic memory — searchable vector store
        print(f"[memory] Storing meeting in semantic (ChromaDB)...")
        semantic_memory.store_meeting(
            job_id=req.job_id,
            title=req.title,
            transcript_text=req.transcript_text,
            summary=req.summary,
            metadata={"date": "", "attendees": req.attendees},
        )
        print(f"[memory] Semantic memory stored OK")
        # Ephemeral memory — structured data
        if req.action_items:
            ephemeral_memory.save_action_items(req.job_id, req.action_items, req.title)
            print(f"[memory] Saved {len(req.action_items)} action items to ephemeral memory")
        if req.budgets:
            ephemeral_memory.save_budgets(req.job_id, req.budgets, req.title)
            print(f"[memory] Saved {len(req.budgets)} budget items")
        if req.decisions:
            ephemeral_memory.save_decisions(req.job_id, req.decisions, req.title)
            print(f"[memory] Saved {len(req.decisions)} decisions")
        count = semantic_memory.count()
        print(f"[memory] Save context complete — semantic count: {count}")
        return {"success": True, "semantic_count": count}
    except Exception as e:
        print(f"[api] POST /memory/save_context ERROR: {e}")
        raise HTTPException(500, f"Save context failed: {e}")


@app.get("/transcribe/audio/{job_id}")
async def get_audio(job_id: str):
    """Serve the audio file for playback in the UI.

    Tries in order:
      1. standardized.wav (16kHz mono — preferred for processing)
      2. Any original.* file (raw uploaded format)
    """
    from fastapi.responses import FileResponse
    from pathlib import Path
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


@app.get("/transcribe/job_logs/{job_id}")
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


@app.get("/transcribe/job_files/{job_id}")
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


@app.get("/transcribe/pipeline_log/{job_id}")
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


# ── Speaker Labeling (pause & resume) ──

@app.get("/transcribe/speaker_clips/{job_id}")
async def get_speaker_clips(job_id: str):
    """Return detected speakers with audio clip URLs for manual labeling.

    Only available when status is 'paused_for_labeling'. Returns each
    detected speaker with a playable audio clip URL so the user can
    hear who they are and assign a name.
    """
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] != "paused_for_labeling":
        raise HTTPException(409, f"Job is not paused for labeling (status={s['status']})")

    diar_data = uploader.load_diarization(job_id)
    if not diar_data or "speaker_segments" not in diar_data:
        raise HTTPException(500, "Diarization data not found for this job")

    speaker_segments = diar_data["speaker_segments"]
    audio_path = uploader.get_audio_path(job_id)
    metadata = uploader.get_metadata(job_id)
    attendee_names = metadata.get("attendees", [])

    speakers = []
    for spk, segs in speaker_segments.items():
        # Find the longest segment for a good sample clip
        longest = max(segs, key=lambda s: s["duration"])
        clip_duration = min(3.0, longest["duration"])
        clip_start = longest["start"]
        clip_end = clip_start + clip_duration

        speakers.append({
            "speaker_id": spk,
            "segment_count": len(segs),
            "total_duration": sum(s["duration"] for s in segs),
            "sample_clip_url": f"/transcribe/audio/speaker_clip/{job_id}/{spk}/0",
            "sample_start": clip_start,
            "sample_end": clip_end,
            "suggested_name": attendee_names[len(speakers)] if len(speakers) < len(attendee_names) else "",
        })

    # Include non-speaking attendees from reconciliation data (if available)
    reconciliation = s.get("reconciliation", {})
    non_speaking = reconciliation.get("non_speaking_attendees", [])
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

    return {
        "job_id": job_id,
        "speakers": speakers,
        "total_speakers": len(speakers),
        "non_speaking_attendees": non_speaking_full,
    }


@app.get("/transcribe/audio/speaker_clip/{job_id}/{speaker_id}/{clip_index}")
async def serve_speaker_clip(job_id: str, speaker_id: str, clip_index: int):
    """Serve a short audio clip for a detected speaker.

    Extracts ~3 seconds from the middle of the speaker's longest segment
    using ffmpeg, served as a WAV for in-browser playback.
    """
    from fastapi.responses import FileResponse, Response
    import subprocess as _sp
    import tempfile as _tf

    diar_data = uploader.load_diarization(job_id)
    if not diar_data or "speaker_segments" not in diar_data:
        raise HTTPException(404, "Diarization data not found")

    speaker_segments = diar_data["speaker_segments"]
    if speaker_id not in speaker_segments:
        raise HTTPException(404, f"Speaker {speaker_id} not found")

    segs = speaker_segments[speaker_id]
    longest = max(segs, key=lambda s: s["duration"])
    audio_path = uploader.get_audio_path(job_id)

    clip_duration = min(3.0, longest["duration"])
    clip_start = longest["start"]
    clip_end = clip_start + clip_duration

    # Extract clip via ffmpeg to a temp file, serve it, then clean up
    fd, clip_path = _tf.mkstemp(suffix=f"_{speaker_id}.wav")
    os.close(fd)
    try:
        cmd = [
            config.FFMPEG_PATH, "-y",
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


@app.post("/transcribe/label_and_resume/{job_id}")
async def label_and_resume(job_id: str, labels: list = Body(...)):
    """Accept speaker labels from the user and resume the pipeline.

    Body: JSON array of {speaker_id, name, email?}
    Saves voiceprints with actual audio embeddings, remaps speaker IDs,
    then continues the pipeline from diarization → ASR → alignment → agent.
    """
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] != "paused_for_labeling":
        raise HTTPException(409, f"Job is not paused for labeling (status={s['status']})")

    if not labels or not isinstance(labels, list):
        raise HTTPException(400, "Body must be a JSON array of {speaker_id, name} objects")

    print(f"[api] POST /transcribe/label_and_resume/{job_id} labels={[l.get('name', '?') for l in labels]}")

    # Save voiceprints with actual audio embeddings
    diar_data = uploader.load_diarization(job_id)
    audio_path = uploader.get_audio_path(job_id)
    label_map = {}
    for label in labels:
        spk = label.get("speaker_id", "")
        name = label.get("name", "").strip()
        email = label.get("email", "").strip()
        if not spk or not name:
            continue
        label_map[spk] = {"name": name, "email": email}

        # Extract an actual embedding from this speaker's audio
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
                    seg_emb = vp_manager.extract_embedding(
                        audio_path, segment=(s["start"], s["end"])
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
                vp_manager.save_voiceprint(
                    name, email, emb,
                    sample_job_id=job_id,
                    sample_start=sample_start,
                    sample_end=sample_end,
                )
                print(f"[api]   ✅ Saved voiceprint for '{name}' ({spk}) — "
                      f"averaged over {len(sampled_embs)} segment(s)")
            else:
                # Fallback: use the longest segment
                longest = max(segs, key=lambda s: s["duration"])
                try:
                    emb = vp_manager.extract_embedding(
                        audio_path,
                        segment=(longest["start"], longest["end"]),
                    )
                    sample_start = longest["start"]
                    sample_end = min(longest["end"], sample_start + 3.0)
                    vp_manager.save_voiceprint(
                        name, email, emb,
                        sample_job_id=job_id,
                        sample_start=sample_start,
                        sample_end=sample_end,
                    )
                    print(f"[api]   ✅ Saved voiceprint (fallback) for '{name}' ({spk})")
                except Exception as e:
                    print(f"[api]   ⚠️  Could not extract embedding for '{name}': {e}")
                    vp_manager.save_voiceprint(name, email, None)

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
            uploader.save_transcript(job_id, transcript)
            uploader.save_transcript_text(job_id, transcript)
            aligned = transcript
        else:
            aligned = []

        metadata = uploader.get_metadata(job_id)
        skip = metadata.get("skip_steps")
        _update_active(job_id, "ready_for_agent", 0.95)

        # Build reconciliation from user labels + saved pre-labeling state
        # At this point all speakers should be known (user labeled them all)
        saved_reconciliation = s.get("reconciliation", {})
        matched_speakers = saved_reconciliation.get("matched_speakers", [])
        non_speaking = saved_reconciliation.get("non_speaking_attendees", [])

        # Add newly labeled speakers to the matched list
        for spk, info in label_map.items():
            matched_speakers.append({
                "name": info["name"],
                "email": info.get("email", ""),
                "speaker_id": spk,
                "confidence": 1.0,  # User-confirmed
            })

        # Register ALL attendees in ephemeral DB after full reconciliation
        all_attendee_names = list(dict.fromkeys(
            [s["name"] for s in matched_speakers] +
            [ns["name"] for ns in non_speaking]
        ))
        all_attendee_emails = []
        for name in all_attendee_names:
            email = next(
                (s.get("email", "") for s in matched_speakers if s["name"] == name),
                next((ns.get("email", "") for ns in non_speaking if ns["name"] == name), "")
            )
            all_attendee_emails.append(email)

        try:
            ephemeral_memory.register_attendees(
                all_attendee_names, all_attendee_emails,
                source="manual_labeling", job_id=job_id,
            )
            print(f"[label_and_resume] Registered {len(all_attendee_names)} attendee(s) "
                  f"({len(matched_speakers)} spoke, {len(non_speaking)} non-speaking) "
                  f"after labeling")
        except Exception as e:
            print(f"[label_and_resume] ⚠️  Could not register attendees: {e}")

        # Persist ML pipeline completion stats
        try:
            total_chars = sum(len(s.get("text", "")) for s in aligned)
            ephemeral_memory.upsert_job(job_id, {
                "transcript_segment_count": len(aligned),
                "transcript_char_count": total_chars,
                "audio_duration_sec": aligned[-1]["end"] if aligned else None,
            })
        except Exception as e:
            print(f"[label_and_resume] Warning: could not update job record: {e}")

        non_speaking_names = [ns["name"] for ns in non_speaking]
        agent_bridge.enqueue_ready(
            job_id, aligned, metadata, skip_steps=skip,
            non_speaking_attendees=non_speaking_names,
        )
        return {"job_id": job_id, "status": "ready_for_agent", "applied_labels": len(label_map)}
    else:
        # Pre-ASR (diarization only) — run full resumed pipeline (ASR → alignment → agent)
        _start_resumed_pipeline(job_id, label_map)
        return {"job_id": job_id, "status": "resuming", "applied_labels": len(label_map)}


def _start_resumed_pipeline(job_id: str, label_map: dict):
    """Launch the resumed pipeline in a background asyncio task."""
    task = asyncio.create_task(_run_resumed_pipeline_async(job_id, label_map))
    _pipeline_tasks[job_id] = task


async def _run_resumed_pipeline_async(job_id: str, label_map: dict):
    """Async wrapper for the resumed pipeline (diarization → ASR → alignment)."""
    async with _pipeline_semaphore:
        print(f"\n{'='*60}")
        print(f"   ▶️  [PIPELINE] Resuming pipeline for job {job_id} (after labeling)")
        print(f"{'='*60}")
        _active_jobs[job_id] = {"status": "resuming", "progress": 0.35, "title": "..."}
        try:
            metadata = uploader.get_metadata(job_id)
            _active_jobs[job_id]["title"] = metadata.get("title", "Untitled")
        except Exception:
            pass
        try:
            await asyncio.to_thread(_run_pipeline_resumed_sync, job_id, label_map)
            print(f"\n{'='*60}")
            print(f"   ✅ [PIPELINE] Resumed pipeline complete for job {job_id}")
            print(f"{'='*60}\n")
        except asyncio.CancelledError:
            _pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} task cancelled.")
            _active_jobs.pop(job_id, None)
            raise
        except Exception as e:
            print(f"\n   ❌ [pipeline] ERROR in resumed job {job_id}: {e}")
            import traceback
            traceback.print_exc()
            uploader.update_status(job_id, {"status": "failed", "error": str(e)})
            agent_bridge.enqueue_failed(job_id, str(e), {})
        finally:
            _pipeline_tasks.pop(job_id, None)
            _pipeline_cancel.discard(job_id)
            _active_jobs.pop(job_id, None)
            _cleanup_pipeline_resources()


def _run_pipeline_resumed_sync(job_id: str, label_map: dict):
    """Resumed pipeline — loads saved diarization, skips to ASR + alignment.

    The diarization was already done and saved. We load it, apply the
    user-provided label map, then run ASR, alignment, and enqueue for agent.

    All progress is also written to the per-job pipeline.log file.
    """
    jlog = _setup_job_logger(job_id)
    try:
        _update_active(job_id, "resuming", 0.35)
        engine = TranscriptionEngine()
        metadata = uploader.get_metadata(job_id)
        audio_path = uploader.get_audio_path(job_id)

        # Load saved diarization
        diar_data = uploader.load_diarization(job_id)
        if not diar_data or "diarization" not in diar_data:
            raise RuntimeError("Diarization data not found — cannot resume pipeline")
        diarization = diar_data["diarization"]
        speaker_segments = diar_data["speaker_segments"]
        jlog.log(f"[pipeline] Loaded saved diarization ({len(diarization)} segments, "
              f"{len(speaker_segments)} speakers)")

        # Build match_result from user labels
        unknown = []
        known = {}
        for spk, segs in speaker_segments.items():
            if spk in label_map:
                info = label_map[spk]
                known[info["name"]] = segs
            else:
                unknown.append({
                    "speaker_id": spk,
                    "segments": [{"start": s["start"], "end": s["end"], "duration": s["duration"], "speaker": s["speaker"]} for s in segs],
                    "sample_segment": {"start": segs[0]["start"], "end": segs[0]["end"]},
                })
        match_result = {"known": known, "unknown": unknown}
        jlog.log(f"[pipeline] User labels applied: {len(known)} known, {len(unknown)} unknown")

        # ── Attendee reconciliation after labeling ──
        metadata_attendees = metadata.get("attendees", [])
        metadata_attendee_emails = metadata.get("attendeeEmails", [])
        reconciliation = _reconcile_attendees(
            metadata_attendees, metadata_attendee_emails,
            match_result, speaker_segments,
        )
        matched_names = [s["name"] for s in reconciliation["matched_speakers"]]
        non_speaking_names = [s["name"] for s in reconciliation["non_speaking_attendees"]]
        unknown_ids = [u["speaker_id"] for u in reconciliation["unknown_speakers"]]
        jlog.log(f"[reconciliation] Attendee reconciliation (resumed): "
              f"{len(matched_names)} matched speaker(s), "
              f"{len(non_speaking_names)} non-speaking, "
              f"{len(unknown_ids)} unknown")
        if non_speaking_names:
            jlog.log(f"[reconciliation]   Non-speaking attendees "
                  f"(present but did not speak): {non_speaking_names}")

        # ── Step 3: ASR Transcription ──
        jlog.log(f"\n   🎤 [PIPELINE] Step 3/5: ASR transcription (Whisper)...")
        _update_active(job_id, "processing_transcription", 0.5)
        if _check_cancelled(job_id): return
        t_asr = time.time()
        transcription = engine.run_transcription(audio_path)
        asr_elapsed = time.time() - t_asr

        # ── Step 4: Alignment ──
        jlog.log(f"\n   🔗 [PIPELINE] Step 4/5: Aligning diarization with transcript...")
        _update_active(job_id, "aligning", 0.7)
        if _check_cancelled(job_id): return
        t_align = time.time()
        aligned = engine.align_transcript(transcription, diarization)
        align_elapsed = time.time() - t_align

        # Apply user-provided speaker labels with ASV feedback
        label_count = 0
        asv_logged = 0
        for seg in aligned:
            for name, segs in known.items():
                for s in segs:
                    if abs(seg["start"] - s["start"]) < 0.5:
                        seg["speaker"] = name
                        label_count += 1
                        # Log ASV feedback for the first N segments
                        if asv_logged < 50 and seg.get("text", "").strip():
                            asv_logged += 1
                            ts_start = seg.get("start", 0)
                            ts_end = seg.get("end", 0)
                            text = seg.get("text", "").strip()
                            jlog.log(f"[transcription] [{ts_start:>8.3f} --> {ts_end:>8.3f}] "
                                  f"{name}: {text[:200]}")
                        break
        if label_count:
            jlog.log(f"[pipeline] Applied {label_count} speaker label(s) from user"
                  f" — logged {asv_logged} ASV match(es)")

        # Save the raw ASR text (unrefined, before any LLM processing)
        raw_text = transcription.get("text", "")
        if raw_text:
            uploader.save_raw_transcript(job_id, raw_text)

        uploader.save_transcript(job_id, aligned)
        uploader.save_transcript_text(job_id, aligned)
        _update_active(job_id, "transcribed", 0.85)

        # Timing summary
        jlog.log(f"\n{'='*50}")
        jlog.log(f"   ⏱️  RESUMED PIPELINE TIMING")
        jlog.log(f"{'='*50}")
        jlog.log(f"      ASR:             {asr_elapsed:>7.1f}s")
        jlog.log(f"      Alignment:       {align_elapsed*1000:>7.0f}ms")
        jlog.log(f"{'='*50}\n")

        # ── Step 5: Enqueue for agent or pause for labeling ──
        jlog.log(f"\n   📨 [PIPELINE] Step 5/5: Enqueueing for agent runner...")
        if _check_cancelled(job_id): return
        if unknown:
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"]["start"]) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            # Unknown speakers — pause for user labeling (saves real embeddings,
            # unlike the agent-runner path which stores None)
            jlog.log(f"\n   ⏸️  [PIPELINE] {len(unknown)} unknown speaker(s) — pausing for user labeling (post-ASR)")
            # Build speaker info for the UI labeling modal
            speaker_info = []
            for u in unknown:
                spk = u["speaker_id"]
                segs = speaker_segments.get(spk, [])
                longest = max(segs, key=lambda s: s["duration"]) if segs else {"start": 0, "end": 0}
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest.get("start", 0),
                    "sample_end": longest.get("end", 0),
                })
            _update_active(job_id, "paused_for_labeling", 0.9,
                          labeling_phase="post_asr", speakers=speaker_info,
                          unknown_speakers=unknown,
                          reconciliation={
                              "matched_speakers": reconciliation["matched_speakers"],
                              "non_speaking_attendees": reconciliation["non_speaking_attendees"],
                          })
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Unknown speakers: {', '.join(u['speaker_id'] for u in unknown)}")

            # Register matched speakers and non-speaking attendees now
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="manual_labeling"
            )
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume
        else:
            _update_active(job_id, "ready_for_agent", 0.95)
            skip = metadata.get("skip_steps")
            jlog.log(f"[pipeline] All speakers known — enqueueing ready_for_processing")

            # Register attendees in ephemeral DB AFTER full reconciliation
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="manual_labeling"
            )

            # Persist ML pipeline completion stats
            try:
                total_chars = sum(len(s.get("text", "")) for s in aligned)
                ephemeral_memory.upsert_job(job_id, {
                    "transcript_segment_count": len(aligned),
                    "transcript_char_count": total_chars,
                    "audio_duration_sec": aligned[-1]["end"] if aligned else None,
                })
            except Exception as e:
                jlog.log(f"[pipeline] Warning: could not update job record: {e}")

            agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=non_speaking_names,
            )

    except Exception as e:
        jlog.log(f"\n   ❌ [pipeline] ERROR in resumed job {job_id}: {e}")
        import traceback
        traceback.print_exc()
        uploader.update_status(job_id, {"status": "failed", "error": str(e)})
        agent_bridge.enqueue_failed(job_id, str(e), {})
    finally:
        jlog.close()
        _pipeline_cancel.discard(job_id)


# ── Job record upsert (called from agent-runner for touchpoints C & D) ──

@app.post("/transcribe/job/upsert")
async def upsert_job_record(data: dict = Body(...)):
    """Partial-upsert a job record. Accepts any subset of allowed columns.
    Used by the agent runner to persist LLM token usage, pipeline steps,
    and delivery results mid-pipeline.
    """
    job_id = data.get("jobId") or data.get("job_id")
    if not job_id:
        raise HTTPException(400, "Missing jobId/job_id")
    try:
        # Map camelCase keys from JS to snake_case DB columns
        key_map = {
            "jobId": None,
            "job_id": None,
            "configSnapshot": "config_snapshot",
            "totalPromptTokens": "total_prompt_tokens",
            "totalCompletionTokens": "total_completion_tokens",
            "totalTokens": "total_tokens",
            "llmProvider": "llm_provider",
            "llmModel": "llm_model",
            "inputCost": "input_cost",
            "outputCost": "output_cost",
            "totalCost": "total_cost",
            "pipelineSteps": "pipeline_steps",
            "deliveryAttempted": "delivery_attempted",
            "deliveryResults": "delivery_results",
            "audioUrl": "audio_url",
            "audioSizeBytes": "audio_size_bytes",
            "audioDurationSec": "audio_duration_sec",
            "errorMessage": "error_message",
            "transcriptSegmentCount": "transcript_segment_count",
            "transcriptCharCount": "transcript_char_count",
            "summaryCharCount": "summary_char_count",
            "hasAnalysis": "has_analysis",
            "analysisCharCount": "analysis_char_count",
            "completedAt": "completed_at",
        }
        updates = {}
        for js_key, db_col in key_map.items():
            if js_key in data:
                val = data[js_key]
                if db_col is not None:
                    updates[db_col] = val
        # Also pass through any snake_case keys directly
        for key, value in data.items():
            if key not in key_map and key not in ("jobId", "job_id"):
                updates[key] = value

        ephemeral_memory.upsert_job(job_id, updates)
        print(f"[api] POST /transcribe/job/upsert/{job_id[:8]} → {len(updates)} field(s) updated")
        return {"success": True, "job_id": job_id}
    except Exception as e:
        print(f"[api] POST /transcribe/job/upsert ERROR: {e}")
        raise HTTPException(500, f"Job upsert failed: {e}")


@app.get("/transcribe/job/{job_id}")
async def get_job_record(job_id: str):
    """Fetch the full ephemeral DB job record for a given job ID.

    Returns the complete row from the jobs table, including config_snapshot,
    token usage, delivery results, and all metadata. Returns 404 if not found.
    """
    try:
        record = ephemeral_memory.get_job(job_id)
    except Exception as e:
        print(f"[api] GET /transcribe/job/{job_id} ERROR: {e}")
        raise HTTPException(500, f"Failed to fetch job record: {e}")

    if not record:
        print(f"[api] GET /transcribe/job/{job_id} → not_found")
        raise HTTPException(404, "Job record not found in ephemeral DB")

    print(f"[api] GET /transcribe/job/{job_id} → OK ({len(record)} fields)")
    return {"job": record}


@app.post("/transcribe/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running pipeline job. Always marks the job as failed."""
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    _pipeline_cancel.add(job_id)
    # Cancel the asyncio task if it's still running
    task = _pipeline_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    uploader.update_status(job_id, {"status": "failed", "error": "Cancelled by user", "progress": 0.0})
    _active_jobs.pop(job_id, None)
    # Persist terminal state
    try:
        ephemeral_memory.upsert_job(job_id, {"result": "cancelled", "completed_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[api] Warning: could not persist cancelled state: {e}")
    print(f"[api] POST /transcribe/cancel/{job_id} → cancelled")
    return {"job_id": job_id, "status": "cancelled", "cancelled": True}


@app.post("/transcribe/fail/{job_id}")
async def fail_job(job_id: str, error: str = "Processing failed"):
    """Mark a job as failed with a specific error message. Called by the agent runner when the LLM pipeline fails."""
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    uploader.update_status(job_id, {"status": "failed", "error": error, "progress": 0.0})
    _active_jobs.pop(job_id, None)
    # Persist terminal state
    try:
        ephemeral_memory.upsert_job(job_id, {"result": "failed", "error_message": error, "completed_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[api] Warning: could not persist failed state: {e}")
    print(f"[api] POST /transcribe/fail/{job_id} → failed: {error[:120]}")
    return {"job_id": job_id, "status": "failed", "error": error}


@app.post("/transcribe/complete/{job_id}")
async def complete_job(job_id: str):
    """Mark a job as complete. Called by the agent runner when the LLM pipeline finishes successfully."""
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    uploader.update_status(job_id, {"status": "complete", "progress": 1.0})
    _active_jobs.pop(job_id, None)

    # Gather final content metrics from disk before persisting
    try:
        summary_path = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
        analysis_path = os.path.join(config.STORAGE_PATH, job_id, "analysis.json")
        summary_char_count = 0
        has_analysis = 0
        analysis_char_count = 0
        if os.path.exists(summary_path):
            with open(summary_path) as f:
                summary_data = json.load(f)
                summary_char_count = len(json.dumps(summary_data))
        if os.path.exists(analysis_path):
            with open(analysis_path) as f:
                analysis_data = json.load(f)
                has_analysis = 1
                analysis_char_count = len(json.dumps(analysis_data))
        ephemeral_memory.upsert_job(job_id, {
            "result": "success",
            "completed_at": datetime.utcnow().isoformat(),
            "summary_char_count": summary_char_count,
            "has_analysis": has_analysis,
            "analysis_char_count": analysis_char_count,
        })
    except Exception as e:
        print(f"[api] Warning: could not persist completed state: {e}")

    print(f"[api] POST /transcribe/complete/{job_id} → complete")
    return {"job_id": job_id, "status": "complete"}


# ── Job Deletion ──

import shutil

@app.delete("/transcribe/job/{job_id}")
async def delete_job(job_id: str):
    """Delete a job and all its associated data from storage."""
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    if not os.path.exists(job_dir):
        print(f"[api] DELETE /transcribe/job/{job_id} → not_found")
        raise HTTPException(404, "Job not found")

    # Ensure it's a real job directory (has status.json)
    if not os.path.exists(os.path.join(job_dir, "status.json")):
        print(f"[api] DELETE /transcribe/job/{job_id} → not a valid job directory")
        raise HTTPException(400, "Not a valid job directory")

    # Cancel if running
    _pipeline_cancel.add(job_id)
    task = _pipeline_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    _active_jobs.pop(job_id, None)

    try:
        shutil.rmtree(job_dir)
        print(f"[api] DELETE /transcribe/job/{job_id} → deleted")
        return {"job_id": job_id, "deleted": True}
    except Exception as e:
        print(f"[api] DELETE /transcribe/job/{job_id} → error: {e}")
        raise HTTPException(500, f"Failed to delete job: {e}")


# ── Log Deletion ──

def _log_file_has_errors(fpath):
    """Check if a log file contains any error events.

    Handles both formats:
      - JSONL (.jsonl): contains "eventType":"failed" or "level":"error"
      - Plain-text (.log): contains [error] or [ERROR]
    """
    try:
        with open(fpath) as f:
            content = f.read()
        if fpath.endswith(".jsonl"):
            return '"eventType":"failed"' in content or '"level":"error"' in content
        else:
            # Plain-text log format: [timestamp] [source] [level] message
            return "[error]" in content or "[ERROR]" in content
    except Exception:
        return False


@app.delete("/storage/logs")
async def delete_logs(log_type: str = "all"):
    """Delete log files from project logs/ and Electron userData logs/ directories.

    Cleans:
      - logs/ — legacy JSONL log files in the project root
      - userData/logs/ — agent runner JSONL + Electron .log files (if configured)

    Query params:
      log_type: "all"                  — delete all files EXCEPT those containing error events
      log_type: "all_including_errors" — delete ALL files (including error files)
      log_type: "error"                — delete only files containing error events
    """
    deleted = 0
    errors = 0

    # Directories to clean: project root logs/ (legacy) + Electron userData logs/
    log_dirs = [
        os.path.join(config._BASE, "logs"),  # logs/*.jsonl (legacy — may be empty after migration)
    ]
    if config.ELECTRON_LOGS_DIR:
        log_dirs.append(config.ELECTRON_LOGS_DIR)  # userData/logs/ — agent JSONL + Electron .log

    for logs_path in log_dirs:
        if not os.path.exists(logs_path):
            continue

        for fname in os.listdir(logs_path):
            if not (fname.endswith(".jsonl") or fname.endswith(".log")):
                continue
            fpath = os.path.join(logs_path, fname)

            # Determine whether this file should be deleted
            if log_type == "error":
                # Delete only files that contain error events
                if not _log_file_has_errors(fpath):
                    continue
            elif log_type == "all":
                # Delete all files EXCEPT those containing error events
                if _log_file_has_errors(fpath):
                    continue
            # else log_type == "all_including_errors": delete everything, no filter

            try:
                os.remove(fpath)
                deleted += 1
                print(f"[api] DELETE /storage/logs → removed {fname} from {logs_path.split('/')[-2]}")
            except Exception as e:
                errors += 1
                print(f"[api] DELETE /storage/logs → failed to remove {fname}: {e}")

    if deleted == 0 and errors == 0:
        return {"deleted": 0, "errors": 0, "log_type": log_type, "message": "No log files found"}


    return {
        "deleted": deleted,
        "errors": errors,
        "log_type": log_type,
        "message": f"Deleted {deleted} log file(s)" + (f" ({errors} error(s))" if errors else ""),
    }


# ── Clear All Job History ──

@app.delete("/storage/jobs")
async def clear_all_jobs():
    """Delete all job directories from storage, preserving non-job dirs (logs, chroma, uploads, .model_cache)."""
    storage_path = config.STORAGE_PATH
    deleted = 0
    errors = 0
    preserved = ["logs", "chroma", "uploads", ".model_cache", "chroma_old"]

    if not os.path.exists(storage_path):
        return {"deleted": 0, "message": "Storage directory does not exist"}

    for entry in os.scandir(storage_path):
        if not entry.is_dir():
            continue
        name = entry.name
        if name in preserved:
            continue

        try:
            shutil.rmtree(entry.path)
            deleted += 1
            print(f"[api] DELETE /storage/jobs → removed {name}")
        except Exception as e:
            errors += 1
            print(f"[api] DELETE /storage/jobs → failed to remove {name}: {e}")

    # Also clear cancelled/active job tracking
    _pipeline_tasks.clear()
    _pipeline_cancel.clear()
    _active_jobs.clear()

    # Also clear from uploader's status cache
    if uploader and hasattr(uploader, '_status_cache'):
        uploader._status_cache.clear()

    msg = f"Deleted {deleted} job director{'y' if deleted == 1 else 'ies'}"
    if errors:
        msg += f" ({errors} error(s))"
    return {"deleted": deleted, "errors": errors, "message": msg}


# ── Clear Semantic Memory (ChromaDB) ──

@app.delete("/storage/semantic")
async def clear_semantic_memory():
    """Delete all ChromaDB vector store data (semantic memory)."""
    chroma_dir = os.path.join(config.STORAGE_PATH, "chroma")
    if not os.path.exists(chroma_dir):
        return {"deleted": False, "message": "No ChromaDB data found"}

    try:
        # Clear in-memory collection reference first
        if semantic_memory:
            semantic_memory._collection = None

        shutil.rmtree(chroma_dir)
        print(f"[api] DELETE /storage/semantic → removed ChromaDB data")
        return {"deleted": True, "message": "Semantic memory (ChromaDB) cleared successfully"}
    except Exception as e:
        print(f"[api] DELETE /storage/semantic → error: {e}")
        raise HTTPException(500, f"Failed to clear semantic memory: {e}")


# ── Clear Ephemeral Memory + Voiceprint Data ──

@app.delete("/storage/ephemeral")
async def clear_ephemeral_data():
    """Delete ephemeral memory database and voiceprint database files."""
    storage_path = config.STORAGE_PATH
    db_files = ["ephemeral_memory.db", "voiceprints.db"]
    deleted_files = []
    errors = []

    for fname in db_files:
        fpath = os.path.join(storage_path, fname)
        if os.path.exists(fpath):
            try:
                # Close any open connections first
                if fname == "ephemeral_memory.db" and ephemeral_memory:
                    ephemeral_memory.close()
                if fname == "voiceprints.db" and vp_manager:
                    vp_manager.close()
                os.remove(fpath)
                deleted_files.append(fname)
                print(f"[api] DELETE /storage/ephemeral → removed {fname}")
            except Exception as e:
                errors.append(f"{fname}: {e}")
                print(f"[api] DELETE /storage/ephemeral → failed to remove {fname}: {e}")

    # Re-initialize so subsequent calls work without restart
    try:
        if ephemeral_memory:
            ephemeral_memory.__init__()
        if vp_manager:
            vp_manager.__init__()
    except Exception as e:
        print(f"[api] DELETE /storage/ephemeral → re-init warning: {e}")

    if not deleted_files and not errors:
        return {"deleted": [], "message": "No database files found"}

    msg = f"Deleted: {', '.join(deleted_files)}" if deleted_files else "Nothing deleted"
    if errors:
        msg += f" | Errors: {', '.join(errors)}"

    return {"deleted": deleted_files, "errors": errors, "message": msg}


@app.get("/transcribe/models/status")
async def models_status():
    """Check which ML models are available. Helps users diagnose setup issues."""
    result = {
        "device": detect_device(),
        "whisper_model": config.WHISPER_MODEL_SIZE,
        "diarization_model": config.DIARIZATION_MODEL,
        "diarization_available": False,
        "diarization_error": None,
        "diarization_traceback": None,
        "hf_token_configured": bool(config.HUGGING_FACE_TOKEN),
    }

    # Try to verify diarization model is loadable
    try:
        from pyannote.audio import Pipeline
        import torch
        hf_token = config.HUGGING_FACE_TOKEN
        if not hf_token:
            result["diarization_error"] = (
                "No HUGGING_FACE_TOKEN set. "
                f"Get a token at https://hf.co/settings/tokens and accept the model terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL}"
            )
        else:
            # PyTorch 2.6+ needs relaxed loading for pyannote pickle models
            import torch as _torch
            _orig_load = _torch.load
            try:
                # Force weights_only=False — lightning_fabric (used by
                # pyannote) explicitly passes weights_only=True, so setdefault
                # is not enough.
                def _permissive_load(f, *a, **kw):
                    kw["weights_only"] = False
                    return _orig_load(f, *a, **kw)
                _torch.load = _permissive_load

                # Try online first so pyannote can check for model updates.
                # Falls back to local cache on network errors (DNS, timeout, etc.).
                try:
                    pipeline = Pipeline.from_pretrained(
                        config.DIARIZATION_MODEL, use_auth_token=hf_token,
                    )
                except Exception as _hub_err:
                    if is_network_error(_hub_err):
                        print(f"[models_status] ⚠️  HuggingFace unreachable ({_hub_err}). "
                              f"Falling back to local cache...")
                        pipeline = Pipeline.from_pretrained(
                            config.DIARIZATION_MODEL, use_auth_token=hf_token,
                            local_files_only=True,
                        )
                    else:
                        raise
                if pipeline is None:
                    result["diarization_error"] = (
                        f"Model '{config.DIARIZATION_MODEL}' returned None — "
                        f"it may be gated. Accept terms at "
                        f"https://hf.co/{config.DIARIZATION_MODEL}"
                    )
                else:
                    pipeline.to(_torch.device("cpu"))
                    result["diarization_available"] = True
                    del pipeline
            finally:
                _torch.load = _orig_load
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        result["diarization_traceback"] = tb
        msg = str(e)
        if "gated" in msg.lower() or "access" in msg.lower() or "token" in msg.lower():
            result["diarization_error"] = (
                "Model is gated — accept terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL} and set HUGGING_FACE_TOKEN"
            )
        elif "module" in msg.lower() and "torchaudio" in msg.lower():
            result["diarization_error"] = (
                f"PyTorch/torchaudio compatibility issue: {msg[:200]}. "
                f"Try reinstalling pyannote.audio: pip install --upgrade pyannote.audio"
            )
        else:
            result["diarization_error"] = f"Model failed to load: {msg[:300]}"

    status_icon = "✅" if result["diarization_available"] else "❌"
    print(f"[api] GET /transcribe/models/status → diarization={status_icon} device={result['device']}")
    if result["diarization_error"]:
        print(f"[api]   diarization_error: {result['diarization_error'][:200]}")
    return result


@app.get("/health")
async def health():
    print(f"[api] GET /health")
    return {"status": "ok", "device": detect_device()}


# ── Storage Usage ──

def _dir_size(path: str) -> int:
    """Recursively compute total size (bytes) of a directory."""
    total = 0
    try:
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
            elif entry.is_dir(follow_symlinks=False):
                total += _dir_size(entry.path)
    except OSError:
        pass
    return total


def _format_bytes(b: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


@app.get("/storage/usage")
async def storage_usage():
    """Report disk usage breakdown: logs, history (job storage), system files, ChromaDB, Ollama models."""
    base = config._BASE  # project root
    storage_path = config.STORAGE_PATH

    # Logs — storage/logs/ mirror + Electron userData logs (if configured)
    logs_dir = os.path.join(storage_path, "logs")
    logs_size = _dir_size(logs_dir) if os.path.exists(logs_dir) else 0
    if config.ELECTRON_LOGS_DIR and os.path.exists(config.ELECTRON_LOGS_DIR):
        logs_size += _dir_size(config.ELECTRON_LOGS_DIR)

    # ChromaDB vector store
    chroma_dir = os.path.join(storage_path, "chroma")
    chroma_size = _dir_size(chroma_dir) if os.path.exists(chroma_dir) else 0

    # History — all job directories in storage/ (exclude logs, chroma, uploads)
    history_size = 0
    job_count = 0
    if os.path.exists(storage_path):
        for entry in os.scandir(storage_path):
            if not entry.is_dir():
                continue
            name = entry.name
            if name in ("logs", "chroma", "uploads", ".model_cache", "chroma_old"):
                continue
            # Check if it has a status.json (i.e. it's a job directory)
            if os.path.exists(os.path.join(entry.path, "status.json")):
                job_count += 1
            history_size += _dir_size(entry.path)

    # System — project source code (python-backend, agent-runner, bridge-server, electron, agent-config)
    system_dirs = ["python-backend", "agent-runner", "bridge-server", "electron", "agent-config"]
    system_size = 0
    for d in system_dirs:
        p = os.path.join(base, d)
        if os.path.exists(p):
            system_size += _dir_size(p)

    # Also include other root-level files (package.json, scripts, etc.)
    root_files_size = 0
    if os.path.exists(base):
        for entry in os.scandir(base):
            if entry.is_file(follow_symlinks=False):
                try:
                    root_files_size += entry.stat().st_size
                except OSError:
                    pass

    system_size += root_files_size

    # Databases — ephemeral memory + voiceprint SQLite files at root of storage/
    db_files = ["ephemeral_memory.db", "voiceprints.db"]
    databases_size = 0
    for fname in db_files:
        fpath = os.path.join(storage_path, fname)
        if os.path.isfile(fpath):
            try:
                databases_size += os.path.getsize(fpath)
            except OSError:
                pass

    # Ollama models — ~/.ollama directory (downloaded LLM models)
    ollama_dir = os.path.expanduser("~/.ollama")
    ollama_size = _dir_size(ollama_dir) if os.path.exists(ollama_dir) else 0

    total = logs_size + history_size + system_size + chroma_size + databases_size + ollama_size

    # File paths for each category
    storage_paths = {
        "history": storage_path,
        "logs": os.path.join(storage_path, "logs") if os.path.exists(os.path.join(storage_path, "logs")) else (config.ELECTRON_LOGS_DIR or None),
        "chroma": os.path.join(storage_path, "chroma") if os.path.exists(os.path.join(storage_path, "chroma")) else None,
        "databases": storage_path,
        "system": base,
        "ollama": ollama_dir if os.path.exists(ollama_dir) else None,
    }

    return {
        "logs": {"bytes": logs_size, "human": _format_bytes(logs_size), "path": storage_paths["logs"]},
        "history": {"bytes": history_size, "human": _format_bytes(history_size), "job_count": job_count, "path": storage_paths["history"]},
        "chroma": {"bytes": chroma_size, "human": _format_bytes(chroma_size), "path": storage_paths["chroma"]},
        "databases": {"bytes": databases_size, "human": _format_bytes(databases_size), "path": storage_paths["databases"]},
        "system": {"bytes": system_size, "human": _format_bytes(system_size), "path": storage_paths["system"]},
        "ollama": {"bytes": ollama_size, "human": _format_bytes(ollama_size), "path": storage_paths["ollama"]},
        "total": {"bytes": total, "human": _format_bytes(total)},
    }


# ── Database browsing (for DevPanel) ──

EPHEMERAL_TABLES = {
    "jobs": {"label": "Jobs", "columns": ["id", "title", "result", "attendees", "total_tokens", "total_cost", "llm_provider", "llm_model", "transcript_segment_count", "transcript_char_count", "has_analysis", "audio_duration_sec", "delivery_attempted", "error_message", "created_at", "updated_at", "completed_at"]},
    "attendees": {"label": "Attendees", "columns": ["id", "name", "email", "source", "job_id", "first_seen", "last_seen"]},
    "action_items": {"label": "Action Items", "columns": ["id", "job_id", "description", "assignee", "deadline", "status", "priority", "source_meeting", "created_at"]},
    "contacts": {"label": "Contacts", "columns": ["id", "name", "email", "organization", "role", "phone", "source_meeting", "first_mentioned", "last_mentioned"]},
    "budgets": {"label": "Budgets", "columns": ["id", "job_id", "description", "amount", "currency", "category", "source_meeting", "created_at"]},
    "decisions": {"label": "Decisions", "columns": ["id", "job_id", "description", "rationale", "made_by", "source_meeting", "created_at"]},
    "notes": {"label": "Notes", "columns": ["id", "job_id", "topic", "content", "created_at"]},
}


@app.post("/memory/ephemeral/register_attendees")
async def memory_register_attendees(req: RegisterAttendeesRequest):
    """Register one or more meeting attendees in ephemeral memory."""
    print(f"[api] POST /memory/ephemeral/register_attendees names={req.names}")
    try:
        ephemeral_memory.register_attendees(
            req.names, req.emails, source=req.source, job_id=req.job_id
        )
        print(f"[api] Registered {len(req.names)} attendee(s)")
        return {"success": True, "count": len(req.names)}
    except Exception as e:
        print(f"[api] POST /memory/ephemeral/register_attendees ERROR: {e}")
        raise HTTPException(500, f"Register attendees failed: {e}")


@app.get("/memory/ephemeral/list_attendees")
async def memory_list_attendees(limit: int = 100):
    """List all registered attendees, newest first."""
    print(f"[api] GET /memory/ephemeral/list_attendees limit={limit}")
    try:
        attendees = ephemeral_memory.list_attendees(limit=limit)
        return {"attendees": attendees}
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/list_attendees ERROR: {e}")
        raise HTTPException(500, f"List attendees failed: {e}")


@app.get("/memory/ephemeral/search_attendees")
async def memory_search_attendees(name: str = "", limit: int = 50):
    """Search registered attendees by name (substring match)."""
    print(f"[api] GET /memory/ephemeral/search_attendees name='{name}' limit={limit}")
    try:
        attendees = ephemeral_memory.query_attendees(name=name, limit=limit)
        return {"attendees": attendees}
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/search_attendees ERROR: {e}")
        raise HTTPException(500, f"Search attendees failed: {e}")


@app.get("/memory/ephemeral/tables")
async def memory_ephemeral_tables():
    """List all ephemeral memory tables with row counts (read-only, for DevPanel)."""
    print(f"[api] GET /memory/ephemeral/tables")
    try:
        # Get row counts for each table using COUNT(*) — avoids fetching all rows
        table_list = []
        for name, info in EPHEMERAL_TABLES.items():
            count = ephemeral_memory.row_count(name)
            table_list.append({
                "name": name,
                "label": info["label"],
                "columns": info["columns"],
                "row_count": count,
            })
        return {"tables": table_list}
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/tables ERROR: {e}")
        raise HTTPException(500, f"Failed to list tables: {e}")


@app.get("/memory/ephemeral/table/{table_name}")
async def memory_ephemeral_table(table_name: str, limit: int = 100, offset: int = 0):
    """Get rows from an ephemeral memory table (read-only, for DevPanel)."""
    print(f"[api] GET /memory/ephemeral/table/{table_name} limit={limit} offset={offset}")
    if table_name not in EPHEMERAL_TABLES:
        raise HTTPException(404, f"Unknown table: {table_name}")

    try:
        all_rows = ephemeral_memory.query_all(table_name, "", limit + offset)
        total = len(all_rows)
        rows = all_rows[offset:offset + limit]
        return {
            "table": table_name,
            "columns": EPHEMERAL_TABLES[table_name]["columns"],
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/table/{table_name} ERROR: {e}")
        raise HTTPException(500, f"Failed to query table: {e}")


@app.get("/memory/semantic/meetings")
async def memory_semantic_meetings():
    """List meetings stored in ChromaDB semantic memory (read-only, for DevPanel)."""
    print(f"[api] GET /memory/semantic/meetings")
    try:
        # Get all data from the collection
        semantic_memory._ensure_loaded()
        coll = semantic_memory._collection
        all_data = coll.get(include=["metadatas"])
        meetings = []
        seen = set()
        if all_data and all_data["ids"]:
            for i in range(len(all_data["ids"])):
                meta = all_data["metadatas"][i] if all_data.get("metadatas") else {}
                job_id = meta.get("job_id", "")
                # Deduplicate by job_id (each meeting has 2 chunks: summary + transcript)
                if job_id and job_id not in seen:
                    seen.add(job_id)
                    meetings.append({
                        "id": all_data["ids"][i],
                        "job_id": job_id,
                        "title": meta.get("title", "Unknown"),
                        "type": meta.get("type", "unknown"),
                        "attendees": meta.get("attendees", ""),
                        "timestamp": meta.get("timestamp", ""),
                    })
        return {"meetings": meetings, "total": len(meetings)}
    except Exception as e:
        print(f"[api] GET /memory/semantic/meetings ERROR: {e}")
        raise HTTPException(500, f"Failed to list meetings: {e}")


@app.get("/memory/semantic/stats")
async def memory_semantic_stats():
    """Get embedding collection stats (read-only, for DevPanel)."""
    print(f"[api] GET /memory/semantic/stats")
    try:
        semantic_memory._ensure_loaded()
        coll = semantic_memory._collection
        all_data = coll.get(include=["metadatas"])
        total_chunks = len(all_data["ids"]) if all_data and all_data["ids"] else 0

        # Count unique meetings
        seen_jobs = set()
        type_counts = {}
        for meta in (all_data.get("metadatas") or []):
            if meta:
                jid = meta.get("job_id", "")
                if jid:
                    seen_jobs.add(jid)
                ctype = meta.get("type", "unknown")
                type_counts[ctype] = type_counts.get(ctype, 0) + 1

        # Get embedding dimension from the collection
        dimension = None
        try:
            if total_chunks > 0:
                sample = coll.get(ids=[all_data["ids"][0]], include=["embeddings"])
                if sample.get("embeddings"):
                    dimension = len(sample["embeddings"][0])
        except Exception:
            pass

        # Get collection metadata for total vector count
        collection_meta = coll.metadata or {}

        return {
            "total_chunks": total_chunks,
            "unique_meetings": len(seen_jobs),
            "chunks_by_type": type_counts,
            "embedding_dimension": dimension,
            "collection_hnsw_space": collection_meta.get("hnsw:space", "cosine"),
            "status": "ok",
        }
    except Exception as e:
        print(f"[api] GET /memory/semantic/stats ERROR: {e}")
        raise HTTPException(500, f"Failed to get stats: {e}")


@app.get("/memory/semantic/search")
async def memory_semantic_search(query: str = "", n: int = 5):
    """Search semantic memory by natural language query (read-only, for DevPanel)."""
    print(f"[api] GET /memory/semantic/search?q={query}&n={n}")
    if not query.strip():
        return {"results": [], "query": query, "status": "ok"}
    try:
        results = semantic_memory.search(query, n_results=n)
        return {"results": results, "query": query, "status": "ok"}
    except Exception as e:
        print(f"[api] GET /memory/semantic/search ERROR: {e}")
        raise HTTPException(500, f"Search failed: {e}")


@app.get("/memory/semantic/overlap")
async def memory_semantic_overlap():
    """Analyze cross-meeting overlap — common attendees, shared keywords (read-only, for DevPanel).

    Returns:
      - common_attendees: attendees that appear in 2+ meetings with meeting titles
      - keyword_overlap: top keywords that appear across multiple meeting summaries
    """
    print(f"[api] GET /memory/semantic/overlap")
    try:
        semantic_memory._ensure_loaded()
        coll = semantic_memory._collection
        all_data = coll.get(include=["metadatas", "documents"])

        if not all_data or not all_data["ids"]:
            return {"common_attendees": [], "keyword_overlap": [], "status": "ok"}

        # ── Attendee overlap ──
        # Build: attendee_name -> [{job_id, title}]
        attendee_map = {}
        meeting_titles = {}
        for i in range(len(all_data["ids"])):
            meta = all_data["metadatas"][i] if all_data.get("metadatas") else {}
            job_id = meta.get("job_id", "")
            title = meta.get("title", "Unknown")
            if job_id:
                meeting_titles[job_id] = title
            attendees_str = meta.get("attendees", "").strip()
            if attendees_str:
                for att in [a.strip() for a in attendees_str.split(",") if a.strip()]:
                    if att not in attendee_map:
                        attendee_map[att] = {}
                    if job_id:
                        attendee_map[att][job_id] = title

        # Filter to attendees in 2+ meetings
        common_attendees = []
        for att, meetings_dict in attendee_map.items():
            if len(meetings_dict) >= 2:
                common_attendees.append({
                    "name": att,
                    "meeting_count": len(meetings_dict),
                    "meetings": [{"job_id": jid, "title": title} for jid, title in meetings_dict.items()],
                })
        common_attendees.sort(key=lambda x: -x["meeting_count"])

        # ── Keyword overlap ──
        # Collect summary documents per meeting, extract common keywords
        from collections import Counter
        import re

        meeting_keywords = {}  # job_id -> set of lowercase words
        for i in range(len(all_data["ids"])):
            meta = all_data["metadatas"][i] if all_data.get("metadatas") else {}
            if meta.get("type") != "meeting_summary":
                continue
            job_id = meta.get("job_id", "")
            doc = all_data["documents"][i] if all_data.get("documents") else ""
            if job_id and doc:
                # Extract meaningful words (3+ chars, not numbers)
                words = set(
                    w.lower() for w in re.findall(r'\b[a-zA-Z]{3,}\b', doc)
                    if w.lower() not in _STOP_WORDS
                )
                if job_id not in meeting_keywords:
                    meeting_keywords[job_id] = set()
                meeting_keywords[job_id].update(words)

        # Find words that appear across multiple meetings
        word_meeting_count = Counter()
        for jid, words in meeting_keywords.items():
            for w in words:
                word_meeting_count[w] += 1

        keyword_overlap = [
            {"word": word, "meeting_count": count}
            for word, count in word_meeting_count.most_common(30)
            if count >= 2
        ]

        return {
            "common_attendees": common_attendees,
            "keyword_overlap": keyword_overlap,
            "status": "ok",
        }
    except Exception as e:
        print(f"[api] GET /memory/semantic/overlap ERROR: {e}")
        raise HTTPException(500, f"Failed to get overlap: {e}")


# ── Stop words for keyword overlap analysis ──

_STOP_WORDS = {
    "the", "and", "for", "that", "this", "with", "have", "will", "was",
    "are", "not", "but", "from", "they", "you", "all", "can", "has",
    "had", "its", "than", "been", "more", "also", "very", "just",
    "about", "over", "into", "them", "then", "some", "what", "when",
    "where", "which", "their", "there", "these", "those", "would",
    "could", "should", "after", "such", "only", "other", "each",
    "well", "did", "does", "done", "going", "make", "made", "take",
    "took", "think", "know", "like", "need", "want", "see", "way",
    "back", "much", "still", "also", "even", "may", "might", "must",
    "new", "now", "one", "two", "use", "used", "get", "got", "say",
    "said", "tell", "told", "ask", "asked", "put", "set", "let",
    "come", "came", "went", "go", "yes", "sure", "okay", "right",
    "look", "looks", "looking", "thing", "things", "really", "actually",
    "basically", "probably", "maybe", "please", "thank", "thanks",
    "yes", "no", "well", "good", "great", "best", "better", "first",
    "last", "next", "previous", "following", "done", "doing", "does",
    "being", "been", "having", "getting", "making", "taking",
}


# ── Per-job logger ──

class JobLogger:
    """Writes pipeline logs to stdout only.

    The Electron main process captures stdout and writes all entries to the
    per-job ``<storage>/<job_id>/pipeline.log`` via ``addLog()``.
    The per-job log is automatically closed when the pipeline completes or fails.
    """

    def __init__(self, job_id: str):
        self.job_id = job_id
        job_dir = os.path.join(config.STORAGE_PATH, job_id)
        os.makedirs(job_dir, exist_ok=True)

    def log(self, message: str):
        """Write a message to stdout (captured by Electron → per-job pipeline.log)."""
        print(message)

    def close(self):
        """No-op — file writing is handled by Electron's addLog()."""
        pass

    def __del__(self):
        self.close()


class _NullLogger:
    """Fallback logger that only prints to stdout."""
    def log(self, message: str):
        print(message)
    def close(self):
        pass


def _setup_job_logger(job_id: str):
    """Create a JobLogger for the given job, or a null fallback."""
    try:
        return JobLogger(job_id)
    except Exception as e:
        print(f"[pipeline] ⚠️  Could not create job logger for {job_id}: {e}")
        return _NullLogger()


# ── Attendee reconciliation helper ──

def _reconcile_attendees(metadata_attendees: list, attendee_emails: list,
                         match_result: dict,
                         speaker_segments: dict) -> dict:
    """Cross-reference registered attendees against voiceprint matching results
    to determine who spoke, who didn't, and who is entirely new.

    Returns a dict:
      matched_speakers: [{name, email, speaker_id, confidence}]
      non_speaking_attendees: [{name, email}] — registered but never detected as speakers
      unknown_speakers: [{speaker_id, ...}] — detected speakers not matched to any attendee
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
        # Find which speaker_id(s) map to this name by checking segment overlap
        for spk_id, spk_segs in speaker_segments.items():
            for s in spk_segs[:5]:  # Check first few segments
                for ks in segs[:5]:
                    if abs(s.get("start", 0) - ks.get("start", 0)) < 0.5:
                        speaker_to_name[spk_id] = name
                        break
                if spk_id in speaker_to_name:
                    break
            if spk_id in speaker_to_name:
                break
        # If no speaker_id found, associate with any unmatched speaker
        if name not in speaker_to_name.values():
            for spk_id in all_detected_speaker_ids:
                if spk_id not in speaker_to_name:
                    speaker_to_name[spk_id] = name
                    break

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
    }


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
    """
    all_attendees = []
    all_emails = []

    for s in reconciliation.get("matched_speakers", []):
        all_attendees.append(s["name"])
        all_emails.append(s.get("email", ""))

    for ns in reconciliation.get("non_speaking_attendees", []):
        all_attendees.append(ns["name"])
        all_emails.append(ns.get("email", ""))

    if not all_attendees:
        return

    try:
        ephemeral_memory.register_attendees(
            all_attendees, all_emails,
            source=source, job_id=job_id,
        )
        print(f"[reconciliation] Registered {len(all_attendees)} attendee(s) "
              f"({len(reconciliation.get('matched_speakers', []))} spoke, "
              f"{len(reconciliation.get('non_speaking_attendees', []))} non-speaking) "
              f"for job {job_id[:8]} in ephemeral DB")
    except Exception as e:
        print(f"[reconciliation] ⚠️  Could not register attendees for job {job_id}: {e}")


# ── Pipeline management ──

def _start_pipeline_async(job_id: str):
    """Fire-and-forget: create an asyncio task for the pipeline, tracked
    so it can be cancelled and monitored via the /transcribe/active endpoint."""
    task = asyncio.create_task(_run_pipeline_async(job_id))
    _pipeline_tasks[job_id] = task


def _check_cancelled(job_id: str) -> bool:
    """Check if this job has been cancelled. Returns True if cancelled."""
    if job_id in _pipeline_cancel:
        print(f"\n   🛑 [pipeline] Job {job_id} cancelled — stopping.")
        _pipeline_cancel.discard(job_id)
        _pipeline_tasks.pop(job_id, None)
        _active_jobs.pop(job_id, None)
        return True
    return False


async def _run_pipeline_async(job_id: str):
    """Async wrapper around the synchronous ML pipeline.

    Uses ``asyncio.to_thread()`` to offload CPU-bound ML work to a thread
    pool, allowing the event loop to handle other requests concurrently.
    An ``asyncio.Semaphore`` limits how many pipelines run simultaneously.

    The synchronous ``_run_pipeline`` function runs in a thread. Cancellation
    is cooperative — the thread checks ``_pipeline_cancel`` between steps.
    """
    async with _pipeline_semaphore:
        print(f"\n{'='*60}")
        print(f"   🎬 [PIPELINE] Starting pipeline for job {job_id}")
        print(f"{'='*60}")
        _active_jobs[job_id] = {"status": "initializing", "progress": 0.0, "title": "..."}
        try:
            # Fetch metadata upfront (lightweight, no ML)
            metadata = uploader.get_metadata(job_id)
            _active_jobs[job_id]["title"] = metadata.get("title", "Untitled")
        except Exception:
            pass
        try:
            await asyncio.to_thread(_run_pipeline_sync, job_id)
            print(f"\n{'='*60}")
            print(f"   ✅ [PIPELINE] Pipeline complete for job {job_id}")
            print(f"{'='*60}\n")
        except asyncio.CancelledError:
            _pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} task cancelled.")
            _active_jobs.pop(job_id, None)
            raise
        except Exception as e:
            print(f"\n   ❌ [pipeline] ERROR in job {job_id}: {e}")
            import traceback
            traceback.print_exc()
            uploader.update_status(job_id, {"status": "failed", "error": str(e)})
            agent_bridge.enqueue_failed(job_id, str(e), {})
        finally:
            _pipeline_tasks.pop(job_id, None)
            _pipeline_cancel.discard(job_id)
            _active_jobs.pop(job_id, None)
            _cleanup_pipeline_resources()


def _cleanup_pipeline_resources():
    """Free ML resources after a pipeline completes.

    Call this when no jobs are active to reclaim MPS memory and unload
    ML models. Safe to call even if models are already unloaded.
    """
    try:
        import gc
        import torch

        # 1. Clear PyTorch MPS allocation cache
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
            print(f"[pipeline]   \U0001f9f9 MPS cache cleared")

        # 2. Unload models only when no jobs are active
        #    (model stays loaded between sequential jobs for speed)
        if len(_active_jobs) == 0:
            global engine, vp_manager

            # Unload diarization model from TranscriptionEngine
            if engine is not None and hasattr(engine, "_diarization"):
                engine._diarization = None
                print(f"[pipeline]   \U0001f9f9 Diarization model unloaded")

            # Unload embedding model from VoiceprintManager
            if vp_manager is not None:
                vp_manager.reset_model()
                print(f"[pipeline]   \U0001f9f9 Embedding model unloaded")

            # Force garbage collection + final MPS cache clear
            gc.collect()
            if hasattr(torch, "mps") and torch.backends.mps.is_available():
                torch.mps.empty_cache()
                print(f"[pipeline]   \U0001f9f9 MPS cache cleared after GC")
    except Exception as e:
        print(f"[pipeline]   \u26a0\ufe0f Cleanup warning: {e}")


def _update_active(job_id: str, status: str, progress: float, **extra):
    """Update the in-memory active job tracker and persist to disk."""
    _active_jobs[job_id] = {**_active_jobs.get(job_id, {}), "status": status, "progress": progress}
    _active_jobs[job_id].update(extra)
    update_kwargs = {"status": status, "progress": progress}
    if extra:
        update_kwargs.update(extra)
    uploader.update_status(job_id, update_kwargs)


def _run_pipeline_sync(job_id: str):
    """Synchronous ML pipeline — runs inside ``asyncio.to_thread()``.

    Each step updates the in-memory ``_active_jobs`` dict (via ``_update_active``)
    and checks ``_pipeline_cancel`` for cooperative cancellation.

    All progress is also written to a per-job log file at ``<storage>/<job_id>/pipeline.log``.
    """
    jlog = _setup_job_logger(job_id)
    try:
        _update_active(job_id, "initializing", 0.05)
        engine = TranscriptionEngine()
        metadata = uploader.get_metadata(job_id)
        audio_path = uploader.get_audio_path(job_id)
        jlog.log(f"[pipeline] Audio path: {audio_path}")
        jlog.log(f"[pipeline] Metadata: title='{metadata.get('title')}', attendees={metadata.get('attendees')}")

        # ── Step 1: Diarization ──
        jlog.log(f"\n   🔬 [PIPELINE] Step 1/5: Diarization (identifying speakers)...")
        _update_active(job_id, "processing_diarization", 0.2)
        if _check_cancelled(job_id): return
        t_diar = time.time()
        diarization = engine.run_diarization(audio_path)
        diar_elapsed = time.time() - t_diar
        speakers_found = set(s["speaker"] for s in diarization)
        jlog.log(f"   ✅ [pipeline] Diarization: {len(diarization)} segments, {len(speakers_found)} speakers "
              f"({', '.join(sorted(speakers_found))}) in {diar_elapsed:.1f}s")

        # Group by speaker (use dicts consistently — no SimpleNamespace)
        speaker_segments = {}
        for seg in diarization:
            spk = seg["speaker"]
            speaker_segments.setdefault(spk, []).append({
                "speaker": seg["speaker"],
                "start": seg["start"],
                "end": seg["end"],
                "duration": seg.get("duration", seg["end"] - seg["start"]),
            })

        # ── Pause for user labeling if speaker count doesn't match attendees ──
        # After diarization we know how many unique voices exist. If the number
        # of attendees provided by the user doesn't match, pause and let them
        # label each detected speaker before we proceed to the expensive ASR step.
        speaker_count = len(speaker_segments)
        attendee_count = len(metadata.get("attendees", []))
        should_pause = (
            speaker_count > 0 and (
                attendee_count == 0 or
                attendee_count != speaker_count
            )
        )
        if should_pause:
            jlog.log(f"\n   ⏸️  [PIPELINE] Speaker count ({speaker_count}) != attendee count ({attendee_count}) — pausing for labeling")
            uploader.save_diarization(job_id, {
                "speaker_segments": speaker_segments,
                "diarization": diarization,
                "total_speakers": speaker_count,
            })
            # Build speaker info for the status so the UI can display it
            speaker_info = []
            for spk, segs in speaker_segments.items():
                longest = max(segs, key=lambda s: s["duration"])
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest["start"],
                    "sample_end": longest["end"],
                })
            _update_active(job_id, "paused_for_labeling", 0.3, speakers=speaker_info)
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Detected speakers: {', '.join(sorted(speaker_segments.keys()))}")
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume

        # ── Step 2: Voiceprint matching ──
        jlog.log(f"\n   🧬 [PIPELINE] Step 2/5: Voiceprint matching...")
        _update_active(job_id, "matching_voiceprints", 0.35)
        if _check_cancelled(job_id): return
        t_vp = time.time()
        attendees = metadata.get("attendees", [])
        if attendees:
            jlog.log(f"[pipeline] Matching against {len(attendees)} known attendees: {attendees}")
            match_result = vp_manager.match_against_attendees(
                audio_path, speaker_segments, attendees
            )
        else:
            jlog.log(f"[pipeline] No known attendees — all speakers will be unknown")
            match_result = {"known": {}, "unknown": [
                {
                    "speaker_id": spk,
                    "segments": [{"start": s["start"], "end": s["end"], "duration": s["duration"], "speaker": s["speaker"]} for s in segs],
                    "sample_segment": {"start": segs[0]["start"], "end": segs[0]["end"]},
                }
                for spk, segs in speaker_segments.items()
            ]}
        vp_elapsed = time.time() - t_vp
        jlog.log(f"   ✅ [pipeline] Voiceprint matching in {vp_elapsed:.1f}s: "
              f"{len(match_result['known'])} known, {len(match_result.get('unknown', []))} unknown")

        # ── Log detailed voiceprint identification results ──
        scores = match_result.get("scores", {})
        if match_result.get("known"):
            jlog.log(f"[voiceprint] ── Speaker Identifications ──")
            for matched_name in match_result["known"]:
                score = scores.get(matched_name, 0)
                segment_count = len(match_result["known"][matched_name])
                # Find the original speaker_id(s) that matched this name
                # (reverse-lookup from the speaker_segments dict)
                source_spk = "?"
                for spk_id, segs in speaker_segments.items():
                    for s in segs:
                        for ks in match_result["known"][matched_name]:
                            if abs(s.get("start", 0) - ks.get("start", 0)) < 0.5:
                                source_spk = spk_id
                                break
                        if source_spk != "?":
                            break
                    if source_spk != "?":
                        break
                jlog.log(f"[voiceprint]   ✅ Speaker {source_spk} → {matched_name} "
                      f"(confidence: {score:.3f}, {segment_count} segment(s))")
            jlog.log(f"[voiceprint] ──────────────────────────────")
            jlog.log(f"[pipeline]   Matched: {list(match_result['known'].keys())}")
        if match_result.get("unknown"):
            jlog.log(f"[voiceprint] ── Unidentified Speakers ──")
            for u in match_result["unknown"]:
                jlog.log(f"[voiceprint]   ❓ {u['speaker_id']}: not identified "
                      f"({len(u['segments'])} segment(s), sample at {u['sample_segment']['start']:.1f}s)")
            jlog.log(f"[voiceprint] ────────────────────────────")

        # ── Attendee reconciliation ──
        metadata_attendees = metadata.get("attendees", [])
        metadata_attendee_emails = metadata.get("attendeeEmails", [])
        reconciliation = _reconcile_attendees(
            metadata_attendees, metadata_attendee_emails,
            match_result, speaker_segments,
        )
        matched_names = [s["name"] for s in reconciliation["matched_speakers"]]
        non_speaking_names = [s["name"] for s in reconciliation["non_speaking_attendees"]]
        unknown_ids = [u["speaker_id"] for u in reconciliation["unknown_speakers"]]
        jlog.log(f"[reconciliation] Attendee reconciliation: "
              f"{len(matched_names)} matched speaker(s), "
              f"{len(non_speaking_names)} non-speaking, "
              f"{len(unknown_ids)} unknown")
        if non_speaking_names:
            jlog.log(f"[reconciliation]   Non-speaking attendees "
                  f"(present but did not speak): {non_speaking_names}")
        if matched_names:
            jlog.log(f"[reconciliation]   Matched speakers: {matched_names}")

        # ── Step 3: ASR Transcription ──
        jlog.log(f"\n   🎤 [PIPELINE] Step 3/5: ASR transcription (Whisper)...")
        _update_active(job_id, "processing_transcription", 0.5)
        if _check_cancelled(job_id): return
        t_asr = time.time()
        transcription = engine.run_transcription(audio_path)
        asr_elapsed = time.time() - t_asr
        jlog.log(f"   ✅ [pipeline] ASR: {len(transcription.get('words', []))} words, "
              f"{len(transcription.get('segments', []))} segments in {asr_elapsed:.1f}s")

        # ── Step 4: Alignment ──
        jlog.log(f"\n   🔗 [PIPELINE] Step 4/5: Aligning diarization with transcript...")
        _update_active(job_id, "aligning", 0.7)
        if _check_cancelled(job_id): return
        t_align = time.time()
        aligned = engine.align_transcript(transcription, diarization)
        align_elapsed = time.time() - t_align
        jlog.log(f"   ✅ [pipeline] Alignment: {len(aligned)} transcript segments in {align_elapsed*1000:.0f}ms")

        # Apply known speaker labels with ASV feedback
        label_count = 0
        asv_logged = 0
        match_scores = match_result.get("scores", {})
        for seg in aligned:
            for name, segs in match_result["known"].items():
                for s in segs:
                    if abs(seg["start"] - s["start"]) < 0.5:
                        seg["speaker"] = name
                        label_count += 1
                        # Log ASV feedback for the first N segments
                        if asv_logged < 50 and seg.get("text", "").strip():
                            asv_logged += 1
                            ts_start = seg.get("start", 0)
                            ts_end = seg.get("end", 0)
                            text = seg.get("text", "").strip()
                            score = match_scores.get(name, 0)
                            jlog.log(f"[transcription] [{ts_start:>8.3f} --> {ts_end:>8.3f}] "
                                  f"{name} (score={score:.3f}): {text[:200]}")
                        break
        if label_count:
            jlog.log(f"[pipeline] Applied {label_count} speaker label(s) from voiceprint matching"
                  f" — logged {asv_logged} ASV match(es)")

        # Save the raw ASR text (unrefined, before any LLM processing)
        raw_text = transcription.get("text", "")
        if raw_text:
            uploader.save_raw_transcript(job_id, raw_text)

        uploader.save_transcript(job_id, aligned)
        uploader.save_transcript_text(job_id, aligned)
        _update_active(job_id, "transcribed", 0.85)

        # ── Pipeline timing summary ──
        pipeline_total = time.time() - (t_diar - diar_elapsed)
        jlog.log(f"\n{'='*50}")
        jlog.log(f"   ⏱️  PIPELINE TIMING SUMMARY")
        jlog.log(f"{'='*50}")
        jlog.log(f"      Diarization:     {diar_elapsed:>7.1f}s")
        jlog.log(f"      Voiceprint:      {vp_elapsed:>7.1f}s")
        jlog.log(f"      ASR:             {asr_elapsed:>7.1f}s")
        jlog.log(f"      Alignment:       {align_elapsed*1000:>7.0f}ms")
        jlog.log(f"      ─────────────────────")
        jlog.log(f"      Total (ML):      {pipeline_total:>7.1f}s")
        jlog.log(f"{'='*50}\n")

        # ── Step 5: Enqueue for agent or pause for labeling ──
        jlog.log(f"\n   📨 [PIPELINE] Step 5/5: Enqueueing for agent runner...")
        if _check_cancelled(job_id): return
        unknown = match_result.get("unknown", [])
        if unknown:
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"]["start"]) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            # Unknown speakers after voiceprint matching — pause for user labeling
            # so they can identify them (saves real embeddings, unlike agent path)
            jlog.log(f"\n   ⏸️  [PIPELINE] {len(unknown)} unknown speaker(s) — pausing for user labeling (post-ASR)")
            # Save diarization data if not already saved (won't exist if we didn't
            # pause after diarization due to matching attendee count)
            if not uploader.load_diarization(job_id).get("speaker_segments"):
                uploader.save_diarization(job_id, {
                    "speaker_segments": speaker_segments,
                    "diarization": diarization,
                    "total_speakers": len(speaker_segments),
                })
            # Build speaker info for the UI labeling modal
            speaker_info = []
            for u in unknown:
                spk = u["speaker_id"]
                segs = speaker_segments.get(spk, [])
                longest = max(segs, key=lambda s: s["duration"]) if segs else {"start": 0, "end": 0}
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest.get("start", 0),
                    "sample_end": longest.get("end", 0),
                })
            _update_active(job_id, "paused_for_labeling", 0.9,
                          labeling_phase="post_asr", speakers=speaker_info,
                          unknown_speakers=unknown,
                          reconciliation={
                              "matched_speakers": reconciliation["matched_speakers"],
                              "non_speaking_attendees": reconciliation["non_speaking_attendees"],
                          })
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Unknown speakers: {', '.join(u['speaker_id'] for u in unknown)}")

            # Register matched speakers and non-speaking attendees now
            # (unknown speakers will be registered after the user labels them)
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="new_job_form"
            )
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume
        else:
            _update_active(job_id, "ready_for_agent", 0.95)
            skip = metadata.get("skip_steps")
            jlog.log(f"[pipeline] All speakers known — enqueueing ready_for_processing (skip_steps={skip})")

            # Register attendees in ephemeral DB AFTER full reconciliation
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="new_job_form"
            )

            # Persist ML pipeline completion stats
            try:
                total_chars = sum(len(s.get("text", "")) for s in aligned)
                ephemeral_memory.upsert_job(job_id, {
                    "transcript_segment_count": len(aligned),
                    "transcript_char_count": total_chars,
                    "audio_duration_sec": aligned[-1]["end"] if aligned else None,
                })
            except Exception as e:
                jlog.log(f"[pipeline] Warning: could not update job record: {e}")

            agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=non_speaking_names,
            )

    except Exception as e:
        jlog.log(f"\n   ❌ [pipeline] ERROR in job {job_id}: {e}")
        import traceback
        traceback.print_exc()
        raise  # Re-raise so the outer _run_pipeline handles status + enqueue
    finally:
        jlog.close()
        _pipeline_cancel.discard(job_id)


import re

# ── Filler words / discourse markers to strip from transcript text ──
# These are common hesitation sounds and speech artifacts. Each pattern
# consumes trailing punctuation and whitespace so that "um, like," becomes
# just "," after removal rather than leaving orphans like " ,".
_FILLER_PATTERNS = [
    r'\bum+\b[\s,.]*',
    r'\buh+\b[\s,.]*',
    r'\bah+\b[\s,.]*',
    r'\bhmm+\b[\s,.]*',
    r'\bmm[- ]hmm+\b[\s,.]*',
    r'\buh[- ]huh+\b[\s,.]*',
    r'\bah[- ]hah?\b[\s,.]*',
    r'\buh[- ]oh\b[\s,.]*',
    r'\byou know\b[\s,.]*',
    r'\bi mean\b[\s,.]*',
    r'\byou see\b[\s,.]*',
    r'\blike\b(?!\s+to\b)[\s,.]*',           # "like" as filler, not "like to"
    r'\bkind of\b[\s,.]*',
    r'\bsort of\b[\s,.]*',
    r'\bso basically\b[\s,.]*',
    r'\bbasically\b[\s,.]*',
    r'\bactually\b[\s,.]*',
    r'\bobviously\b[\s,.]*',
    r'\bright\b[\s,.]*',
    r'\bokay\b[\s,.]*',
    r'\balright\b(?!\s+so\b)[\s,.]*',
]


def _auto_refine(segments: list[dict], custom_rules: list[str], keep_timestamps: bool = True) -> list[dict]:
    """Apply automatic transcript refinement to every segment.

    ``start`` and ``end`` fields are always preserved so the UI can display
    timestamps even when ``keep_timestamps`` is False. The flag only controls
    whether the optional ``duration`` field is kept.

    For each segment:
      1. Strip filler words and discourse markers from the text.
      2. Redact PII (emails, phones, SSN, credit cards, account numbers).
      3. Apply any additional custom redaction rules passed by the LLM.
      4. Collapse multiple spaces and trim.

    Returns a new list of refined segment dicts (the original is not mutated).
    """
    fillers_re = re.compile('|'.join(_FILLER_PATTERNS), re.IGNORECASE)
    refined = []
    for seg in segments:
        # Always preserve speaker, start, end — these are structural fields
        # needed by the UI, not secrets/PII.
        clean = {
            "speaker": seg.get("speaker", "Unknown"),
            "start": seg.get("start"),
            "end": seg.get("end"),
        }
        if keep_timestamps:
            # Also preserve optional duration
            if "duration" in seg:
                clean["duration"] = seg["duration"]
        text = seg.get("text", "")

        # 2. Strip filler words
        text = fillers_re.sub('', text)

        # 3. Clean up punctuation orphans left by filler removal
        #    e.g. "um, like," → after removing fillers → " , ," → clean → ""
        text = re.sub(r'\s+[,.;:!?]+', ',', text)   # ", word" → ", word"
        text = re.sub(r'[,.;:!?]+(?!\S)', '', text)  # trailing punctuation cleanup
        text = re.sub(r'\s+', ' ', text)             # collapse spaces

        # 4. Redact PII automatically
        text = _redact_pii(text)

        # 5. Apply any custom LLM-provided redaction rules
        for rule in custom_rules:
            text = _redact_custom(text, rule)

        # 6. Final whitespace collapse and trim
        text = re.sub(r'\s+', ' ', text).strip()

        clean["text"] = text
        refined.append(clean)

    return refined


def _redact_pii(text: str) -> str:
    """Automatically redact common PII patterns from text."""
    # Email addresses
    text = re.sub(r'[\w.+-]+@[\w.-]+\.\w{2,}', '[EMAIL REDACTED]', text)
    # Phone numbers (various formats)
    text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    # SSN-like patterns (###-##-####)
    text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN REDACTED]', text)
    # Credit-card-like patterns (####-####-####-#### or ################)
    text = re.sub(r'\b(?:\d{4}[-\s]?){3}\d{4}\b', '[CARD REDACTED]', text)
    text = re.sub(r'\b\d{16}\b', '[CARD REDACTED]', text)
    # Long digit sequences (account numbers / banking)
    text = re.sub(r'\b\d{8,}\b', '[ACCOUNT REDACTED]', text)
    return text


def _redact_custom(text: str, rule: str) -> str:
    """Apply a single LLM-provided custom redaction rule."""
    rule_lower = rule.lower()
    if "account" in rule_lower or "banking" in rule_lower:
        text = re.sub(r'\b\d{4,}\b', '[REDACTED]', text)
    if "email" in rule_lower or "phone" in rule_lower or "contact" in rule_lower:
        text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL REDACTED]', text)
        text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    if "name" in rule_lower or "person" in rule_lower:
        text = re.sub(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', '[NAME REDACTED]', text)
    return text


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
