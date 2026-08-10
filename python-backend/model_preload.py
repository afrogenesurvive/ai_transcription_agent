"""Model preload machinery + status endpoint, extracted from main.py (Phase 1).

The pyannote diarization pipeline and the voiceprint embedding model are loaded
ONCE in background asyncio tasks so that /transcribe/models/status never blocks
the request — important on first run where models must be downloaded (can take
minutes). The status endpoint returns the current state instantly and the UI can
show download progress.

The preload is fully lazy: ``_ensure_diarization_load_started`` and
``_ensure_embedding_model_load_started`` are only called by the models/status
route. The only runtime singleton touched is ``services.vp_manager`` (used by
``_load_embedding_model_sync`` for ``preload_model()``).
"""

import asyncio
import os
import traceback

from fastapi import APIRouter

from config import config
import patches
import services
from helpers import _diar_diag, _diar_diag_env, _current_dl_progress
from transcription import detect_device

# ── Diarization model status (non-blocking) ──
# status: "idle" | "downloading" | "loading" | "available" | "error"
_diar_model_state: dict = {
    "status": "idle",
    "progress": None,      # float 0-100 when known, else None
    "available": False,
    "error": None,         # str | None
    "traceback": None,     # str | None
    "started": False,
}
_diar_model_task: asyncio.Task = None

# ── Voiceprint embedding model status (non-blocking) ──
# status: "idle" | "loading" | "available" | "error"
_emb_model_state: dict = {
    "status": "idle",
    "available": False,
    "error": None,
    "traceback": None,
    "started": False,
}
_emb_model_task: asyncio.Task = None

router = APIRouter()


def _load_diarization_model_sync():
    """Synchronous pyannote pipeline load (runs inside a worker thread)."""
    result: dict = {"available": False, "error": None, "traceback": None}
    _diar_diag_env()
    try:
        from pyannote.audio import Pipeline
        import torch as _torch
        hf_token = config.HUGGING_FACE_TOKEN
        if not hf_token:
            result["error"] = (
                "No HUGGING_FACE_TOKEN set. "
                f"Get a token at https://hf.co/settings/tokens and accept the model terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL}"
            )
            return result

        # PyTorch 2.6+ needs relaxed loading for pyannote pickle models.
        _orig_load = _torch.load
        try:
            # Force weights_only=False — lightning_fabric (used by pyannote)
            # explicitly passes weights_only=True, so setdefault is not enough.
            def _permissive_load(f, *a, **kw):
                kw["weights_only"] = False
                return _orig_load(f, *a, **kw)
            _torch.load = _permissive_load

            # Try online first so pyannote can check for model updates. On ANY
            # failure (network, TLS, transient, auth) retry from the local cache
            # so an already-downloaded model still loads offline. Note: pyannote's
            # from_pretrained does NOT accept local_files_only, so we force the
            # whole process offline (HF_HUB_OFFLINE) instead of passing it.
            _diar_diag("attempt", "online")
            try:
                pipeline = Pipeline.from_pretrained(
                    config.DIARIZATION_MODEL, use_auth_token=hf_token,
                )
            except Exception as _hub_err:
                import traceback as _tb
                _diar_diag("online_failed", str(_hub_err)[:500], _tb.format_exc())
                _diar_diag("download_progress", str(patches.get_dl_progress()))
                patches.force_offline()
                _diar_diag("attempt", "offline (fallback to cache)")
                try:
                    pipeline = Pipeline.from_pretrained(
                        config.DIARIZATION_MODEL, use_auth_token=hf_token,
                    )
                except Exception:
                    _diar_diag("offline_failed", str(_hub_err)[:500])
                    # No usable local cache — surface the ORIGINAL online error.
                    raise _hub_err
                _diar_diag("result", "loaded from local cache (online unreachable)")
            if pipeline is None:
                result["error"] = (
                    f"Model '{config.DIARIZATION_MODEL}' returned None — "
                    f"it may be gated. Accept terms at "
                    f"https://hf.co/{config.DIARIZATION_MODEL}"
                )
            else:
                pipeline.to(_torch.device("cpu"))
                result["available"] = True
                del pipeline
                _diar_diag("result", "available")
        finally:
            _torch.load = _orig_load
    except Exception as e:
        result["traceback"] = traceback.format_exc()
        msg = str(e)
        if "gated" in msg.lower() or "access" in msg.lower() or "token" in msg.lower():
            result["error"] = (
                "Model is gated — accept terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL} and set HUGGING_FACE_TOKEN"
            )
        elif "module" in msg.lower() and "torchaudio" in msg.lower():
            result["error"] = (
                f"PyTorch/torchaudio compatibility issue: {msg[:200]}. "
                f"Try reinstalling pyannote.audio: pip install --upgrade pyannote.audio"
            )
        else:
            result["error"] = f"Model failed to load: {msg[:300]}"
        _diar_diag("error", result["error"], result["traceback"])
    return result


async def _diarization_load_worker():
    """Background load of the pyannote diarization model (runs once).

    Runs the blocking pipeline load in a thread so the status endpoint never
    blocks. While running, ``_diar_model_state["status"]`` is "downloading";
    the endpoint refines that to "loading" when no download is actually active
    (cached model) and reports ``progress`` from the tqdm hook on first run.
    """
    if not config.HUGGING_FACE_TOKEN:
        _diar_model_state["status"] = "error"
        _diar_model_state["error"] = (
            "No HUGGING_FACE_TOKEN set. "
            f"Get a token at https://hf.co/settings/tokens and accept the model terms at "
            f"https://hf.co/{config.DIARIZATION_MODEL}"
        )
        return
    _diar_model_state["status"] = "downloading"
    _diar_model_state["progress"] = None
    try:
        outcome = await asyncio.to_thread(_load_diarization_model_sync)
    except Exception as e:  # pragma: no cover - defensive
        _diar_model_state["status"] = "error"
        _diar_model_state["error"] = f"Model failed to load: {e}"
        _diar_model_state["traceback"] = traceback.format_exc()
        return
    _diar_model_state["available"] = bool(outcome.get("available"))
    _diar_model_state["error"] = outcome.get("error")
    _diar_model_state["traceback"] = outcome.get("traceback")
    _diar_model_state["status"] = "available" if _diar_model_state["available"] else "error"
    _diar_model_state["progress"] = None


async def _ensure_diarization_load_started():
    """Lazily start the background diarization load exactly once."""
    global _diar_model_task
    if _diar_model_state["started"]:
        return
    # No await between check and set, so this is race-free on the event loop.
    _diar_model_state["started"] = True
    _diar_model_task = asyncio.create_task(_diarization_load_worker())


def _load_embedding_model_sync():
    """Synchronous voiceprint embedding-model load (runs in a worker thread)."""
    if not config.HUGGING_FACE_TOKEN:
        return {
            "available": False,
            "error": (
                "No HUGGING_FACE_TOKEN set. "
                "Get a token at https://hf.co/settings/tokens and accept the model terms at "
                "https://hf.co/pyannote/embedding"
            ),
            "traceback": None,
        }
    return services.vp_manager.preload_model()


async def _embedding_model_load_worker():
    """Background load of the voiceprint embedding model (runs once)."""
    _emb_model_state["status"] = "loading"
    try:
        outcome = await asyncio.to_thread(_load_embedding_model_sync)
    except Exception as e:  # pragma: no cover - defensive
        _emb_model_state["status"] = "error"
        _emb_model_state["error"] = f"Model failed to load: {e}"
        _emb_model_state["traceback"] = traceback.format_exc()
        return
    _emb_model_state["available"] = bool(outcome.get("available"))
    _emb_model_state["error"] = outcome.get("error")
    _emb_model_state["traceback"] = outcome.get("traceback")
    _emb_model_state["status"] = "available" if _emb_model_state["available"] else "error"


async def _ensure_embedding_model_load_started():
    """Lazily start the background embedding-model load exactly once."""
    global _emb_model_task
    if _emb_model_state["started"]:
        return
    # No await between check and set, so this is race-free on the event loop.
    _emb_model_state["started"] = True
    _emb_model_task = asyncio.create_task(_embedding_model_load_worker())


@router.get("/transcribe/models/status")
async def models_status():
    """Check which ML models are available. Helps users diagnose setup issues.

    Non-blocking: the pyannote pipeline is loaded once in a background task, so
    this endpoint returns instantly. On first run (fresh install / empty cache)
    it reports ``diarization_status: "downloading"`` with a progress percentage
    (when known) so the UI can show the model fetch.
    """
    await _ensure_diarization_load_started()
    await _ensure_embedding_model_load_started()

    state = _diar_model_state
    if state["status"] == "downloading":
        pct = _current_dl_progress()
        if pct is not None:
            status, progress = "downloading", pct
        else:
            status, progress = "loading", None
    else:
        status, progress = state["status"], None

    result = {
        "device": detect_device(),
        "whisper_model": config.WHISPER_MODEL_SIZE,
        "diarization_model": config.DIARIZATION_MODEL,
        "diarization_available": state["available"],
        "diarization_error": state["error"],
        "diarization_traceback": state["traceback"],
        "hf_token_configured": bool(config.HUGGING_FACE_TOKEN),
        "diarization_status": status,
        "diarization_progress": progress,
    }

    status_icon = "✅" if state["available"] else "❌"
    print(f"[api] GET /transcribe/models/status → diarization={status_icon} status={status} device={result['device']}")
    if state["error"]:
        print(f"[api]   diarization_error: {state['error'][:200]}")
    return result
