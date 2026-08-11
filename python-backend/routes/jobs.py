"""Job CRUD routes — Phase 3g extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by main.lifespan() before any request), and
pipeline state via the shared ``state`` singleton from pipeline_state.py.
"""

import json
import os
import shutil
from datetime import datetime

from fastapi import APIRouter, Body, HTTPException

from config import config
from pipeline_state import state
from reconciliation import _ensure_job_attendees_registered

import services

router = APIRouter()


# ── Job record upsert (called from agent-runner for touchpoints C & D) ──

@router.post("/transcribe/job/upsert")
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

        services.ephemeral_memory.upsert_job(job_id, updates)
        print(f"[api] POST /transcribe/job/upsert/{job_id[:8]} → {len(updates)} field(s) updated")
        return {"success": True, "job_id": job_id}
    except Exception as e:
        print(f"[api] POST /transcribe/job/upsert ERROR: {e}")
        raise HTTPException(500, f"Job upsert failed: {e}")


@router.get("/transcribe/job/{job_id}")
async def get_job_record(job_id: str):
    """Fetch the full ephemeral DB job record for a given job ID.

    Returns the complete row from the jobs table, including config_snapshot,
    token usage, delivery results, and all metadata. Returns 404 if not found.
    """
    try:
        record = services.ephemeral_memory.get_job(job_id)
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
    for _col in ("config_snapshot", "delivery_results", "pipeline_steps"):
        _raw = record.get(_col)
        if _raw and isinstance(_raw, str):
            try:
                record[_col] = json.loads(_raw)
            except (json.JSONDecodeError, TypeError):
                pass  # leave as-is if the value isn't valid JSON

    print(f"[api] GET /transcribe/job/{job_id} → OK ({len(record)} fields)")
    return {"job": record}


@router.post("/transcribe/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running pipeline job. Always marks the job as failed."""
    s = services.uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    state._pipeline_cancel.add(job_id)
    # Cancel the asyncio task if it's still running
    task = state._pipeline_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    services.uploader.update_status(job_id, {"status": "failed", "error": "Cancelled by user", "progress": 0.0})
    state._active_jobs.pop(job_id, None)
    # Persist terminal state
    try:
        services.ephemeral_memory.upsert_job(job_id, {"result": "cancelled", "completed_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[api] Warning: could not persist cancelled state: {e}")
    print(f"[api] POST /transcribe/cancel/{job_id} → cancelled")
    return {"job_id": job_id, "status": "cancelled", "cancelled": True}


@router.post("/transcribe/fail/{job_id}")
async def fail_job(job_id: str, error: str = "Processing failed"):
    """Mark a job as failed with a specific error message. Called by the agent runner when the LLM pipeline fails."""
    s = services.uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    services.uploader.update_status(job_id, {"status": "failed", "error": error, "progress": 0.0})
    state._active_jobs.pop(job_id, None)
    # Persist terminal state
    try:
        services.ephemeral_memory.upsert_job(job_id, {"result": "failed", "error_message": error, "completed_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[api] Warning: could not persist failed state: {e}")
    print(f"[api] POST /transcribe/fail/{job_id} → failed: {error[:120]}")
    return {"job_id": job_id, "status": "failed", "error": error}


@router.post("/transcribe/complete/{job_id}")
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
    s = services.uploader.get_status(job_id)
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
                services.uploader.update_status(job_id, {"warnings": []})
            except Exception:
                pass
    else:
        state._active_jobs.pop(job_id, None)
        services.uploader.update_status(job_id, {"status": "complete_with_warning", "progress": 1.0})
        print(f"[api] POST /transcribe/complete/{job_id} → preserved complete_with_warning "
              f"(attendee registration pending)")
        return {"job_id": job_id, "status": "complete_with_warning"}

    services.uploader.update_status(job_id, {"status": "complete", "progress": 1.0})
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
        services.ephemeral_memory.upsert_job(job_id, {
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


@router.post("/transcribe/save_summary/{job_id}")
async def save_summary_edits(job_id: str, body: dict = Body(...)):
    """Save edited summary after job completion. Logs the edit for audit.

    Body:
      summary: dict — the full summary object (executive_summary, key_decisions,
                      discussion_points, action_items)
    """
    s = services.uploader.get_status(job_id)
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

        services.uploader.save_summary(job_id, summary)
        if changed_fields:
            services.uploader.save_edit_action(job_id, "post_complete_edit_summary", {
                "fields_changed": changed_fields,
            })

        print(f"[api] POST /transcribe/save_summary/{job_id} → saved (changed: {changed_fields})")
        return {"success": True, "job_id": job_id, "fields_changed": changed_fields}

    raise HTTPException(409, f"Cannot edit summary for job in status: {s['status']}")


@router.post("/transcribe/save_analysis/{job_id}")
async def save_analysis_edits(job_id: str, body: dict = Body(...)):
    """Save edited analysis after job completion. Logs the edit for audit.

    Body:
      analysis: dict — the full analysis object (topics, sentiment, key_entities,
                       effectiveness, follow_ups)
    """
    s = services.uploader.get_status(job_id)
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

        services.uploader.save_analysis(job_id, analysis)
        if changed_fields:
            services.uploader.save_edit_action(job_id, "post_complete_edit_analysis", {
                "fields_changed": changed_fields,
            })

        print(f"[api] POST /transcribe/save_analysis/{job_id} → saved (changed: {changed_fields})")
        return {"success": True, "job_id": job_id, "fields_changed": changed_fields}

    raise HTTPException(409, f"Cannot edit analysis for job in status: {s['status']}")


# ── Job Deletion ──

@router.delete("/transcribe/job/{job_id}")
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
