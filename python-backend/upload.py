"""
Audio upload and validation module
"""

import os
import uuid
import json
import subprocess
import tempfile
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
        from pathlib import Path
        # Prefer standardized.wav (16kHz mono), fall back to original.*
        wav = os.path.join(self.storage_path, job_id, "standardized.wav")
        if os.path.exists(wav):
            return wav
        job_dir = os.path.join(self.storage_path, job_id)
        orig = sorted(Path(job_dir).glob("original.*"))
        if orig:
            return str(orig[0])
        raise FileNotFoundError(f"No audio file found for job {job_id}")

    def get_status(self, job_id: str) -> dict:
        p = os.path.join(self.storage_path, job_id, "status.json")
        if not os.path.exists(p):
            return {"job_id": job_id, "status": "not_found", "error": "Job not found"}
        try:
            with open(p) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError) as e:
            # The status file is corrupt (truncated write, concurrent write, etc.).
            # Return a degraded status so callers can still handle the job gracefully.
            print(f"[upload] ⚠️  Corrupt status.json for job {job_id}: {e}")
            return {
                "job_id": job_id,
                "status": "corrupted",
                "error": f"Status file corrupt: {e}",
                "progress": 0.0,
            }

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

    def save_diarization(self, job_id: str, data: dict):
        """Save diarization results so the pipeline can resume after labeling."""
        with open(os.path.join(self.storage_path, job_id, "diarization.json"), "w") as f:
            json.dump(data, f, indent=2)
        print(f"[upload] Diarization data saved for job {job_id}")

    def load_diarization(self, job_id: str) -> dict:
        """Load saved diarization results. Returns empty dict if not found."""
        p = os.path.join(self.storage_path, job_id, "diarization.json")
        if not os.path.exists(p):
            return {}
        with open(p) as f:
            return json.load(f)

    def save_transcript(self, job_id: str, transcript: list):
        with open(os.path.join(self.storage_path, job_id, "transcript.json"), "w") as f:
            json.dump(transcript, f, indent=2)

    def save_transcript_text(self, job_id: str, transcript: list):
        """Save the transcript as a plain-text .txt file (readable, no JSON)."""
        lines = [f"[{s.get('start', 0.0):.1f}s] {s['speaker']}: {s['text']}" for s in transcript]
        text = "\n".join(lines)
        path = os.path.join(self.storage_path, job_id, "transcript.txt")
        with open(path, "w") as f:
            f.write(text + "\n")
        print(f"[upload] Text transcript saved ({len(lines)} lines) to {path}")

    def save_raw_transcript(self, job_id: str, raw_text: str):
        """Save the raw/unrefined ASR transcript text (before any refinement)."""
        path = os.path.join(self.storage_path, job_id, "raw_transcript.txt")
        with open(path, "w") as f:
            f.write(raw_text + "\n")
        print(f"[upload] Raw transcript saved ({len(raw_text)} chars) to {path}")

    def save_summary(self, job_id: str, summary: dict):
        with open(os.path.join(self.storage_path, job_id, "summary.json"), "w") as f:
            json.dump(summary, f, indent=2)

    def save_analysis(self, job_id: str, analysis: dict):
        with open(os.path.join(self.storage_path, job_id, "analysis.json"), "w") as f:
            json.dump(analysis, f, indent=2)

    def _write_status(self, job_id: str, status: dict):
        d = os.path.join(self.storage_path, job_id)
        os.makedirs(d, exist_ok=True)
        dest = os.path.join(d, "status.json")
        # Atomic write: write to a temp file first, then rename.
        # This prevents readers from seeing a partially-written file
        # if the process crashes during serialization.
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(status, f, indent=2)
            os.replace(tmp, dest)
        except Exception:
            # Clean up temp file on failure, then re-raise
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

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
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else "(no stderr)"
            print(f"[upload] ⚠️  ffmpeg standardization FAILED (exit {e.returncode}): {stderr[:500]}")
            raise
