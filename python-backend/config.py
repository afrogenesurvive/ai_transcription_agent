"""
Configuration — loaded from environment variables
"""

import os
from pathlib import Path


class Config:
    # Server
    HOST = os.getenv("TRANSCRIPTION_HOST", "127.0.0.1")
    PORT = int(os.getenv("TRANSCRIPTION_PORT", "5001"))

    # Storage paths (relative to this file's directory)
    _BASE = Path(__file__).resolve().parent.parent
    STORAGE_PATH = os.getenv("TRANSCRIPTION_STORAGE", str(_BASE / "storage"))
    QUEUE_DIR = os.getenv("TRANSCRIPTION_QUEUE_DIR", str(_BASE / "queue"))
    TRIGGER_FILE = os.getenv(
        "TRANSCRIPTION_TRIGGER_FILE",
        str(_BASE / "queue" / ".transcription-trigger"),
    )

    # Voiceprint DB
    VOICEPRINT_DB = os.getenv(
        "VOICEPRINT_DB_PATH",
        os.path.join(STORAGE_PATH, "voiceprints.db"),
    )

    # Models
    WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium")
    DIARIZATION_MODEL = os.getenv(
        "DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1"
    )
    EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "pyannote/embedding")

    # Platform (auto-detect if not set)
    PLATFORM = os.getenv("PLATFORM", "auto")  # auto, mac, windows, cloud
    DEVICE = os.getenv("DEVICE", "auto")  # auto, cpu, cuda, mps

    # Voiceprint matching threshold
    VOICEPRINT_THRESHOLD = float(os.getenv("VOICEPRINT_THRESHOLD", "0.75"))

    # Allowed upload formats
    ALLOWED_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm"}
    MAX_FILE_SIZE = int(
        os.getenv("TRANSCRIPTION_MAX_FILE_SIZE", str(500 * 1024 * 1024))
    )

    # FFmpeg
    FFMPEG_PATH = os.getenv("FFMPEG_PATH", "ffmpeg")

    # Hugging Face auth (required for gated models like pyannote/speaker-diarization-3.1)
    HUGGING_FACE_TOKEN = os.getenv("HUGGING_FACE_TOKEN") or os.getenv("HF_TOKEN") or None


config = Config()
