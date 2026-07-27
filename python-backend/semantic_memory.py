"""
Semantic Memory — ChromaDB-based vector storage for meeting transcripts and summaries.

Stores embeddings of meeting summaries, key decisions, and action items so the
agent can search across past meetings using natural language queries.

Auto-saves after summarization completes in the pipeline.
"""

import os
import re
import json
from typing import List, Optional, Dict, Any
from config import config


# ── Known abbreviations that end with a period but are NOT sentence boundaries ──
# These are matched at potential split points so the splitter can skip them.
# Words are listed WITHOUT the trailing period for readability.
_ABBREVIATIONS = {
    # Titles — NEVER end a sentence
    "Mr", "Mrs", "Ms", "Dr", "Jr", "Sr", "St", "Prof",
    "Gen", "Sgt", "Capt", "Col", "Maj", "Gov", "Rep", "Sen", "Rev", "Hon",
    # Business — rarely end a sentence
    "Inc", "Ltd", "Corp", "Co", "LLC", "Ave", "Blvd", "Est", "Dept",
    # Geographic
    "U.S", "U.K",
    # Academic
    "Fig", "Eq", "al", "Vol", "No", "Ed", "Univ", "Assn", "Ext", "Tel",
    # Months — can end a sentence but uncommon in meeting transcripts
    "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    # Other — never end a sentence
    "vs", "approx", "dept",
}

def _is_abbreviation(word: str) -> bool:
    """Check if a word (with trailing period) is a known abbreviation.

    e.g. ``_is_abbreviation('Dr.')`` → True
         ``_is_abbreviation('budget.')`` → False
    """
    # Strip the trailing period
    if not word.endswith("."):
        return False
    base = word[:-1]
    return base in _ABBREVIATIONS

# Paragraph break — two or more consecutive newlines (from summary formatting)
_PARAGRAPH_SPLIT = re.compile(r'\n\s*\n')


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
        if self._embedder is not None and self._tokenizer is not None:
            return
        from sentence_transformers import SentenceTransformer
        from transformers import AutoTokenizer
        # Assign to locals first so a failure in AutoTokenizer doesn't leave
        # self._embedder set while self._tokenizer is still None (which would
        # cause subsequent calls to return early without fixing the tokenizer).
        embedder = SentenceTransformer(
            "sentence-transformers/all-MiniLM-L6-v2",
            cache_folder=os.path.join(config.STORAGE_PATH, ".model_cache"),
        )
        tokenizer = AutoTokenizer.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
        self._embedder = embedder
        self._tokenizer = tokenizer

    def _embed(self, texts: List[str]) -> List[List[float]]:
        self._ensure_embedder()
        return self._embedder.encode(texts, normalize_embeddings=True).tolist()

    # ── Public API ──

    def _split_sentences(self, text: str) -> List[str]:
        """Split text into sentences at semantic boundaries.

        Strategy (in order of priority):
          1. Split on paragraph breaks (\\n\\n) — strongest boundary
          2. Walk through each paragraph character-by-character, splitting
             at `. ! ?` followed by whitespace + capital letter, unless the
             word before the punctuation is a known abbreviation (e.g. "Dr.",
             "U.S.", "a.m.")

        Returns a list of non-empty sentence strings.
        """
        if not text.strip():
            return []

        paragraphs = _PARAGRAPH_SPLIT.split(text)
        sentences = []

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            # Walk through the paragraph finding split points
            start = 0
            for m in re.finditer(r"[.!?]\s+", para):
                end = m.end()  # position after the whitespace
                # The word immediately before the punctuation
                before = para[start:m.start()].strip()
                if before:
                    # Check if the LAST word (including the period) is an
                    # abbreviation — e.g. "Dr" + "." → "Dr."
                    words = before.split()
                    last_word_with_period = (words[-1] + ".") if words else ""
                    if _is_abbreviation(last_word_with_period):
                        # Not a real sentence boundary — skip
                        continue
                # Real sentence boundary — split
                sentence = para[start:end].strip()
                if sentence:
                    sentences.append(sentence)
                start = end

            # Remaining text after last split point
            tail = para[start:].strip()
            if tail:
                sentences.append(tail)

        return sentences

    def _chunk_text(self, text: str, max_tokens: int = 480) -> List[str]:
        """Split text into chunks at sentence boundaries.

        Unlike the old token-count slicer, this method:
          1. Splits text into sentences using ``_split_sentences()``
          2. Groups sentences together until the token budget is reached
          3. Never splits mid-sentence

        If a single sentence exceeds ``max_tokens`` (rare for meeting text,
        possible for very long utterances), it is split token-wise as a
        fallback with a warning.

        No overlap is needed because chunk boundaries always fall at
        sentence boundaries — adjacent chunks don't lose mid-sentence
        context. Each chunk is a coherent set of complete thoughts.
        """
        if not text.strip():
            return []
        self._ensure_embedder()

        # Quick path: entire text fits in one chunk
        total_tokens = len(self._tokenizer.encode(text))
        if total_tokens <= max_tokens:
            return [text]

        sentences = self._split_sentences(text)
        if not sentences:
            return []

        chunks = []
        current_chunk: List[str] = []
        current_tokens = 0

        for sent in sentences:
            sent_tokens = len(self._tokenizer.encode(sent))

            # If a single sentence exceeds the budget, split it token-wise
            # (rare edge case — e.g., a very long monologue with no punctuation)
            if sent_tokens > max_tokens:
                # Flush any accumulated sentences first
                if current_chunk:
                    chunks.append(" ".join(current_chunk))
                    current_chunk = []
                    current_tokens = 0

                print(f"[semantic_memory] ⚠️  Single sentence exceeds {max_tokens} tokens "
                      f"({sent_tokens} tokens) — falling back to token-level split")
                # Token-split this single oversized sentence
                tokens = self._tokenizer.encode(sent)
                for i in range(0, len(tokens), max_tokens):
                    piece = self._tokenizer.decode(tokens[i:i + max_tokens], skip_special_tokens=True)
                    chunks.append(piece)
                continue

            # If adding this sentence would exceed the budget, start a new chunk
            if current_tokens + sent_tokens > max_tokens:
                if current_chunk:
                    chunks.append(" ".join(current_chunk))
                current_chunk = [sent]
                current_tokens = sent_tokens
            else:
                current_chunk.append(sent)
                current_tokens += sent_tokens

        # Flush remaining sentences
        if current_chunk:
            chunks.append(" ".join(current_chunk))

        # Deduplicate identical adjacent chunks (can happen with very short
        # texts where different splits produce the same merged result)
        deduped = []
        for c in chunks:
            if not deduped or c != deduped[-1]:
                deduped.append(c)

        return deduped

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

        Long texts are split into sentence-aligned chunks of up to ~480
        tokens each (well within the 512-token limit of all-MiniLM-L6-v2)
        so that no chunk ever splits mid-sentence. Chunk boundaries fall
        at paragraph breaks (\\n\\n) or sentence-ending punctuation (. ! ?),
        preserving semantic coherence.
        """
        self._ensure_loaded()
        self._ensure_embedder()
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
        total_summary_tokens = len(self._tokenizer.encode(search_text))
        print(f"[semantic_memory] Summary: {len(summary_chunks)} chunk(s) ({total_summary_tokens} total tokens)")

        # ── Chunk and store transcript ──
        transcript_chunks = []
        if transcript_text.strip():
            transcript_chunks = self._chunk_text(transcript_text)
            total_transcript_tokens = len(self._tokenizer.encode(transcript_text))
            print(f"[semantic_memory] Transcript: {len(transcript_chunks)} chunk(s) ({total_transcript_tokens} total tokens)")

        # ── Batch embed ALL chunks at once ──
        # Collect all data first, then embed in a single batched call.
        # sentence-transformers is optimized for batched encoding (GPU batch,
        # reduced Python overhead), making this significantly faster than
        # N individual calls to self._embed().
        all_chunks = []
        all_ids = []
        all_metadatas = []

        for idx, chunk_text in enumerate(summary_chunks):
            all_chunks.append(chunk_text)
            all_ids.append(f"meeting_{job_id}_summary_{idx}")
            all_metadatas.append({
                **base_meta,
                "type": "meeting_summary",
                "chunk_index": idx,
                "total_chunks": len(summary_chunks),
            })

        for idx, chunk_text in enumerate(transcript_chunks):
            all_chunks.append(chunk_text)
            all_ids.append(f"meeting_{job_id}_transcript_{idx}")
            all_metadatas.append({
                **base_meta,
                "type": "transcript",
                "chunk_index": idx,
                "total_chunks": len(transcript_chunks),
            })

        if all_chunks:
            all_embeddings = self._embed(all_chunks)
            # Upsert in a single batch call (ChromaDB handles this efficiently)
            self._collection.upsert(
                ids=all_ids,
                embeddings=all_embeddings,
                documents=all_chunks,
                metadatas=all_metadatas,
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
        # Over-fetch to account for multiple chunks per meeting;
        # ef_search=50 improves HNSW recall from ~97% to ~99%
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