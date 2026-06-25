"""
Transcription engine — platform-aware ASR + diarization
"""

import platform as sys_platform
from typing import Optional
from config import config


def detect_platform() -> str:
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

    def run_diarization(self, audio_path: str) -> list:
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

    def run_transcription(self, audio_path: str) -> dict:
        if self.platform == "mac":
            return self._transcribe_mac(audio_path)
        elif self.platform == "windows":
            return self._transcribe_windows(audio_path)
        return self._transcribe_standard(audio_path)

    def _transcribe_standard(self, audio_path: str) -> dict:
        import whisper
        if self._whisper is None:
            self._whisper = whisper.load_model(self.model_size, device=self.device)
        result = self._whisper.transcribe(audio_path, word_timestamps=True)
        return self._extract_words(result)

    def _transcribe_mac(self, audio_path: str) -> dict:
        import mlx_whisper
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=f"mlx-community/whisper-{self.model_size}",
            word_timestamps=True,
        )
        return self._extract_words(result)

    def _transcribe_windows(self, audio_path: str) -> dict:
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
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "text": w.get("word", ""),
                    "start": w.get("start", 0),
                    "end": w.get("end", 0),
                })
        return {"text": result.get("text", ""), "segments": result.get("segments", []), "words": words}

    def align_transcript(self, transcription: dict, diarization: list) -> list:
        aligned, word_index = [], 0
        words = transcription.get("words", [])

        for diar_seg in diarization:
            spk, start, end = diar_seg["speaker"], diar_seg["start"], diar_seg["end"]
            seg_words = []
            while word_index < len(words):
                w = words[word_index]
                if w["start"] >= start and w["end"] <= end:
                    seg_words.append(w["text"])
                    word_index += 1
                elif w["start"] > end:
                    break
                else:
                    if w["start"] < (start + end) / 2:
                        seg_words.append(w["text"])
                    word_index += 1
            if seg_words:
                aligned.append({
                    "speaker": spk, "text": " ".join(seg_words).strip(),
                    "start": start, "end": end,
                })
        return aligned

    def process_full(self, audio_path: str) -> dict:
        diarization = self.run_diarization(audio_path)
        transcription = self.run_transcription(audio_path)
        aligned = self.align_transcript(transcription, diarization)
        return {"aligned_transcript": aligned, "raw_diarization": diarization}
