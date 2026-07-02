"""
FastAPI application — transcription backend

Endpoints:
  ML Pipeline: /transcribe/upload, /transcribe/status/{id}, /transcribe/transcript/{id}
  Agent-facing: /agent/refine, /agent/summarize, /agent/label_speakers, /agent/deliver
  Memory:       /memory/search, /memory/ephemeral/query, /memory/ephemeral/save, /memory/save_context
"""

import os
import json
import threading
import warnings
from datetime import datetime

# ── speechbrain LazyModule workaround ──
# speechbrain 1.0+ uses lazy imports for optional integrations (k2, flair, etc.).
# When PyTorch Lightning calls inspect.stack() → linecache → getattr(mod, '__file__'),
# the LazyModule.__getattr__ triggers, tries to import the missing dependency, and
# crashes the whole pipeline. We patch LazyModule to avoid triggering on __file__.
# This must run BEFORE importing pyannote.audio.
try:
    import speechbrain.utils.importutils as _sb_utils
    _orig_lazy_getattr = _sb_utils.LazyModule.__getattr__
    def _safe_lazy_getattr(self, attr):
        if attr == "__file__":
            raise AttributeError(attr)
        return _orig_lazy_getattr(self, attr)
    _sb_utils.LazyModule.__getattr__ = _safe_lazy_getattr
except Exception:
    pass  # speechbrain may not be installed yet

# ── pyannote.audio torchaudio compat patch ──
# pyannote.audio uses torchaudio.info(backend=...) and torchaudio.list_audio_backends()
# — both deprecated since torchaudio 2.5+ and scheduled for removal in torchaudio 2.9.
# When removed, pyannote will crash.
#
# Since all pipeline audio is standardized to 16kHz mono WAV, we bypass torchaudio
# entirely for file info and hardcode the backend to "soundfile".
#
# IMPORTANT: torchaudio.list_audio_backends must be patched BEFORE any pyannote
# import, because pyannote.audio.utils.protocol creates Audio(mono="downmix") at
# module level, triggering the deprecated path during import.
import soundfile
import torchaudio as _torchaudio
_torchaudio.list_audio_backends = lambda: ["soundfile"]

try:
    import pyannote.audio.core.io as _pyannote_io

    class _SafeAudioMetaData:
        """Duck-typed replacement for torchaudio.AudioMetaData.
        Avoids the in-place deprecation wrapper on torchaudio's AudioMetaData.__init__."""
        def __init__(self, sample_rate, num_frames, num_channels):
            self.sample_rate = sample_rate
            self.num_frames = num_frames
            self.num_channels = num_channels
            self.bits_per_sample = 0
            self.encoding = "PCM_S"

    def _patched_get_torchaudio_info(file, backend=None):
        sinfo = soundfile.info(file["audio"])
        return _SafeAudioMetaData(sinfo.samplerate, sinfo.frames, sinfo.channels)
    _pyannote_io.get_torchaudio_info = _patched_get_torchaudio_info

    print("[startup] ✅ Patched pyannote.audio → soundfile (avoids torchaudio deprecations)")
except Exception:
    pass  # pyannote may not be installed yet

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from config import config


def _is_network_error(exc: Exception) -> bool:
    """Check if an exception is caused by a network connectivity issue.

    Distinguishes network failures (DNS, timeout, connection refused)
    from genuine model errors (gated model, missing cache). When a
    network error is detected, model loading retries with
    local_files_only=True instead of crashing.
    """
    msg = str(exc).lower()
    err_type = type(exc).__name__.lower()
    for keyword in ("connectionerror", "timeout", "maxretryerror",
                    "nameresolutionerror", "connectionreseterror"):
        if keyword in err_type:
            return True
    for keyword in ("connection refused", "connection reset",
                    "name resolution", "nodename nor servname",
                    "max retries exceeded", "failed to resolve",
                    "connection timeout", "network unreachable",
                    "host unreachable", "temporarily unavailable"):
        if keyword in msg:
            return True
    if isinstance(exc, OSError) and getattr(exc, 'errno', None) in (8, 51, 54, 57, 60, 61, 64, 65, 66):
        return True
    return False



from upload import AudioUploader
from voiceprint import VoiceprintManager
from transcription import TranscriptionEngine, detect_device
from models import (
    RefineRequest, SummarizeRequest, LabelRequest, AnalysisRequest, Deliverable,
    MemorySearchRequest, MemorySearchResult,
    EphemeralMemoryItem, EphemeralMemoryQuery, EphemeralMemoryActionResult,
    SaveMeetingContextRequest, UploadByPathRequest,
)
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

uploader: AudioUploader = None
vp_manager: VoiceprintManager = None
agent_bridge: AgentBridge = None
semantic_memory: SemanticMemory = None
ephemeral_memory: EphemeralMemory = None

# Track running pipeline threads for cancellation
_pipeline_threads: dict[str, threading.Thread] = {}
_pipeline_cancel: set[str] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global uploader, vp_manager, agent_bridge, semantic_memory, ephemeral_memory
    uploader = AudioUploader()
    vp_manager = VoiceprintManager()
    agent_bridge = AgentBridge()
    semantic_memory = SemanticMemory()
    ephemeral_memory = EphemeralMemory()
    os.makedirs(config.STORAGE_PATH, exist_ok=True)
    os.makedirs(config.QUEUE_DIR, exist_ok=True)
    print(f"[startup] Backend on {config.HOST}:{config.PORT} | device={detect_device()}")
    print(f"[startup] Semantic memory: {semantic_memory.persist_dir}")
    print(f"[startup] Ephemeral memory: {ephemeral_memory.db_path}")

    # ── Startup cleanup: reset orphaned pipeline statuses ──
    # Jobs that were mid-pipeline when the process was killed (crash,
    # force-quit, restart) leave stale status.json files behind. The
    # /transcribe/active endpoint reads these from disk and would
    # incorrectly report them as running. Reset any in-flight status
    # to "failed" so the system starts with a clean slate and users
    # aren't blocked by "active jobs" guards.
    ml_inflight_statuses = {
        "uploaded", "initializing", "processing_diarization",
        "matching_voiceprints", "processing_transcription", "aligning",
    }
    cleaned = 0
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir() or entry.name in ("chroma", "logs", "uploads"):
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        try:
            with open(status_path) as f:
                status = json.load(f)
            job_status = status.get("status", "")
            if job_status in ml_inflight_statuses:
                status["status"] = "failed"
                status["error"] = "Processing interrupted by restart — job was in-flight when the backend shut down"
                status["progress"] = 0.0
                status["failed_at"] = datetime.utcnow().isoformat()
                with open(status_path, "w") as f:
                    json.dump(status, f, indent=2)
                job_id = status.get("job_id", entry.name)
                print(f"   🧹 [startup] Reset orphaned job {job_id} ({job_status} → failed)")
                cleaned += 1
        except (json.JSONDecodeError, OSError) as e:
            print(f"   ⚠️  [startup] Could not read status for {entry.name}: {e}")
    if cleaned:
        print(f"   🧹 [startup] Cleaned {cleaned} orphaned job(s)")
    else:
        print(f"   ✅ [startup] No orphaned jobs found")
    yield


app = FastAPI(title="Meeting Transcription Backend", version="1.0.0", lifespan=lifespan)

# Allow cross-origin requests from the Electron renderer (Vite dev server on :5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── ML Pipeline ──

@app.post("/transcribe/upload")
async def upload_audio(
    file: UploadFile = File(...),
    title: str = Form("Untitled Meeting"),
    attendees: str = Form("[]"),
    event_type: str = Form("internal"),
    skip_steps: str = Form(""),
):
    ext = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    temp_dir = os.path.join(config.STORAGE_PATH, "uploads")
    os.makedirs(temp_dir, exist_ok=True)
    temp_path = os.path.join(temp_dir, f"upload_{os.urandom(4).hex()}{ext}")

    content = await file.read()
    with open(temp_path, "wb") as f:
        f.write(content)

    parsed_skip = json.loads(skip_steps) if skip_steps else [
        "transcribe_analyze",
        "transcribe_prepare_delivery",
        "send_delivery_email",
        "save_to_drive",
        "create_trello_action_items",
    ]
    metadata = {
        "title": title,
        "attendees": json.loads(attendees),
        "event_type": event_type,
        "skip_steps": parsed_skip,
    }
    try:
        result = uploader.upload(temp_path, metadata)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    job_id = result["job_id"]
    print(f"[upload] Received file '{file.filename}' ({len(content)} bytes) → job_id={job_id}")
    print(f"[upload] Metadata: title='{title}', attendees={attendees}, event_type='{event_type}'")
    print(f"[upload] skip_steps={parsed_skip}")
    t = threading.Thread(target=_run_pipeline, args=(job_id,), daemon=True)
    _pipeline_threads[job_id] = t
    t.start()
    return {"job_id": job_id, "status": "uploaded"}


@app.post("/transcribe/upload_by_path")
async def upload_audio_by_path(req: UploadByPathRequest):
    """Upload an audio file by local filesystem path.

    Accepts a file path instead of multipart upload. Handles both
    POSIX (macOS/Linux) and Windows paths via os.path.
    """
    file_path = os.path.abspath(os.path.expanduser(req.file_path))

    if not os.path.exists(file_path):
        raise HTTPException(404, f"File not found: {file_path}")
    if not os.path.isfile(file_path):
        raise HTTPException(400, f"Path is not a file: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format: {ext}. Allowed: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}")

    skip_steps = req.skip_steps or [
        "transcribe_analyze",
        "transcribe_prepare_delivery",
        "send_delivery_email",
        "save_to_drive",
        "create_trello_action_items",
    ]
    metadata = {
        "title": req.title,
        "attendees": req.attendees,
        "event_type": req.event_type,
        "skip_steps": skip_steps,
    }
    try:
        result = uploader.upload(file_path, metadata)
    except ValueError as e:
        raise HTTPException(400, str(e))

    job_id = result["job_id"]
    file_size = os.path.getsize(file_path)
    print(f"[upload_by_path] File '{file_path}' ({file_size} bytes) → job_id={job_id}")
    print(f"[upload_by_path] Metadata: title='{req.title}', attendees={req.attendees}")
    t = threading.Thread(target=_run_pipeline, args=(job_id,), daemon=True)
    _pipeline_threads[job_id] = t
    t.start()
    return {"job_id": job_id, "status": "uploaded", "file_path": file_path}


@app.get("/transcribe/status/{job_id}")
async def get_status(job_id: str):
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        print(f"[api] GET /transcribe/status/{job_id} → not_found")
        raise HTTPException(404, "Job not found")
    print(f"[api] GET /transcribe/status/{job_id} → {s['status']} (progress={s.get('progress', '?')})")
    return s


@app.get("/transcribe/active")
async def get_active_jobs():
    """List jobs actively running in the ML pipeline.

    Only returns jobs whose status indicates the ML pipeline thread is
    actively executing (diarization, ASR, alignment). Jobs that have
    moved past the pipeline stage (refined, summarized, analyzed,
    delivered, transcribed) or were never started (labeling_needed)
    are not returned — they're handled by the agent runner separately.
    """
    ml_pipeline_statuses = {
        "uploaded", "initializing", "processing_diarization",
        "matching_voiceprints", "processing_transcription", "aligning",
    }
    active = []
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir():
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        with open(status_path) as f:
            status = json.load(f)
        job_status = status.get("status", "")
        if job_status not in ml_pipeline_statuses:
            continue
        # Load metadata for display
        metadata = {}
        meta_path = os.path.join(entry.path, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                metadata = json.load(f)
        active.append({
            "job_id": status.get("job_id", entry.name),
            "status": job_status,
            "progress": status.get("progress", 0.0),
            "title": metadata.get("title", "Untitled"),
        })
    active.sort(key=lambda j: j.get("progress", 0), reverse=True)
    print(f"[api] GET /transcribe/active → {len(active)} active ML job(s)")
    return {"active_jobs": active}


@app.get("/transcribe/history")
async def get_job_history():
    """List all jobs (including completed/failed) with metadata, newest first."""
    jobs = []
    for entry in os.scandir(config.STORAGE_PATH):
        if not entry.is_dir() or entry.name == "chroma" or entry.name == "logs" or entry.name == "uploads":
            continue
        status_path = os.path.join(entry.path, "status.json")
        if not os.path.exists(status_path):
            continue
        with open(status_path) as f:
            status = json.load(f)
        metadata = {}
        meta_path = os.path.join(entry.path, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                metadata = json.load(f)
        # Get transcript segment count
        transcript_path = os.path.join(entry.path, "transcript.json")
        has_transcript = os.path.exists(transcript_path)
        # Use file mtime as a proxy for recency
        mtime = os.path.getmtime(status_path)
        # Pipeline stage info: capture the final stage snapshot
        pipeline_stage = status.get("status", "unknown")
        pipeline_progress = status.get("progress", 0.0)
        pipeline_error = status.get("error", None)
        jobs.append({
            "job_id": status.get("job_id", entry.name),
            "status": pipeline_stage,
            "progress": pipeline_progress,
            "error": pipeline_error,
            "title": metadata.get("title", "Untitled"),
            "event_type": metadata.get("event_type", ""),
            "attendees": metadata.get("attendees", []),
            "has_transcript": has_transcript,
            "mtime": mtime,
        })
    jobs.sort(key=lambda j: j["mtime"], reverse=True)
    print(f"[api] GET /transcribe/history → {len(jobs)} job(s)")
    return {"jobs": jobs}


@app.get("/transcribe/transcript/{job_id}")
async def get_transcript(job_id: str, format: str = "json"):
    s = uploader.get_status(job_id)
    p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/transcript/{job_id} → not_found")
        raise HTTPException(404, "Transcript not ready")
    with open(p) as f:
        transcript = json.load(f)
    print(f"[api] GET /transcribe/transcript/{job_id} → {len(transcript)} segments (format={format})")
    if format == "text":
        lines = [f"[{s['start']:.1f}s] {s['speaker']}: {s['text']}" for s in transcript]
        return {"text": "\n".join(lines)}
    return {"transcript": transcript}


@app.get("/transcribe/summary/{job_id}")
async def get_summary(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/summary/{job_id} → not_found")
        raise HTTPException(404, "Summary not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/summary/{job_id} → OK")
    return data


# ── Agent-facing endpoints ──

@app.post("/agent/refine")
async def agent_refine(req: RefineRequest):
    print(f"[api] POST /agent/refine job_id={req.job_id} rules={req.rules} keep_timestamps={req.keep_timestamps}")
    # If no transcript was passed in the request (e.g. the LLM tool schema
    # doesn't include it), read the existing stored transcript instead.
    if req.transcript:
        transcript = [s.dict() for s in req.transcript]
    else:
        p = os.path.join(config.STORAGE_PATH, req.job_id, "transcript.json")
        if os.path.exists(p):
            with open(p) as f:
                transcript = json.load(f)
        else:
            transcript = []

    refined = _auto_refine(transcript, req.rules, req.keep_timestamps)

    uploader.save_transcript(req.job_id, refined)
    uploader.update_status(req.job_id, {"status": "refined"})
    print(f"[api] POST /agent/refine → refined {len(refined)} segments " +
          ("" if req.keep_timestamps else "(timestamps stripped, ") +
          f"fillers removed, PII redacted" +
          (f", +{len(req.rules)} custom rule(s)" if req.rules else "") + ")")
    return {"transcript": refined}


@app.post("/agent/summarize")
async def agent_summarize(req: SummarizeRequest):
    print(f"[api] POST /agent/summarize job_id={req.job_id}")
    uploader.save_summary(req.job_id, req.summary)
    uploader.update_status(req.job_id, {"status": "summarized"})
    summary_type = type(req.summary).__name__
    items = len(req.summary.get("action_items", [])) if isinstance(req.summary, dict) else 0
    print(f"[api] POST /agent/summarize → summary saved ({summary_type}, {items} action items)")
    return {"summary": req.summary}


@app.post("/agent/analyze")
async def agent_analyze(req: AnalysisRequest):
    """Store LLM-generated analysis of the transcript.

    The analysis can include:
      - topics: list of topics discussed
      - sentiment: overall sentiment or per-speaker sentiment
      - key_entities: names, dates, amounts mentioned
      - effectiveness: meeting effectiveness score/notes
      - follow_ups: questions or items that need future discussion
    """
    print(f"[api] POST /agent/analyze job_id={req.job_id}")
    uploader.save_analysis(req.job_id, req.analysis)
    uploader.update_status(req.job_id, {"status": "analyzed"})
    topics = req.analysis.get("topics", [])
    print(f"[api] POST /agent/analyze → analysis saved (topics: {len(topics)})")
    return {"analysis": req.analysis}


@app.get("/transcribe/analysis/{job_id}")
async def get_analysis(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "analysis.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/analysis/{job_id} → not_found")
        raise HTTPException(404, "Analysis not ready")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/analysis/{job_id} → OK")
    return data


@app.get("/transcribe/usage/{job_id}")
async def get_token_usage(job_id: str):
    """Return token usage data recorded by the agent runner during LLM processing."""
    p = os.path.join(config.STORAGE_PATH, job_id, "usage.json")
    if not os.path.exists(p):
        print(f"[api] GET /transcribe/usage/{job_id} → not_found")
        raise HTTPException(404, "Token usage not available (job may have been processed before tracking was added)")
    with open(p) as f:
        data = json.load(f)
    print(f"[api] GET /transcribe/usage/{job_id} → OK ({data.get('totals', {}).get('total_tokens', '?')} tokens)")
    return data


@app.post("/agent/label_speakers")
async def agent_label_speakers(req: LabelRequest):
    names = [f"{l.name} ({l.speaker_id})" for l in req.labels]
    print(f"[api] POST /agent/label_speakers job_id={req.job_id} labels={names}")
    for label in req.labels:
        vp_manager.save_voiceprint(label.name, label.email or "", None)

    p = os.path.join(config.STORAGE_PATH, req.job_id, "transcript.json")
    if os.path.exists(p):
        with open(p) as f:
            transcript = json.load(f)
        mapping = {l.speaker_id: l.name for l in req.labels}
        for seg in transcript:
            if seg["speaker"] in mapping:
                seg["speaker"] = mapping[seg["speaker"]]
        uploader.save_transcript(req.job_id, transcript)
        print(f"[api] Applied {len(names)} speaker label(s) to transcript")

    uploader.update_status(req.job_id, {"status": "labeled", "unknown_speakers": []})
    print(f"[api] POST /agent/label_speakers → done")
    return {"success": True, "applied_labels": len(req.labels)}


@app.get("/agent/voiceprints")
async def agent_list_voiceprints():
    vps = vp_manager.list_voiceprints()
    print(f"[api] GET /agent/voiceprints → {len(vps)} enrolled")
    return {"voiceprints": vps}


@app.post("/agent/deliver")
async def agent_deliver(req: Deliverable):
    print(f"[api] POST /agent/deliver job_id={req.job_id} destinations={req.destinations} emails={req.email_recipients}")
    package = {
        "job_id": req.job_id, "title": req.title,
        "attendees": req.attendees, "destinations": req.destinations,
        "email_recipients": req.email_recipients, "status": "ready_for_delivery",
    }
    with open(os.path.join(config.STORAGE_PATH, req.job_id, "delivery.json"), "w") as f:
        json.dump(package, f, indent=2)
    print(f"[api] POST /agent/deliver → delivery.json written")
    return package


# ── Memory Endpoints ──

@app.post("/memory/search")
async def memory_search(req: MemorySearchRequest):
    """Semantic search across past meeting transcripts and summaries."""
    print(f"[api] POST /memory/search query='{req.query}' n_results={req.n_results}")
    try:
        results = semantic_memory.search(req.query, n_results=req.n_results)
        print(f"[api] POST /memory/search → {len(results.get('results', results))} result(s)")
        return {"results": results}
    except Exception as e:
        print(f"[api] POST /memory/search ERROR: {e}")
        raise HTTPException(500, f"Memory search failed: {e}")


@app.post("/memory/ephemeral/save")
async def memory_ephemeral_save(req: EphemeralMemoryItem):
    """Save an item to ephemeral memory (action_items, contacts, budgets, decisions, notes)."""
    print(f"[api] POST /memory/ephemeral/save table={req.table}")
    try:
        table = req.table
        data = req.data
        if table == "action_items":
            items = data.get("items", [])
            ephemeral_memory.save_action_items(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} action items to ephemeral memory")
        elif table == "contacts":
            ephemeral_memory.upsert_contact(
                data.get("name", ""), data.get("email", ""), data.get("org", ""),
                data.get("role", ""), data.get("phone", ""), data.get("meeting", ""),
            )
            print(f"[api] Upserted contact '{data.get('name')}'")
        elif table == "budgets":
            items = data.get("items", [])
            ephemeral_memory.save_budgets(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} budget items")
        elif table == "decisions":
            items = data.get("items", [])
            ephemeral_memory.save_decisions(
                data.get("job_id", ""), items, data.get("meeting_title", "")
            )
            print(f"[api] Saved {len(items)} decisions")
        elif table == "notes":
            ephemeral_memory.save_note(
                data.get("job_id", ""), data.get("topic", ""), data.get("content", "")
            )
            print(f"[api] Saved note topic='{data.get('topic')}'")
        else:
            raise HTTPException(400, f"Unknown table: {table}")
        return {"success": True}
    except Exception as e:
        print(f"[api] POST /memory/ephemeral/save ERROR: {e}")
        raise HTTPException(500, f"Ephemeral memory save failed: {e}")


@app.post("/memory/ephemeral/query")
async def memory_ephemeral_query(req: EphemeralMemoryQuery):
    """Query ephemeral memory by table and optional keyword."""
    print(f"[api] POST /memory/ephemeral/query table={req.table} query='{req.query}' limit={req.limit}")
    try:
        data = ephemeral_memory.query_all(req.table, req.query, req.limit)
        print(f"[api] POST /memory/ephemeral/query → {len(data)} result(s)")
        return {"results": data}
    except Exception as e:
        print(f"[api] POST /memory/ephemeral/query ERROR: {e}")
        raise HTTPException(500, f"Ephemeral memory query failed: {e}")


@app.post("/memory/save_context")
async def memory_save_context(req: SaveMeetingContextRequest):
    """Save full meeting context to both semantic and ephemeral memory at once.
    Called by the agent runner after summarization completes."""
    print(f"[api] POST /memory/save_context job_id={req.job_id} title='{req.title}'")
    try:
        # Semantic memory — searchable vector store
        print(f"[memory] Storing meeting in semantic (ChromaDB)...")
        semantic_memory.store_meeting(
            job_id=req.job_id,
            title=req.title,
            transcript_text=req.transcript_text,
            summary=req.summary,
            metadata={"date": "", "attendees": req.attendees},
        )
        print(f"[memory] Semantic memory stored OK")
        # Ephemeral memory — structured data
        if req.action_items:
            ephemeral_memory.save_action_items(req.job_id, req.action_items, req.title)
            print(f"[memory] Saved {len(req.action_items)} action items to ephemeral memory")
        if req.budgets:
            ephemeral_memory.save_budgets(req.job_id, req.budgets, req.title)
            print(f"[memory] Saved {len(req.budgets)} budget items")
        if req.decisions:
            ephemeral_memory.save_decisions(req.job_id, req.decisions, req.title)
            print(f"[memory] Saved {len(req.decisions)} decisions")
        count = semantic_memory.count()
        print(f"[memory] Save context complete — semantic count: {count}")
        return {"success": True, "semantic_count": count}
    except Exception as e:
        print(f"[api] POST /memory/save_context ERROR: {e}")
        raise HTTPException(500, f"Save context failed: {e}")


@app.get("/transcribe/audio/{job_id}")
async def get_audio(job_id: str):
    """Serve the standardized WAV audio file for playback in the UI."""
    from fastapi.responses import FileResponse
    try:
        audio_path = uploader.get_audio_path(job_id)
        if not os.path.exists(audio_path):
            raise HTTPException(404, "Audio file not found")
        print(f"[api] GET /transcribe/audio/{job_id} → serving {audio_path}")
        return FileResponse(audio_path, media_type="audio/wav", filename=f"{job_id}.wav")
    except FileNotFoundError:
        raise HTTPException(404, "Audio not found for job")
    except Exception as e:
        raise HTTPException(500, f"Failed to serve audio: {e}")


@app.get("/transcribe/job_logs/{job_id}")
async def get_job_logs(job_id: str, max_lines: int = 200):
    """Return job-specific log lines from the global log files filtered by job_id."""
    logs_dir = os.path.join(config.STORAGE_PATH, "logs")
    matched_lines = []
    if os.path.exists(logs_dir):
        for fname in sorted(os.listdir(logs_dir), reverse=True)[:3]:
            fpath = os.path.join(logs_dir, fname)
            if not fname.endswith(".log"):
                continue
            try:
                with open(fpath) as f:
                    for line in f:
                        if job_id in line:
                            matched_lines.append(line.strip())
            except Exception:
                continue
    # Also check the job directory itself for any logs
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    job_logs = []
    if os.path.exists(job_dir):
        for fname in os.listdir(job_dir):
            if fname.endswith(".log") or fname.endswith(".txt"):
                fpath = os.path.join(job_dir, fname)
                try:
                    with open(fpath) as f:
                        content = f.read()
                        job_logs.append({"file": fname, "content": content})
                except Exception:
                    continue
    return {"logs": matched_lines[-max_lines:], "job_logs": job_logs}


@app.get("/transcribe/job_files/{job_id}")
async def get_job_files(job_id: str):
    """List all files in a job's storage directory."""
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    if not os.path.exists(job_dir):
        raise HTTPException(404, "Job directory not found")
    files = []
    for fname in os.listdir(job_dir):
        fpath = os.path.join(job_dir, fname)
        try:
            stat = os.stat(fpath)
            files.append({
                "name": fname,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "type": "json" if fname.endswith(".json") else
                        "audio" if fname.endswith((".wav", ".mp3", ".m4a")) else
                        "text" if fname.endswith(".txt") else "other",
            })
        except Exception:
            continue
    files.sort(key=lambda f: f["name"])
    return {"job_id": job_id, "files": files}


@app.post("/transcribe/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running pipeline job. Always marks the job as failed."""
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    _pipeline_cancel.add(job_id)
    uploader.update_status(job_id, {"status": "failed", "error": "Cancelled by user", "progress": 0.0})
    print(f"[api] POST /transcribe/cancel/{job_id} → cancelled")
    return {"job_id": job_id, "status": "cancelled", "cancelled": True}


# ── Job Deletion ──

import shutil

@app.delete("/transcribe/job/{job_id}")
async def delete_job(job_id: str):
    """Delete a job and all its associated data from storage."""
    job_dir = os.path.join(config.STORAGE_PATH, job_id)
    if not os.path.exists(job_dir):
        print(f"[api] DELETE /transcribe/job/{job_id} → not_found")
        raise HTTPException(404, "Job not found")

    # Ensure it's a real job directory (has status.json)
    if not os.path.exists(os.path.join(job_dir, "status.json")):
        print(f"[api] DELETE /transcribe/job/{job_id} → not a valid job directory")
        raise HTTPException(400, "Not a valid job directory")

    # Cancel if running
    _pipeline_cancel.add(job_id)
    _pipeline_threads.pop(job_id, None)

    try:
        shutil.rmtree(job_dir)
        print(f"[api] DELETE /transcribe/job/{job_id} → deleted")
        return {"job_id": job_id, "deleted": True}
    except Exception as e:
        print(f"[api] DELETE /transcribe/job/{job_id} → error: {e}")
        raise HTTPException(500, f"Failed to delete job: {e}")


# ── Log Deletion ──

def _log_file_has_errors(fpath):
    """Check if a log file contains any error events.

    Handles both formats:
      - JSONL (.jsonl): contains "eventType":"failed" or "level":"error"
      - Plain-text (.log): contains [error] or [ERROR]
    """
    try:
        with open(fpath) as f:
            content = f.read()
        if fpath.endswith(".jsonl"):
            return '"eventType":"failed"' in content or '"level":"error"' in content
        else:
            # Plain-text log format: [timestamp] [source] [level] message
            return "[error]" in content or "[ERROR]" in content
    except Exception:
        return False


@app.delete("/storage/logs")
async def delete_logs(log_type: str = "all"):
    """Delete log files from project logs/ and Electron userData logs/ directories.

    Cleans:
      - logs/ — legacy JSONL log files in the project root
      - userData/logs/ — agent runner JSONL + Electron .log files (if configured)

    Query params:
      log_type: "all"                  — delete all files EXCEPT those containing error events
      log_type: "all_including_errors" — delete ALL files (including error files)
      log_type: "error"                — delete only files containing error events
    """
    deleted = 0
    errors = 0

    # Directories to clean: project root logs/ (legacy) + Electron userData logs/
    log_dirs = [
        os.path.join(config._BASE, "logs"),  # logs/*.jsonl (legacy — may be empty after migration)
    ]
    if config.ELECTRON_LOGS_DIR:
        log_dirs.append(config.ELECTRON_LOGS_DIR)  # userData/logs/ — agent JSONL + Electron .log

    for logs_path in log_dirs:
        if not os.path.exists(logs_path):
            continue

        for fname in os.listdir(logs_path):
            if not (fname.endswith(".jsonl") or fname.endswith(".log")):
                continue
            fpath = os.path.join(logs_path, fname)

            # Determine whether this file should be deleted
            if log_type == "error":
                # Delete only files that contain error events
                if not _log_file_has_errors(fpath):
                    continue
            elif log_type == "all":
                # Delete all files EXCEPT those containing error events
                if _log_file_has_errors(fpath):
                    continue
            # else log_type == "all_including_errors": delete everything, no filter

            try:
                os.remove(fpath)
                deleted += 1
                print(f"[api] DELETE /storage/logs → removed {fname} from {logs_path.split('/')[-2]}")
            except Exception as e:
                errors += 1
                print(f"[api] DELETE /storage/logs → failed to remove {fname}: {e}")

    if deleted == 0 and errors == 0:
        return {"deleted": 0, "errors": 0, "log_type": log_type, "message": "No log files found"}


    return {
        "deleted": deleted,
        "errors": errors,
        "log_type": log_type,
        "message": f"Deleted {deleted} log file(s)" + (f" ({errors} error(s))" if errors else ""),
    }


@app.get("/transcribe/models/status")
async def models_status():
    """Check which ML models are available. Helps users diagnose setup issues."""
    result = {
        "device": detect_device(),
        "whisper_model": config.WHISPER_MODEL_SIZE,
        "diarization_model": config.DIARIZATION_MODEL,
        "diarization_available": False,
        "diarization_error": None,
        "diarization_traceback": None,
        "hf_token_configured": bool(config.HUGGING_FACE_TOKEN),
    }

    # Try to verify diarization model is loadable
    try:
        from pyannote.audio import Pipeline
        import torch
        hf_token = config.HUGGING_FACE_TOKEN
        if not hf_token:
            result["diarization_error"] = (
                "No HUGGING_FACE_TOKEN set. "
                f"Get a token at https://hf.co/settings/tokens and accept the model terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL}"
            )
        else:
            # PyTorch 2.6+ needs relaxed loading for pyannote pickle models
            import torch as _torch
            _orig_load = _torch.load
            try:
                # Force weights_only=False — lightning_fabric (used by
                # pyannote) explicitly passes weights_only=True, so setdefault
                # is not enough.
                def _permissive_load(f, *a, **kw):
                    kw["weights_only"] = False
                    return _orig_load(f, *a, **kw)
                _torch.load = _permissive_load

                # Try online first so pyannote can check for model updates.
                # Falls back to local cache on network errors (DNS, timeout, etc.).
                try:
                    pipeline = Pipeline.from_pretrained(
                        config.DIARIZATION_MODEL, use_auth_token=hf_token,
                    )
                except Exception as _hub_err:
                    if _is_network_error(_hub_err):
                        print(f"[models_status] ⚠️  HuggingFace unreachable ({_hub_err}). "
                              f"Falling back to local cache...")
                        pipeline = Pipeline.from_pretrained(
                            config.DIARIZATION_MODEL, use_auth_token=hf_token,
                            local_files_only=True,
                        )
                    else:
                        raise
                if pipeline is None:
                    result["diarization_error"] = (
                        f"Model '{config.DIARIZATION_MODEL}' returned None — "
                        f"it may be gated. Accept terms at "
                        f"https://hf.co/{config.DIARIZATION_MODEL}"
                    )
                else:
                    pipeline.to(_torch.device("cpu"))
                    result["diarization_available"] = True
                    del pipeline
            finally:
                _torch.load = _orig_load
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        result["diarization_traceback"] = tb
        msg = str(e)
        if "gated" in msg.lower() or "access" in msg.lower() or "token" in msg.lower():
            result["diarization_error"] = (
                "Model is gated — accept terms at "
                f"https://hf.co/{config.DIARIZATION_MODEL} and set HUGGING_FACE_TOKEN"
            )
        elif "module" in msg.lower() and "torchaudio" in msg.lower():
            result["diarization_error"] = (
                f"PyTorch/torchaudio compatibility issue: {msg[:200]}. "
                f"Try reinstalling pyannote.audio: pip install --upgrade pyannote.audio"
            )
        else:
            result["diarization_error"] = f"Model failed to load: {msg[:300]}"

    status_icon = "✅" if result["diarization_available"] else "❌"
    print(f"[api] GET /transcribe/models/status → diarization={status_icon} device={result['device']}")
    if result["diarization_error"]:
        print(f"[api]   diarization_error: {result['diarization_error'][:200]}")
    return result


@app.get("/health")
async def health():
    print(f"[api] GET /health")
    return {"status": "ok", "device": detect_device()}


# ── Storage Usage ──

def _dir_size(path: str) -> int:
    """Recursively compute total size (bytes) of a directory."""
    total = 0
    try:
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
            elif entry.is_dir(follow_symlinks=False):
                total += _dir_size(entry.path)
    except OSError:
        pass
    return total


def _format_bytes(b: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


@app.get("/storage/usage")
async def storage_usage():
    """Report disk usage breakdown: logs, history (job storage), system files, ChromaDB, Ollama models."""
    base = config._BASE  # project root
    storage_path = config.STORAGE_PATH

    # Logs — storage/logs/ mirror + Electron userData logs (if configured)
    logs_dir = os.path.join(storage_path, "logs")
    logs_size = _dir_size(logs_dir) if os.path.exists(logs_dir) else 0
    if config.ELECTRON_LOGS_DIR and os.path.exists(config.ELECTRON_LOGS_DIR):
        logs_size += _dir_size(config.ELECTRON_LOGS_DIR)

    # ChromaDB vector store
    chroma_dir = os.path.join(storage_path, "chroma")
    chroma_size = _dir_size(chroma_dir) if os.path.exists(chroma_dir) else 0

    # History — all job directories in storage/ (exclude logs, chroma, uploads)
    history_size = 0
    job_count = 0
    if os.path.exists(storage_path):
        for entry in os.scandir(storage_path):
            if not entry.is_dir():
                continue
            name = entry.name
            if name in ("logs", "chroma", "uploads", ".model_cache", "chroma_old"):
                continue
            # Check if it has a status.json (i.e. it's a job directory)
            if os.path.exists(os.path.join(entry.path, "status.json")):
                job_count += 1
            history_size += _dir_size(entry.path)

    # System — project source code (python-backend, agent-runner, bridge-server, electron, agent-config)
    system_dirs = ["python-backend", "agent-runner", "bridge-server", "electron", "agent-config"]
    system_size = 0
    for d in system_dirs:
        p = os.path.join(base, d)
        if os.path.exists(p):
            system_size += _dir_size(p)

    # Also include other root-level files (package.json, scripts, etc.)
    root_files_size = 0
    if os.path.exists(base):
        for entry in os.scandir(base):
            if entry.is_file(follow_symlinks=False):
                try:
                    root_files_size += entry.stat().st_size
                except OSError:
                    pass

    system_size += root_files_size

    # Databases — ephemeral memory + voiceprint SQLite files at root of storage/
    db_files = ["ephemeral_memory.db", "voiceprints.db"]
    databases_size = 0
    for fname in db_files:
        fpath = os.path.join(storage_path, fname)
        if os.path.isfile(fpath):
            try:
                databases_size += os.path.getsize(fpath)
            except OSError:
                pass

    # Ollama models — ~/.ollama directory (downloaded LLM models)
    ollama_dir = os.path.expanduser("~/.ollama")
    ollama_size = _dir_size(ollama_dir) if os.path.exists(ollama_dir) else 0

    total = logs_size + history_size + system_size + chroma_size + databases_size + ollama_size

    # File paths for each category
    storage_paths = {
        "history": storage_path,
        "logs": os.path.join(storage_path, "logs") if os.path.exists(os.path.join(storage_path, "logs")) else (config.ELECTRON_LOGS_DIR or None),
        "chroma": os.path.join(storage_path, "chroma") if os.path.exists(os.path.join(storage_path, "chroma")) else None,
        "databases": storage_path,
        "system": base,
        "ollama": ollama_dir if os.path.exists(ollama_dir) else None,
    }

    return {
        "logs": {"bytes": logs_size, "human": _format_bytes(logs_size), "path": storage_paths["logs"]},
        "history": {"bytes": history_size, "human": _format_bytes(history_size), "job_count": job_count, "path": storage_paths["history"]},
        "chroma": {"bytes": chroma_size, "human": _format_bytes(chroma_size), "path": storage_paths["chroma"]},
        "databases": {"bytes": databases_size, "human": _format_bytes(databases_size), "path": storage_paths["databases"]},
        "system": {"bytes": system_size, "human": _format_bytes(system_size), "path": storage_paths["system"]},
        "ollama": {"bytes": ollama_size, "human": _format_bytes(ollama_size), "path": storage_paths["ollama"]},
        "total": {"bytes": total, "human": _format_bytes(total)},
    }


# ── Database browsing (for DevPanel) ──

EPHEMERAL_TABLES = {
    "action_items": {"label": "Action Items", "columns": ["id", "job_id", "description", "assignee", "deadline", "status", "priority", "source_meeting", "created_at"]},
    "contacts": {"label": "Contacts", "columns": ["id", "name", "email", "organization", "role", "phone", "source_meeting", "first_mentioned", "last_mentioned"]},
    "budgets": {"label": "Budgets", "columns": ["id", "job_id", "description", "amount", "currency", "category", "source_meeting", "created_at"]},
    "decisions": {"label": "Decisions", "columns": ["id", "job_id", "description", "rationale", "made_by", "source_meeting", "created_at"]},
    "notes": {"label": "Notes", "columns": ["id", "job_id", "topic", "content", "created_at"]},
}


@app.get("/memory/ephemeral/tables")
async def memory_ephemeral_tables():
    """List all ephemeral memory tables with row counts (read-only, for DevPanel)."""
    print(f"[api] GET /memory/ephemeral/tables")
    try:
        # Get row counts for each table — use a large limit to get all rows
        table_list = []
        for name, info in EPHEMERAL_TABLES.items():
            rows = ephemeral_memory.query_all(name, "", 100000)
            table_list.append({
                "name": name,
                "label": info["label"],
                "columns": info["columns"],
                "row_count": len(rows),
            })
        return {"tables": table_list}
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/tables ERROR: {e}")
        raise HTTPException(500, f"Failed to list tables: {e}")


@app.get("/memory/ephemeral/table/{table_name}")
async def memory_ephemeral_table(table_name: str, limit: int = 100, offset: int = 0):
    """Get rows from an ephemeral memory table (read-only, for DevPanel)."""
    print(f"[api] GET /memory/ephemeral/table/{table_name} limit={limit} offset={offset}")
    if table_name not in EPHEMERAL_TABLES:
        raise HTTPException(404, f"Unknown table: {table_name}")

    try:
        all_rows = ephemeral_memory.query_all(table_name, "", limit + offset)
        total = len(all_rows)
        rows = all_rows[offset:offset + limit]
        return {
            "table": table_name,
            "columns": EPHEMERAL_TABLES[table_name]["columns"],
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    except Exception as e:
        print(f"[api] GET /memory/ephemeral/table/{table_name} ERROR: {e}")
        raise HTTPException(500, f"Failed to query table: {e}")


@app.get("/memory/semantic/meetings")
async def memory_semantic_meetings():
    """List meetings stored in ChromaDB semantic memory (read-only, for DevPanel)."""
    print(f"[api] GET /memory/semantic/meetings")
    try:
        # Get all data from the collection
        semantic_memory._ensure_loaded()
        coll = semantic_memory._collection
        all_data = coll.get(include=["metadatas"])
        meetings = []
        seen = set()
        if all_data and all_data["ids"]:
            for i in range(len(all_data["ids"])):
                meta = all_data["metadatas"][i] if all_data.get("metadatas") else {}
                job_id = meta.get("job_id", "")
                # Deduplicate by job_id (each meeting has 2 chunks: summary + transcript)
                if job_id and job_id not in seen:
                    seen.add(job_id)
                    meetings.append({
                        "id": all_data["ids"][i],
                        "job_id": job_id,
                        "title": meta.get("title", "Unknown"),
                        "type": meta.get("type", "unknown"),
                        "attendees": meta.get("attendees", ""),
                        "timestamp": meta.get("timestamp", ""),
                    })
        return {"meetings": meetings, "total": len(meetings)}
    except Exception as e:
        print(f"[api] GET /memory/semantic/meetings ERROR: {e}")
        raise HTTPException(500, f"Failed to list meetings: {e}")


# ── Internal pipeline ──

def _check_cancelled(job_id: str) -> bool:
    """Check if this job has been cancelled. Returns True if cancelled."""
    if job_id in _pipeline_cancel:
        print(f"\n   🛑 [pipeline] Job {job_id} cancelled — stopping.")
        _pipeline_cancel.discard(job_id)
        _pipeline_threads.pop(job_id, None)
        return True
    return False


def _run_pipeline(job_id: str):
    print(f"\n{'='*60}")
    print(f"   🎬 [PIPELINE] Starting pipeline for job {job_id}")
    print(f"{'='*60}")
    try:
        uploader.update_status(job_id, {"status": "initializing", "progress": 0.05})
        engine = TranscriptionEngine()
        metadata = uploader.get_metadata(job_id)
        audio_path = uploader.get_audio_path(job_id)
        print(f"[pipeline] Audio path: {audio_path}")
        print(f"[pipeline] Metadata: title='{metadata.get('title')}', attendees={metadata.get('attendees')}")

        # ── Step 1: Diarization ──
        print(f"\n   🔬 [PIPELINE] Step 1/5: Diarization (identifying speakers)...")
        uploader.update_status(job_id, {"status": "processing_diarization", "progress": 0.2})
        if _check_cancelled(job_id): return
        diarization = engine.run_diarization(audio_path)
        speakers_found = set(s["speaker"] for s in diarization)
        print(f"   ✅ [pipeline] Diarization complete: {len(diarization)} segments, {len(speakers_found)} speakers: {', '.join(sorted(speakers_found))}")

        # Group by speaker
        from types import SimpleNamespace
        speaker_segments = {}
        for seg in diarization:
            spk = seg["speaker"]
            speaker_segments.setdefault(spk, []).append(SimpleNamespace(**seg))

        # ── Step 2: Voiceprint matching ──
        print(f"\n   🧬 [PIPELINE] Step 2/5: Voiceprint matching...")
        uploader.update_status(job_id, {"status": "matching_voiceprints", "progress": 0.35})
        if _check_cancelled(job_id): return
        attendees = metadata.get("attendees", [])
        if attendees:
            print(f"[pipeline] Matching against {len(attendees)} known attendees: {attendees}")
            match_result = vp_manager.match_against_attendees(
                audio_path, speaker_segments, attendees
            )
        else:
            print(f"[pipeline] No known attendees — all speakers will be unknown")
            match_result = {"known": {}, "unknown": [
                {
                    "speaker_id": spk,
                    "segments": [{"start": s.start, "end": s.end, "duration": s.duration, "speaker": s.speaker} for s in segs],
                    "sample_segment": {"start": segs[0].start, "end": segs[0].end},
                }
                for spk, segs in speaker_segments.items()
            ]}
        print(f"[pipeline] Voiceprint result: {len(match_result['known'])} known, {len(match_result.get('unknown', []))} unknown")
        if match_result['known']:
            print(f"[pipeline] Matched speakers: {list(match_result['known'].keys())}")

        # ── Step 3: ASR Transcription ──
        print(f"\n   🎤 [PIPELINE] Step 3/5: ASR transcription (Whisper)...")
        uploader.update_status(job_id, {"status": "processing_transcription", "progress": 0.5})
        if _check_cancelled(job_id): return
        transcription = engine.run_transcription(audio_path)
        print(f"   ✅ [pipeline] ASR complete: {len(transcription.get('words', []))} words, {len(transcription.get('segments', []))} segments")

        # ── Step 4: Alignment ──
        print(f"\n   🔗 [PIPELINE] Step 4/5: Aligning diarization with transcript...")
        uploader.update_status(job_id, {"status": "aligning", "progress": 0.7})
        if _check_cancelled(job_id): return
        aligned = engine.align_transcript(transcription, diarization)
        print(f"   ✅ [pipeline] Alignment complete: {len(aligned)} transcript segments")

        # Apply known speaker labels
        label_count = 0
        for seg in aligned:
            for name, segs in match_result["known"].items():
                for s in segs:
                    if abs(seg["start"] - s.start) < 0.5:
                        seg["speaker"] = name
                        label_count += 1
                        break
        if label_count:
            print(f"[pipeline] Applied {label_count} speaker label(s) from voiceprint matching")

        uploader.save_transcript(job_id, aligned)
        uploader.save_transcript_text(job_id, aligned)
        uploader.update_status(job_id, {"status": "transcribed", "progress": 0.85})

        # ── Step 5: Enqueue for agent ──
        print(f"\n   📨 [PIPELINE] Step 5/5: Enqueueing for agent runner...")
        if _check_cancelled(job_id): return
        unknown = match_result.get("unknown", [])
        if unknown:
            # Normalize sample_segment to dict in case it came from match_against_attendees
            # (which returns dicts) vs the fallback path (which previously used SimpleNamespace)
            for u in unknown:
                if hasattr(u["sample_segment"], "start"):
                    u["sample_segment"] = {"start": u["sample_segment"].start, "end": u["sample_segment"].end}
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"]["start"]) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            uploader.update_status(job_id, {"status": "labeling_needed", "progress": 0.9, "unknown_speakers": unknown})
            print(f"[pipeline] {len(unknown)} unknown speaker(s) — enqueueing labeling_needed")
            agent_bridge.enqueue_labeling_needed(job_id, unknown, aligned, metadata)
        else:
            uploader.update_status(job_id, {"status": "ready_for_agent", "progress": 0.95})
            skip = metadata.get("skip_steps")
            print(f"[pipeline] All speakers known — enqueueing ready_for_processing (skip_steps={skip})")
            agent_bridge.enqueue_ready(job_id, aligned, metadata, skip_steps=skip)

        print(f"\n{'='*60}")
        print(f"   ✅ [PIPELINE] Pipeline complete for job {job_id}")
        print(f"{'='*60}\n")

    except Exception as e:
        print(f"\n   ❌ [pipeline] ERROR in job {job_id}: {e}")
        import traceback
        traceback.print_exc()
        uploader.update_status(job_id, {"status": "failed", "error": str(e)})
        agent_bridge.enqueue_failed(job_id, str(e), {})
    finally:
        _pipeline_threads.pop(job_id, None)
        _pipeline_cancel.discard(job_id)


import re

# ── Filler words / discourse markers to strip from transcript text ──
# These are common hesitation sounds and speech artifacts. Each pattern
# consumes trailing punctuation and whitespace so that "um, like," becomes
# just "," after removal rather than leaving orphans like " ,".
_FILLER_PATTERNS = [
    r'\bum+\b[\s,.]*',
    r'\buh+\b[\s,.]*',
    r'\bah+\b[\s,.]*',
    r'\bhmm+\b[\s,.]*',
    r'\bmm[- ]hmm+\b[\s,.]*',
    r'\buh[- ]huh+\b[\s,.]*',
    r'\bah[- ]hah?\b[\s,.]*',
    r'\buh[- ]oh\b[\s,.]*',
    r'\byou know\b[\s,.]*',
    r'\bi mean\b[\s,.]*',
    r'\byou see\b[\s,.]*',
    r'\blike\b(?!\s+to\b)[\s,.]*',           # "like" as filler, not "like to"
    r'\bkind of\b[\s,.]*',
    r'\bsort of\b[\s,.]*',
    r'\bso basically\b[\s,.]*',
    r'\bbasically\b[\s,.]*',
    r'\bactually\b[\s,.]*',
    r'\bobviously\b[\s,.]*',
    r'\bright\b[\s,.]*',
    r'\bokay\b[\s,.]*',
    r'\balright\b(?!\s+so\b)[\s,.]*',
]


def _auto_refine(segments: list[dict], custom_rules: list[str], keep_timestamps: bool = False) -> list[dict]:
    """Apply automatic transcript refinement to every segment.

    For each segment:
      1. Strip timestamp metadata (``start``, ``end``, ``duration`` keys) — unless ``keep_timestamps`` is True.
      2. Strip filler words and discourse markers from the text.
      3. Redact PII (emails, phones, SSN, credit cards, account numbers).
      4. Apply any additional custom redaction rules passed by the LLM.
      5. Collapse multiple spaces and trim.

    Returns a new list of refined segment dicts (the original is not mutated).
    """
    fillers_re = re.compile('|'.join(_FILLER_PATTERNS), re.IGNORECASE)
    refined = []
    for seg in segments:
        if keep_timestamps:
            # Preserve all original fields (speaker, text, start, end, duration)
            clean = dict(seg)
        else:
            # 1. Strip timestamp metadata — keep only speaker label + cleaned text
            clean = {"speaker": seg.get("speaker", "Unknown")}
        text = seg.get("text", "")

        # 2. Strip filler words
        text = fillers_re.sub('', text)

        # 3. Clean up punctuation orphans left by filler removal
        #    e.g. "um, like," → after removing fillers → " , ," → clean → ""
        text = re.sub(r'\s+[,.;:!?]+', ',', text)   # ", word" → ", word"
        text = re.sub(r'[,.;:!?]+(?!\S)', '', text)  # trailing punctuation cleanup
        text = re.sub(r'\s+', ' ', text)             # collapse spaces

        # 4. Redact PII automatically
        text = _redact_pii(text)

        # 5. Apply any custom LLM-provided redaction rules
        for rule in custom_rules:
            text = _redact_custom(text, rule)

        # 6. Final whitespace collapse and trim
        text = re.sub(r'\s+', ' ', text).strip()

        clean["text"] = text
        refined.append(clean)

    return refined


def _redact_pii(text: str) -> str:
    """Automatically redact common PII patterns from text."""
    # Email addresses
    text = re.sub(r'[\w.+-]+@[\w.-]+\.\w{2,}', '[EMAIL REDACTED]', text)
    # Phone numbers (various formats)
    text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    # SSN-like patterns (###-##-####)
    text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN REDACTED]', text)
    # Credit-card-like patterns (####-####-####-#### or ################)
    text = re.sub(r'\b(?:\d{4}[-\s]?){3}\d{4}\b', '[CARD REDACTED]', text)
    text = re.sub(r'\b\d{16}\b', '[CARD REDACTED]', text)
    # Long digit sequences (account numbers / banking)
    text = re.sub(r'\b\d{8,}\b', '[ACCOUNT REDACTED]', text)
    return text


def _redact_custom(text: str, rule: str) -> str:
    """Apply a single LLM-provided custom redaction rule."""
    rule_lower = rule.lower()
    if "account" in rule_lower or "banking" in rule_lower:
        text = re.sub(r'\b\d{4,}\b', '[REDACTED]', text)
    if "email" in rule_lower or "phone" in rule_lower or "contact" in rule_lower:
        text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL REDACTED]', text)
        text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    if "name" in rule_lower or "person" in rule_lower:
        text = re.sub(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', '[NAME REDACTED]', text)
    return text


def _redact(text: str, rule: str) -> str:
    """Legacy single-rule redaction (kept for backward compatibility)."""
    return _redact_custom(text, rule)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
