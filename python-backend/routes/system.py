"""System routes extracted from main.py (Phase 4).

Only `/health` lives here. `/transcribe/models/status` stays in `model_preload.py`
(Phase 1) because it owns the model-state machinery it reports on. Singletons are
accessed lazily through the `services` registry (populated by `services/lifespan.py`
before any request) — never `from main import ...` (main.py runs as __main__ and a
second import would re-execute the file without ever running lifespan()).
"""

from fastapi import APIRouter

from transcription import detect_device

router = APIRouter()


@router.get("/health")
async def health():
    print(f"[api] GET /health")
    return {"status": "ok", "device": detect_device()}
