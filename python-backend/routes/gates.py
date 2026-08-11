"""Approval gate routes — Phase 3c extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by services/lifespan.py before any request), and
pipeline state via the shared ``state`` singleton from pipeline_state.py.
"""

import json
import os
import traceback
from datetime import datetime

from fastapi import APIRouter, Body, HTTPException

from config import config
from pipeline_state import state

import services

router = APIRouter()


# ── Approval Gate Endpoints ──

@router.post("/transcribe/approve_gate1/{job_id}")
async def approve_gate1(job_id: str, body: dict = Body(...)):
    """Accept or reject the raw transcript at Gate 1 (post-ASR, pre-LLM).

    Body:
      action: "approve" | "approve_with_edits" | "reject_cancel" | "reject_retry"
      edited_transcript: Optional[{speaker, text, start, end}[]] — full edited transcript

    On approve/enqueue: passes the transcript to the agent runner for LLM processing.
    On reject_cancel: marks the job as failed.
    On reject_retry: re-runs the ML pipeline (ASR + alignment).
    """
    try:
        s = services.uploader.get_status(job_id)
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
                    services.uploader.save_transcript(job_id, edited_transcript)
                    services.uploader.save_transcript_text(job_id, edited_transcript)
                    services.uploader.save_edit_action(job_id, "gate1_edit", {
                        "target": "transcript",
                        "segments_changed": len(edited_transcript),
                    })
                    print(f"[api]   ✏️  Gate 1: transcript edited ({len(edited_transcript)} segments saved)")
            services.uploader.save_edit_action(job_id, "gate1_approve", {"action": action})
            # Reload transcript (may have been edited) and enqueue for agent runner
            p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
            try:
                with open(p) as f:
                    aligned = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                aligned = []
            metadata = services.uploader.get_metadata(job_id)
            skip = metadata.get("skip_steps")
            services.agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=s.get("non_speaking_attendees", []),
            )
            services.uploader.update_status(job_id, {"status": "enqueued"})
            print(f"\n{'═' * 40}")
            print(f"  ✅ GATE 1 COMPLETE (job={job_id[:8]})")
            print(f"  Status: enqueued for agent runner")
            print(f"  Pipeline resuming...")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "enqueued", "action": action}

        elif action == "reject_cancel":
            services.uploader.save_edit_action(job_id, "gate1_reject_cancel", {})
            services.uploader.update_status(job_id, {
                "status": "failed",
                "error": "Rejected at raw transcript review (Gate 1)",
            })
            print(f"[api]   ❌ Gate 1: rejected and cancelled")
            print(f"\n{'═' * 40}")
            print(f"  ⛔ GATE 1 REJECTED — Job cancelled (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "failed"}

        elif action == "reject_retry":
            services.uploader.save_edit_action(job_id, "gate1_reject_retry", {})
            services.uploader.update_status(job_id, {"status": "reprocessing", "progress": 0.0})
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


@router.post("/transcribe/approve_gate2/{job_id}")
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
    try:
        s = services.uploader.get_status(job_id)
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
                    services.uploader.save_transcript(job_id, edited_transcript)
                    services.uploader.save_transcript_text(job_id, edited_transcript)
                    services.uploader.save_edit_action(job_id, "gate2_edit_transcript", {
                        "segments_changed": len(edited_transcript),
                    })
                    edits_made.append("transcript")

            edited_summary = body.get("editedSummary") or body.get("edited_summary")
            if edited_summary:
                services.uploader.save_summary(job_id, edited_summary)
                services.uploader.save_edit_action(job_id, "gate2_edit_summary", {
                    "fields_changed": list(edited_summary.keys()),
                })
                edits_made.append("summary")

            edited_analysis = body.get("editedAnalysis") or body.get("edited_analysis")
            if edited_analysis:
                services.uploader.save_analysis(job_id, edited_analysis)
                services.uploader.save_edit_action(job_id, "gate2_edit_analysis", {
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

            services.uploader.save_edit_action(job_id, "gate2_approve", {
                "action": action,
                "edits": edits_made,
            })

            # Enqueue delivery_approved event for the agent runner.
            # Read title from metadata.json (not status.json, which lacks a title field).
            meta = services.uploader.get_metadata(job_id)
            services.agent_bridge.enqueue("delivery_approved", {
                "jobId": job_id,
                "title": meta.get("title", "Untitled Meeting"),
                "edits_made": edits_made,
            })
            services.uploader.update_status(job_id, {"status": "delivery_approved"})
            print(f"[api]   ✅ Gate 2: approved — delivery_approved enqueued (edits: {edits_made})")
            print(f"\n{'═' * 40}")
            print(f"  ✅ GATE 2 COMPLETE (job={job_id[:8]})")
            print(f"  Status: delivery_approved — agent runner resuming")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "delivery_approved", "edits_made": edits_made}

        elif action == "reject_cancel":
            err_msg = body.get("feedback", "") or "Rejected at delivery review (Gate 2)"
            services.uploader.save_edit_action(job_id, "gate2_reject_cancel", {"feedback": body.get("feedback", "")})
            services.uploader.update_status(job_id, {"status": "failed", "error": err_msg})
            print(f"[api]   ❌ Gate 2: rejected and cancelled")
            print(f"\n{'═' * 40}")
            print(f"  ⛔ GATE 2 REJECTED — Job cancelled (job={job_id[:8]})")
            print(f"{'═' * 40}\n")
            return {"job_id": job_id, "status": "failed"}

        elif action == "reject_retry":
            feedback = body.get("feedback", "")
            services.uploader.save_edit_action(job_id, "gate2_reject_retry", {"feedback": feedback})
            # Reset to enqueued so the agent runner re-processes from the beginning
            metadata = services.uploader.get_metadata(job_id)
            p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
            try:
                with open(p) as f:
                    aligned = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                aligned = []
            skip = metadata.get("skip_steps")
            # Enqueue with retry flag + user feedback (enqueue BEFORE status update)
            services.agent_bridge.enqueue("ready_for_processing", {
                "jobId": job_id,
                "title": metadata.get("title", "Untitled Meeting"),
                "attendees": metadata.get("attendees", []),
                "transcript": aligned,
                "skip_steps": skip,
                "retry_feedback": feedback,
                "retry_from_gate2": True,
            })
            services.uploader.update_status(job_id, {"status": "enqueued"})
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
