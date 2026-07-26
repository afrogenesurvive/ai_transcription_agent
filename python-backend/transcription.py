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

import os
import time
import warnings
import platform as sys_platform
import multiprocessing as mp
from typing import Optional
from patches import *  # noqa: F401  (monkey-patches speechbrain + torchaudio + pyannote)
from config import config
from utils import is_network_error


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


# ── Diarization subprocess (crash isolation) ──

DIARIZATION_TIMEOUT = 900  # 15 minutes — matches PIPELINE_TIMEOUT_SECONDS


def _run_diarization_subprocess(
    audio_path: str,
    result_queue: mp.Queue,
    device: str,
    hf_token: str,
    model_name: str,
):
    """Run pyannote diarization in a subprocess for crash isolation.

    Loads the model and runs inference in this child process. Results are
    returned via ``result_queue`` as a list of ``{speaker, start, end, duration}``
    dicts.

    On success: puts segments on queue and exits with code 0.
    On catchable error: logs, puts empty list on queue, exits 0.
    On uncatchable crash (segfault etc.): exits with non-zero code (parent detects).
    """
    import os
    import time
    import traceback

    from config import config
    from utils import is_network_error
    from pyannote.audio import Pipeline
    import torch
    import soundfile as _sf

    t0 = time.time()

    # ── Check HF token ──
    if not hf_token:
        print("[transcription] ⚠️  No HUGGING_FACE_TOKEN set. Diarization unavailable.")
        result_queue.put([])
        return

    # ── Audio info ──
    try:
        _sinfo = _sf.info(audio_path)
        print(f"[transcription]   🎯 Audio: {_sinfo.samplerate}Hz, {_sinfo.channels}ch, "
              f"{_sinfo.frames / _sinfo.samplerate:.1f}s, {os.path.getsize(audio_path) / 1024:.0f}KB")
    except Exception:
        pass

    # ── Load pipeline ──
    print(f"[transcription] Loading diarization model ({model_name}) on {device}...")
    try:
        try:
            pipeline = Pipeline.from_pretrained(model_name, use_auth_token=hf_token)
        except Exception as _hub_err:
            if is_network_error(_hub_err):
                print(f"[transcription] ⚠️  HuggingFace unreachable — using local cache...")
                pipeline = Pipeline.from_pretrained(
                    model_name, use_auth_token=hf_token, local_files_only=True,
                )
            else:
                raise
        if pipeline is None:
            raise RuntimeError(f"Model '{model_name}' returned None")
        pipeline.to(torch.device(device))
        print(f"[transcription] ✅ Diarization model loaded on {device} in {time.time() - t0:.1f}s")
    except Exception as e:
        err_lower = str(e).lower()
        if device == "mps" and ("mps" in err_lower or "metal" in err_lower or "out of memory" in err_lower):
            print(f"[transcription] ⚠️  MPS device error, falling back to CPU: {e}")
            try:
                pipeline = Pipeline.from_pretrained(model_name, use_auth_token=hf_token)
                if pipeline:
                    pipeline.to(torch.device("cpu"))
                    device = "cpu"
                    print(f"[transcription] ✅ Diarization model loaded on CPU (fallback) in {time.time() - t0:.1f}s")
                else:
                    raise RuntimeError("Pipeline returned None on CPU fallback")
            except Exception as cpu_err:
                print(f"[transcription] ❌ CPU fallback also failed: {cpu_err}")
                traceback.print_exc()
                result_queue.put([])
                return
        else:
            print(f"[transcription] ❌ Failed to load diarization model: {e}")
            traceback.print_exc()
            result_queue.put([])
            return

    # ── Run inference ──
    print(f"[transcription]   ⏳ Running pyannote diarization pipeline ({model_name}) on {device}...")
    print("[transcription]   🔍 Call stack entering pyannote:")
    for line in traceback.format_stack(limit=4)[:-1]:
        for sub in line.rstrip().split("\n"):
            print(f"[transcription]     | {sub}")

    try:
        diarization = pipeline(audio_path)
    except Exception as e:
        print(f"[transcription] ❌ Diarization inference failed: {e}")
        traceback.print_exc()
        result_queue.put([])
        return

    infer_elapsed = time.time() - t0

    # ── Collect segments ──
    segments = []
    speaker_duration = {}
    diar_tracks = list(diarization.itertracks(yield_label=True))
    total_diar_segments = len(diar_tracks)
    log_interval = max(1, total_diar_segments // 5)

    for i, (t, _, s) in enumerate(diar_tracks):
        dur = t.end - t.start
        segments.append({"speaker": s, "start": t.start, "end": t.end, "duration": dur})
        speaker_duration[s] = speaker_duration.get(s, 0.0) + dur
        if (i + 1) % log_interval == 0 or i == total_diar_segments - 1:
            pct = (i + 1) / total_diar_segments * 100
            speaker_count = len(set(sp["speaker"] for sp in segments))
            elapsed = time.time() - t0
            print(f"[transcription]   📊 [{elapsed:>6.1f}s] Diarization progress: {i + 1}/{total_diar_segments} segments "
                  f"({pct:.0f}%), {speaker_count} speaker(s) identified so far")

    total_speech = sum(speaker_duration.values())
    elapsed = time.time() - t0
    print(f"[transcription]   ✅ [{elapsed:>6.1f}s] Diarization complete in {infer_elapsed:.1f}s — "
          f"{len(segments)} segments, {len(speaker_duration)} speakers, "
          f"{total_speech:.1f}s total speech")
    for spk, dur in sorted(speaker_duration.items()):
        pct = dur / total_speech * 100 if total_speech else 0
        seg_count = sum(1 for s in segments if s["speaker"] == spk)
        print(f"[transcription]      [{time.time() - t0:>6.1f}s] {spk}: {dur:.1f}s ({pct:.0f}%) across {seg_count} segment(s)")

    # ── Cleanup MPS cache ──
    try:
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass

    result_queue.put(segments)


class TranscriptionEngine:
    def __init__(self, model_size: Optional[str] = None, device: Optional[str] = None,
                 cpu_fallback: bool = False):
        """Initialize the transcription engine.

        Args:
            model_size: Whisper model size ("medium", "large", etc.).
            device: Target compute device ("mps", "cuda", "cpu", or None for auto-detect).
            cpu_fallback: If True, force CPU regardless of detected device. Used when
                          a previous MPS OOM error has been detected in the pipeline.
        """
        detected = device or detect_device()
        if cpu_fallback and detected == "mps":
            detected = "cpu"
            print(f"[transcription] ⚠️  CPU fallback requested — forcing device='cpu' "
                  f"(detected was 'mps')")
        self.model_size = model_size or config.WHISPER_MODEL_SIZE
        self.device = detected
        self.platform = detect_platform()
        self._whisper = None
        self._diarization = None
        self._initial_prompt_enabled = config.WHISPER_INITIAL_PROMPT_ENABLED
        self._initial_prompt = config.WHISPER_INITIAL_PROMPT
        # Set True when an MPS OOM error is caught during inference.
        # The pipeline reads this after each ML step to decide whether
        # to fall back to CPU for subsequent steps.
        self.mps_oom_occurred = False

    # ── Step 1: Diarization (who spoke when) ──

    def run_diarization(self, audio_path: str) -> list:
        """Run speaker diarization using pyannote in a crash-isolated subprocess.

        Delegates the actual pyannote inference to a ``multiprocessing.Process``
        subprocess. If pyannote's internal multiprocessing crashes (MPS segfault,
        leaked semaphore objects, etc.), only the child process dies — the main
        backend continues running and can retry on CPU.

        Returns a list of dicts: {speaker, start, end, duration}.
        """
        print(f"[transcription] 🚀 Starting diarization subprocess for {audio_path} "
              f"(device={self.device}, timeout={DIARIZATION_TIMEOUT // 60}min)...")

        hf_token = config.HUGGING_FACE_TOKEN
        if not hf_token:
            print(f"[transcription] ⚠️  No HUGGING_FACE_TOKEN set. Skipping diarization.")
            return []

        result_queue = mp.Queue()
        proc = mp.Process(
            target=_run_diarization_subprocess,
            args=(
                audio_path,
                result_queue,
                self.device,
                hf_token,
                config.DIARIZATION_MODEL,
            ),
        )
        proc.start()
        proc.join(timeout=DIARIZATION_TIMEOUT + 30)  # +30s grace for model loading

        if proc.is_alive():
            proc.terminate()
            proc.join()
            raise TimeoutError(
                f"Diarization subprocess timed out after {DIARIZATION_TIMEOUT // 60} min"
            )

        if proc.exitcode != 0:
            self.mps_oom_occurred = True
            raise RuntimeError(
                f"Diarization subprocess crashed (exit code {proc.exitcode}) — "
                f"likely MPS OOM. Parent process unaffected."
            )

        try:
            segments = result_queue.get(timeout=10)
        except Exception:
            print(f"[transcription] ⚠️  Subprocess exited 0 but queue was empty — "
                  f"returning empty diarization")
            segments = []

        print(f"[transcription] ✅ Diarization complete: {len(segments)} segments from subprocess")
        return segments

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
        t0 = time.time()
        # Log audio info upfront
        import soundfile as _sf
        try:
            _sinfo = _sf.info(audio_path)
            print(f"[transcription] 🎤 ASR starting — {_sinfo.samplerate}Hz, {_sinfo.channels}ch, "
                  f"{_sinfo.frames/_sinfo.samplerate:.1f}s audio, "
                  f"platform={self.platform}, model={self.model_size}, device={self.device}")
        except Exception:
            print(f"[transcription] 🎤 ASR starting — platform={self.platform}, "
                  f"model={self.model_size}, device={self.device}")

        # Log initial prompt configuration
        if self._initial_prompt_enabled:
            prompt_preview = self._initial_prompt[:120] + ("..." if len(self._initial_prompt) > 120 else "")
            print(f"[transcription]   🧠 Initial prompt ENABLED ({len(self._initial_prompt)} chars): \"{prompt_preview}\"")
        else:
            print(f"[transcription]   🧠 Initial prompt DISABLED — no context passed to Whisper")

        if self.platform == "mac":
            result = self._transcribe_mac(audio_path)
        elif self.platform == "windows":
            result = self._transcribe_windows(audio_path)
        else:
            result = self._transcribe_standard(audio_path)

        total_elapsed = time.time() - t0
        words = result.get("words", [])
        segments = result.get("segments", [])
        rt_factor = total_elapsed / (_sinfo.frames / _sinfo.samplerate) if _sinfo and _sinfo.frames else 0
        print(f"[transcription]   ✅ ASR complete in {total_elapsed:.1f}s "
              f"(RT={rt_factor:.2f}x) — {len(words)} words, {len(segments)} segments")
        return result

    def _transcribe_standard(self, audio_path: str) -> dict:
        """Transcribe using openai-whisper (PyTorch). Works on any platform."""
        import whisper
        if self._whisper is None:
            t_load = time.time()
            print(f"[transcription]   📦 Loading openai-whisper model '{self.model_size}' on {self.device}...")
            try:
                self._whisper = whisper.load_model(self.model_size, device=self.device)
            except Exception as _load_err:
                err_lower = str(_load_err).lower()
                if self.device == "mps" and ("mps" in err_lower or "out of memory" in err_lower or "metal" in err_lower):
                    print(f"[transcription] ⚠️  MPS OOM loading Whisper model: {_load_err}")
                    print(f"[transcription]    Retrying on CPU...")
                    self.mps_oom_occurred = True
                    self.device = "cpu"
                    self._whisper = whisper.load_model(self.model_size, device="cpu")
                else:
                    raise
            print(f"[transcription]   ✅ Model loaded in {time.time()-t_load:.1f}s")
        t_infer = time.time()
        print(f"[transcription]   ⏳ Transcribing (openai-whisper, verbose)...")
        transcribe_kwargs = {
            "word_timestamps": True,
            "verbose": True,
        }
        if self._initial_prompt_enabled and self._initial_prompt:
            transcribe_kwargs["initial_prompt"] = self._initial_prompt
            print(f"[transcription]   🧠 Using initial_prompt ({len(self._initial_prompt)} chars)")
        try:
            result = self._whisper.transcribe(audio_path, **transcribe_kwargs)
        except Exception as _infer_err:
            err_lower = str(_infer_err).lower()
            if "mps" in err_lower or "out of memory" in err_lower or "metal" in err_lower:
                print(f"[transcription] ⚠️  MPS OOM during Whisper inference: {_infer_err}")
                self.mps_oom_occurred = True
                # Return empty result — pipeline will fall back to CPU
                return {"text": "", "segments": [], "words": []}
            raise
        print(f"[transcription]   ⏱️  Inference done in {time.time()-t_infer:.1f}s")
        return self._extract_words(result)

    def _transcribe_mac(self, audio_path: str) -> dict:
        """Transcribe using mlx-whisper — optimized for Apple Silicon (MPS)."""
        t_infer = time.time()
        print(f"[transcription]   📦 Using mlx-whisper (Apple Silicon) model 'mlx-community/whisper-{self.model_size}'...")
        import mlx_whisper
        transcribe_kwargs = {
            "path_or_hf_repo": f"mlx-community/whisper-{self.model_size}",
            "word_timestamps": True,
            "verbose": True,
        }
        if self._initial_prompt_enabled and self._initial_prompt:
            transcribe_kwargs["initial_prompt"] = self._initial_prompt
            print(f"[transcription]   🧠 Using initial_prompt ({len(self._initial_prompt)} chars)")
        result = mlx_whisper.transcribe(audio_path, **transcribe_kwargs)
        elapsed = time.time() - t_infer
        print(f"[transcription]   ⏱️  mlx-whisper done in {elapsed:.1f}s")
        return self._extract_words(result)

    def _transcribe_windows(self, audio_path: str) -> dict:
        """Transcribe using faster-whisper — CTranslate2 backend with INT8/FP16."""
        from faster_whisper import WhisperModel
        ct = "float16" if self.device == "cuda" else "int8"

        if self._whisper is None:
            t_load = time.time()
            print(f"[transcription]   📦 Loading faster-whisper model '{self.model_size}' "
                  f"(compute_type={ct}, device={self.device})...")
            self._whisper = WhisperModel(self.model_size, device=self.device, compute_type=ct)
            print(f"[transcription]   ✅ Model loaded in {time.time()-t_load:.1f}s")

        t_infer = time.time()
        print(f"[transcription]   ⏳ Transcribing (faster-whisper, beam_size=5)...")
        transcribe_kwargs = {
            "beam_size": 5,
            "word_timestamps": True,
        }
        if self._initial_prompt_enabled and self._initial_prompt:
            transcribe_kwargs["initial_prompt"] = self._initial_prompt
            print(f"[transcription]   🧠 Using initial_prompt ({len(self._initial_prompt)} chars)")
        segs, info = self._whisper.transcribe(audio_path, **transcribe_kwargs)
        elapsed = time.time() - t_infer

        words = []
        seg_count = 0
        last_log_time = time.time()
        for s in segs:
            seg_count += 1
            for w in s.words:
                words.append({"text": w.word, "start": w.start, "end": w.end})
            # Log progress every ~5 seconds of wall-clock time
            now = time.time()
            if now - last_log_time >= 5:
                pct = (s.end / info.duration * 100) if info.duration else 0
                print(f"[transcription]   📊 ASR progress: {seg_count} segments, "
                      f"{len(words)} words ({pct:.0f}% through audio)")
                last_log_time = now

        print(f"[transcription]   ⏱️  faster-whisper done in {elapsed:.1f}s — "
              f"lang={info.language} ({info.language_probability*100:.0f}%), "
              f"audio_dur={info.duration:.1f}s, {seg_count} segments, {len(words)} words")
        return {"text": "", "segments": list(segs), "words": words}

    def _extract_words(self, result: dict) -> dict:
        """Normalize Whisper output into a consistent {words, segments, text} format."""
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "text": w.get("word") or w.get("text") or "",
                    "start": w.get("start", 0),
                    "end": w.get("end", 0),
                })
        # If no word-level timestamps, fall back to segment-level text
        if not words and result.get("segments"):
            for seg in result.get("segments", []):
                words.append({
                    "text": seg.get("text", ""),
                    "start": seg.get("start", 0),
                    "end": seg.get("end", 0),
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
        t0 = time.time()
        print(f"[transcription] 🔗 Aligning {len(words)} words with {len(diarization)} diarization segments...")

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

        elapsed = time.time() - t0
        words_used = sum(len(a["text"].split()) for a in aligned)
        print(f"[transcription]   ✅ Alignment done in {elapsed*1000:.0f}ms — "
              f"{len(aligned)} merged segments ({words_used}/{len(words)} words assigned)")

        # Fallback: if diarization produced nothing but ASR has words,
        # create a flat single-speaker transcript so the result isn't empty.
        if not aligned and words:
            full_text = " ".join(w["text"] for w in words)
            aligned.append({
                "speaker": "Unknown Speaker",
                "text": full_text,
                "start": words[0].get("start", 0.0),
                "end": words[-1].get("end", 0.0),
            })
            print(f"[transcription]   ⚠️  No diarization segments — created flat transcript ({len(words)} words)")

        return aligned

    def process_full(self, audio_path: str) -> dict:
        t_total = time.time()
        print(f"\n{'='*60}")
        print(f"   🎬 PROCESSING: {audio_path}")
        print(f"{'='*60}")
        diarization = self.run_diarization(audio_path)
        transcription = self.run_transcription(audio_path)
        aligned = self.align_transcript(transcription, diarization)
        total_elapsed = time.time() - t_total
        print(f"\n{'='*60}")
        print(f"   ✅ FULL PIPELINE done in {total_elapsed:.1f}s")
        print(f"{'='*60}")
        return {"aligned_transcript": aligned, "raw_diarization": diarization}
