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
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from contextlib import asynccontextmanager

from config import config
from upload import AudioUploader
from voiceprint import VoiceprintManager
from transcription import TranscriptionEngine, detect_device
from models import (
    RefineRequest, SummarizeRequest, LabelRequest, Deliverable,
    MemorySearchRequest, MemorySearchResult,
    EphemeralMemoryItem, EphemeralMemoryQuery, EphemeralMemoryActionResult,
    SaveMeetingContextRequest,
)
from agent_bridge import AgentBridge
from semantic_memory import SemanticMemory
from ephemeral_memory import EphemeralMemory

uploader: AudioUploader = None
vp_manager: VoiceprintManager = None
agent_bridge: AgentBridge = None
semantic_memory: SemanticMemory = None
ephemeral_memory: EphemeralMemory = None


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
    yield


app = FastAPI(title="Meeting Transcription Backend", version="1.0.0", lifespan=lifespan)


# ── ML Pipeline ──

@app.post("/transcribe/upload")
async def upload_audio(
    file: UploadFile = File(...),
    title: str = Form("Untitled Meeting"),
    attendees: str = Form("[]"),
    event_type: str = Form("internal"),
):
    ext = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    temp_dir = os.path.join(config.STORAGE_PATH, "uploads")
    os.makedirs(temp_dir, exist_ok=True)
    temp_path = os.path.join(temp_dir, f"upload_{os.urandom(4).hex()}{ext}")

    content = await file.read()
    with open(temp_path, "wb") as f:
        f.write(content)

    metadata = {"title": title, "attendees": json.loads(attendees), "event_type": event_type}
    try:
        result = uploader.upload(temp_path, metadata)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    threading.Thread(target=_run_pipeline, args=(result["job_id"],), daemon=True).start()
    return {"job_id": result["job_id"], "status": "uploaded"}


@app.get("/transcribe/status/{job_id}")
async def get_status(job_id: str):
    s = uploader.get_status(job_id)
    if s["status"] == "not_found":
        raise HTTPException(404, "Job not found")
    return s


@app.get("/transcribe/transcript/{job_id}")
async def get_transcript(job_id: str, format: str = "json"):
    s = uploader.get_status(job_id)
    p = os.path.join(config.STORAGE_PATH, job_id, "transcript.json")
    if not os.path.exists(p):
        raise HTTPException(404, "Transcript not ready")
    with open(p) as f:
        transcript = json.load(f)
    if format == "text":
        lines = [f"[{s['start']:.1f}s] {s['speaker']}: {s['text']}" for s in transcript]
        return {"text": "\n".join(lines)}
    return {"transcript": transcript}


@app.get("/transcribe/summary/{job_id}")
async def get_summary(job_id: str):
    p = os.path.join(config.STORAGE_PATH, job_id, "summary.json")
    if not os.path.exists(p):
        raise HTTPException(404, "Summary not ready")
    with open(p) as f:
        return json.load(f)


# ── Agent-facing endpoints ──

@app.post("/agent/refine")
async def agent_refine(req: RefineRequest):
    transcript = [s.dict() for s in req.transcript]
    refined = []
    for seg in transcript:
        text = seg["text"]
        for rule in req.rules:
            text = _redact(text, rule)
        refined.append({**seg, "text": text})
    uploader.save_transcript(req.job_id, refined)
    uploader.update_status(req.job_id, {"status": "refined"})
    return {"transcript": refined}


@app.post("/agent/summarize")
async def agent_summarize(req: SummarizeRequest):
    uploader.save_summary(req.job_id, req.summary)
    uploader.update_status(req.job_id, {"status": "summarized"})
    return {"summary": req.summary}


@app.post("/agent/label_speakers")
async def agent_label_speakers(req: LabelRequest):
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

    uploader.update_status(req.job_id, {"status": "labeled", "unknown_speakers": []})
    return {"success": True, "applied_labels": len(req.labels)}


@app.get("/agent/voiceprints")
async def agent_list_voiceprints():
    return {"voiceprints": vp_manager.list_voiceprints()}


@app.post("/agent/deliver")
async def agent_deliver(req: Deliverable):
    package = {
        "job_id": req.job_id, "title": req.title,
        "attendees": req.attendees, "destinations": req.destinations,
        "email_recipients": req.email_recipients, "status": "ready_for_delivery",
    }
    with open(os.path.join(config.STORAGE_PATH, req.job_id, "delivery.json"), "w") as f:
        json.dump(package, f, indent=2)
    return package


# ── Memory Endpoints ──

@app.post("/memory/search")
async def memory_search(req: MemorySearchRequest):
    """Semantic search across past meeting transcripts and summaries."""
    try:
        results = semantic_memory.search(req.query, n_results=req.n_results)
        return {"results": results}
    except Exception as e:
        raise HTTPException(500, f"Memory search failed: {e}")


@app.post("/memory/ephemeral/save")
async def memory_ephemeral_save(req: EphemeralMemoryItem):
    """Save an item to ephemeral memory (action_items, contacts, budgets, decisions, notes)."""
    try:
        table = req.table
        data = req.data
        if table == "action_items":
            ephemeral_memory.save_action_items(
                data.get("job_id", ""), data.get("items", []), data.get("meeting_title", "")
            )
        elif table == "contacts":
            ephemeral_memory.upsert_contact(
                data.get("name", ""), data.get("email", ""), data.get("org", ""),
                data.get("role", ""), data.get("phone", ""), data.get("meeting", ""),
            )
        elif table == "budgets":
            ephemeral_memory.save_budgets(
                data.get("job_id", ""), data.get("items", []), data.get("meeting_title", "")
            )
        elif table == "decisions":
            ephemeral_memory.save_decisions(
                data.get("job_id", ""), data.get("items", []), data.get("meeting_title", "")
            )
        elif table == "notes":
            ephemeral_memory.save_note(
                data.get("job_id", ""), data.get("topic", ""), data.get("content", "")
            )
        else:
            raise HTTPException(400, f"Unknown table: {table}")
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, f"Ephemeral memory save failed: {e}")


@app.post("/memory/ephemeral/query")
async def memory_ephemeral_query(req: EphemeralMemoryQuery):
    """Query ephemeral memory by table and optional keyword."""
    try:
        data = ephemeral_memory.query_all(req.table, req.query, req.limit)
        return {"results": data}
    except Exception as e:
        raise HTTPException(500, f"Ephemeral memory query failed: {e}")


@app.post("/memory/save_context")
async def memory_save_context(req: SaveMeetingContextRequest):
    """Save full meeting context to both semantic and ephemeral memory at once.
    Called by the agent runner after summarization completes."""
    try:
        # Semantic memory — searchable vector store
        semantic_memory.store_meeting(
            job_id=req.job_id,
            title=req.title,
            transcript_text=req.transcript_text,
            summary=req.summary,
            metadata={"date": "", "attendees": req.attendees},
        )
        # Ephemeral memory — structured data
        if req.action_items:
            ephemeral_memory.save_action_items(req.job_id, req.action_items, req.title)
        if req.budgets:
            ephemeral_memory.save_budgets(req.job_id, req.budgets, req.title)
        if req.decisions:
            ephemeral_memory.save_decisions(req.job_id, req.decisions, req.title)
        return {"success": True, "semantic_count": semantic_memory.count()}
    except Exception as e:
        raise HTTPException(500, f"Save context failed: {e}")


@app.get("/health")
async def health():
    return {"status": "ok", "device": detect_device()}


# ── Internal pipeline ──

def _run_pipeline(job_id: str):
    try:
        uploader.update_status(job_id, {"status": "initializing", "progress": 0.05})
        engine = TranscriptionEngine()
        metadata = uploader.get_metadata(job_id)
        audio_path = uploader.get_audio_path(job_id)

        uploader.update_status(job_id, {"status": "processing_diarization", "progress": 0.2})
        diarization = engine.run_diarization(audio_path)

        # Group by speaker
        from types import SimpleNamespace
        speaker_segments = {}
        for seg in diarization:
            spk = seg["speaker"]
            speaker_segments.setdefault(spk, []).append(SimpleNamespace(**seg))

        # Voiceprint matching
        uploader.update_status(job_id, {"status": "matching_voiceprints", "progress": 0.35})
        attendees = metadata.get("attendees", [])
        match_result = vp_manager.match_against_attendees(
            audio_path, speaker_segments, attendees
        ) if attendees else {"known": {}, "unknown": [
            {"speaker_id": spk, "segments": segs, "sample_segment": segs[0]}
            for spk, segs in speaker_segments.items()
        ]}

        uploader.update_status(job_id, {"status": "processing_transcription", "progress": 0.5})
        transcription = engine.run_transcription(audio_path)

        uploader.update_status(job_id, {"status": "aligning", "progress": 0.7})
        aligned = engine.align_transcript(transcription, diarization)

        # Apply known speaker labels
        for seg in aligned:
            for name, segs in match_result["known"].items():
                for s in segs:
                    if abs(seg["start"] - s.start) < 0.5:
                        seg["speaker"] = name

        uploader.save_transcript(job_id, aligned)
        uploader.update_status(job_id, {"status": "transcribed", "progress": 0.85})

        unknown = match_result.get("unknown", [])
        if unknown:
            for u in unknown:
                for seg in aligned:
                    if abs(seg["start"] - u["sample_segment"].start) < 1.0:
                        u["sample_text"] = seg["text"][:200]
                        break
            uploader.update_status(job_id, {"status": "labeling_needed", "progress": 0.9, "unknown_speakers": unknown})
            agent_bridge.enqueue_labeling_needed(job_id, unknown, aligned, metadata)
        else:
            uploader.update_status(job_id, {"status": "ready_for_agent", "progress": 0.95})
            agent_bridge.enqueue_ready(job_id, aligned, metadata)

    except Exception as e:
        print(f"[pipeline] Error {job_id}: {e}")
        uploader.update_status(job_id, {"status": "failed", "error": str(e)})
        agent_bridge.enqueue_failed(job_id, str(e), {})


def _redact(text: str, rule: str) -> str:
    import re
    if "account" in rule.lower() or "banking" in rule.lower():
        text = re.sub(r'\b\d{4,}\b', '[REDACTED]', text)
    if "email" in rule.lower() or "phone" in rule.lower() or "contact" in rule.lower():
        text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL REDACTED]', text)
        text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    return text


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
