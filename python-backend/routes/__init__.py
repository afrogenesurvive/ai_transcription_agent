# Route domain modules extracted from main.py (Phase 3).
# Each module defines `router = APIRouter()`; main.py includes them via
# app.include_router(...). Singletons are accessed lazily through the
# `services` registry (populated by main.lifespan() before any request) —
# never `from main import ...` (main.py runs as __main__ and a second import
# would re-execute the file without ever running lifespan()).
