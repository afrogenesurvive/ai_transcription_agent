"""Misc helper functions extracted from main.py (Phase 0).

Most helpers depend only on stdlib + ``config``. ``_dump_all_voiceprints`` is
the only one that touches a runtime service singleton; it reads
``services.vp_manager`` lazily (see services.py for why late binding is
required — the singletons are ``None`` until lifespan() populates them).
"""

import os
from datetime import datetime

from config import config
import patches  # (monkey-patches speechbrain + torchaudio + pyannote)
import services


def _dump_all_voiceprints(label: str):
    """Diagnostic helper: dump all voiceprint DB rows to stdout."""
    try:
        conn = services.vp_manager._get_conn()
        rows = conn.execute(
            "SELECT id, speaker_name, email, job_id FROM voiceprints"
        ).fetchall()
        print(f"[drift] 📋 Voiceprint DB state {label}:")
        for r in rows:
            print(f"  id={r[0]} name={r[1]} email={r[2]} job_id={r[3]}")
    except Exception as e:
        print(f"[drift] ⚠️  _dump_all_voiceprints error: {e}")


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


def _current_dl_progress():
    """Current huggingface_hub download progress (0-100) from the tqdm hook.

    Returns None when no download is actively in progress (e.g. the model is
    already cached and merely being loaded).
    """
    try:
        p = patches.get_dl_progress()
    except Exception:
        return None
    if p.get("active") and p.get("total"):
        return min(100.0, p["done"] / p["total"] * 100.0)
    return None


def _diar_diag(event, detail="", tb=None):
    """Append a diagnostic line to <userData>/logs/diarization-error.log.

    The Setting Up modal truncates the on-screen error, so persist the full
    picture (cache location, attempts, errors, tracebacks) to a file that can
    be read even while the modal is up.
    """
    try:
        log_dir = os.environ.get("ELECTRON_LOGS_DIR") or os.path.join(
            config.STORAGE_PATH, "logs"
        )
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "diarization-error.log"), "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] {event}: {detail}\n")
            if tb:
                f.write(tb if tb.endswith("\n") else tb + "\n")
    except Exception:
        pass


def _diar_diag_env():
    """Log where the app resolves the pyannote/HF caches and whether the model is visible.

    pyannote.audio 3.4 caches under PYANNOTE_CACHE (default ~/.cache/torch/pyannote),
    NOT the huggingface_hub default — the most common confusion when copying a cache
    from another machine.
    """
    try:
        import huggingface_hub.constants as _hf_c
        hf_cache = _hf_c.HUGGINGFACE_HUB_CACHE
        py_cache = os.path.expanduser(os.environ.get("PYANNOTE_CACHE", "~/.cache/torch/pyannote"))
        model_dir = os.path.join(py_cache, "models--pyannote--speaker-diarization-3.1")
        snap = os.path.join(model_dir, "snapshots")
        detail = (
            f"home={os.path.expanduser('~')} | PYANNOTE_CACHE={os.environ.get('PYANNOTE_CACHE')} "
            f"pyannote_cache={py_cache} exists={os.path.exists(py_cache)} | "
            f"hf_cache={hf_cache} exists={os.path.exists(hf_cache)}"
        )
        if os.path.isdir(snap):
            revs = os.listdir(snap)
            files = []
            for r in revs:
                files.extend(sorted(os.listdir(os.path.join(snap, r))))
            detail += f" | pyannote_model_snapshots={revs} files={files}"
        else:
            detail += " | pyannote_model_cache=ABSENT"
        _diar_diag("env", detail)
    except Exception as e:
        _diar_diag("env", f"(env probe failed: {e})")


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


def _job_dir_exists(job_id: str) -> bool:
    """True if the job's storage directory still exists (i.e. wasn't deleted).

    Guards against an orphaned pipeline thread resurrecting a job the user
    deleted from History: upload._write_status() does ``os.makedirs(exist_ok=True)``,
    so a late failure write would recreate the deleted job folder + status.json.
    """
    try:
        return os.path.isdir(os.path.join(config.STORAGE_PATH, job_id))
    except Exception:
        return False
