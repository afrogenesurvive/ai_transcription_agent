"""
Transcription engine — platform-aware ASR + diarization

This module does two independent ML tasks and then merges them:

1. **Diarization** (pyannote/speaker-diarization-3.1):
   - Input: 16kHz mono WAV audio
   - Output: A list of segments, each labeled with a speaker ID (SPEAKER_00, SPEAKER_01, ...)
     and start/end timestamps.
   - This answers "WHO spoke when" — it identifies speaker change points but
     does NOT transcribe the words.
   - Internally: uses a pre-trained pipeline combining voice activity detection
     (VAD) + speaker embedding + clustering.

2. **ASR — Automatic Speech Recognition** (Whisper):
   - Input: Same 16kHz mono WAV audio
   - Output: Word-by-word transcription with timestamps
   - This answers "WHAT was said" — but doesn't know who said it.
   - Platform-specific backends for optimal performance:
       macOS  → mlx-whisper (Apple Silicon GPU)
       Windows → faster-whisper (CTranslate2, supports CUDA)
       Linux   → openai-whisper (PyTorch-based fallback)

3. **Alignment** (align_transcript):
   - Merges diarization (who) with ASR (what) by matching word timestamps
     to speaker segment boundaries.
   - Output: A list of {speaker, text, start, end} segments — a speaker-labeled
     transcript ready for refinement and summarization.
"""

import platform as sys_platform
from typing import Optional
from config import config


def detect_platform() -> str:
    """Detect the host OS to pick the optimal Whisper backend.

    Returns: "mac" (Apple Silicon), "mac_intel", "windows", or "linux".
    """
    if config.PLATFORM != "auto":
        return config.PLATFORM
    system = sys_platform.system().lower()
    machine = sys_platform.machine().lower()
    if system == "darwin":
        return "mac" if machine in ("arm64", "aarch64") else "mac_intel"
    elif system == "windows":
        return "windows"
    return "linux"


def detect_device() -> str:
    """Detect the best available compute device.

    Priority: CUDA (NVIDIA GPU) > MPS (Apple Silicon) > CPU
    """
    if config.DEVICE != "auto":
        return config.DEVICE
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class TranscriptionEngine:
    def __init__(self, model_size: Optional[str] = None, device: Optional[str] = None):
        self.model_size = model_size or config.WHISPER_MODEL_SIZE
        self.device = device or detect_device()
        self.platform = detect_platform()
        self._whisper = None
        self._diarization = None

    # ── Step 1: Diarization (who spoke when) ──

    def run_diarization(self, audio_path: str) -> list:
        """Run speaker diarization using pyannote.

        Returns a list of dicts: {speaker, start, end, duration}.

        The pyannote Pipeline wraps a neural VAD + speaker embedding model:
          1. Detect speech regions (VAD)
          2. Split into speaker-homogeneous segments via clustering
          3. Assign each segment a speaker label (SPEAKER_00, SPEAKER_01, ...)

        Notes:
          - Speaker labels are arbitrary (not names) — just cluster IDs.
          - Voiceprint matching (in VoiceprintManager) later maps these to names.
          - Requires huggingface access to pyannote/speaker-diarization-3.1.
        """
        if self._diarization is None:
            from pyannote.audio import Pipeline
            import torch
            self._diarization = Pipeline.from_pretrained(
                config.DIARIZATION_MODEL, use_auth_token=None,
            )
            self._diarization.to(torch.device(self.device))

        diarization = self._diarization(audio_path)
        return [
            {"speaker": s, "start": t.start, "end": t.end, "duration": t.end - t.start}
            for t, _, s in diarization.itertracks(yield_label=True)
        ]

    # ── Step 2: ASR (what was said) ──

    def run_transcription(self, audio_path: str) -> dict:
        """Run Automatic Speech Recognition using the best backend for this platform.

        Returns dict with:
          - text: full transcript as a string
          - segments: list of segment dicts with word-level detail
          - words: flat list of {text, start, end} for every word

        Platform dispatch:
          macOS  → mlx_whisper (Metal GPU acceleration on Apple Silicon)
          Windows → faster_whisper (CTranslate2 w/ INT8 or FP16)
          Linux   → openai-whisper (PyTorch baseline)
        """
        if self.platform == "mac":
            return self._transcribe_mac(audio_path)
        elif self.platform == "windows":
            return self._transcribe_windows(audio_path)
        return self._transcribe_standard(audio_path)

    def _transcribe_standard(self, audio_path: str) -> dict:
        """Transcribe using openai-whisper (PyTorch). Works on any platform."""
        import whisper
        if self._whisper is None:
            self._whisper = whisper.load_model(self.model_size, device=self.device)
        result = self._whisper.transcribe(audio_path, word_timestamps=True)
        return self._extract_words(result)

    def _transcribe_mac(self, audio_path: str) -> dict:
        """Transcribe using mlx-whisper — optimized for Apple Silicon (MPS).

        Uses a community-converted MLX model from HuggingFace
        (mlx-community/whisper-{size}). Much faster than PyTorch on Mac.
        """
        import mlx_whisper
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=f"mlx-community/whisper-{self.model_size}",
            word_timestamps=True,
        )
        return self._extract_words(result)

    def _transcribe_windows(self, audio_path: str) -> dict:
        """Transcribe using faster-whisper — CTranslate2 backend with INT8/FP16.

        Up to 4x faster than openai-whisper on CUDA. Falls back to INT8 on CPU.
        """
        from faster_whisper import WhisperModel
        ct = "float16" if self.device == "cuda" else "int8"
        model = WhisperModel(self.model_size, device=self.device, compute_type=ct)
        segs, _ = model.transcribe(audio_path, beam_size=5, word_timestamps=True)
        words = []
        for s in segs:
            for w in s.words:
                words.append({"text": w.word, "start": w.start, "end": w.end})
        return {"text": "", "segments": list(segs), "words": words}

    def _extract_words(self, result: dict) -> dict:
        """Normalize Whisper output into a consistent {words, segments, text} format."""
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "text": w.get("word", ""),
                    "start": w.get("start", 0),
                    "end": w.get("end", 0),
                })
        return {"text": result.get("text", ""), "segments": result.get("segments", []), "words": words}

    # ── Step 3: Alignment (merge who + what) ──

    def align_transcript(self, transcription: dict, diarization: list) -> list:
        """Merge diarization (speaker segments) with ASR (word timestamps).

        This is the key integration step that produces the final speaker-labeled
        transcript. It works by iterating through the diarization segments and
        collecting all Whisper words whose timestamps fall within each segment's
        time window.

        Algorithm:
          1. Get the flat word list from ASR with per-word start/end timestamps.
          2. For each diarization segment (speaker + time window):
             a. Walk forward through the word list, collecting words whose
                timestamps fall within [segment.start, segment.end].
             b. Handle edge cases: words that overlap a boundary are assigned
                to the speaker whose midpoint is closest.
             c. Join collected words into a single text string.
          3. Return the aligned array — each element has speaker, text, start, end.

        Returns a list of dicts:
          {speaker: "SPEAKER_00"|"Alice", text: "...", start: float, end: float}

        Note: Speaker labels at this stage are still pyannote's cluster IDs
        (SPEAKER_00, etc.). Voiceprint matching (in VoiceprintManager) renames
        them to actual names before the transcript is saved.
        """
        aligned, word_index = [], 0
        words = transcription.get("words", [])

        for diar_seg in diarization:
            spk, start, end = diar_seg["speaker"], diar_seg["start"], diar_seg["end"]
            seg_words = []
            while word_index < len(words):
                w = words[word_index]
                if w["start"] >= start and w["end"] <= end:
                    # Word is fully inside this speaker's segment
                    seg_words.append(w["text"])
                    word_index += 1
                elif w["start"] > end:
                    # Past this segment's boundary — move to next diarization segment
                    break
                else:
                    # Word overlaps a boundary: assign to the speaker who owns
                    # the midpoint of this word's time range
                    if w["start"] < (start + end) / 2:
                        seg_words.append(w["text"])
                    word_index += 1
            if seg_words:
                aligned.append({
                    "speaker": spk,
                    "text": " ".join(seg_words).strip(),
                    "start": start,
                    "end": end,
                })
        return aligned

    def process_full(self, audio_path: str) -> dict:
        diarization = self.run_diarization(audio_path)
        transcription = self.run_transcription(audio_path)
        aligned = self.align_transcript(transcription, diarization)
        return {"aligned_transcript": aligned, "raw_diarization": diarization}
