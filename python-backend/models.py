"""
Pydantic models for the transcription API
"""

from pydantic import BaseModel, Field
from typing import List, Optional


class MeetingMetadata(BaseModel):
    title: str
    date: str = ""
    attendees: List[str] = Field(default_factory=list)
    event_type: str = "internal"
    client: str = ""
    notes: str = ""


class TranscriptionSegment(BaseModel):
    speaker: str
    text: str
    start: float
    end: float


class UnknownSpeaker(BaseModel):
    speaker_id: str
    segments: List[dict] = Field(default_factory=list)
    sample_text: str = ""
    sample_start: float = 0.0
    sample_end: float = 0.0


class SpeakerLabel(BaseModel):
    speaker_id: str
    name: str
    email: str = ""


class LabelRequest(BaseModel):
    job_id: str
    labels: List[SpeakerLabel]


class SummaryResult(BaseModel):
    executive_summary: str = ""
    key_decisions: List[str] = Field(default_factory=list)
    discussion_points: List[str] = Field(default_factory=list)
    action_items: List[dict] = Field(default_factory=list)


class RefineRequest(BaseModel):
    job_id: str
    transcript: List[TranscriptionSegment]
    rules: List[str] = Field(default_factory=list)


class SummarizeRequest(BaseModel):
    job_id: str
    summary: dict = Field(default_factory=dict)


class Deliverable(BaseModel):
    job_id: str
    title: str = ""
    attendees: List[str] = Field(default_factory=list)
    destinations: List[str] = Field(default_factory=list)
    email_recipients: List[str] = Field(default_factory=list)
