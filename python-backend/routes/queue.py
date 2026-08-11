"""Queue routes (SQLite-backed event queue) — Phase 3f extraction from main.py.

Handlers moved verbatim from main.py. Singletons are accessed lazily via the
``services`` registry (populated by services/lifespan.py before any request).
"""

from fastapi import APIRouter, Body, HTTPException

import services

router = APIRouter()


# ── Queue Endpoints (SQLite-backed event queue) ──
# These are infrastructure endpoints called by the agent runner's poller.
# They replace the former JSONL file queue with atomic SQLite operations.

@router.post("/queue/claim")
async def queue_claim(body: dict = Body({})):
    """Atomically claim the next pending queue event.

    The agent runner calls this when woken by the trigger file.
    Uses a BEGIN IMMEDIATE transaction to prevent race conditions
    between concurrent claim attempts from different processes.

    Request body (optional):
      types_filter: list[str] — restrict claiming to specific event types

    Returns:
      {event: {id, source, type, data, priority, retry_count, ...} | null}
    """
    types_filter = body.get("types_filter")
    event = services.ephemeral_memory.claim_event(types_filter=types_filter)
    if event:
        print(f"[api] POST /queue/claim → claimed event {event['id'][:8]} "
              f"({event['type']}, priority={event['priority']})")
    else:
        print(f"[api] POST /queue/claim → no pending events")
    return {"event": event}


@router.post("/queue/complete/{event_id}")
async def queue_complete(event_id: str):
    """Mark a claimed event as completed.

    Called by the agent runner after successfully processing an event.
    """
    ok = services.ephemeral_memory.complete_event(event_id)
    if ok:
        print(f"[api] POST /queue/complete/{event_id[:8]} → completed")
    else:
        print(f"[api] POST /queue/complete/{event_id[:8]} → not found or not processing")
    return {"success": ok}


@router.post("/queue/fail/{event_id}")
async def queue_fail(event_id: str, body: dict = Body({})):
    """Mark a claimed event as failed.

    If retry_count < max_retries, the event is reset to 'pending' for
    re-delivery. If exhausted, it moves to 'failed' status (dead letter).

    Request body:
      error: str — error message (optional)
    """
    error = body.get("error", "")
    ok = services.ephemeral_memory.fail_event(event_id, error)
    if ok:
        # Check the new state
        stats = services.ephemeral_memory.get_queue_stats()
        print(f"[api] POST /queue/fail/{event_id[:8]} → failed (queue: "
              f"{stats['pending']} pending, {stats['failed']} dlq)")
    else:
        print(f"[api] POST /queue/fail/{event_id[:8]} → not found or not processing")
    return {"success": ok}


@router.post("/queue/enqueue")
async def queue_enqueue(body: dict = Body(...)):
    """Enqueue a new event. Used by the agent runner's enqueueFailed().

    Request body:
      source: str — 'transcription' or 'agent-runner'
      type: str — event type
      data: dict — event payload
      priority: int (optional, default 0)
      ttl_seconds: int (optional, default 86400)
      max_retries: int (optional, default 5)
    """
    source = body.get("source", "agent-runner")
    event_type = body.get("type", "")
    data = body.get("data", {})
    priority = body.get("priority", 0)
    ttl_seconds = body.get("ttl_seconds", 86400)
    max_retries = body.get("max_retries", 5)

    if not event_type:
        raise HTTPException(400, "type is required")

    event_id = services.ephemeral_memory.enqueue_event(
        source=source, event_type=event_type, data=data,
        priority=priority, ttl_seconds=ttl_seconds, max_retries=max_retries,
    )
    print(f"[api] POST /queue/enqueue → {event_id[:8]} ({event_type})")

    # Touch trigger so the agent runner picks it up
    services.agent_bridge._touch_trigger()

    return {"event_id": event_id, "source": source, "type": event_type}


@router.get("/queue/stats")
async def queue_stats():
    """Return queue depth by status.

    Also triggers TTL cleanup of expired completed events on read.
    Used by the agent runner for status checks and the DevPanel for monitoring.
    """
    cleaned = services.ephemeral_memory.cleanup_expired_events()
    stats = services.ephemeral_memory.get_queue_stats()
    print(f"[api] GET /queue/stats → {stats} (cleaned {cleaned} expired)")
    return {"stats": stats, "expired_cleaned": cleaned}


@router.post("/queue/requeue/{event_id}")
async def queue_requeue(event_id: str):
    """Move a failed (DLQ) event back to pending for reprocessing.

    Resets retry_count to 0. Called manually via DevPanel or API.
    """
    ok = services.ephemeral_memory.requeue_dlq_event(event_id)
    if ok:
        print(f"[api] POST /queue/requeue/{event_id[:8]} → requeued")
    else:
        print(f"[api] POST /queue/requeue/{event_id[:8]} → not found or not failed")
    return {"success": ok}
