"""
FastAPI application — transcription backend

Endpoints:
  ML Pipeline: /transcribe/upload, /transcribe/status/{id}, /transcribe/transcript/{id}
  Agent-facing: /agent/refine, /agent/summarize, /agent/label_speakers, /agent/deliver
  Memory:       /memory/search, /memory/ephemeral/query, /memory/ephemeral/save, /memory/save_context
"""

import os
import re
import sys
import json
import time
import asyncio
import platform as _sys_platform
import numpy as np
from datetime import datetime
from typing import Any, cast

# ── Load .env file (if present) for standalone Python runs ──
# override=True ensures .env values take precedence over env vars inherited
# from the Electron parent process (which may contain stale defaults).
from dotenv import load_dotenv
load_dotenv(override=True)

# ── MPS memory limit (Apple Silicon) ──
# PyTorch's MPS backend enforces a high-water mark (~90% of available VRAM).
# When running large models (whisper-medium + pyannote diarization), the combined
# allocation can exceed this limit and crash with "MPS backend out of memory".
# The watermark ratio tells PyTorch when to raise OOMError BEFORE macOS kills
# the process.  0.7 = raise error at ~70% MPS usage (catchable).
# 0.0 = unlimited (macOS may SIGKILL the process instead).
# DO NOT set to 0.0 — it disables the safety valve and causes hard crashes.
# os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.7")

# ── Windows/CrossOver stdout encoding guard ──
# The packaged Windows backend runs under the ANSI code page (cp1252 on en-US)
# when stdout is piped by the Electron shell. cp1252 cannot encode the emoji
# used throughout startup prints (patches.py's "✅" first), which raised
# UnicodeEncodeError at import and crashed the backend before it became ready.
# Force UTF-8 mode for this process and for any subprocess we spawn.
os.environ.setdefault("PYTHONUTF8", "1")
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None:
        try:
            # reconfigure() is a runtime io.TextIOWrapper method that isn't in
            # the TextIO type stub — cast so type checkers accept it.
            # errors="replace" renders any non-ASCII char (emoji, arrows) as
            # "?" instead of raising, so a startup print() can never crash
            # the process with UnicodeEncodeError again.
            cast(Any, _stream).reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            # Non-fatal: if the stream isn't reconfigurable (unusual in a
            # frozen app), keep Python's default. The Electron spawn env
            # (PYTHONUTF8=1 / PYTHONIOENCODING=utf-8) already forces UTF-8
            # mode before the process starts, so this is purely defensive.
            pass

# ── Apply third-party compatibility patches FIRST (before any pyannote imports) ──
import patches  # noqa: F401  (monkey-patches speechbrain + torchaudio + pyannote)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from config import config
from utils import is_network_error

from upload import AudioUploader, resolve_ffmpeg
from voiceprint import VoiceprintManager
from transcription import detect_device
from models import (
    RefineRequest, SummarizeRequest, LabelRequest, AnalysisRequest, Deliverable,
    MemorySearchRequest,
    EphemeralMemoryItem, EphemeralMemoryQuery,
    RegisterAttendeesRequest, SaveMeetingContextRequest, UploadByPathRequest,
)
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

import services
import services.pipeline  # noqa: F401  (binds services.run_pipeline_async / run_resumed_pipeline_async)
from constants import (
    ML_PIPELINE_STATUSES, ML_UPLOAD_BLOCKING_STATUSES, PIPELINE_TIMEOUT_SECONDS,
    _STATUS_MESSAGES, _MAX_STEP_MESSAGES, EPHEMERAL_TABLES, _STOP_WORDS,
)
from refinement import _auto_refine
from helpers import (
    _dump_all_voiceprints, _log_file_has_errors, _current_dl_progress,
    _diar_diag, _diar_diag_env, _dir_size, _format_bytes,
)
from reconciliation import (
    _resolve_attendee_email, _split_excluded_non_speaking,
    _prune_excluded_emails, _dedup_attendees,
    _ensure_job_attendees_registered, _job_attendee_shortfall,
)
from pipeline_state import PipelineState, state
from model_preload import router as model_preload_router

uploader: AudioUploader = None
vp_manager: VoiceprintManager = None
agent_bridge: AgentBridge = None
semantic_memory: SemanticMemory = None
ephemeral_memory: EphemeralMemory = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global uploader, vp_manager, agent_bridge, semantic_memory, ephemeral_memory
    uploader = AudioUploader()
    vp_manager = VoiceprintManager(provider=config.EMBEDDING_PROVIDER)
    semantic_memory = SemanticMemory()
    ephemeral_memory = EphemeralMemory()
    # AgentBridge needs ephemeral_memory for the SQLite-backed event queue
    agent_bridge = AgentBridge(ephemeral_memory=ephemeral_memory)

    # Expose the live singletons to the Phase-0 extracted modules via the
    # services.py registry. MUST run before the startup attendee-repair sweep
    # below, which calls _job_attendee_shortfall / _ensure_job_attendees_registered.
    services.uploader = uploader
    services.vp_manager = vp_manager
    services.semantic_memory = semantic_memory
    services.ephemeral_memory = ephemeral_memory
    services.agent_bridge = agent_bridge
    os.makedirs(config.STORAGE_PATH, exist_ok=True)
    # QUEUE_DIR still needed for the .transcription-trigger file (fs.watch wakeup)
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

    # ── Startup DB recovery: handle ChromaDB corruption from prior crash ──
    # If the process was killed mid-write (SIGKILL from OOM), ChromaDB's
    # SQLite database can be left in a corrupted state. Try to open it;
    # if it fails, delete and recreate so the app starts fresh.
    if semantic_memory is not None:
        chroma_dir = semantic_memory.persist_dir
        chroma_db = os.path.join(chroma_dir, "chroma.sqlite3")

        # ── Clean up stale WAL files from prior crashes ──
        # If the process was killed mid-write, leftover .db-wal / .db-shm
        # files can cause ChromaDB's Rust bindings to open the database in
        # read-only mode (SQLITE_READONLY_DBMOVED / code 1032).  Remove
        # them first so SQLite starts with a clean slate regardless of
        # how the raw sqlite3 test below behaves.
        if os.path.isdir(chroma_dir):
            for _stale_ext in (".db-wal", ".db-shm", ".db-journal"):
                _stale_path = chroma_db + _stale_ext
                if os.path.exists(_stale_path):
                    try:
                        os.remove(_stale_path)
                        print(f"   🧹 [startup] Removed stale WAL file: {_stale_path}")
                    except Exception as _remove_err:
                        print(f"   ⚠️  [startup] Could not remove {_stale_path}: {_remove_err}")

        if os.path.exists(chroma_db):
            try:
                import sqlite3 as _sc
                _test_conn = _sc.connect(chroma_db)
                _test_conn.execute("SELECT 1")
                # Also test write access — a read-only check isn't enough.
                # SQLite can return SQLITE_READONLY_DBMOVED (1032) on writes
                # even when reads succeed (e.g., after a crash mid-WAL-write).
                _test_conn.execute("CREATE TABLE IF NOT EXISTS _startup_write_test (id)")
                _test_conn.execute("DROP TABLE _startup_write_test")
                _test_conn.commit()
                _test_conn.close()
            except Exception as _db_err:
                print(f"   ⚠️  [startup] ChromaDB check failed ({_db_err}). Deleting and recreating...")
                try:
                    _test_conn.close()
                except Exception:
                    pass
                import shutil as _sh
                try:
                    _sh.rmtree(chroma_dir)
                    os.makedirs(chroma_dir, exist_ok=True)
                    print(f"   ✅ [startup] ChromaDB directory recreated at {chroma_dir}")
                except Exception as _rm_err:
                    print(f"   ❌ [startup] Could not delete corrupted ChromaDB: {_rm_err}")

    # ── Startup POSIX semaphore cleanup ──
    # On macOS, multiprocessing.Queue creates POSIX named semaphores that can
    # leak if not properly unlinked (e.g., after a crash). These accumulate
    # in /dev/shm/ as /mp.* files. macOS has a low default semaphore limit
    # (~256), so leaked semaphores can cause subsequent mp.Queue() calls to
    # hang. Try to clean up any orphaned /mp.* semaphores on startup.
    if _sys_platform.system().lower() == "darwin":
        try:
            _sem_cleaned = 0
            _dev_shm = "/dev/shm"
            if os.path.isdir(_dev_shm):
                for _entry in os.scandir(_dev_shm):
                    if _entry.name.startswith("mp.") and _entry.is_file():
                        try:
                            os.unlink(_entry.path)
                            _sem_cleaned += 1
                        except (OSError, PermissionError):
                            pass
            if _sem_cleaned:
                print(f"   🧹 [startup] Cleaned {_sem_cleaned} orphaned POSIX semaphore(s) from /dev/shm/")
        except Exception as _sem_err:
            print(f"   ⚠️  [startup] POSIX semaphore cleanup skipped: {_sem_err}")

    # ── Startup queue recovery: reclaim stale events ──
    # If the agent runner was killed mid-job, its claimed events are stuck
    # in 'processing' state. Reset them back to 'pending' so they get picked
    # up by the next agent runner instance.
    reclaimed = ephemeral_memory.reclaim_stale_events(max_age_seconds=300)
    if reclaimed:
        print(f"   🧹 [startup] Reclaimed {reclaimed} stale queue event(s)")

    # ── Startup attendee repair: warning jobs + silently-short complete jobs ──
    # Two classes are repaired here, both rebuilt from metadata.json (the
    # durable source of truth):
    #   1. Jobs flagged complete_with_warning / warnings — registration failed
    #      mid-pipeline (e.g. a transient SQLite "disk I/O error").
    #   2. Otherwise-complete jobs whose attendee registry is silently short —
    #      registration was deferred on A/B conflicts in the pre-ASR path
    #      (which never re-registers) and no warning was recorded.
    # The shortfall check for class 2 keeps us from touching healthy jobs, so
    # their `last_seen` timestamps aren't bumped on every startup.
    repaired = 0
    still_warning = 0
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir() or entry.name in ("chroma", "logs", "uploads", ".model_cache"):
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        try:
            with open(status_path) as f:
                _status = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        _job_id = _status.get("job_id", entry.name)
        is_warning = (
            _status.get("status") == "complete_with_warning"
            or bool(_status.get("warnings"))
        )
        if not is_warning:
            # Only touch otherwise-complete jobs that actually have a shortfall.
            if _status.get("status") != "complete":
                continue
            if not _job_attendee_shortfall(_job_id):
                continue
        if _ensure_job_attendees_registered(_job_id):
            try:
                uploader.update_status(_job_id, {"status": "complete", "progress": 1.0, "warnings": []})
            except Exception:
                pass
            try:
                ephemeral_memory.upsert_job(_job_id, {"result": "success"})
            except Exception:
                pass
            print(f"   🧹 [startup] Repaired attendee records for job {_job_id} — marked complete")
            repaired += 1
        else:
            still_warning += 1
            try:
                uploader.update_status(_job_id, {"status": "complete_with_warning", "progress": 1.0})
            except Exception:
                pass
            print(f"   ⚠️  [startup] Could not repair attendees for job {_job_id} — keeping complete_with_warning")
    if repaired or still_warning:
        print(f"   🧹 [startup] Attendee repair sweep: {repaired} repaired, {still_warning} still flagged")

    # ── Periodic queue cleanup: expire old completed events ──
    # Every 30 minutes, delete completed events older than their ttl_seconds.
    # This prevents the events table from accumulating stale history entries.
    _queue_cleanup_interval = 1800  # 30 minutes in seconds

    async def _periodic_queue_cleanup():
        while True:
            await asyncio.sleep(_queue_cleanup_interval)
            try:
                deleted = ephemeral_memory.cleanup_expired_events()
                if deleted:
                    print(f"[cleanup] Expired {deleted} completed queue event(s)")
            except Exception as _ce:
                print(f"[cleanup] ⚠️  Queue cleanup error: {_ce}")

    _cleanup_task = asyncio.create_task(_periodic_queue_cleanup())

    yield

    # ── Shutdown: cancel cleanup task and close SQLite connections ──
    _cleanup_task.cancel()
    try:
        await _cleanup_task
    except asyncio.CancelledError:
        pass
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

# /transcribe/models/status (model preload status) moved to model_preload.py (Phase 1)
app.include_router(model_preload_router)


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
    # Reject new uploads while ML pipeline jobs or review-gated jobs exist
    for info in state._active_jobs.values():
        if info.get("status") in ML_UPLOAD_BLOCKING_STATUSES:
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
        "original_filename": file.filename,
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
            "original_filename": file.filename,
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

    state.start_pipeline_async(job_id)
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


@app.post("/transcribe/upload_by_path")
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

    state.start_pipeline_async(job_id)
    return {"job_id": job_id, "status": "uploaded", "file_path": file_path}


@app.get("/transcribe/status/{job_id}")
async def get_status(job_id: str):
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        print(f"[api] GET /transcribe/status/{job_id} → not_found")
        raise HTTPException(404, "Job not found")
    print(f"[api] GET /transcribe/status/{job_id} → {s['status']} (progress={s.get('progress', '?')})")
    return s


@app.post("/transcribe/step_message/{job_id}")
async def add_step_message(job_id: str, body: dict = Body(...)):
    """Append a simplified step message to the job's live log (agent runner)."""
    message = body.get("message", "")
    if not message:
        raise HTTPException(400, "message is required")
    state.add_step_message(job_id, message)
    return {"ok": True}


@app.get("/transcribe/active")
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
            "warnings": status.get("warnings", []),
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
                            vp_manager.extract_embedding, audio_path,
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
                            vp_manager.extract_embedding, audio_path,
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
        email_key = vp_manager._make_email(name, email)
        all_matches = await asyncio.to_thread(
            vp_manager.find_matching_voiceprints, emb,
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
        vp_manager.save_voiceprint(
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
        uploader.save_transcript(req.job_id, transcript_data)
        print(f"[api] Applied {len(names)} speaker label(s) to transcript")

    uploader.update_status(req.job_id, {"status": "labeled", "unknown_speakers": []})
    print(f"[api] POST /agent/label_speakers → done")
    return {"success": True, "applied_labels": len(req.labels)}


# ── Label Verification (Mitigation 1: voiceprint-backed label verification) ──

@app.post("/agent/verify-labels")
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
    diar_data = uploader.load_diarization(job_id)
    audio_path = None
    if diar_data and "speaker_segments" in diar_data:
        try:
            audio_path = uploader.get_audio_path(job_id)
        except Exception:
            audio_path = None

    # Load registered attendees for the job
    metadata = uploader.get_metadata(job_id)
    registered_attendees = metadata.get("attendees", [])

    verifications = []
    unregistered_names = []

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
                        vp_manager.extract_embedding, audio_path,
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
                    vp_manager.find_matching_voiceprints, emb,
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
                own_sim = vp_manager.similarity_to(name, emb)
                if own_sim is None and email:
                    own_sim = vp_manager.similarity_to(email, emb)
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
    }


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


@app.post("/agent/deliver")
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
        # Update status so the frontend stepper shows a dedicated "Saving to Memory" stage
        uploader.update_status(req.job_id, {"status": "saving_memory", "progress": 0.97})
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
                        vp_manager.extract_embedding, audio_path,
                        segment=(s["start"], s["end"]),
                    )
                    sampled_embs.append(seg_emb)
                if sampled_embs:
                    emb = np.mean(sampled_embs, axis=0)
                    emb = emb / np.linalg.norm(emb)
                    matches = await asyncio.to_thread(
                        vp_manager.find_matching_voiceprints, emb,
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
    vp_rows = vp_manager.list_voiceprints()  # [{name, email, sample_job_id, ...}]
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
    for att in ephemeral_memory.list_attendees(limit=500):
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


@app.post("/transcribe/label_and_resume/{job_id}")
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
    import traceback
    try:
        s = uploader.get_status(job_id)
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
    # Defer imports that rely on the module-level globals
    from config import config
    import json, os, numpy as np
    from datetime import datetime
    from fastapi import HTTPException

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
                        vp_manager.extract_embedding, audio_path,
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
                        vp_manager.extract_embedding, audio_path,
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
                    vp_manager.find_matching_voiceprints, emb,
                    threshold=config.VOICEPRINT_THRESHOLD,
                )

            deleted_any = False
            for old_match in old_matches:
                old_name = old_match.get("name", "")
                if not old_name or old_name.lower() == name.lower():
                    continue
                # Delete voiceprint unconditionally — user chose to overwrite
                deleted_rows = vp_manager.delete_voiceprint_by_name(old_name)
                if deleted_rows == 0 and old_match.get("email"):
                    print(f"[drift] ⚠️  delete by name '{old_name}' "
                          f"returned 0 rows — falling back to email "
                          f"'{old_match['email']}'")
                    vp_manager.delete_voiceprint(old_match["email"])
                # Also clean up the stale attendee record
                try:
                    ephemeral_memory.delete_attendee_by_name(old_name)
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

        email_key = vp_manager._make_email(name, email)
        # Match against ALL existing enrolled voiceprints
        all_matches = await asyncio.to_thread(
            vp_manager.find_matching_voiceprints, emb,
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
    metadata = uploader.get_metadata(job_id)
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
            _conn2 = vp_manager._get_conn()
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

        vp_manager.save_voiceprint(
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
        final_count = vp_manager._get_conn().execute(
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
            uploader.save_transcript(job_id, transcript)
            uploader.save_transcript_text(job_id, transcript)
            aligned = transcript
        else:
            aligned = []

        metadata = uploader.get_metadata(job_id)
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
            existing_vp = vp_manager.get_voiceprint(us["name"])
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
                existing_vp = vp_manager.get_voiceprint(us["name"])
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
            ephemeral_memory.register_attendees(
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
            existing_vp = vp_manager.get_voiceprint(us["name"])
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
            ephemeral_memory.upsert_job(job_id, {
                "transcript_segment_count": len(aligned),
                "transcript_char_count": total_chars,
                "audio_duration_sec": aligned[-1]["end"] if aligned else None,
            })
        except Exception as e:
            print(f"[label_and_resume] Warning: could not update job record: {e}")

        non_speaking_names = [ns["name"] for ns in non_speaking]

        # ── Gate 1: Raw Transcript Review (after labeling, before enqueue) ──
        if config.GATE_RAW_REVIEW_ENABLED:
            uploader.update_status(job_id, {"status": "pending_raw_review", "progress": 0.95})
            print(f"[label_and_resume] ⏸️  Gate 1 active — pausing for raw transcript review after labeling")
            state.update_active(job_id, "pending_raw_review", 0.95)
            return {"job_id": job_id, "status": "pending_raw_review", "applied_labels": len(label_map)}

        agent_bridge.enqueue_ready(
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


# ── Approval Gate Endpoints ──

@app.post("/transcribe/approve_gate1/{job_id}")
async def approve_gate1(job_id: str, body: dict = Body(...)):
    """Accept or reject the raw transcript at Gate 1 (post-ASR, pre-LLM).

    Body:
      action: "approve" | "approve_with_edits" | "reject_cancel" | "reject_retry"
      edited_transcript: Optional[{speaker, text, start, end}[]] — full edited transcript

    On approve/enqueue: passes the transcript to the agent runner for LLM processing.
    On reject_cancel: marks the job as failed.
    On reject_retry: re-runs the ML pipeline (ASR + alignment).
    """
    import traceback
    try:
        s = uploader.get_status(job_id)
        if s["status"] == "not_found":
            raise HTTPException(404, "Job not found")
        if s["status"] != "pending_raw_review":
            raise HTTPException(409, f"Job is not pending raw review (status={s['status']})")

        action = body.get("action", "approve")
        print(f"[api] POST /transcribe/approve_gate1/{job_id} action={action}")
        print(f"\n{'═' * 40}")
        print(f"  📨 GATE 1 SUBMITTED (job={job_id[:8]})")
        print(f"  Action: {action}")
        print(f"{'═' * 40}")

        if action in ("approve", "approve_with_edits"):
            print(f"  ⚙️ Processing Gate 1 approval...")
            # Check both camelCase (from frontend) and snake_case (from Python)
            edited_transcript = body.get("editedTranscript") or body.get("edited_transcript")
            if action == "approve_with_edits" and edited_transcript:
                if isinstance(edited_transcript, list):
                    uploader.save_transcript(job_id, edited_transcript)
                    uploader.save_transcript_text(job_id, edited_transcript)
                    uploader.save_edit_action(job_id, "gate1_edit", {
                        "target": "transcript",
                        "segments_changed": len(edited_transcript),
                    })
                    print(f"[api]   ✏️  Gate 1: transcript edited ({len(edited_transcript)} segments saved)")
            uploader.save_edit_action(job_id, "gate1_approve", {"action": action})
            # Reload transcript (may have been edited) and enqueue for agent runner
            p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
            try:
                with open(p) as f:
                    aligned = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                aligned = []
            metadata = uploader.get_metadata(job_id)
            skip = metadata.get("skip_steps")
            agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=s.get("non_speaking_attendees", []),
            )
            uploader.update_status(job_id, {"status": "enqueued"})
            print(f"\n{'═' * 40}")
            print(f"  ✅ GATE 1 COMPLETE (job={job_id[:8]})")
            print(f"  Status: enqueued for agent runner")
            print(f"  Pipeline resuming...")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "enqueued", "action": action}

        elif action == "reject_cancel":
            uploader.save_edit_action(job_id, "gate1_reject_cancel", {})
            uploader.update_status(job_id, {
                "status": "failed",
                "error": "Rejected at raw transcript review (Gate 1)",
            })
            print(f"[api]   ❌ Gate 1: rejected and cancelled")
            print(f"\n{'═' * 40}")
            print(f"  ⛔ GATE 1 REJECTED — Job cancelled (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "failed"}

        elif action == "reject_retry":
            uploader.save_edit_action(job_id, "gate1_reject_retry", {})
            uploader.update_status(job_id, {"status": "reprocessing", "progress": 0.0})
            state.start_pipeline_async(job_id)
            print(f"[api]   🔄 Gate 1: rejected and retrying pipeline")
            print(f"\n{'═' * 40}")
            print(f"  🔄 GATE 1 REJECTED — Pipeline retrying (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "reprocessing"}

        else:
            raise HTTPException(400, f"Unknown action: {action}")
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[api]   ❌ Gate 1 approval failed with exception:\n{tb}")
        raise HTTPException(500, f"Gate 1 approval failed: {e}")


@app.post("/transcribe/approve_gate2/{job_id}")
async def approve_gate2(job_id: str, body: dict = Body(...)):
    """Accept or reject the delivery package at Gate 2 (post-LLM, pre-memory-save).

    Called by the frontend when the user finishes reviewing the transcript,
    summary, analysis, and delivery options. On approve, the agent runner
    (which receives the delivery_approved event) will save to memory then deliver.

    Body:
      action: "approve" | "approve_with_edits" | "reject_cancel" | "reject_retry"
      edited_transcript: Optional[{speaker, text, start, end}[]]
      edited_summary: Optional[dict]
      edited_analysis: Optional[dict]
      delivery_options: Optional[{recipients: str[], destinations: str[]}]
      feedback: Optional[str] — user feedback included in retry context
    """
    import traceback
    try:
        s = uploader.get_status(job_id)
        if s["status"] == "not_found":
            raise HTTPException(404, "Job not found")
        if s["status"] != "pending_delivery_review":
            raise HTTPException(409, f"Job is not pending delivery review (status={s['status']})")

        action = body.get("action", "approve")
        print(f"[api] POST /transcribe/approve_gate2/{job_id} action={action}")
        print(f"\n{'═' * 40}")
        print(f"  📨 GATE 2 SUBMITTED (job={job_id[:8]})")
        print(f"  Action: {action}")
        print(f"{'═' * 40}")

        if action in ("approve", "approve_with_edits"):
            print(f"  ⚙️ Processing Gate 2 approval...")
            edits_made = []

            # Check both camelCase and snake_case for edited fields
            edited_transcript = body.get("editedTranscript") or body.get("edited_transcript")
            if edited_transcript:
                if isinstance(edited_transcript, list):
                    uploader.save_transcript(job_id, edited_transcript)
                    uploader.save_transcript_text(job_id, edited_transcript)
                    uploader.save_edit_action(job_id, "gate2_edit_transcript", {
                        "segments_changed": len(edited_transcript),
                    })
                    edits_made.append("transcript")

            edited_summary = body.get("editedSummary") or body.get("edited_summary")
            if edited_summary:
                uploader.save_summary(job_id, edited_summary)
                uploader.save_edit_action(job_id, "gate2_edit_summary", {
                    "fields_changed": list(edited_summary.keys()),
                })
                edits_made.append("summary")

            edited_analysis = body.get("editedAnalysis") or body.get("edited_analysis")
            if edited_analysis:
                uploader.save_analysis(job_id, edited_analysis)
                uploader.save_edit_action(job_id, "gate2_edit_analysis", {
                    "fields_changed": list(edited_analysis.keys()),
                })
                edits_made.append("analysis")

            # ── Custom delivery per meeting: persist the user's recipient selection ──
            # When CUSTOM_DELIVERY_PER_MEETING is enabled, the frontend sends the chosen
            # attendee emails via delivery_options.recipients. Persist them to
            # recipient-selection.json so POST /agent/deliver (prepare_delivery) uses them
            # as the authoritative job recipient list. Config default recipients are always
            # appended separately. An empty list is valid (deliver to no attendees).
            delivery_options = body.get("delivery_options") or body.get("deliveryOptions") or {}
            selected_recipients = delivery_options.get("recipients")
            if selected_recipients is not None:
                if not isinstance(selected_recipients, list):
                    selected_recipients = []
                selection = {
                    "recipients": [str(e).strip() for e in selected_recipients if str(e).strip()],
                    "destinations": delivery_options.get("destinations") or [],
                    "custom": bool(config.CUSTOM_DELIVERY_PER_MEETING),
                    "saved_at": datetime.utcnow().isoformat(),
                }
                sel_path = os.path.join(config.STORAGE_PATH, job_id, "recipient-selection.json")
                try:
                    with open(sel_path, "w") as f:
                        json.dump(selection, f, indent=2)
                    edits_made.append("recipients")
                    print(f"[api]   ✅ Gate 2: persisted recipient selection ({len(selection['recipients'])} recipients)")
                except Exception as e:
                    print(f"[api]   ⚠️  Gate 2: could not persist recipient selection: {e}")

            uploader.save_edit_action(job_id, "gate2_approve", {
                "action": action,
                "edits": edits_made,
            })

            # Enqueue delivery_approved event for the agent runner.
            # Read title from metadata.json (not status.json, which lacks a title field).
            meta = uploader.get_metadata(job_id)
            agent_bridge.enqueue("delivery_approved", {
                "jobId": job_id,
                "title": meta.get("title", "Untitled Meeting"),
                "edits_made": edits_made,
            })
            uploader.update_status(job_id, {"status": "delivery_approved"})
            print(f"[api]   ✅ Gate 2: approved — delivery_approved enqueued (edits: {edits_made})")
            print(f"\n{'═' * 40}")
            print(f"  ✅ GATE 2 COMPLETE (job={job_id[:8]})")
            print(f"  Status: delivery_approved — agent runner resuming")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "delivery_approved", "edits_made": edits_made}

        elif action == "reject_cancel":
            err_msg = body.get("feedback", "") or "Rejected at delivery review (Gate 2)"
            uploader.save_edit_action(job_id, "gate2_reject_cancel", {"feedback": body.get("feedback", "")})
            uploader.update_status(job_id, {"status": "failed", "error": err_msg})
            print(f"[api]   ❌ Gate 2: rejected and cancelled")
            print(f"\n{'═' * 40}")
            print(f"  ⛔ GATE 2 REJECTED — Job cancelled (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "failed"}

        elif action == "reject_retry":
            feedback = body.get("feedback", "")
            uploader.save_edit_action(job_id, "gate2_reject_retry", {"feedback": feedback})
            # Reset to enqueued so the agent runner re-processes from the beginning
            metadata = uploader.get_metadata(job_id)
            p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
            try:
                with open(p) as f:
                    aligned = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                aligned = []
            skip = metadata.get("skip_steps")
            # Enqueue with retry flag + user feedback (enqueue BEFORE status update)
            agent_bridge.enqueue("ready_for_processing", {
                "jobId": job_id,
                "title": metadata.get("title", "Untitled Meeting"),
                "attendees": metadata.get("attendees", []),
                "transcript": aligned,
                "skip_steps": skip,
                "retry_feedback": feedback,
                "retry_from_gate2": True,
            })
            uploader.update_status(job_id, {"status": "enqueued"})
            print(f"[api]   🔄 Gate 2: rejected and retrying LLM pipeline (feedback: '{feedback[:100]}')")
            print(f"\n{'═' * 40}")
            print(f"  🔄 GATE 2 REJECTED — Pipeline retrying (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "enqueued", "retry": True}

        else:
            raise HTTPException(400, f"Unknown action: {action}")
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[api]   ❌ Gate 2 approval failed with exception:\n{tb}")
        raise HTTPException(500, f"Gate 2 approval failed: {e}")


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

    # Parse JSON-string columns back into objects so the bridge sanitizer
    # doesn't truncate them and break the JSON structure. This affects
    # config_snapshot (agent instructions, pipeline steps, hints, etc.),
    # delivery_results (per-recipient delivery status), and pipeline_steps
    # (accumulated token usage across retries).
    import json as _json
    for _col in ("config_snapshot", "delivery_results", "pipeline_steps"):
        _raw = record.get(_col)
        if _raw and isinstance(_raw, str):
            try:
                record[_col] = _json.loads(_raw)
            except (_json.JSONDecodeError, TypeError):
                pass  # leave as-is if the value isn't valid JSON

    print(f"[api] GET /transcribe/job/{job_id} → OK ({len(record)} fields)")
    return {"job": record}


@app.post("/transcribe/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running pipeline job. Always marks the job as failed."""
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    state._pipeline_cancel.add(job_id)
    # Cancel the asyncio task if it's still running
    task = state._pipeline_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    uploader.update_status(job_id, {"status": "failed", "error": "Cancelled by user", "progress": 0.0})
    state._active_jobs.pop(job_id, None)
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
    state._active_jobs.pop(job_id, None)
    # Persist terminal state
    try:
        ephemeral_memory.upsert_job(job_id, {"result": "failed", "error_message": error, "completed_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[api] Warning: could not persist failed state: {e}")
    print(f"[api] POST /transcribe/fail/{job_id} → failed: {error[:120]}")
    return {"job_id": job_id, "status": "failed", "error": error}


@app.post("/transcribe/complete/{job_id}")
async def complete_job(job_id: str):
    """Mark a job as complete. Called by the agent runner when the LLM pipeline finishes successfully.

    The attendee registry is always reconciled from metadata.json before the
    job is marked complete. This covers registrations that were deferred on
    A/B conflicts (the pre-ASR labeling path defers and never re-registers) and
    any transient failure, so no job ever completes with a silently-short
    attendee registry. If the reconcile fails, the ``complete_with_warning``
    state is preserved so the job is never silently "complete" with missing
    attendee records.
    """
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")

    # Always reconcile the attendee registry from metadata.json before marking
    # the job complete. This covers registrations that were deferred on A/B
    # conflicts (the pre-ASR labeling path defers and never re-registers) and
    # any transient failure, so the registry converges to metadata.json for
    # every completed job — even without a `warnings` flag. Idempotent
    # (upsert + dedup), so it is safe to run on every completion.
    if _ensure_job_attendees_registered(job_id):
        # Clear any stale warning from an earlier failed registration attempt.
        if s.get("warnings") or s.get("status") == "complete_with_warning":
            print(f"[api] POST /transcribe/complete/{job_id} → repaired attendees, marking complete")
            try:
                uploader.update_status(job_id, {"warnings": []})
            except Exception:
                pass
    else:
        state._active_jobs.pop(job_id, None)
        uploader.update_status(job_id, {"status": "complete_with_warning", "progress": 1.0})
        print(f"[api] POST /transcribe/complete/{job_id} → preserved complete_with_warning "
              f"(attendee registration pending)")
        return {"job_id": job_id, "status": "complete_with_warning"}

    uploader.update_status(job_id, {"status": "complete", "progress": 1.0})
    state._active_jobs.pop(job_id, None)

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


# ── Post-Completion Summary & Analysis Editing ──


@app.post("/transcribe/save_summary/{job_id}")
async def save_summary_edits(job_id: str, body: dict = Body(...)):
    """Save edited summary after job completion. Logs the edit for audit.

    Body:
      summary: dict — the full summary object (executive_summary, key_decisions,
                      discussion_points, action_items)
    """
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] == "complete" or s["status"] == "failed" or True:  # allow any terminal/non-terminal state
        summary = body.get("summary", {})
        if not summary:
            raise HTTPException(400, "Missing summary data")

        # Detect which fields changed by comparing with existing
        existing = {}
        existing_path = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
        if os.path.exists(existing_path):
            with open(existing_path) as f:
                existing = json.load(f)

        changed_fields = []
        for key in summary:
            if key not in existing or json.dumps(summary[key], sort_keys=True) != json.dumps(existing[key], sort_keys=True):
                changed_fields.append(key)

        uploader.save_summary(job_id, summary)
        if changed_fields:
            uploader.save_edit_action(job_id, "post_complete_edit_summary", {
                "fields_changed": changed_fields,
            })

        print(f"[api] POST /transcribe/save_summary/{job_id} → saved (changed: {changed_fields})")
        return {"success": True, "job_id": job_id, "fields_changed": changed_fields}

    raise HTTPException(409, f"Cannot edit summary for job in status: {s['status']}")


@app.post("/transcribe/save_analysis/{job_id}")
async def save_analysis_edits(job_id: str, body: dict = Body(...)):
    """Save edited analysis after job completion. Logs the edit for audit.

    Body:
      analysis: dict — the full analysis object (topics, sentiment, key_entities,
                       effectiveness, follow_ups)
    """
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    if s["status"] == "complete" or s["status"] == "failed" or True:
        analysis = body.get("analysis", {})
        if not analysis:
            raise HTTPException(400, "Missing analysis data")

        # Detect which fields changed
        existing = {}
        existing_path = os.path.join(config.STORAGE_PATH, job_id, "analysis.json")
        if os.path.exists(existing_path):
            with open(existing_path) as f:
                existing = json.load(f)

        changed_fields = []
        for key in analysis:
            if key not in existing or json.dumps(analysis[key], sort_keys=True) != json.dumps(existing[key], sort_keys=True):
                changed_fields.append(key)

        uploader.save_analysis(job_id, analysis)
        if changed_fields:
            uploader.save_edit_action(job_id, "post_complete_edit_analysis", {
                "fields_changed": changed_fields,
            })

        print(f"[api] POST /transcribe/save_analysis/{job_id} → saved (changed: {changed_fields})")
        return {"success": True, "job_id": job_id, "fields_changed": changed_fields}

    raise HTTPException(409, f"Cannot edit analysis for job in status: {s['status']}")


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
    state._pipeline_cancel.add(job_id)
    task = state._pipeline_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    state._active_jobs.pop(job_id, None)

    try:
        shutil.rmtree(job_dir)
        print(f"[api] DELETE /transcribe/job/{job_id} → deleted")
        return {"job_id": job_id, "deleted": True}
    except Exception as e:
        print(f"[api] DELETE /transcribe/job/{job_id} → error: {e}")
        raise HTTPException(500, f"Failed to delete job: {e}")


# ── Log Deletion ──


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

    # Also delete the test-bot log file from the storage directory
    test_bot_log = os.path.join(config.STORAGE_PATH, "test-bot-log.jsonl")
    if os.path.exists(test_bot_log):
        try:
            os.remove(test_bot_log)
            deleted += 1
            print(f"[api] DELETE /storage/logs → removed test-bot-log.jsonl from storage")
        except Exception as e:
            errors += 1
            print(f"[api] DELETE /storage/logs → failed to remove test-bot-log.jsonl: {e}")

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

    # Mark any in-flight jobs as cancelled so the running pipeline threads stop
    # re-registering the deleted jobs (the _update_active guard checks this set).
    # We must NOT clear _pipeline_cancel: clearing it would let an orphaned
    # pipeline thread resurrect a deleted job (write status.json, re-enter
    # _active_jobs) — the exact bug that made jobs look "still running" after
    # Clear All Data.
    for _jid in list(state._active_jobs.keys()):
        state._pipeline_cancel.add(_jid)
    state._pipeline_tasks.clear()
    state._active_jobs.clear()

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

        # Evict the stale ChromaDB System singleton so the next
        # _ensure_loaded() creates a fresh PersistentClient against the
        # empty directory instead of returning the cached System with
        # the old in-memory data still present.
        from chromadb.api.shared_system_client import SharedSystemClient
        stale = SharedSystemClient._identifier_to_system.pop(chroma_dir, None)
        if stale is not None:
            stale.stop()
            print(f"[api] DELETE /storage/semantic → evicted cached ChromaDB System")

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
                # Close any open connections first (close_all so connections
                # held by OTHER threads are closed too — closing only this
                # thread's connection can leave stale conns that later hit
                # "disk I/O error" when the DB file is recreated).
                if fname == "ephemeral_memory.db" and ephemeral_memory:
                    ephemeral_memory.close_all()
                if fname == "voiceprints.db" and vp_manager:
                    vp_manager.close_all()
                os.remove(fpath)
                # Also clean up stale SQLite WAL/shared-memory companion files
                # that can cause "disk I/O error" on re-created databases
                # (see https://sqlite.org/wal.html).
                for suffix in ("-wal", "-shm"):
                    companion = fpath + suffix
                    if os.path.exists(companion):
                        os.remove(companion)
                        print(f"[api] DELETE /storage/ephemeral → removed {fname}{suffix}")
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


@app.get("/health")
async def health():
    print(f"[api] GET /health")
    return {"status": "ok", "device": detect_device()}


# ── Queue Endpoints (SQLite-backed event queue) ──
# These are infrastructure endpoints called by the agent runner's poller.
# They replace the former JSONL file queue with atomic SQLite operations.

@app.post("/queue/claim")
async def queue_claim(body: dict = Body({})):
    """Atomically claim the next pending queue event.

    The agent runner calls this when woken by the trigger file.
    Uses a BEGIN IMMEDIATE transaction to prevent race conditions
    between concurrent claim attempts from different processes.

    Request body (optional):
      types_filter: list[str] — restrict claiming to specific event types

    Returns:
      {event: {id, source, type, data, priority, retry_count, ...} | null}
    """
    types_filter = body.get("types_filter")
    event = ephemeral_memory.claim_event(types_filter=types_filter)
    if event:
        print(f"[api] POST /queue/claim → claimed event {event['id'][:8]} "
              f"({event['type']}, priority={event['priority']})")
    else:
        print(f"[api] POST /queue/claim → no pending events")
    return {"event": event}


@app.post("/queue/complete/{event_id}")
async def queue_complete(event_id: str):
    """Mark a claimed event as completed.

    Called by the agent runner after successfully processing an event.
    """
    ok = ephemeral_memory.complete_event(event_id)
    if ok:
        print(f"[api] POST /queue/complete/{event_id[:8]} → completed")
    else:
        print(f"[api] POST /queue/complete/{event_id[:8]} → not found or not processing")
    return {"success": ok}


@app.post("/queue/fail/{event_id}")
async def queue_fail(event_id: str, body: dict = Body({})):
    """Mark a claimed event as failed.

    If retry_count < max_retries, the event is reset to 'pending' for
    re-delivery. If exhausted, it moves to 'failed' status (dead letter).

    Request body:
      error: str — error message (optional)
    """
    error = body.get("error", "")
    ok = ephemeral_memory.fail_event(event_id, error)
    if ok:
        # Check the new state
        stats = ephemeral_memory.get_queue_stats()
        print(f"[api] POST /queue/fail/{event_id[:8]} → failed (queue: "
              f"{stats['pending']} pending, {stats['failed']} dlq)")
    else:
        print(f"[api] POST /queue/fail/{event_id[:8]} → not found or not processing")
    return {"success": ok}


@app.post("/queue/enqueue")
async def queue_enqueue(body: dict = Body(...)):
    """Enqueue a new event. Used by the agent runner's enqueueFailed().

    Request body:
      source: str — 'transcription' or 'agent-runner'
      type: str — event type
      data: dict — event payload
      priority: int (optional, default 0)
      ttl_seconds: int (optional, default 86400)
      max_retries: int (optional, default 5)
    """
    source = body.get("source", "agent-runner")
    event_type = body.get("type", "")
    data = body.get("data", {})
    priority = body.get("priority", 0)
    ttl_seconds = body.get("ttl_seconds", 86400)
    max_retries = body.get("max_retries", 5)

    if not event_type:
        raise HTTPException(400, "type is required")

    event_id = ephemeral_memory.enqueue_event(
        source=source, event_type=event_type, data=data,
        priority=priority, ttl_seconds=ttl_seconds, max_retries=max_retries,
    )
    print(f"[api] POST /queue/enqueue → {event_id[:8]} ({event_type})")

    # Touch trigger so the agent runner picks it up
    agent_bridge._touch_trigger()

    return {"event_id": event_id, "source": source, "type": event_type}


@app.get("/queue/stats")
async def queue_stats():
    """Return queue depth by status.

    Also triggers TTL cleanup of expired completed events on read.
    Used by the agent runner for status checks and the DevPanel for monitoring.
    """
    cleaned = ephemeral_memory.cleanup_expired_events()
    stats = ephemeral_memory.get_queue_stats()
    print(f"[api] GET /queue/stats → {stats} (cleaned {cleaned} expired)")
    return {"stats": stats, "expired_cleaned": cleaned}


@app.post("/queue/requeue/{event_id}")
async def queue_requeue(event_id: str):
    """Move a failed (DLQ) event back to pending for reprocessing.

    Resets retry_count to 0. Called manually via DevPanel or API.
    """
    ok = ephemeral_memory.requeue_dlq_event(event_id)
    if ok:
        print(f"[api] POST /queue/requeue/{event_id[:8]} → requeued")
    else:
        print(f"[api] POST /queue/requeue/{event_id[:8]} → not found or not failed")
    return {"success": ok}


# ── Storage Usage ──


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
                "columns": ephemeral_memory.table_columns(name),
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
        rows = all_rows[offset:offset + limit]
        return {
            "table": table_name,
            "columns": ephemeral_memory.table_columns(table_name),
            "rows": rows,
            # Real total via COUNT(*) — len(all_rows) is capped at limit + offset
            "total": ephemeral_memory.row_count(table_name),
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


if __name__ == "__main__":
    # Required for Windows + PyInstaller: mp.Process uses SPAWN on Windows, so a
    # spawned diarization subprocess re-imports/executes this module. Without
    # freeze_support() the child re-runs the whole backend (port-bind conflict
    # [Errno 10048]) and crashes (exit code 3). No-op when not frozen (macOS dev).
    import multiprocessing
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
