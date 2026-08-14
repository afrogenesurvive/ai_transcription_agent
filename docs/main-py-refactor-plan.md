# Python Backend — Code Structure

High-level note on the Python backend's organization. The detailed refactoring
plan (per-route implementation, line maps, verification steps) is maintained
internally and is not published in this repo.

## Current structure (high level)

The backend's `main.py` is kept deliberately small (~120 lines) and acts as the
application entry point:

- **Environment setup** + FastAPI app/CORS + router registration + `__main__` runner.
- **`routes/` package** — one module per domain (transcription, labeling, gates,
  agent, memory, queue, jobs/storage, system).
- **`services/` package** — pipeline orchestration, lifespan/startup, and the
  service registry.
- **Support modules** — constants, helpers, refinement (filler/PII processing),
  reconciliation (attendees/voiceprints), pipeline state, model preload, models,
  semantic/ephemeral memory, upload.

This layout keeps the backend maintainable, and each refactor step was done in
independent, revertible commits. See `backend_architecture.md` for the broader
architecture.
