"""
Agent Bridge — enqueues jobs for the agent runner via trigger file

When a transcription job completes a processing stage (diarization, labeling,
summarization), this module writes a JSON event to the queue directory and
touches .transcription-trigger so that the agent runner (watching via fs.watch)
picks it up immediately — no polling needed.
"""

import os
import json
import time
import uuid
from typing import Optional
from config import config


class AgentBridge:
    def __init__(self, queue_dir: Optional[str] = None):
        self.queue_dir = queue_dir or config.QUEUE_DIR
        self.trigger_file = config.TRIGGER_FILE
        self.queue_file = os.path.join(self.queue_dir, "transcription.jsonl")
        os.makedirs(self.queue_dir, exist_ok=True)

    def enqueue(self, event_type: str, data: dict) -> str:
        """Write event to queue file and touch trigger to wake the runner."""
        event_id = str(uuid.uuid4())
        event = {
            "id": event_id,
            "source": "transcription",
            "type": event_type,
            "data": data,
            "queuedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }

        job_id = data.get("jobId", "?")
        print(f"[agent_bridge] Enqueueing event: id={event_id[:8]} type={event_type} job={job_id}")
        print(f"[agent_bridge] Queue file: {self.queue_file}")

        with open(self.queue_file, "a") as f:
            f.write(json.dumps(event) + "\n")
        print(f"[agent_bridge] Event written to queue")

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
        return self.enqueue("ready_for_processing", {
            "jobId": job_id,
            "title": metadata.get("title", "Untitled Meeting"),
            "attendees": metadata.get("attendees", []),
            "emailRecipients": metadata.get("email_recipients", []),
            "eventType": metadata.get("event_type", "internal"),
            "transcript": transcript,
            "unknownSpeakers": unknown_speakers or [],
            "nonSpeakingAttendees": non_speaking_attendees or [],
            "skip_steps": skip_steps,
            "actions": ["refine", "summarize", "extract_action_items"],
        })

    def enqueue_labeling_needed(self, job_id: str, unknown_speakers: list,
                                transcript: list, metadata: dict):
        """Unknown speakers detected — agent should notify for labeling.

        Includes the full transcript so the agent-runner's empty-transcript
        guard can properly detect content (it reads ``event.data.transcript``).
        Also keeps a preview for quick reference.

        Includes skip_steps from metadata so the agent runner restricts
        pipeline tools (analyze, delivery, etc.) — the LLM should only
        handle labeling, not re-run the full pipeline.
        """
        skip_steps = metadata.get("skip_steps", config.DEFAULT_SKIP_STEPS)
        return self.enqueue("labeling_needed", {
            "jobId": job_id,
            "title": metadata.get("title", "Untitled Meeting"),
            "unknownSpeakers": unknown_speakers,
            "transcript": transcript,
            "transcriptPreview": transcript[:5] if transcript else [],
            "skip_steps": skip_steps,
            "actions": ["notify_labeling_needed"],
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
