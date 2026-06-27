"""
Audio upload and validation module
"""

import os
import uuid
import json
import subprocess
from typing import Optional
from config import config


class AudioUploader:
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = storage_path or config.STORAGE_PATH
        os.makedirs(self.storage_path, exist_ok=True)

    def upload(self, file_path: str, metadata: dict) -> dict:
        """Register an audio file. Returns job dict with job_id and standardized path."""
        job_id = str(uuid.uuid4())
        ext = os.path.splitext(file_path)[1].lower()

        if ext not in config.ALLOWED_EXTENSIONS:
            raise ValueError(f"Unsupported format: {ext}")

        size = os.path.getsize(file_path)
        if size > config.MAX_FILE_SIZE:
            raise ValueError(f"File too large: {size} bytes")

        job_dir = os.path.join(self.storage_path, job_id)
        os.makedirs(job_dir, exist_ok=True)

        original_path = os.path.join(job_dir, f"original{ext}")
        self._copy_file(file_path, original_path)
        print(f"[upload] Copied original file ({size} bytes) to {original_path}")

        wav_path = os.path.join(job_dir, "standardized.wav")
        print(f"[upload] Standardizing audio to 16kHz mono WAV...")
        self._standardize_audio(original_path, wav_path)
        wav_size = os.path.getsize(wav_path)
        print(f"[upload] Standardized WAV ready ({wav_size} bytes) at {wav_path}")

        meta_path = os.path.join(job_dir, "metadata.json")
        with open(meta_path, "w") as f:
            json.dump(metadata, f, indent=2)
        print(f"[upload] Metadata written to {meta_path}")

        self._write_status(job_id, {
            "job_id": job_id, "status": "uploaded", "progress": 0.0,
            "error": "", "unknown_speakers": [], "transcript": [],
            "summary": None, "metadata": metadata,
        })
        print(f"[upload] Job {job_id} registered — status=uploaded")

        return {"job_id": job_id, "audio_path": wav_path, "metadata": metadata}

    def get_audio_path(self, job_id: str) -> str:
        p = os.path.join(self.storage_path, job_id, "standardized.wav")
        if not os.path.exists(p):
            raise FileNotFoundError(f"Audio not found for job {job_id}")
        return p

    def get_status(self, job_id: str) -> dict:
        p = os.path.join(self.storage_path, job_id, "status.json")
        if not os.path.exists(p):
            return {"job_id": job_id, "status": "not_found", "error": "Job not found"}
        with open(p) as f:
            return json.load(f)

    def update_status(self, job_id: str, updates: dict):
        status = self.get_status(job_id)
        status.update(updates)
        self._write_status(job_id, status)

    def get_metadata(self, job_id: str) -> dict:
        p = os.path.join(self.storage_path, job_id, "metadata.json")
        if not os.path.exists(p):
            return {}
        with open(p) as f:
            return json.load(f)

    def save_transcript(self, job_id: str, transcript: list):
        with open(os.path.join(self.storage_path, job_id, "transcript.json"), "w") as f:
            json.dump(transcript, f, indent=2)

    def save_summary(self, job_id: str, summary: dict):
        with open(os.path.join(self.storage_path, job_id, "summary.json"), "w") as f:
            json.dump(summary, f, indent=2)

    def save_analysis(self, job_id: str, analysis: dict):
        with open(os.path.join(self.storage_path, job_id, "analysis.json"), "w") as f:
            json.dump(analysis, f, indent=2)

    def _write_status(self, job_id: str, status: dict):
        d = os.path.join(self.storage_path, job_id)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "status.json"), "w") as f:
            json.dump(status, f, indent=2)

    @staticmethod
    def _copy_file(src: str, dst: str):
        subprocess.run(["cp", src, dst], check=True)

    def _standardize_audio(self, input_path: str, output_path: str):
        """Convert to 16kHz mono WAV using ffmpeg."""
        cmd = [
            config.FFMPEG_PATH, "-i", input_path,
            "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000",
            "-y", output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
