"""
Semantic Memory — ChromaDB-based vector storage for meeting transcripts and summaries.

Stores embeddings of meeting summaries, key decisions, and action items so the
agent can search across past meetings using natural language queries.

Auto-saves after summarization completes in the pipeline.
"""

import os
import json
import hashlib
from typing import List, Optional, Dict, Any
from config import config


class SemanticMemory:
    """Wrapper around ChromaDB for meeting transcript/summary storage and retrieval.

    Uses sentence-transformers for local embedding (no API key needed).
    Data is persisted to disk at storage/chroma/.
    """

    def __init__(self, persist_dir: Optional[str] = None):
        self.persist_dir = persist_dir or os.path.join(config.STORAGE_PATH, "chroma")
        self._collection = None
        self._embedder = None

    # ── Lazy init (first use loads the model) ──

    def _ensure_loaded(self):
        if self._collection is not None:
            return
        import chromadb
        from chromadb.config import Settings

        os.makedirs(self.persist_dir, exist_ok=True)
        client = chromadb.PersistentClient(
            path=self.persist_dir,
            settings=Settings(anonymized_telemetry=False),
        )
        self._collection = client.get_or_create_collection(
            name="meeting_memories",
            metadata={"hnsw:space": "cosine"},
        )

    def _ensure_embedder(self):
        if self._embedder is not None:
            return
        from sentence_transformers import SentenceTransformer
        self._embedder = SentenceTransformer(
            "all-MiniLM-L6-v2",
            cache_folder=os.path.join(config.STORAGE_PATH, ".model_cache"),
        )

    def _embed(self, texts: List[str]) -> List[List[float]]:
        self._ensure_embedder()
        return self._embedder.encode(texts, normalize_embeddings=True).tolist()

    # ── Public API ──

    def store_meeting(
        self,
        job_id: str,
        title: str,
        transcript_text: str,
        summary: dict,
        metadata: Optional[dict] = None,
    ):
        """Embed and store a completed meeting for future semantic search."""
        self._ensure_loaded()
        print(f"[semantic_memory] Storing meeting '{title}' (job_id={job_id})...")

        # Build searchable text from summary fields
        summary_text = summary.get("executive_summary", "") if isinstance(summary, dict) else ""
        decisions = " ".join(summary.get("key_decisions", [])) if isinstance(summary, dict) else ""
        discussion = " ".join(summary.get("discussion_points", [])) if isinstance(summary, dict) else ""
        actions = " ".join(
            a.get("description", "") for a in (summary.get("action_items", []) if isinstance(summary, dict) else [])
        )

        # Combine transcript + summary for rich embeddings
        search_text = f"{title}\n\n{summary_text}\n\nKey Decisions: {decisions}\n\nDiscussion: {discussion}\n\nAction Items: {actions}"

        # Truncate to avoid huge embeddings (sentence-transformers has 512 token limit)
        MAX_CHARS = 8000
        if len(search_text) > MAX_CHARS:
            search_text = search_text[:MAX_CHARS] + "..."

        doc_id = f"meeting_{job_id}"
        chunk_id = f"{doc_id}_summary"

        print(f"[semantic_memory] Generating embedding for summary ({len(search_text)} chars)...")
        embedding = self._embed([search_text])[0]
        meta = {
            "job_id": job_id,
            "title": title,
            "type": "meeting_summary",
            "timestamp": metadata.get("date", "") if metadata else "",
            "attendees": ", ".join(metadata.get("attendees", [])) if metadata else "",
        }

        # Upsert — replace if same doc_id exists
        self._collection.upsert(
            ids=[chunk_id],
            embeddings=[embedding],
            documents=[search_text],
            metadatas=[meta],
        )
        print(f"[semantic_memory] Summary chunk stored (id={chunk_id})")

        # Also store a shorter chunk for the transcript itself (different chunk_id)
        transcript_chunk_id = f"{doc_id}_transcript"
        transcript_trimmed = transcript_text[:MAX_CHARS] if len(transcript_text) > MAX_CHARS else transcript_text
        if transcript_trimmed.strip():
            print(f"[semantic_memory] Generating embedding for transcript ({len(transcript_trimmed)} chars)...")
            trans_embedding = self._embed([transcript_trimmed])[0]
            self._collection.upsert(
                ids=[transcript_chunk_id],
                embeddings=[trans_embedding],
                documents=[transcript_trimmed],
                metadatas=[{**meta, "type": "transcript"}],
            )
            print(f"[semantic_memory] Transcript chunk stored (id={transcript_chunk_id})")
        print(f"[semantic_memory] Meeting '{title}' stored successfully")

    def search(self, query: str, n_results: int = 5) -> List[dict]:
        """Search past meetings by semantic similarity. Returns top matches."""
        self._ensure_loaded()
        print(f"[semantic_memory] Searching for: '{query}' (n_results={n_results})")

        query_embedding = self._embed([query])[0]
        results = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
        )

        output = []
        if results["ids"]:
            for i in range(len(results["ids"][0])):
                output.append({
                    "id": results["ids"][0][i],
                    "score": float(results["distances"][0][i]) if results.get("distances") else 0,
                    "document": results["documents"][0][i][:500] if results.get("documents") else "",
                    "metadata": results["metadatas"][0][i] if results.get("metadatas") else {},
                })
        print(f"[semantic_memory] Search returned {len(output)} result(s)")
        return output

    def get_meeting_context(self, job_id: str) -> Optional[dict]:
        """Retrieve stored context for a specific job (summary + transcript chunks)."""
        self._ensure_loaded()
        for chunk_id in [f"meeting_{job_id}_summary", f"meeting_{job_id}_transcript"]:
            results = self._collection.get(ids=[chunk_id])
            if results["ids"]:
                return {
                    "document": results["documents"][0] if results.get("documents") else "",
                    "metadata": results["metadatas"][0] if results.get("metadatas") else {},
                }
        return None

    def delete_meeting(self, job_id: str):
        """Remove all chunks for a given meeting."""
        self._ensure_loaded()
        self._collection.delete(ids=[f"meeting_{job_id}_summary", f"meeting_{job_id}_transcript"])

    def count(self) -> int:
        """Return number of stored meeting chunks."""
        self._ensure_loaded()
        return self._collection.count()
