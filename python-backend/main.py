"""
FastAPI application — transcription backend

Endpoints:
  ML Pipeline: /transcribe/upload, /transcribe/status/{id}, /transcribe/transcript/{id}
  Agent-facing: /agent/refine, /agent/summarize, /agent/label_speakers, /agent/deliver
  Memory:       /memory/search, /memory/ephemeral/query, /memory/ephemeral/save, /memory/save_context
"""

import os
import sys
import json
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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from config import config

from upload import AudioUploader
from voiceprint import VoiceprintManager
from transcription import detect_device
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

import services
import services.pipeline  # noqa: F401  (binds services.run_pipeline_async / run_resumed_pipeline_async)
from constants import (
    ML_PIPELINE_STATUSES,
)
from reconciliation import (
    _ensure_job_attendees_registered, _job_attendee_shortfall,
)
from model_preload import router as model_preload_router
from routes.transcription import router as transcription_router
from routes.labeling import router as labeling_router
from routes.jobs import router as jobs_router
from routes.storage import router as storage_router
from routes.gates import router as gates_router
from routes.memory import router as memory_router
from routes.queue import router as queue_router
from routes.agent import router as agent_router

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
app.include_router(jobs_router)
app.include_router(storage_router)
app.include_router(gates_router)
app.include_router(memory_router)
app.include_router(queue_router)
app.include_router(agent_router)


@app.get("/health")
async def health():
    print(f"[api] GET /health")
    return {"status": "ok", "device": detect_device()}


if __name__ == "__main__":
    # Required for Windows + PyInstaller: mp.Process uses SPAWN on Windows, so a
    # spawned diarization subprocess re-imports/executes this module. Without
    # freeze_support() the child re-runs the whole backend (port-bind conflict
    # [Errno 10048]) and crashes (exit code 3). No-op when not frozen (macOS dev).
    import multiprocessing
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
