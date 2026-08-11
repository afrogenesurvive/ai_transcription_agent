"""Storage management routes — Phase 3g extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by main.lifespan() before any request), and
pipeline state via the shared ``state`` singleton from pipeline_state.py.
"""

import os
import shutil

from fastapi import APIRouter, HTTPException

from config import config
from pipeline_state import state
from helpers import _dir_size, _format_bytes, _log_file_has_errors

import services

router = APIRouter()


# ── Log Deletion ──


@router.delete("/storage/logs")
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

@router.delete("/storage/jobs")
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
    if services.uploader and hasattr(services.uploader, '_status_cache'):
        services.uploader._status_cache.clear()

    msg = f"Deleted {deleted} job director{'y' if deleted == 1 else 'ies'}"
    if errors:
        msg += f" ({errors} error(s))"
    return {"deleted": deleted, "errors": errors, "message": msg}


# ── Clear Semantic Memory (ChromaDB) ──

@router.delete("/storage/semantic")
async def clear_semantic_memory():
    """Delete all ChromaDB vector store data (semantic memory)."""
    chroma_dir = os.path.join(config.STORAGE_PATH, "chroma")
    if not os.path.exists(chroma_dir):
        return {"deleted": False, "message": "No ChromaDB data found"}

    try:
        # Clear in-memory collection reference first
        if services.semantic_memory:
            services.semantic_memory._collection = None

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

@router.delete("/storage/ephemeral")
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
                if fname == "ephemeral_memory.db" and services.ephemeral_memory:
                    services.ephemeral_memory.close_all()
                if fname == "voiceprints.db" and services.vp_manager:
                    services.vp_manager.close_all()
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
        if services.ephemeral_memory:
            services.ephemeral_memory.__init__()
        if services.vp_manager:
            services.vp_manager.__init__()
    except Exception as e:
        print(f"[api] DELETE /storage/ephemeral → re-init warning: {e}")

    if not deleted_files and not errors:
        return {"deleted": [], "message": "No database files found"}

    msg = f"Deleted: {', '.join(deleted_files)}" if deleted_files else "Nothing deleted"
    if errors:
        msg += f" | Errors: {', '.join(errors)}"

    return {"deleted": deleted_files, "errors": errors, "message": msg}


# ── Storage Usage ──


@router.get("/storage/usage")
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
