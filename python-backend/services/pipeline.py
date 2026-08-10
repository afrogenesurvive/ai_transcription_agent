"""ML pipeline orchestration, extracted from main.py (Phase 2).

Owns the per-job logger, the sync/async pipeline runners, the resumed-pipeline
runners, and the model-resource unloader. All service access goes through the
``services`` registry (``services.uploader``, ``services.engine``, etc.);
pipeline state lives on the shared ``state`` singleton from pipeline_state.py.
The two async runners are exposed to ``pipeline_state.start_pipeline_async`` /
``start_resumed_pipeline`` via the late-bound ``services.run_pipeline_async`` /
``services.run_resumed_pipeline_async`` callables, bound at the bottom of this
module.
"""

import asyncio
import os
import time
import traceback

import numpy as np

from config import config
import services
from pipeline_state import state
from constants import _MIN_INTERJOB_COOLDOWN_SEC
from transcription import TranscriptionEngine, detect_device, PipelineCancelled
from helpers import _job_dir_exists
from reconciliation import (
    _reconcile_attendees, _split_excluded_non_speaking,
    _update_metadata_with_reconciliation, _register_attendees_after_reconciliation,
)


# ── Per-job logger ──

class JobLogger:
    """Writes pipeline logs to stdout only.

    The Electron main process captures stdout and writes all entries to the
    per-job ``<storage>/<job_id>/pipeline.log`` via ``addLog()``.
    The per-job log is automatically closed when the pipeline completes or fails.
    """

    def __init__(self, job_id: str):
        self.job_id = job_id
        job_dir = os.path.join(config.STORAGE_PATH, job_id)
        os.makedirs(job_dir, exist_ok=True)

    def log(self, message: str):
        """Write a message to stdout (captured by Electron → per-job pipeline.log)."""
        print(message)

    def close(self):
        """No-op — file writing is handled by Electron's addLog()."""
        pass

    def __del__(self):
        self.close()


class _NullLogger:
    """Fallback logger that only prints to stdout."""
    def log(self, message: str):
        print(message)
    def close(self):
        pass


def _setup_job_logger(job_id: str):
    """Create a JobLogger for the given job, or a null fallback."""
    try:
        return JobLogger(job_id)
    except Exception as e:
        print(f"[pipeline] ⚠️  Could not create job logger for {job_id}: {e}")
        return _NullLogger()


async def _run_pipeline_async(job_id: str):
    """Async wrapper around the synchronous ML pipeline.

    Uses ``asyncio.to_thread()`` to offload CPU-bound ML work to a thread
    pool, allowing the event loop to handle other requests concurrently.
    An ``asyncio.Semaphore`` limits how many pipelines run simultaneously.

    The synchronous ``_run_pipeline`` function runs in a thread. Cancellation
    is cooperative — the thread checks ``state._pipeline_cancel`` between steps.
    """
    async with state._pipeline_semaphore:
        # Reset the MPS OOM flag before each new pipeline run
        state._mps_oom_occurred = False

        # Register job immediately so the frontend sees "initializing"
        # during the cooldown period (instead of stale "uploaded" status).
        print(f"\n{'='*60}")
        print(f"   🎬 [PIPELINE] Starting pipeline for job {job_id}")
        print(f"{'='*60}")
        state._active_jobs[job_id] = {"status": "initializing", "progress": 0.0, "title": "..."}
        try:
            # Fetch metadata upfront (lightweight, no ML)
            metadata = services.uploader.get_metadata(job_id)
            title = metadata.get("title", "Untitled")
            state._active_jobs[job_id]["title"] = title
            print(f"[pipeline] JOB-STARTED job_id={job_id} title='{title}'")
        except Exception:
            print(f"[pipeline] JOB-STARTED job_id={job_id} title='Untitled'")
        finally:
            # Persist initial status so polling sees it during cooldown
            services.uploader.update_status(job_id, {"status": "initializing", "progress": 0.0})

        # ── Inter-job cooldown (after registration, so frontend shows progress) ──
        if not config.KEEP_MODELS_WARM and state._last_pipeline_end_time > 0:
            elapsed_since_last = time.time() - state._last_pipeline_end_time
            if elapsed_since_last < _MIN_INTERJOB_COOLDOWN_SEC:
                wait = _MIN_INTERJOB_COOLDOWN_SEC - elapsed_since_last
                print(f"[pipeline] ⏳ Inter-job cooldown: waiting {wait:.1f}s for MPS memory to settle...")
                await asyncio.sleep(wait)

        try:
            await asyncio.to_thread(_run_pipeline_sync, job_id)
            print(f"\n{'='*60}")
            print(f"   ✅ [PIPELINE] Pipeline complete for job {job_id}")
            print(f"{'='*60}\n")
        except PipelineCancelled:
            state._pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} cancelled by user.")
            state._active_jobs.pop(job_id, None)
            # Swallow: the finally block cleans up tracking; do not mark failed
            # or print "Pipeline complete".
        except asyncio.CancelledError:
            state._pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} task cancelled.")
            state._active_jobs.pop(job_id, None)
            raise
        except Exception as e:
            print(f"\n   ❌ [pipeline] ERROR in job {job_id}: {e}")
            traceback.print_exc()
            # If the job's storage directory was deleted (user deleted the job from
            # History), do NOT write a failed status back — upload._write_status()
            # would recreate the dir and "resurrect" a deleted job.
            if not _job_dir_exists(job_id):
                print(f"[pipeline] Job {job_id} was deleted — skipping failure status write")
            else:
                # If it was an MPS OOM, surface that clearly in the error message
                err_str = str(e).lower()
                if "mps" in err_str or "out of memory" in err_str:
                    device = detect_device()
                    if device == "mps":
                        enhanced = f"MPS out of memory — try setting DEVICE=cpu in .env: {e}"
                    else:
                        enhanced = f"Backend error (device={device}): {e}"
                    services.uploader.update_status(job_id, {"status": "failed", "error": enhanced})
                    services.agent_bridge.enqueue_failed(job_id, enhanced, {})
                else:
                    services.uploader.update_status(job_id, {"status": "failed", "error": str(e)})
                    services.agent_bridge.enqueue_failed(job_id, str(e), {})
        finally:
            state._pipeline_tasks.pop(job_id, None)
            state._pipeline_cancel.discard(job_id)
            state._active_jobs.pop(job_id, None)
            state._last_pipeline_end_time = time.time()
            _cleanup_pipeline_resources()
            state._mps_oom_occurred = False  # defensive reset


def _cleanup_pipeline_resources():
    """Free ML resources after a pipeline completes.

    When ``config.KEEP_MODELS_WARM`` is False (default): unloads ALL ML
    models regardless of whether other jobs are active. On Apple Silicon
    the MPS memory driver does NOT reclaim fragmented pages until the
    model objects are fully released AND a GC cycle runs. Eager unloading
    prevents cumulative fragmentation from causing an OOM crash on the
    next job.

    When ``KEEP_MODELS_WARM`` is True: skips model deletion but still
    runs GC, MPS cache clearing, and the cooldown sleep. The model
    references survive across jobs so ``from_pretrained()`` is never
    called again.

    Safe to call even if models are already unloaded.
    """
    try:
        import gc
        import torch

        # 1. Break reference cycles by deliberately deleting model refs
        #    before setting to None.  Python's GC can miss cycles involving
        #    torch.nn.Module objects (which hold references to CUDA/MPS
        #    allocations) if we only set to None.
        if not config.KEEP_MODELS_WARM:
            if services.engine is not None:
                # _diarization removed — diarization now runs in an isolated subprocess
                # (see _run_diarization_subprocess in transcription.py)
                if hasattr(services.engine, "_whisper") and services.engine._whisper is not None:
                    del services.engine._whisper
                    services.engine._whisper = None
                    print(f"[pipeline]   \U0001f9f9 Whisper model unloaded")
                # Clear MLX metal cache on Apple Silicon (mlx-whisper internal cache)
                try:
                    import mlx.core as mx
                    mx.clear_cache()
                    print(f"[pipeline]   \U0001f9f9 MLX metal cache cleared")
                except (ImportError, AttributeError):
                    pass  # Not on macOS or mlx not installed — fine
                # Release engine itself
                services.engine = None
                print(f"[pipeline]   \U0001f9f9 TranscriptionEngine released")
        else:
            # Warm mode: keep models loaded between jobs
            print(f"[pipeline]   \U0001f525 Models kept warm (KEEP_MODELS_WARM=true)")

        # 2. Unload embedding model from VoiceprintManager
        if services.vp_manager is not None:
            services.vp_manager.reset_model()
            print(f"[pipeline]   \U0001f9f9 Embedding model unloaded")

        # 3. Force garbage collection to break any remaining cycles
        gc.collect()
        gc.collect()  # 2x pass — PyTorch objects often need two cycles

        # 4. Clear MPS cache AFTER GC so the freed memory is actually released
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
            print(f"[pipeline]   \U0001f9f9 MPS cache cleared after GC")

        # 5. Brief sleep to let the MPS driver reclaim freed pages
        #    Without this, subsequent model loads can still see stale
        #    allocation tables and fail or fragment further.
        time.sleep(0.5)
    except Exception as e:
        print(f"[pipeline]   \u26a0\ufe0f Cleanup warning: {e}")


def _run_pipeline_sync(job_id: str):
    """Synchronous ML pipeline — runs inside ``asyncio.to_thread()``.

    Each step updates the in-memory ``state._active_jobs`` dict (via
    ``state.update_active``) and checks ``state._pipeline_cancel`` for
    cooperative cancellation.

    All progress is also written to a per-job log file at ``<storage>/<job_id>/pipeline.log``.
    """
    _pipeline_start = time.time()
    jlog = _setup_job_logger(job_id)
    try:
        state.update_active(job_id, "initializing", 0.05)

        # Create the transcription engine, respecting any prior MPS OOM flag.
        # If a previous job in this process hit an MPS OOM error, force CPU
        # from the start for this job to prevent cascading failures.
        initial_device = "cpu" if state._mps_oom_occurred else None
        if initial_device == "cpu":
            jlog.log(f"[pipeline] ⚠️  Prior MPS OOM detected — forcing CPU fallback for this job")
        services.engine = TranscriptionEngine(device=initial_device)
        metadata = services.uploader.get_metadata(job_id)
        audio_path = services.uploader.get_audio_path(job_id)
        jlog.log(f"[pipeline] Audio path: {audio_path}")
        jlog.log(f"[pipeline] Metadata: title='{metadata.get('title')}', attendees={metadata.get('attendees')}")

        # ── Compute max_speakers hint from attendee count ──
        attendee_count = len(metadata.get("attendees", []))
        max_speakers = max(2, attendee_count + 1) if attendee_count > 0 else 0
        # Optional hard cap from config (DIARIZATION_MAX_SPEAKERS). When > 0 it
        # constrains the attendee-derived hint (and applies even with no attendees).
        if config.DIARIZATION_MAX_SPEAKERS > 0:
            max_speakers = (
                min(max_speakers, config.DIARIZATION_MAX_SPEAKERS) if max_speakers > 0
                else config.DIARIZATION_MAX_SPEAKERS
            )
        if max_speakers > 0:
            jlog.log(f"[pipeline] Using max_speakers={max_speakers} from {attendee_count} attendee(s)")

        # ── Step 1: Diarization ──
        # Runs in an isolated subprocess (see _run_diarization_subprocess in
        # transcription.py). If pyannote's internal multiprocessing crashes,
        # only the child dies — the backend survives and retries on CPU.
        jlog.log(f"\n   🔬 [PIPELINE] Step 1/5: Diarization (identifying speakers)...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "processing_diarization", 0.2)
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        t_diar = time.time()
        # Live progress: pyannote step progress maps onto the 0.2 → 0.3 band so
        # the UI moves instead of sitting at 20% for long files.
        def _diar_progress(frac):
            state.update_active(job_id, "processing_diarization", 0.2 + 0.1 * max(0.0, min(1.0, frac)))

        # Cancellation check shared by every long ML call in this pipeline thread.
        def _is_cancelled():
            return job_id in state._pipeline_cancel

        try:
            diarization = services.engine.run_diarization(
                audio_path, max_speakers=max_speakers, progress_cb=_diar_progress,
                cancel_check=_is_cancelled,
            )
        except PipelineCancelled:
            jlog.log(f"[pipeline] 🛑 Diarization cancelled — stopping pipeline")
            raise
        except (RuntimeError, TimeoutError) as _diar_err:
            err_str = str(_diar_err).lower()
            if "subprocess" in err_str or "timed out" in err_str or "mps" in err_str or "out of memory" in err_str:
                jlog.log(f"[pipeline] ⚠️  Diarization subprocess failed — {_diar_err}")
                jlog.log(f"[pipeline]    Retrying diarization on CPU...")
                state._mps_oom_occurred = True
                services.engine = TranscriptionEngine(device="cpu")
                t_diar_cpu = time.time()
                diarization = services.engine.run_diarization(
                    audio_path, max_speakers=max_speakers, progress_cb=_diar_progress,
                    cancel_check=_is_cancelled,
                )
                diar_elapsed = time.time() - t_diar_cpu
                jlog.log(f"   ✅ [pipeline] CPU diarization: {len(diarization)} segments in {diar_elapsed:.1f}s")
                state._mps_oom_occurred = False
            else:
                raise
        else:
            diar_elapsed = time.time() - t_diar
        speakers_found = set(s["speaker"] for s in diarization)
        jlog.log(f"   ✅ [pipeline] Diarization: {len(diarization)} segments, {len(speakers_found)} speakers "
              f"({', '.join(sorted(speakers_found))}) in {diar_elapsed:.1f}s")
        if not speakers_found:
            jlog.log(f"[pipeline] ⚠️  Diarization returned 0 speakers — transcript will be "
                  f"unlabeled and all attendees will be marked non-speaking")

        # Group by speaker (use dicts consistently — no SimpleNamespace)
        speaker_segments = {}
        for seg in diarization:
            spk = seg["speaker"]
            speaker_segments.setdefault(spk, []).append({
                "speaker": seg["speaker"],
                "start": seg["start"],
                "end": seg["end"],
                "duration": seg.get("duration", seg["end"] - seg["start"]),
            })

        # ── Pause for user labeling if speaker count doesn't match attendees ──
        # After diarization we know how many unique voices exist. If the number
        # of attendees provided by the user doesn't match, pause and let them
        # label each detected speaker before we proceed to the expensive ASR step.
        speaker_count = len(speaker_segments)
        attendee_count = len(metadata.get("attendees", []))
        should_pause = speaker_count > 0
        if should_pause:
            jlog.log(f"\n   ⏸️  [PIPELINE] {speaker_count} speaker(s) detected — pausing for labeling (attendees: {attendee_count})")
            services.uploader.save_diarization(job_id, {
                "speaker_segments": speaker_segments,
                "diarization": diarization,
                "total_speakers": speaker_count,
            })
            # Build speaker info for the status so the UI can display it
            speaker_info = []
            for spk, segs in speaker_segments.items():
                longest = max(segs, key=lambda s: s["duration"])
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest["start"],
                    "sample_end": longest["end"],
                })
            state.update_active(job_id, "paused_for_labeling", 0.3, speakers=speaker_info)
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Detected speakers: {', '.join(sorted(speaker_segments.keys()))}")
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume

        # ── Step 2: Voiceprint matching ──
        jlog.log(f"\n   🧬 [PIPELINE] Step 2/5: Voiceprint matching...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "matching_voiceprints", 0.35)
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        t_vp = time.time()
        attendees = metadata.get("attendees", [])
        if attendees:
            jlog.log(f"[pipeline] Matching against {len(attendees)} known attendees: {attendees}")
            match_result = services.vp_manager.match_against_attendees(
                audio_path, speaker_segments, attendees
            )
        else:
            jlog.log(f"[pipeline] No known attendees — all speakers will be unknown")
            match_result = {"known": {}, "unknown": [
                {
                    "speaker_id": spk,
                    "segments": [{"start": s["start"], "end": s["end"], "duration": s["duration"], "speaker": s["speaker"]} for s in segs],
                    "sample_segment": {"start": segs[0]["start"], "end": segs[0]["end"]},
                }
                for spk, segs in speaker_segments.items()
            ]}
        vp_elapsed = time.time() - t_vp
        jlog.log(f"   ✅ [pipeline] Voiceprint matching in {vp_elapsed:.1f}s: "
              f"{len(match_result['known'])} known, {len(match_result.get('unknown', []))} unknown")

        # ── Cross-check: detect voiceprint conflicts before auto-labeling ──
        # If a matched speaker's voice also matches an EXISTING enrolled
        # voiceprint under a DIFFERENT name, don't auto-label — defer to
        # the user so they can resolve the conflict via the labeling modal.
        if match_result.get("known"):
            scores = match_result.get("scores", {})
            for matched_name, segs in list(match_result["known"].items()):
                # Extract composite embedding from the matched segments
                sample_segs = segs[:5]
                step = max(1, len(segs) // 5) if len(segs) > 5 else 1
                sampled_embs = []
                for i in range(0, len(segs), step):
                    if len(sampled_embs) >= 5:
                        break
                    s = segs[i]
                    try:
                        seg_emb = services.vp_manager.extract_embedding(
                            audio_path, segment=(s["start"], s["end"])
                        )
                        sampled_embs.append(seg_emb)
                    except Exception:
                        continue
                if not sampled_embs:
                    continue
                emb = np.mean(sampled_embs, axis=0)
                emb = emb / np.linalg.norm(emb)
                # Check against ALL enrolled voiceprints for conflicts
                all_matches = services.vp_manager.find_matching_voiceprints(
                    emb, threshold=config.VOICEPRINT_THRESHOLD
                )
                # If ANY enrolled voiceprint has the same name as this matched
                # speaker, they are correctly identified — don't move to unknown
                # even if there are secondary cross-matches from same-audio prints.
                has_exact_name_match = any(
                    m["name"].lower() == matched_name.lower()
                    for m in all_matches
                )
                if has_exact_name_match:
                    jlog.log(f"[voiceprint] ✅ '{matched_name}' has direct voiceprint match — "
                          f"keeping as known (suppressed {len(all_matches) - 1} cross-match(es))")
                    continue

                for m in all_matches:
                    if m["name"].lower() == matched_name.lower():
                        continue  # Same name — no conflict
                    # Conflict! This voice is already enrolled under a different name.
                    jlog.log(f"[voiceprint] ⚠️  Auto-label '{matched_name}' ({segs[0].get('speaker', '?')}) "
                          f"conflicts with existing voiceprint '{m['name']}' "
                          f"(sim={m['similarity']:.3f}) — deferring to user")
                    # Move from known → unknown
                    conflict_segments = match_result["known"].pop(matched_name)
                    match_result.setdefault("scores", {}).pop(matched_name, None)
                    # Use the speaker field from the segments directly
                    conflict_spk_id = conflict_segments[0].get("speaker", "?") if conflict_segments else "?"
                    match_result.setdefault("unknown", []).append({
                        "speaker_id": conflict_spk_id,
                        "segments": [{"start": s["start"], "end": s["end"]} for s in conflict_segments],
                        "sample_segment": {"start": conflict_segments[0]["start"],
                                           "end": conflict_segments[0]["end"]},
                    })
                    break  # Only the first conflict per speaker

        # ── Move unregistered voiceprint matches into unknown ──
        # Speakers whose voice matches an EXISTING enrolled voiceprint under a
        # DIFFERENT name (and that name isn't in this job's attendee list) must
        # be surfaced to the user for labeling. get_speaker_clips will detect
        # the match and populate voiceprint_matches, which the labeling modal
        # displays as inline conflict warnings.
        # Save names before pop so reconciliation can track them.
        unregistered = match_result.pop("unregistered", {})
        if unregistered:
            for name, segs in unregistered.items():
                spk_id = segs[0].get("speaker", "?") if segs else "?"
                match_result.setdefault("unknown", []).append({
                    "speaker_id": spk_id,
                    "segments": [{"start": s["start"], "end": s["end"]} for s in segs],
                    "sample_segment": {"start": segs[0]["start"],
                                       "end": segs[0]["end"]},
                })
            total_unknown = len(match_result.get("unknown", []))
            jlog.log(f"[voiceprint] 🔄 Moved {len(unregistered)} unregistered match(es) "
                  f"into unknown ({total_unknown} total unknown) — "
                  f"will pause for user labeling")

        # ── Log detailed voiceprint identification results ──
        scores = match_result.get("scores", {})
        if match_result.get("known"):
            jlog.log(f"[voiceprint] ── Speaker Identifications ──")
            for matched_name in match_result["known"]:
                score = scores.get(matched_name, 0)
                segment_count = len(match_result["known"][matched_name])
                # Use the speaker field from the segments directly
                known_segs = match_result["known"][matched_name]
                source_spk = known_segs[0].get("speaker", "?") if known_segs else "?"
                jlog.log(f"[voiceprint]   ✅ Speaker {source_spk} → {matched_name} "
                      f"(confidence: {score:.3f}, {segment_count} segment(s))")
            jlog.log(f"[voiceprint] ──────────────────────────────")
            jlog.log(f"[pipeline]   Matched: {list(match_result['known'].keys())}")
        if match_result.get("unknown"):
            jlog.log(f"[voiceprint] ── Unidentified Speakers ──")
            for u in match_result["unknown"]:
                jlog.log(f"[voiceprint]   ❓ {u['speaker_id']}: not identified "
                      f"({len(u['segments'])} segment(s), sample at {u['sample_segment']['start']:.1f}s)")
            jlog.log(f"[voiceprint] ────────────────────────────")

        # ── Attendee reconciliation ──
        metadata_attendees = metadata.get("attendees", [])
        metadata_attendee_emails = metadata.get("attendeeEmails", [])
        reconciliation = _reconcile_attendees(
            metadata_attendees, metadata_attendee_emails,
            match_result, speaker_segments,
        )

        # ── Merge unregistered voiceprint matches into reconciliation ──
        # The unregistered speakers were moved to unknown before reconciliation
        # ran (so they pause for user labeling), but their names need to be
        # tracked in unregistered_speakers so that downstream code in
        # label_and_resume knows they came from existing voiceprints, not from
        # the form. This prevents orphan attendee records when the user picks
        # "Use voice owner" in the A/B conflict selector.
        if unregistered:
            existing_unreg_names = {s["name"].lower() for s in reconciliation.get("unregistered_speakers", [])}
            for u_name in unregistered:
                if u_name.lower() not in existing_unreg_names:
                    u_email = ""
                    try:
                        vp = services.vp_manager.get_voiceprint(u_name)
                        if vp:
                            u_email = vp.get("email", "")
                    except Exception:
                        pass
                    reconciliation.setdefault("unregistered_speakers", []).append({
                        "name": u_name,
                        "email": u_email,
                    })
                    existing_unreg_names.add(u_name.lower())
            jlog.log(f"[reconciliation] Added {len(unregistered)} unregistered voiceprint match(es) "
                  f"to reconciliation: {list(unregistered.keys())}")

        matched_names = [s["name"] for s in reconciliation["matched_speakers"]]
        non_speaking_names = [s["name"] for s in reconciliation["non_speaking_attendees"]]
        unknown_ids = [u["speaker_id"] for u in reconciliation["unknown_speakers"]]
        jlog.log(f"[reconciliation] Attendee reconciliation: "
              f"{len(matched_names)} matched speaker(s), "
              f"{len(non_speaking_names)} non-speaking, "
              f"{len(unknown_ids)} unknown")
        if non_speaking_names:
            jlog.log(f"[reconciliation]   Non-speaking attendees "
                  f"(present but did not speak): {non_speaking_names}")
        if matched_names:
            jlog.log(f"[reconciliation]   Matched speakers: {matched_names}")

        # ── Step 3: ASR Transcription ──
        jlog.log(f"\n   🎤 [PIPELINE] Step 3/5: ASR transcription (Whisper)...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "processing_transcription", 0.5)
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        t_asr = time.time()
        transcription = services.engine.run_transcription(audio_path, cancel_check=_is_cancelled)
        asr_elapsed = time.time() - t_asr
        jlog.log(f"   ✅ [pipeline] ASR: {len(transcription.get('words', []))} words, "
              f"{len(transcription.get('segments', []))} segments in {asr_elapsed:.1f}s")

        # ── MPS OOM check after ASR ──
        # If ASR hit an MPS OOM error, the transcription may be empty.
        # Fall back to CPU and re-run.
        if (getattr(services.engine, 'mps_oom_occurred', False) or state._mps_oom_occurred) and not transcription.get("words"):
            state._mps_oom_occurred = True
            jlog.log(f"[pipeline] ⚠️  MPS OOM during ASR — retrying transcription on CPU...")
            services.engine = TranscriptionEngine(device="cpu")
            t_asr_cpu = time.time()
            transcription = services.engine.run_transcription(audio_path, cancel_check=_is_cancelled)
            asr_elapsed = time.time() - t_asr_cpu
            jlog.log(f"   ✅ [pipeline] CPU ASR retry: {len(transcription.get('words', []))} words in {asr_elapsed:.1f}s")
            state._mps_oom_occurred = False

        # ── Step 4: Alignment ──
        jlog.log(f"\n   🔗 [PIPELINE] Step 4/5: Aligning diarization with transcript...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "aligning", 0.7)
        t_align = time.time()
        aligned = services.engine.align_transcript(transcription, diarization)
        align_elapsed = time.time() - t_align
        jlog.log(f"   ✅ [pipeline] Alignment: {len(aligned)} transcript segments in {align_elapsed*1000:.0f}ms")

        # Apply known speaker labels with ASV feedback
        label_count = 0
        asv_logged = 0
        match_scores = match_result.get("scores", {})
        for seg in aligned:
            for name, segs in match_result["known"].items():
                for s in segs:
                    if abs(seg["start"] - s["start"]) < 0.5:
                        seg["speaker"] = name
                        label_count += 1
                        # Log ASV feedback for the first N segments
                        if asv_logged < 50 and seg.get("text", "").strip():
                            asv_logged += 1
                            ts_start = seg.get("start", 0)
                            ts_end = seg.get("end", 0)
                            text = seg.get("text", "").strip()
                            score = match_scores.get(name, 0)
                            jlog.log(f"[transcription] [{ts_start:>8.3f} --> {ts_end:>8.3f}] "
                                  f"{name} (score={score:.3f}): {text[:200]}")
                        break
        if label_count:
            jlog.log(f"[pipeline] Applied {label_count} speaker label(s) from voiceprint matching"
                  f" — logged {asv_logged} ASV match(es)")

        # Save the raw ASR text (unrefined, before any LLM processing)
        raw_text = transcription.get("text", "")
        if raw_text:
            services.uploader.save_raw_transcript(job_id, raw_text)

        services.uploader.save_transcript(job_id, aligned)
        services.uploader.save_transcript_text(job_id, aligned)
        state.update_active(job_id, "transcribed", 0.85)

        # ── Pipeline timing summary ──
        pipeline_total = time.time() - (t_diar - diar_elapsed)
        jlog.log(f"\n{'='*50}")
        jlog.log(f"   ⏱️  PIPELINE TIMING SUMMARY")
        jlog.log(f"{'='*50}")
        jlog.log(f"      Diarization:     {diar_elapsed:>7.1f}s")
        jlog.log(f"      Voiceprint:      {vp_elapsed:>7.1f}s")
        jlog.log(f"      ASR:             {asr_elapsed:>7.1f}s")
        jlog.log(f"      Alignment:       {align_elapsed*1000:>7.0f}ms")
        jlog.log(f"      ─────────────────────")
        jlog.log(f"      Total (ML):      {pipeline_total:>7.1f}s")
        jlog.log(f"{'='*50}\n")

        # ── Step 5: Enqueue for agent or pause for labeling ──
        jlog.log(f"\n   📨 [PIPELINE] Step 5/5: Enqueueing for agent runner...")
        if state.check_cancelled(job_id): return
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        unknown = match_result.get("unknown", [])
        if unknown:
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"]["start"]) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            # Unknown speakers after voiceprint matching — pause for user labeling
            # so they can identify them (saves real embeddings, unlike agent path)
            jlog.log(f"\n   ⏸️  [PIPELINE] {len(unknown)} unknown speaker(s) — pausing for user labeling (post-ASR)")
            # Save diarization data if not already saved (won't exist if we didn't
            # pause after diarization due to matching attendee count)
            if not services.uploader.load_diarization(job_id).get("speaker_segments"):
                # Rebuild speaker_segments from the full diarization list to
                # guarantee no speaker is lost due to earlier filtering/grouping.
                complete_segments: dict[str, list[dict]] = {}
                for seg in diarization:
                    spk = seg["speaker"]
                    complete_segments.setdefault(spk, []).append({
                        "speaker": seg["speaker"],
                        "start": seg["start"],
                        "end": seg["end"],
                        "duration": seg.get("duration", seg["end"] - seg["start"]),
                    })
                services.uploader.save_diarization(job_id, {
                    "speaker_segments": complete_segments,
                    "diarization": diarization,
                    "total_speakers": len(complete_segments),
                })
            # Build speaker info for the UI labeling modal
            speaker_info = []
            for u in unknown:
                spk = u["speaker_id"]
                segs = speaker_segments.get(spk, [])
                longest = max(segs, key=lambda s: s["duration"]) if segs else {"start": 0, "end": 0}
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest.get("start", 0),
                    "sample_end": longest.get("end", 0),
                })
            # ── Build pre-computed voiceprint matches for consistent conflict detection ──
            # Maps speaker_id → list of voiceprint matches found by the pipeline.
            # get_speaker_clips uses this to avoid re-running voiceprint matching
            # (which can produce non-deterministic results).
            voiceprint_matches_by_speaker = {}
            vp_scores = match_result.get("scores", {})
            # Known speakers (matched to registered attendees in attendee list)
            for matched_name, segs in match_result.get("known", {}).items():
                score = vp_scores.get(matched_name, 0)
                if segs and "speaker" in segs[0]:
                    spk_id = segs[0]["speaker"]
                    voiceprint_matches_by_speaker[spk_id] = [{
                        "name": matched_name,
                        "similarity": round(score, 3),
                    }]
            # Unregistered matches (moved to unknown — voiceprint owners not in form)
            if unregistered:
                for name, segs in unregistered.items():
                    u_email = ""
                    u_job_id = ""
                    try:
                        vp = services.vp_manager.get_voiceprint(name)
                        if vp:
                            u_email = vp.get("email", "")
                            u_job_id = vp.get("sample_job_id", "")
                    except Exception:
                        pass
                    if segs and "speaker" in segs[0]:
                        spk_id = segs[0]["speaker"]
                        voiceprint_matches_by_speaker[spk_id] = [{
                            "name": name,
                            "email": u_email,
                            "similarity": 1.0,
                            "sample_job_id": u_job_id,
                        }]

            state.update_active(job_id, "paused_for_labeling", 0.9,
                          labeling_phase="post_asr", speakers=speaker_info,
                          unknown_speakers=unknown,
                          voiceprint_matches_by_speaker=voiceprint_matches_by_speaker,
                          reconciliation={
                              "matched_speakers": reconciliation["matched_speakers"],
                              "non_speaking_attendees": reconciliation["non_speaking_attendees"],
                              "unregistered_speakers": reconciliation.get("unregistered_speakers", []),
                          })
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Unknown speakers: {', '.join(u['speaker_id'] for u in unknown)}")

            # Register matched speakers and non-speaking attendees now
            # (unknown speakers will be registered after the user labels them)
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="new_job_form"
            )
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume
        else:
            # Persist reconciled attendee list (incl. non-speaking annotation)
            # back to metadata.json so results/delivery read the full list.
            _update_metadata_with_reconciliation(job_id, metadata, reconciliation, jlog)

            # Register attendees in ephemeral DB AFTER full reconciliation
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="new_job_form"
            )

            # Persist ML pipeline completion stats
            try:
                total_chars = sum(len(s.get("text", "")) for s in aligned)
                services.ephemeral_memory.upsert_job(job_id, {
                    "transcript_segment_count": len(aligned),
                    "transcript_char_count": total_chars,
                    "audio_duration_sec": aligned[-1]["end"] if aligned else None,
                })
            except Exception as e:
                jlog.log(f"[pipeline] Warning: could not update job record: {e}")

            # ── Gate 1: Raw Transcript Review ──
            if config.GATE_RAW_REVIEW_ENABLED:
                state.update_active(job_id, "pending_raw_review", 0.95)
                jlog.log(f"\n   ⏸️  [PIPELINE] Gate 1 active — pausing for raw transcript review")
                jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for user to review/edit transcript")
                return  # Exit pipeline — resume via POST /transcribe/approve_gate1/{job_id}

            state.update_active(job_id, "ready_for_agent", 0.95)
            skip = metadata.get("skip_steps")
            jlog.log(f"[pipeline] All speakers known — enqueueing ready_for_processing (skip_steps={skip})")
            services.agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=non_speaking_names,
            )

    except Exception as e:
        jlog.log(f"\n   ❌ [pipeline] ERROR in job {job_id}: {e}")
        traceback.print_exc()
        raise  # Re-raise so the outer _run_pipeline handles status + enqueue
    finally:
        jlog.close()
        state._pipeline_cancel.discard(job_id)


async def _run_resumed_pipeline_async(job_id: str, label_map: dict, excluded_non_speaking: list = None):
    """Async wrapper for the resumed pipeline (diarization → ASR → alignment)."""
    async with state._pipeline_semaphore:
        print(f"\n{'='*60}")
        print(f"   ▶️  [PIPELINE] Resuming pipeline for job {job_id} (after labeling)")
        print(f"{'='*60}")
        state._active_jobs[job_id] = {"status": "resuming", "progress": 0.35, "title": "..."}
        try:
            metadata = services.uploader.get_metadata(job_id)
            state._active_jobs[job_id]["title"] = metadata.get("title", "Untitled")
        except Exception:
            pass
        try:
            await asyncio.to_thread(
                _run_pipeline_resumed_sync, job_id, label_map, excluded_non_speaking
            )
            print(f"\n{'='*60}")
            print(f"   ✅ [PIPELINE] Resumed pipeline complete for job {job_id}")
            print(f"{'='*60}\n")
        except PipelineCancelled:
            state._pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} cancelled by user.")
            state._active_jobs.pop(job_id, None)
            # Swallow: the finally block cleans up tracking.
        except asyncio.CancelledError:
            state._pipeline_cancel.add(job_id)
            print(f"\n   🛑 [pipeline] Job {job_id} task cancelled.")
            state._active_jobs.pop(job_id, None)
            raise
        except Exception as e:
            print(f"\n   ❌ [pipeline] ERROR in resumed job {job_id}: {e}")
            traceback.print_exc()
            services.uploader.update_status(job_id, {"status": "failed", "error": str(e)})
            services.agent_bridge.enqueue_failed(job_id, str(e), {})
        finally:
            state._pipeline_tasks.pop(job_id, None)
            state._pipeline_cancel.discard(job_id)
            state._active_jobs.pop(job_id, None)
            _cleanup_pipeline_resources()


def _run_pipeline_resumed_sync(job_id: str, label_map: dict, excluded_non_speaking: list = None):
    """Resumed pipeline — loads saved diarization, skips to ASR + alignment.

    The diarization was already done and saved. We load it, apply the
    user-provided label map, then run ASR, alignment, and enqueue for agent.

    All progress is also written to the per-job pipeline.log file.
    """
    _pipeline_start = time.time()
    jlog = _setup_job_logger(job_id)
    try:
        state.update_active(job_id, "resuming", 0.35)

        # Reuse warm engine if available (same logic as _run_pipeline_sync)
        if config.KEEP_MODELS_WARM and services.engine is not None:
            jlog.log(f"[pipeline] \U0001f525 Reusing warm TranscriptionEngine (device={services.engine.device})")
        else:
            services.engine = TranscriptionEngine()

        metadata = services.uploader.get_metadata(job_id)
        audio_path = services.uploader.get_audio_path(job_id)

        # Load saved diarization
        diar_data = services.uploader.load_diarization(job_id)
        if not diar_data or "diarization" not in diar_data:
            raise RuntimeError("Diarization data not found — cannot resume pipeline")
        diarization = diar_data["diarization"]
        speaker_segments = diar_data["speaker_segments"]
        jlog.log(f"[pipeline] Loaded saved diarization ({len(diarization)} segments, "
              f"{len(speaker_segments)} speakers)")

        # Build label_name_map: speaker_id → name (used for direct label application
        # after alignment — avoids the old bug where `known` was keyed by name,
        # causing duplicate names to overwrite one speaker's segments).
        label_name_map = {spk: info["name"] for spk, info in label_map.items()}

        # Build match_result from user labels (still needed for reconciliation).
        # Guard against name collisions — keep first occurrence only.
        unknown = []
        known = {}
        for spk, segs in speaker_segments.items():
            if spk in label_map:
                info = label_map[spk]
                if info["name"] not in known:
                    known[info["name"]] = segs
            else:
                unknown.append({
                    "speaker_id": spk,
                    "segments": [{"start": s["start"], "end": s["end"], "duration": s["duration"], "speaker": s["speaker"]} for s in segs],
                    "sample_segment": {"start": segs[0]["start"], "end": segs[0]["end"]},
                })
        match_result = {"known": known, "unknown": unknown}
        jlog.log(f"[pipeline] User labels applied: {len(known)} known, {len(unknown)} unknown")

        # ── Attendee reconciliation after labeling ──
        metadata_attendees = metadata.get("attendees", [])
        metadata_attendee_emails = metadata.get("attendeeEmails", [])
        reconciliation = _reconcile_attendees(
            metadata_attendees, metadata_attendee_emails,
            match_result, speaker_segments,
        )

        # Drop form entries the user excluded (A/B conflict losers + X'd
        # non-speaking attendees) from the reconciliation, so they are not
        # persisted to metadata/delivery/DB or passed to the agent context.
        if excluded_non_speaking:
            kept_ns, removed_ns = _split_excluded_non_speaking(
                reconciliation.get("non_speaking_attendees", []), excluded_non_speaking)
            if removed_ns:
                reconciliation["non_speaking_attendees"] = kept_ns
                jlog.log(f"[reconciliation] 🗑️ Excluded {len(removed_ns)} non-speaking "
                      f"attendee(s) ({[r.get('name') for r in removed_ns]}) — "
                      f"dropped from meeting record + delivery")

        matched_names = [s["name"] for s in reconciliation["matched_speakers"]]
        non_speaking_names = [s["name"] for s in reconciliation["non_speaking_attendees"]]
        unknown_ids = [u["speaker_id"] for u in reconciliation["unknown_speakers"]]
        jlog.log(f"[reconciliation] Attendee reconciliation (resumed): "
              f"{len(matched_names)} matched speaker(s), "
              f"{len(non_speaking_names)} non-speaking, "
              f"{len(unknown_ids)} unknown")
        if non_speaking_names:
            jlog.log(f"[reconciliation]   Non-speaking attendees "
                  f"(present but did not speak): {non_speaking_names}")

        # ── Step 3: ASR Transcription ──
        jlog.log(f"\n   🎤 [PIPELINE] Step 3/5: ASR transcription (Whisper)...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "processing_transcription", 0.5)
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        t_asr = time.time()
        transcription = services.engine.run_transcription(audio_path, cancel_check=lambda: job_id in state._pipeline_cancel)
        asr_elapsed = time.time() - t_asr

        # ── Step 4: Alignment ──
        jlog.log(f"\n   🔗 [PIPELINE] Step 4/5: Aligning diarization with transcript...")
        if state.check_cancelled(job_id): return
        state.update_active(job_id, "aligning", 0.7)
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        t_align = time.time()
        aligned = services.engine.align_transcript(transcription, diarization)
        align_elapsed = time.time() - t_align

        # Apply user-provided speaker labels via direct speaker_id→name mapping.
        # Uses label_name_map (keyed by speaker_id) instead of the old time-based
        # matching against `known` (keyed by name), which lost segments when two
        # speakers had the same name due to dict overwrite.
        label_count = 0
        asv_logged = 0
        for seg in aligned:
            spk_id = seg.get("speaker", "")
            if spk_id in label_name_map:
                seg["speaker"] = label_name_map[spk_id]
                label_count += 1
                # Log ASV feedback for the first N segments
                if asv_logged < 50 and seg.get("text", "").strip():
                    asv_logged += 1
                    ts_start = seg.get("start", 0)
                    ts_end = seg.get("end", 0)
                    text = seg.get("text", "").strip()
                    jlog.log(f"[transcription] [{ts_start:>8.3f} --> {ts_end:>8.3f}] "
                          f"{seg['speaker']}: {text[:200]}")
        if label_count:
            jlog.log(f"[pipeline] Applied {label_count} speaker label(s) from user"
                  f" — logged {asv_logged} ASV match(es)")

        # Save the raw ASR text (unrefined, before any LLM processing)
        raw_text = transcription.get("text", "")
        if raw_text:
            services.uploader.save_raw_transcript(job_id, raw_text)

        services.uploader.save_transcript(job_id, aligned)
        services.uploader.save_transcript_text(job_id, aligned)
        state.update_active(job_id, "transcribed", 0.85)

        # Timing summary
        jlog.log(f"\n{'='*50}")
        jlog.log(f"   ⏱️  RESUMED PIPELINE TIMING")
        jlog.log(f"{'='*50}")
        jlog.log(f"      ASR:             {asr_elapsed:>7.1f}s")
        jlog.log(f"      Alignment:       {align_elapsed*1000:>7.0f}ms")
        jlog.log(f"{'='*50}\n")

        # ── Step 5: Enqueue for agent or pause for labeling ──
        jlog.log(f"\n   📨 [PIPELINE] Step 5/5: Enqueueing for agent runner...")
        if state.check_cancelled(job_id): return
        state.check_pipeline_timeout(job_id, _pipeline_start, jlog)
        if unknown:
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"]["start"]) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            # Unknown speakers — pause for user labeling (saves real embeddings,
            # unlike the agent-runner path which stores None)
            jlog.log(f"\n   ⏸️  [PIPELINE] {len(unknown)} unknown speaker(s) — pausing for user labeling (post-ASR)")
            # Build speaker info for the UI labeling modal
            speaker_info = []
            for u in unknown:
                spk = u["speaker_id"]
                segs = speaker_segments.get(spk, [])
                longest = max(segs, key=lambda s: s["duration"]) if segs else {"start": 0, "end": 0}
                speaker_info.append({
                    "speaker_id": spk,
                    "segment_count": len(segs),
                    "total_duration": sum(s["duration"] for s in segs),
                    "sample_start": longest.get("start", 0),
                    "sample_end": longest.get("end", 0),
                })
            # ── Pre-computed voiceprint matches for consistent conflict detection ──
            # Maps speaker_id → list of voiceprint matches found by the pipeline.
            # get_speaker_clips uses this to avoid re-running voiceprint matching
            # (which can produce non-deterministic results). Reuse the map saved
            # during the initial (pre-ASR) pause — it already includes both known
            # and unregistered voiceprint owners, and diarization is identical so
            # the speaker_id → matches mapping is still valid. update_status()
            # merges fields, so the saved map survives this function's earlier
            # status updates. Fall back to a known-only rebuild if unavailable.
            saved_status = services.uploader.get_status(job_id)
            voiceprint_matches_by_speaker = saved_status.get("voiceprint_matches_by_speaker", {}) or {}
            if not voiceprint_matches_by_speaker:
                vp_scores = match_result.get("scores", {})
                for matched_name, segs in match_result.get("known", {}).items():
                    score = vp_scores.get(matched_name, 0)
                    if segs and "speaker" in segs[0]:
                        spk_id = segs[0]["speaker"]
                        voiceprint_matches_by_speaker[spk_id] = [{
                            "name": matched_name,
                            "similarity": round(score, 3),
                        }]

            state.update_active(job_id, "paused_for_labeling", 0.9,
                          labeling_phase="post_asr", speakers=speaker_info,
                          unknown_speakers=unknown,
                          voiceprint_matches_by_speaker=voiceprint_matches_by_speaker,
                          reconciliation={
                              "matched_speakers": reconciliation["matched_speakers"],
                              "non_speaking_attendees": reconciliation["non_speaking_attendees"],
                              "unregistered_speakers": reconciliation.get("unregistered_speakers", []),
                          })
            jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for speaker labels from user")
            jlog.log(f"[pipeline]   Unknown speakers: {', '.join(u['speaker_id'] for u in unknown)}")

            # Register matched speakers and non-speaking attendees now
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="manual_labeling"
            )
            return  # Exit pipeline — resume via POST /transcribe/label_and_resume
        else:
            # ── Gate 1: Raw Transcript Review ──
            if config.GATE_RAW_REVIEW_ENABLED:
                state.update_active(job_id, "pending_raw_review", 0.95)
                print(f"\n{'═' * 40}")
                print(f"  ⏸️  GATE 1 TRIGGERED — Raw Transcript Review (job={job_id[:8]})")
                print(f"{'═' * 40}")
                jlog.log(f"\n   ⏸️  [PIPELINE] Gate 1 active — pausing for raw transcript review")
                jlog.log(f"[pipeline] ⏸️  Pipeline paused — waiting for user to review/edit transcript")
                # ── Persist reconciled attendee list back to metadata.json ──
                # The original metadata (from upload) only has the pre-labeling
                # attendee list. After labeling, update metadata so downstream
                # consumers (Gate 1 approval, agent runner delivery) get the
                # full attendee list with delivery recipients.
                _update_metadata_with_reconciliation(job_id, metadata, reconciliation, jlog,
                                                    excluded_non_speaking)

                # Register attendees before pausing so the approval panel has access to them
                _register_attendees_after_reconciliation(
                    job_id, metadata, reconciliation, source="manual_labeling"
                )
                return  # Exit pipeline — resume via POST /transcribe/approve_gate1/{job_id}

            state.update_active(job_id, "ready_for_agent", 0.95)

            # ── Persist reconciled attendee list back to metadata.json ──
            _update_metadata_with_reconciliation(job_id, metadata, reconciliation, jlog,
                                                excluded_non_speaking)

            skip = metadata.get("skip_steps")
            jlog.log(f"[pipeline] All speakers known — enqueueing ready_for_processing")

            # Register attendees in ephemeral DB AFTER full reconciliation
            _register_attendees_after_reconciliation(
                job_id, metadata, reconciliation, source="manual_labeling"
            )

            # Persist ML pipeline completion stats
            try:
                total_chars = sum(len(s.get("text", "")) for s in aligned)
                services.ephemeral_memory.upsert_job(job_id, {
                    "transcript_segment_count": len(aligned),
                    "transcript_char_count": total_chars,
                    "audio_duration_sec": aligned[-1]["end"] if aligned else None,
                })
            except Exception as e:
                jlog.log(f"[pipeline] Warning: could not update job record: {e}")

            services.agent_bridge.enqueue_ready(
                job_id, aligned, metadata, skip_steps=skip,
                non_speaking_attendees=non_speaking_names,
            )

    except Exception as e:
        jlog.log(f"\n   ❌ [pipeline] ERROR in resumed job {job_id}: {e}")
        traceback.print_exc()
        # Skip status writes if the job was deleted while the thread was running —
        # writing would recreate the deleted job directory (see _write_status).
        if _job_dir_exists(job_id):
            services.uploader.update_status(job_id, {"status": "failed", "error": str(e)})
            services.agent_bridge.enqueue_failed(job_id, str(e), {})
        else:
            print(f"[pipeline] Job {job_id} was deleted — skipping failure status write")
    finally:
        jlog.close()
        state._pipeline_cancel.discard(job_id)


# ── Late-bind the pipeline runners for pipeline_state (Phase 2) ──
# pipeline_state.start_pipeline_async / start_resumed_pipeline call these via
# `services.<name>`. Bound here, after the defs exist, so there is no import
# cycle and no `__main__` re-execution problem (main.py imports this module at
# the top for the side effect).
services.run_pipeline_async = _run_pipeline_async
services.run_resumed_pipeline_async = _run_resumed_pipeline_async
