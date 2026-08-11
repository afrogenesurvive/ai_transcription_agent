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

from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from config import config
from utils import is_network_error

from upload import AudioUploader, resolve_ffmpeg
from voiceprint import VoiceprintManager
from transcription import detect_device
from models import (
    RefineRequest, SummarizeRequest, AnalysisRequest, Deliverable,
    MemorySearchRequest,
    EphemeralMemoryItem, EphemeralMemoryQuery,
    RegisterAttendeesRequest, SaveMeetingContextRequest,
)
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

import services
import services.pipeline  # noqa: F401  (binds services.run_pipeline_async / run_resumed_pipeline_async)
from constants import (
    ML_PIPELINE_STATUSES, EPHEMERAL_TABLES, _STOP_WORDS,
)
from refinement import _auto_refine
from helpers import (
    _log_file_has_errors, _dir_size, _format_bytes,
)
from reconciliation import (
    _ensure_job_attendees_registered, _job_attendee_shortfall,
)
from pipeline_state import PipelineState, state
from model_preload import router as model_preload_router
from routes.transcription import router as transcription_router
from routes.labeling import router as labeling_router

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
app.include_router(transcription_router)
app.include_router(labeling_router)


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


@app.get("/agent/voiceprints")
async def agent_list_voiceprints():
    vps = vp_manager.list_voiceprints()
    print(f"[api] GET /agent/voiceprints → {len(vps)} enrolled")
    return {"voiceprints": vps}


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
