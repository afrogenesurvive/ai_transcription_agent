"""
Agent Bridge — enqueues jobs for the agent runner via SQLite-backed event queue.

When a transcription job completes a processing stage (diarization, labeling,
summarization), this module writes an event to the ``events`` table in
``ephemeral_memory.db`` and touches ``.transcription-trigger`` so the agent
runner (watching via fs.watch) picks it up immediately — no polling needed.

Previously used a JSONL file (``transcription.jsonl``), migrated to SQLite
for ACID guarantees, retry tracking, and dead-letter semantics.
"""

import os
import json
import time
import uuid
from typing import Optional
from config import config


class AgentBridge:
    def __init__(self, queue_dir: Optional[str] = None,
                 ephemeral_memory=None):
        self.queue_dir = queue_dir or config.QUEUE_DIR
        self.trigger_file = config.TRIGGER_FILE
        self._ephemeral = ephemeral_memory
        # Ensure the trigger file directory exists
        os.makedirs(self.queue_dir, exist_ok=True)

    def enqueue(self, event_type: str, data: dict,
                priority: int = 0, ttl_seconds: int = 86400) -> str:
        """Write event to SQLite queue and touch trigger to wake the runner.

        Args:
            event_type: Event type string
            data: JSON-serializable payload
            priority: Higher = processed first (default 0)
            ttl_seconds: Auto-delete after N seconds post-completion (default 24h)

        Returns:
            The generated event ID (UUID4 hex)
        """
        job_id = data.get("jobId", "?")
        print(f"[agent_bridge] Enqueueing event: type={event_type} job={job_id}")

        if self._ephemeral is not None:
            event_id = self._ephemeral.enqueue_event(
                source="transcription",
                event_type=event_type,
                data=data,
                priority=priority,
                ttl_seconds=ttl_seconds,
            )
            print(f"[agent_bridge] Event {event_id[:8]} written to SQLite events table")
        else:
            # Fallback: use a UUID directly (no DB available)
            event_id = str(uuid.uuid4())
            print(f"[agent_bridge] Warning: no ephemeral_memory provided — "
                  f"event {event_id[:8]} cannot be persisted")

        self._touch_trigger()
        print(f"[agent_bridge] Trigger file touched — agent runner will pick up")
        return event_id

    def enqueue_ready(self, job_id: str, transcript: list, metadata: dict,
                      unknown_speakers: Optional[list] = None,
                      skip_steps: Optional[list] = None,
                      non_speaking_attendees: Optional[list] = None):
        """Diarization + transcription complete, ready for LLM processing.

        Args:
            skip_steps: List of tool names to skip in the agent pipeline.
                        Defaults to ["transcribe_analyze", "transcribe_prepare_delivery",
                        "send_delivery_email", "save_to_drive", "create_trello_action_items"].
                        Pass an empty list to run all steps.
            non_speaking_attendees: List of attendee names who were registered
                        but did not speak (present but silent). Passed to the LLM
                        prompt so the agent can report accurate attendance.
        """
        if skip_steps is None:
            skip_steps = config.DEFAULT_SKIP_STEPS

        # Build attendee → email map so the agent runner can show
        # per-attendee delivery status in the LLM context.
        meta_attendees = metadata.get("attendees", [])
        meta_attendee_emails = metadata.get("attendeeEmails", [])
        # Normalize: handle both list (positional) and dict ({name: email}) formats
        if isinstance(meta_attendee_emails, dict):
            meta_attendee_emails = [meta_attendee_emails.get(name, "") for name in meta_attendees]
        attendee_email_map = {}
        for i, name in enumerate(meta_attendees):
            email = meta_attendee_emails[i] if i < len(meta_attendee_emails) else ""
            attendee_email_map[name] = email

        return self.enqueue("ready_for_processing", {
            "jobId": job_id,
            "title": metadata.get("title", "Untitled Meeting"),
            "attendees": meta_attendees,
            "attendeeEmails": attendee_email_map,
            "emailRecipients": metadata.get("email_recipients", []),
            "eventType": metadata.get("event_type", "internal"),
            "transcript": transcript,
            "unknownSpeakers": unknown_speakers or [],
            "nonSpeakingAttendees": non_speaking_attendees or [],
            "skip_steps": skip_steps,
            "actions": ["refine", "summarize", "extract_action_items"],
        })



    def enqueue_failed(self, job_id: str, error: str, metadata: dict):
        return self.enqueue("failed", {
            "jobId": job_id, "error": error,
            "title": metadata.get("title", "Untitled Meeting"),
        })

    def _touch_trigger(self):
        """Touch the trigger file so the agent runner's fs.watch fires."""
        try:
            if os.path.exists(self.trigger_file):
                os.utime(self.trigger_file, None)
            else:
                with open(self.trigger_file, "w") as f:
                    f.write("")
        except Exception as e:
            print(f"[agent_bridge] Warning: failed to touch trigger: {e}")
