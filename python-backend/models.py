"""
Pydantic models for the transcription API
"""

from pydantic import BaseModel, Field
from typing import List, Optional


class UploadByPathRequest(BaseModel):
    """Upload an audio file by local filesystem path.

    Works cross-platform — accepts both POSIX (/Users/...) and
    Windows (C:\\Users\\...) paths. The path is resolved via
    os.path.abspath() and os.path.expanduser() before use.
    """
    file_path: str = Field(..., description="Absolute or relative path to an audio file")
    title: str = "Untitled Meeting"
    attendees: List[str] = Field(default_factory=list)
    attendee_emails: List[str] = Field(default_factory=list, description="Emails aligned positionally with attendees")
    email_recipients: List[str] = Field(default_factory=list, description="Per-job email recipients for delivery")
    event_type: str = "internal"
    source: str = Field(default="upload", description="Where the audio came from: upload | capture | zoom | teams")
    skip_steps: Optional[List[str]] = Field(default=None, description="Tool names to skip in the agent pipeline. Defaults to skipping analysis and delivery.")


class TranscriptionSegment(BaseModel):
    speaker: str
    text: str
    start: float
    end: float


class SpeakerLabel(BaseModel):
    speaker_id: str
    name: str
    email: str = ""


class LabelRequest(BaseModel):
    job_id: str
    labels: List[SpeakerLabel]


class RefineRequest(BaseModel):
    job_id: str
    transcript: List[TranscriptionSegment]
    rules: List[str] = Field(default_factory=list)
    keep_timestamps: bool = False


class SummarizeRequest(BaseModel):
    job_id: str
    summary: dict = Field(default_factory=dict)


class AnalysisRequest(BaseModel):
    job_id: str
    analysis: dict = Field(default_factory=dict)


class Deliverable(BaseModel):
    job_id: str
    title: str = ""
    attendees: List[str] = Field(default_factory=list)
    destinations: List[str] = Field(default_factory=list)
    email_recipients: List[str] = Field(default_factory=list)


# ── Memory Models ──

class MemorySearchRequest(BaseModel):
    query: str
    n_results: int = 5


class MemorySearchResult(BaseModel):
    results: list


class RegisterAttendeesRequest(BaseModel):
    """Register one or more meeting attendees."""
    names: List[str]
    emails: List[str] = Field(default_factory=list)
    source: str = "new_job_form"
    job_id: str = ""


class EphemeralMemoryItem(BaseModel):
    table: str = "notes"  # attendees, action_items, contacts, budgets, decisions, notes
    data: dict


class EphemeralMemoryQuery(BaseModel):
    table: str = "notes"
    query: str = ""
    limit: int = 10


class EphemeralMemoryActionResult(BaseModel):
    success: bool
    message: str = ""
    data: list = Field(default_factory=list)


class SaveMeetingContextRequest(BaseModel):
    job_id: str
    title: str = ""
    attendees: List[str] = Field(default_factory=list)
    transcript_text: str = ""
    summary: dict = Field(default_factory=dict)
    action_items: List[dict] = Field(default_factory=list)
    budgets: List[dict] = Field(default_factory=list)
    decisions: List[dict] = Field(default_factory=list)
