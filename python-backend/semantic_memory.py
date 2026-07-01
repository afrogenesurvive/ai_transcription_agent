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
        self._tokenizer = None

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
        from transformers import AutoTokenizer
        self._embedder = SentenceTransformer(
            "all-MiniLM-L6-v2",
            cache_folder=os.path.join(config.STORAGE_PATH, ".model_cache"),
        )
        self._tokenizer = AutoTokenizer.from_pretrained("all-MiniLM-L6-v2")

    def _embed(self, texts: List[str]) -> List[List[float]]:
        self._ensure_embedder()
        return self._embedder.encode(texts, normalize_embeddings=True).tolist()

    def _chunk_text(self, text: str, max_tokens: int = 480, overlap_tokens: int = 40) -> List[str]:
        """Split text into overlapping chunks by token count.

        Uses the embedding model's tokenizer so chunk boundaries align
        with the model's context window (all-MiniLM-L6-v2 = 512 tokens).
        Overlap preserves context between adjacent chunks.
        """
        if not text.strip():
            return []

        self._ensure_embedder()
        tokens = self._tokenizer.encode(text)

        if len(tokens) <= max_tokens:
            return [text]

        chunks = []
        start = 0
        while start < len(tokens):
            end = min(start + max_tokens, len(tokens))
            chunk_tokens = tokens[start:end]
            chunk_text = self._tokenizer.decode(chunk_tokens, skip_special_tokens=True)
            chunks.append(chunk_text)
            if end == len(tokens):
                break
            start = end - overlap_tokens

        return chunks

    # ── Public API ──

    def store_meeting(
        self,
        job_id: str,
        title: str,
        transcript_text: str,
        summary: dict,
        metadata: Optional[dict] = None,
    ):
        """Embed and store a completed meeting for future semantic search.

        Long texts are split into overlapping chunks of ~480 tokens each
        (well within the 512-token limit of all-MiniLM-L6-v2) to avoid
        silently discarding content.
        """
        self._ensure_loaded()
        print(f"[semantic_memory] Storing meeting '{title}' (job_id={job_id})...")

        # Build searchable text from summary fields
        summary_text = summary.get("executive_summary", "") if isinstance(summary, dict) else ""
        decisions = " ".join(summary.get("key_decisions", [])) if isinstance(summary, dict) else ""
        discussion = " ".join(summary.get("discussion_points", [])) if isinstance(summary, dict) else ""
        actions = " ".join(
            a.get("description", "") for a in (summary.get("action_items", []) if isinstance(summary, dict) else [])
        )

        search_text = f"{title}\n\n{summary_text}\n\nKey Decisions: {decisions}\n\nDiscussion: {discussion}\n\nAction Items: {actions}"

        base_meta = {
            "job_id": job_id,
            "title": title,
            "timestamp": metadata.get("date", "") if metadata else "",
            "attendees": ", ".join(metadata.get("attendees", [])) if metadata else "",
        }

        # ── Chunk and store summary ──
        summary_chunks = self._chunk_text(search_text)
        print(f"[semantic_memory] Summary: {len(summary_chunks)} chunk(s) ({len(self._tokenizer.encode(search_text))} total tokens)")
        for idx, chunk_text in enumerate(summary_chunks):
            chunk_id = f"meeting_{job_id}_summary_{idx}"
            embedding = self._embed([chunk_text])[0]
            self._collection.upsert(
                ids=[chunk_id],
                embeddings=[embedding],
                documents=[chunk_text],
                metadatas=[{
                    **base_meta,
                    "type": "meeting_summary",
                    "chunk_index": idx,
                    "total_chunks": len(summary_chunks),
                }],
            )

        # ── Chunk and store transcript ──
        transcript_chunks = []
        if transcript_text.strip():
            transcript_chunks = self._chunk_text(transcript_text)
            print(f"[semantic_memory] Transcript: {len(transcript_chunks)} chunk(s) ({len(self._tokenizer.encode(transcript_text))} total tokens)")
            for idx, chunk_text in enumerate(transcript_chunks):
                chunk_id = f"meeting_{job_id}_transcript_{idx}"
                embedding = self._embed([chunk_text])[0]
                self._collection.upsert(
                    ids=[chunk_id],
                    embeddings=[embedding],
                    documents=[chunk_text],
                    metadatas=[{
                        **base_meta,
                        "type": "transcript",
                        "chunk_index": idx,
                        "total_chunks": len(transcript_chunks),
                    }],
                )

        print(f"[semantic_memory] Meeting '{title}' stored successfully "
              f"({len(summary_chunks)} summary + {len(transcript_chunks)} transcript chunks)")

    def search(self, query: str, n_results: int = 5) -> List[dict]:
        """Search past meetings by semantic similarity. Returns top N unique meetings.

        Groups chunks by job_id so each meeting appears at most once in results.
        """
        self._ensure_loaded()
        print(f"[semantic_memory] Searching for: '{query}' (n_results={n_results})")

        query_embedding = self._embed([query])[0]
        # Over-fetch to account for multiple chunks per meeting
        results = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results * 5,
        )

        output = []
        seen_jobs = set()
        if results["ids"]:
            for i in range(len(results["ids"][0])):
                meta = results["metadatas"][0][i] if results.get("metadatas") else {}
                job_id = meta.get("job_id", "")
                if job_id in seen_jobs:
                    continue
                seen_jobs.add(job_id)
                output.append({
                    "id": results["ids"][0][i],
                    "job_id": job_id,
                    "title": meta.get("title", ""),
                    "score": float(results["distances"][0][i]) if results.get("distances") else 0,
                    "document": results["documents"][0][i][:500] if results.get("documents") else "",
                    "metadata": meta,
                })
                if len(output) >= n_results:
                    break
        print(f"[semantic_memory] Search returned {len(output)} unique meeting(s)")
        return output

    def get_meeting_context(self, job_id: str) -> Optional[dict]:
        """Retrieve stored context for a specific job (all chunks reassembled)."""
        self._ensure_loaded()
        results = self._collection.get(where={"job_id": job_id})
        if results["ids"]:
            docs = results.get("documents", [])
            metas = results.get("metadatas", [])
            if docs:
                # Sort chunks by index to reassemble in order
                indexed = sorted(
                    [(meta.get("chunk_index", 0) if meta else 0, doc, meta)
                     for doc, meta in zip(docs, metas)],
                    key=lambda x: x[0],
                )
                full_text = "\n\n".join(doc for _, doc, _ in indexed)
                return {
                    "document": full_text,
                    "metadata": indexed[0][2] if indexed else {},
                    "chunk_count": len(indexed),
                }
        return None

    def delete_meeting(self, job_id: str):
        """Remove all chunks for a given meeting."""
        self._ensure_loaded()
        self._collection.delete(where={"job_id": job_id})

    def count(self) -> int:
        """Return number of stored document chunks (not unique meetings)."""
        self._ensure_loaded()
        return self._collection.count()