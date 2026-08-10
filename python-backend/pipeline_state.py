"""Pipeline execution state, consolidated out of main.py (Phase 1).

Holds the in-memory job tracking, cancellation set, asyncio task registry, MPS
OOM flag, inter-job cooldown timestamp, and the concurrency semaphore, plus the
methods that operate on them.

Staying code in main.py (the pipeline runners and the cancel/delete/clear
routes) accesses the attributes directly via ``state._active_jobs`` etc. The two
start methods call the pipeline runners through the late-bound callables
``services.run_pipeline_async`` / ``services.run_resumed_pipeline_async``
(populated at the bottom of main.py) so there is no import cycle.

Note: ``_mps_oom_occurred``, ``_last_pipeline_end_time`` and
``_pipeline_semaphore`` are plain attributes — they are consumed only by the
pipeline runners that stay in main.py (no PipelineState method touches them).
"""

import asyncio
import time

from config import config
from constants import _STATUS_MESSAGES, _MAX_STEP_MESSAGES, PIPELINE_TIMEOUT_SECONDS
import services


class PipelineState:
    """In-memory state for the transcription ML pipeline (Phase 1)."""

    def __init__(self):
        self._pipeline_tasks: dict[str, asyncio.Task] = {}
        self._pipeline_cancel: set[str] = set()
        self._pipeline_semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_PIPELINES)
        # In-memory active job tracking (replaces disk-scanning in /transcribe/active)
        # Keyed by job_id; values are {status, progress, title}
        self._active_jobs: dict[str, dict] = {}
        # MPS OOM flag — set when an ML step hits an MPS out-of-memory error.
        # The pipeline reads this after each ML step and falls back to CPU for
        # subsequent steps to avoid cascading failures.
        self._mps_oom_occurred: bool = False
        # Timestamp of the last pipeline completion — used to insert a cooldown
        # delay between sequential jobs so MPS fragmented memory can settle.
        self._last_pipeline_end_time: float = 0.0

    def update_active(self, job_id: str, status: str, progress: float, **extra):
        """Update the in-memory active job tracker and persist to disk."""
        # Don't re-add jobs that have been cancelled — the thread may still be
        # running an ML operation when the cancel endpoint already popped the job.
        if job_id in self._pipeline_cancel:
            return
        self._active_jobs[job_id] = {**self._active_jobs.get(job_id, {}), "status": status, "progress": progress}
        self._active_jobs[job_id].update(extra)

        # Append a simplified step message for the mini live log
        msg = _STATUS_MESSAGES.get(status)
        if msg:
            msgs = self._active_jobs[job_id].setdefault("step_messages", [])
            msgs.append(msg)
            self._active_jobs[job_id]["step_messages"] = msgs[-_MAX_STEP_MESSAGES:]

        update_kwargs = {"status": status, "progress": progress}
        if extra:
            update_kwargs.update(extra)
        services.uploader.update_status(job_id, update_kwargs)

    def add_step_message(self, job_id: str, message: str):
        """Append a custom step message to a job's live log (used by agent runner)."""
        if not message:
            return
        if job_id in self._active_jobs:
            msgs = self._active_jobs[job_id].setdefault("step_messages", [])
            msgs.append(message)
            self._active_jobs[job_id]["step_messages"] = msgs[-_MAX_STEP_MESSAGES:]
        # Also persist to disk so the frontend can read it
        services.uploader.update_status(job_id, {"step_messages": self._active_jobs.get(job_id, {}).get("step_messages", [])})

    def check_cancelled(self, job_id: str) -> bool:
        """Check if this job has been cancelled. Returns True if cancelled."""
        if job_id in self._pipeline_cancel:
            print(f"\n   🛑 [pipeline] Job {job_id} cancelled — stopping.")
            self._pipeline_cancel.discard(job_id)
            self._pipeline_tasks.pop(job_id, None)
            self._active_jobs.pop(job_id, None)
            return True
        return False

    @staticmethod
    def check_pipeline_timeout(job_id: str, start_time: float, jlog=None) -> bool:
        """Check if the pipeline has exceeded the wall-clock timeout.

        Returns True if timed out (caller should return/fail). Raises
        TimeoutError so the outer try/except catches it and sets failed status.
        """
        elapsed = time.time() - start_time
        if elapsed > PIPELINE_TIMEOUT_SECONDS:
            msg = (f"Pipeline exceeded {PIPELINE_TIMEOUT_SECONDS // 60}-minute timeout "
                   f"(elapsed={elapsed:.0f}s)")
            if jlog:
                jlog.log(f"\n   ⏰ [pipeline] {msg}")
            raise TimeoutError(msg)
        return False

    def start_pipeline_async(self, job_id: str):
        """Fire-and-forget: create an asyncio task for the pipeline, tracked
        so it can be cancelled and monitored via the /transcribe/active endpoint."""
        task = asyncio.create_task(services.run_pipeline_async(job_id))
        self._pipeline_tasks[job_id] = task

    def start_resumed_pipeline(self, job_id: str, label_map: dict, excluded_non_speaking: list = None):
        """Launch the resumed pipeline in a background asyncio task."""
        task = asyncio.create_task(
            services.run_resumed_pipeline_async(job_id, label_map, excluded_non_speaking)
        )
        self._pipeline_tasks[job_id] = task
