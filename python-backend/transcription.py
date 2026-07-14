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
import platform as sys_platform
import warnings
from typing import Optional
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
        print(f"[transcription] Loading diarization model ({config.DIARIZATION_MODEL}) on {self.device}...")
        if self._diarization is None:
            from pyannote.audio import Pipeline
            import torch

            hf_token = config.HUGGING_FACE_TOKEN
            if not hf_token:
                print(f"[transcription] ⚠️  No HUGGING_FACE_TOKEN set. The diarization model is gated and requires authentication.")
                print(f"[transcription]   1. Get a token: https://hf.co/settings/tokens")
                print(f"[transcription]   2. Accept terms: https://hf.co/{config.DIARIZATION_MODEL}")
                print(f"[transcription]   3. Set HUGGING_FACE_TOKEN in your .env or config")
                print(f"[transcription]   Falling back — will generate placeholder segments without diarization.")

                # Return empty diarization — the pipeline continues without speaker labels
                return []

            # PyTorch 2.6+ defaults torch.load() to weights_only=True for
            # security, but pyannote's models were saved with pickle and
            # require full deserialization. Temporarily relax this.
            import torch as _torch
            _orig_load = _torch.load
            try:
                # Force weights_only=False — lightning_fabric (used by pyannote)
                # explicitly passes weights_only=True, so setdefault is not enough.
                def _permissive_load(f, *a, **kw):
                    kw["weights_only"] = False
                    return _orig_load(f, *a, **kw)
                _torch.load = _permissive_load

                device_for_model = _torch.device(self.device)
                # Try online first so pyannote can check for model updates.
                # Falls back to local cache on network errors (DNS, timeout, etc.).
                try:
                    pipeline = Pipeline.from_pretrained(
                        config.DIARIZATION_MODEL, use_auth_token=hf_token,
                    )
                except Exception as _hub_err:
                    if is_network_error(_hub_err):
                        print(f"[transcription] ⚠️  HuggingFace unreachable ({_hub_err}). "
                              f"Falling back to local cache...")
                        pipeline = Pipeline.from_pretrained(
                            config.DIARIZATION_MODEL, use_auth_token=hf_token,
                            local_files_only=True,
                        )
                    else:
                        raise
                if pipeline is None:
                    raise RuntimeError(
                        f"Model '{config.DIARIZATION_MODEL}' returned None — "
                        "may be gated or unreachable"
                    )
                pipeline.to(device_for_model)
                self._diarization = pipeline
                print(f"[transcription] ✅ Diarization model loaded on {device_for_model}")
            except RuntimeError as e:
                # If model fails on MPS (common with some pyannote ops), try CPU
                if self.device == "mps" and ("mps" in str(e).lower() or "metal" in str(e).lower()):
                    print(f"[transcription] ⚠️  MPS device error, falling back to CPU: {e}")
                    try:
                        # Re-apply patch (finally block restores original)
                        _torch.load = _permissive_load
                        t_cpu = time.time()
                        # Try online first; fall back to local cache on network error
                        try:
                            pipeline_cpu = Pipeline.from_pretrained(
                                config.DIARIZATION_MODEL, use_auth_token=hf_token,
                            )
                        except Exception as _cpu_hub_err:
                            if is_network_error(_cpu_hub_err):
                                print(f"[transcription] ⚠️  HuggingFace unreachable on CPU fallback, "
                                      f"using local cache...")
                                pipeline_cpu = Pipeline.from_pretrained(
                                    config.DIARIZATION_MODEL, use_auth_token=hf_token,
                                    local_files_only=True,
                                )
                            else:
                                raise
                        if pipeline_cpu:
                            pipeline_cpu.to(_torch.device("cpu"))
                            self._diarization = pipeline_cpu
                            self.device = "cpu"
                            print(f"[transcription] ✅ Diarization model loaded on CPU (fallback) in {time.time()-t_cpu:.1f}s")
                        else:
                            raise RuntimeError("Pipeline returned None on CPU fallback")
                    except Exception as cpu_err:
                        import traceback
                        traceback.print_exc()
                        print(f"[transcription] ❌ CPU fallback also failed: {cpu_err}")
                        print(f"[transcription]    ⚠️  Speaker identification unavailable.")
                        return []
                else:
                    import traceback
                    traceback.print_exc()
                    print(f"[transcription] ❌ Failed to load diarization model: {e}")
                    print(f"[transcription]    ⚠️  Speaker identification unavailable.")
                    return []
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"[transcription] ❌ Failed to load diarization model: {e}")
                print(f"[transcription]    ⚠️  Speaker identification unavailable.")
                return []
            finally:
                # Always restore original torch.load to avoid side effects
                _torch.load = _orig_load

        # ── Run diarization inference with timing ──
        t0 = time.time()
        # Log audio info before inference
        import soundfile as _sf
        try:
            _sinfo = _sf.info(audio_path)
            print(f"[transcription]   🎯 Audio: {_sinfo.samplerate}Hz, {_sinfo.channels}ch, "
                  f"{_sinfo.frames/_sinfo.samplerate:.1f}s, {os.path.getsize(audio_path)/1024:.0f}KB")
        except Exception:
            pass

        print(f"[transcription]   ⏳ Running diarization pipeline on {self.device}...")
        diarization = self._diarization(audio_path)
        infer_elapsed = time.time() - t0

        # Collect segments and compute per-speaker stats, logging progress
        segments = []
        speaker_duration = {}
        # Convert to list so we know total count for progress reporting
        diar_tracks = list(diarization.itertracks(yield_label=True))
        total_diar_segments = len(diar_tracks)
        log_interval = max(1, total_diar_segments // 5)  # 5 progress updates
        for i, (t, _, s) in enumerate(diar_tracks):
            dur = t.end - t.start
            segments.append({"speaker": s, "start": t.start, "end": t.end, "duration": dur})
            speaker_duration[s] = speaker_duration.get(s, 0.0) + dur
            if (i + 1) % log_interval == 0 or i == total_diar_segments - 1:
                pct = (i + 1) / total_diar_segments * 100
                speaker_count = len(set(sp["speaker"] for sp in segments))
                elapsed = time.time() - t0
                print(f"[transcription]   📊 [{elapsed:>6.1f}s] Diarization progress: {i+1}/{total_diar_segments} segments "
                      f"({pct:.0f}%), {speaker_count} speaker(s) identified so far")

        # Log detailed results
        total_speech = sum(speaker_duration.values())
        elapsed = time.time() - t0
        print(f"[transcription]   ✅ [{elapsed:>6.1f}s] Diarization complete in {infer_elapsed:.1f}s — "
              f"{len(segments)} segments, {len(speaker_duration)} speakers, "
              f"{total_speech:.1f}s total speech")
        for spk, dur in sorted(speaker_duration.items()):
            pct = dur / total_speech * 100 if total_speech else 0
            seg_count = sum(1 for s in segments if s["speaker"] == spk)
            print(f"[transcription]      [{time.time() - t0:>6.1f}s] {spk}: {dur:.1f}s ({pct:.0f}%) across {seg_count} segment(s)")
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
            self._whisper = whisper.load_model(self.model_size, device=self.device)
            print(f"[transcription]   ✅ Model loaded in {time.time()-t_load:.1f}s")
        t_infer = time.time()
        print(f"[transcription]   ⏳ Transcribing (openai-whisper, verbose)...")
        result = self._whisper.transcribe(audio_path, word_timestamps=True, verbose=True)
        print(f"[transcription]   ⏱️  Inference done in {time.time()-t_infer:.1f}s")
        return self._extract_words(result)

    def _transcribe_mac(self, audio_path: str) -> dict:
        """Transcribe using mlx-whisper — optimized for Apple Silicon (MPS)."""
        t_infer = time.time()
        print(f"[transcription]   📦 Using mlx-whisper (Apple Silicon) model 'mlx-community/whisper-{self.model_size}'...")
        import mlx_whisper
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=f"mlx-community/whisper-{self.model_size}",
            word_timestamps=True,
            verbose=True,
        )
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
        segs, info = model.transcribe(audio_path, beam_size=5, word_timestamps=True)
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
