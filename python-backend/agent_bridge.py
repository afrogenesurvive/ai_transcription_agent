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

        with open(self.queue_file, "a") as f:
            f.write(json.dumps(event) + "\n")

        self._touch_trigger()
        return event_id

    def enqueue_ready(self, job_id: str, transcript: list, metadata: dict,
                      unknown_speakers: Optional[list] = None):
        """Diarization + transcription complete, ready for LLM processing."""
        return self.enqueue("ready_for_processing", {
            "jobId": job_id,
            "title": metadata.get("title", "Untitled Meeting"),
            "attendees": metadata.get("attendees", []),
            "eventType": metadata.get("event_type", "internal"),
            "transcript": transcript,
            "unknownSpeakers": unknown_speakers or [],
            "actions": ["refine", "summarize", "extract_action_items"],
        })

    def enqueue_labeling_needed(self, job_id: str, unknown_speakers: list,
                                transcript: list, metadata: dict):
        """Unknown speakers detected — agent should notify for labeling."""
        return self.enqueue("labeling_needed", {
            "jobId": job_id,
            "title": metadata.get("title", "Untitled Meeting"),
            "unknownSpeakers": unknown_speakers,
            "transcriptPreview": transcript[:5] if transcript else [],
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
