"""
Configuration — loaded from environment variables
"""

import logging
import os
from pathlib import Path


def _env_int(name, default):
    """Read an integer env var safely.

    Falls back to `default` and logs a warning if the value is missing or not a
    valid integer, so a bad config value (e.g. a typo in the ConfigPanel) never
    crashes the backend at import time.
    """
    raw = os.getenv(name, "")
    if raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logging.getLogger("config").warning(
            "Invalid integer for %s=%r — using default %r", name, raw, default
        )
        return default


def _env_float(name, default):
    """Read a float env var safely (same guard as _env_int)."""
    raw = os.getenv(name, "")
    if raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logging.getLogger("config").warning(
            "Invalid number for %s=%r — using default %r", name, raw, default
        )
        return default


class Config:
    # Server
    HOST = os.getenv("TRANSCRIPTION_HOST", "127.0.0.1")
    PORT = _env_int("TRANSCRIPTION_PORT", 5001)

    # Storage paths (relative to this file's directory)
    _BASE = Path(__file__).resolve().parent.parent
    STORAGE_PATH = os.getenv("TRANSCRIPTION_STORAGE", str(_BASE / "storage"))
    QUEUE_DIR = os.getenv("TRANSCRIPTION_QUEUE_DIR", str(_BASE / "queue"))
    TRIGGER_FILE = os.getenv(
        "TRANSCRIPTION_TRIGGER_FILE",
        str(_BASE / "queue" / ".transcription-trigger"),
    )
    # Electron app log directory (optional — for storage usage reporting)
    ELECTRON_LOGS_DIR = os.getenv("ELECTRON_LOGS_DIR") or None

    # Voiceprint DB
    VOICEPRINT_DB = os.getenv(
        "VOICEPRINT_DB_PATH",
        os.path.join(STORAGE_PATH, "voiceprints.db"),
    )

    # Models
    WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium")
    WHISPER_INITIAL_PROMPT_ENABLED = os.getenv("WHISPER_INITIAL_PROMPT_ENABLED", "false").lower() in ("true", "1", "yes")
    WHISPER_INITIAL_PROMPT = os.getenv("WHISPER_INITIAL_PROMPT", "")
    DIARIZATION_MODEL = os.getenv(
        "DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1"
    )
    EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "pyannote/embedding")
    EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "pyannote")

    # Platform (auto-detect if not set)
    PLATFORM = os.getenv("PLATFORM", "auto")  # auto, mac, windows, cloud
    DEVICE = os.getenv("DEVICE", "auto")  # auto, cpu, cuda, mps

    # Voiceprint matching threshold
    VOICEPRINT_THRESHOLD = _env_float("VOICEPRINT_THRESHOLD", 0.75)

    # ── Diarization tuning (ASV phantom speaker suppression) ──
    # Post-processing: discard speakers below these thresholds
    DIARIZATION_MIN_SPEAKER_DURATION = _env_float("DIARIZATION_MIN_SPEAKER_DURATION", 3.0)
    DIARIZATION_MIN_SPEAKER_SEGMENTS = _env_int("DIARIZATION_MIN_SPEAKER_SEGMENTS", 3)
    # Post-processing: merge adjacent same-speaker segments with gap <= this
    DIARIZATION_MERGING_GAP = _env_float("DIARIZATION_MERGING_GAP", 0.5)
    # Clustering override: 0.0 = use pyannote model default
    DIARIZATION_CLUSTERING_THRESHOLD = _env_float("DIARIZATION_CLUSTERING_THRESHOLD", 0.0)
    # Hard upper bound on speaker count; 0 = no limit
    DIARIZATION_MAX_SPEAKERS = _env_int("DIARIZATION_MAX_SPEAKERS", 0)

    # Allowed upload formats
    ALLOWED_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm"}
    MAX_FILE_SIZE = _env_int("TRANSCRIPTION_MAX_FILE_SIZE", 500 * 1024 * 1024)

    # FFmpeg
    FFMPEG_PATH = os.getenv("FFMPEG_PATH", "ffmpeg")

    # Hugging Face auth (required for gated models like pyannote/speaker-diarization-3.1)
    HUGGING_FACE_TOKEN = os.getenv("HUGGING_FACE_TOKEN") or os.getenv("HF_TOKEN") or None

    # Transcript refinement options
    KEEP_TRANSCRIPT_TIMESTAMPS = os.getenv("KEEP_TRANSCRIPT_TIMESTAMPS", "false").lower() in ("true", "1", "yes")

    # Default pipeline steps to skip (overridden by per-request skip_steps)
    DEFAULT_SKIP_STEPS = [
        "transcribe_analyze",
        "transcribe_prepare_delivery",
        "send_delivery_email",
        "save_to_drive",
        "create_trello_action_items",
    ]

    # Maximum concurrent ML pipeline jobs
    MAX_CONCURRENT_PIPELINES = _env_int("MAX_CONCURRENT_PIPELINES", 2)

    # Pipeline timeout (minutes) before a hung job fails itself
    PIPELINE_TIMEOUT_MINUTES = _env_int("PIPELINE_TIMEOUT_MINUTES", 15)
    PIPELINE_TIMEOUT_SECONDS = PIPELINE_TIMEOUT_MINUTES * 60

    # Delivery configuration (set via ConfigPanel → config.json → env vars)
    DELIVERY_RECIPIENT_EMAILS = os.getenv("DELIVERY_RECIPIENT_EMAILS", "")
    DELIVERY_EMAIL_SUBJECT = os.getenv("DELIVERY_EMAIL_SUBJECT", "Meeting Summary: {title}")
    DELIVERY_EMAIL_ADDITIONAL_CONTENT = os.getenv("DELIVERY_EMAIL_ADDITIONAL_CONTENT", "")
    DELIVERY_DRIVE_FOLDER = os.getenv("DELIVERY_DRIVE_FOLDER", "Meeting Transcripts")

    # ── Model lifecycle ──
    # When True: ML models (whisper + diarization) stay loaded between jobs.
    # Subsequent jobs start faster (no reload, no HuggingFace HEAD request),
    # but memory usage stays high and MPS fragmentation may accumulate.
    # When False (default): models are unloaded after each job via GC + torch.mps.empty_cache().
    # Slower per-job startup but safer on memory-constrained Apple Silicon systems.
    KEEP_MODELS_WARM = os.getenv("KEEP_MODELS_WARM", "false").lower() in ("true", "1", "yes")

    # ── Approval Gates ──
    # Gate 1: pause after ASR+alignment for raw transcript review/editing before LLM processing
    GATE_RAW_REVIEW_ENABLED = os.getenv("GATE_RAW_REVIEW_ENABLED", "false").lower() in ("true", "1", "yes")
    # Gate 2: pause after LLM analysis for transcript/summary/analysis review before memory save + delivery
    GATE_DELIVERY_REVIEW_ENABLED = os.getenv("GATE_DELIVERY_REVIEW_ENABLED", "false").lower() in ("true", "1", "yes")
    # Custom delivery per meeting: when enabled, delivery review (Gate 2) always pauses so the
    # user can pick which attendees receive the email. When disabled, delivery goes to all attendees.
    CUSTOM_DELIVERY_PER_MEETING = os.getenv("CUSTOM_DELIVERY_PER_MEETING", "false").lower() in ("true", "1", "yes")


config = Config()
