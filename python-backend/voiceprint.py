"""
Voiceprint management — speaker embedding extraction, matching, and storage

How it works:
1. Each speaker has a unique "voiceprint" — a high-dimensional embedding vector
   extracted from a short audio sample using pyannote's embedding model.
2. Voiceprints are stored in a local SQLite DB (voiceprints.db) keyed by name + email.
3. When a new meeting is processed, the pipeline extracts embeddings from each
   diarization segment and compares them (via cosine similarity) against stored
   voiceprints to identify known speakers.
4. Unmatched speakers are flagged as "unknown" for the agent to handle later via
   transcribe_label_speaker.

The embedding model (default: pyannote/embedding) converts a variable-length audio
segment into a fixed-size vector (~512 floats). Cosine similarity between two
embeddings ranges from -1 (opposite) to 1 (identical). A threshold of 0.75 means
two speakers are considered a match if their vectors point within ~41 degrees of
each other.
"""

import os
import sqlite3
import pickle
import threading
import numpy as np
from typing import List, Optional, Dict
from config import config
from utils import is_network_error


class VoiceprintManager:
    _thread_local = threading.local()

    def __init__(self, db_path: Optional[str] = None, device: Optional[str] = None):
        self.db_path = db_path or config.VOICEPRINT_DB
        self._device = device  # Pass a device string ("mps", "cuda", "cpu") or None for auto-detect
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._embedding_model = None  # Lazy-loaded pyannote Inference model
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        """Get a thread-local SQLite connection. Reused across operations to
        avoid the overhead of open/close per call."""
        if not hasattr(self._thread_local, "conn") or self._thread_local.conn is None:
            conn = sqlite3.connect(self.db_path)
            conn.execute("PRAGMA busy_timeout=5000")
            self._thread_local.conn = conn
        return self._thread_local.conn

    def close(self):
        """Close the thread-local connection if open."""
        conn = getattr(self._thread_local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._thread_local.conn = None

    def _init_db(self):
        """Create the SQLite voiceprints table if it doesn't exist.

        Schema:
          speaker_name — human-readable label (e.g. "Alice Johnson")
          email        — unique identifier for upsert
          embedding    — pickle-dumped numpy array of ~512 floats
          sample_job_id, sample_start, sample_end — reference to a sample audio
            clip for playback, captured when the voiceprint is enrolled.
        """
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS voiceprints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                speaker_name TEXT UNIQUE,
                email TEXT UNIQUE,
                embedding BLOB,
                sample_job_id TEXT,
                sample_start REAL,
                sample_end REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Add sample columns if missing (migration for existing DBs)
        try:
            conn.execute("ALTER TABLE voiceprints ADD COLUMN sample_job_id TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE voiceprints ADD COLUMN sample_start REAL")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE voiceprints ADD COLUMN sample_end REAL")
        except Exception:
            pass
        conn.commit()
        conn.close()

    def extract_embedding(self, audio_path: str, segment: tuple = None) -> np.ndarray:
        """Extract a speaker embedding vector from an audio file.

        Args:
            audio_path: Path to the 16kHz mono WAV file.
            segment: Optional (start_seconds, end_seconds) tuple. If None,
                     the entire file is used.

        Returns:
            A numpy array of floats — the speaker embedding.

        The pyannote Inference model wraps a pre-trained speaker recognition
        network (e.g., ResNet-based) that outputs a fixed-dimensional vector
        representing vocal characteristics.
        """
        if self._embedding_model is None:
            from pyannote.audio import Inference
            # Inference model: takes audio → outputs embedding vector
            # window="whole" means process the full segment at once (not sliding)
            print(f"[voiceprint] Loading embedding model ({config.EMBEDDING_MODEL})...")
            # Try online first so pyannote can check for model updates.
            # Falls back to local cache on network errors.
            try:
                # Pass explicit device if configured to avoid pyannote's
                # auto-detection, which can fail on MPS with certain ops.
                inference_kwargs = {"window": "whole"}
                if self._device:
                    inference_kwargs["device"] = self._device
                self._embedding_model = Inference(
                    config.EMBEDDING_MODEL, **inference_kwargs,
                )
            except Exception as _hub_err:
                if is_network_error(_hub_err):
                    print(f"[voiceprint] ⚠️  HuggingFace unreachable ({_hub_err}). "
                          f"Falling back to local cache...")
                    inference_kwargs = {"window": "whole", "local_files_only": True}
                    if self._device:
                        inference_kwargs["device"] = self._device
                    self._embedding_model = Inference(
                        config.EMBEDDING_MODEL, **inference_kwargs,
                    )
                else:
                    raise
            print(f"[voiceprint] Embedding model loaded" +
                  (f" on device='{self._device}'" if self._device else ""))

        if segment:
            start, end = segment
            emb = self._embedding_model(audio_path, start=start, end=end)
            return emb
        return self._embedding_model(audio_path)

    def match_against_attendees(
        self, audio_path: str, speaker_segments: dict,
        attendees: List[str], threshold: float = None
    ) -> dict:
        """Match each diarized speaker cluster against known voiceprints.

        Args:
            audio_path: Standardized 16kHz mono WAV.
            speaker_segments: Dict from diarization — {speaker_id: [Segments]}.
            attendees: List of known attendee names or emails to match against.
            threshold: Cosine similarity threshold (0.0–1.0). Default from config.

        Returns:
            {
              "known": {matched_name: [segments]},
              "unknown": [{speaker_id, segments, sample_segment, sample_text}]
            }

        Algorithm:
        1. Load embeddings for all known attendees from SQLite.
        2. For each diarized speaker cluster, sample up to N evenly-spaced
           segments and average their embeddings for a robust signature.
        3. Compute cosine similarity against every known embedding.
        4. If best match above threshold → label as that person.
        5. Otherwise → add to unknown list for agent resolution.
        """
        if threshold is None:
            threshold = config.VOICEPRINT_THRESHOLD

        # How many segments to sample per speaker cluster for averaging
        MAX_SAMPLE_SEGMENTS = 5

        # Step 1: Load stored embeddings for attendees who have voiceprints enrolled
        known_embeddings = self._get_known_embeddings(attendees)
        print(f"[voiceprint] Found {len(known_embeddings)} stored voiceprints for attendees: {list(known_embeddings.keys())}")
        results = {"known": {}, "unknown": []}

        # Step 2-5: Match each speaker cluster
        # Segments are plain dicts with "start", "end", "duration", "speaker" keys
        for speaker_id, segments in speaker_segments.items():
            first = segments[0]

            # Sample evenly-spaced segments across the cluster and average their embeddings
            sample_count = min(MAX_SAMPLE_SEGMENTS, len(segments))
            step = max(1, len(segments) // sample_count)
            sampled_embs = []
            for i in range(0, len(segments), step):
                if len(sampled_embs) >= sample_count:
                    break
                s = segments[i]
                seg_emb = self.extract_embedding(audio_path, segment=(s["start"], s["end"]))
                sampled_embs.append(seg_emb)

            # Average and re-normalize for a robust composite embedding
            emb = np.mean(sampled_embs, axis=0)
            emb = emb / np.linalg.norm(emb)

            # Find the best matching known voiceprint
            best_match, best_score = None, 0
            for name, stored in known_embeddings.items():
                sim = self._cosine_similarity(emb, stored)
                if sim > threshold and sim > best_score:
                    best_match, best_score = name, sim

            if best_match:
                # Known speaker — assign all their segments
                results["known"][best_match] = segments
                # Store score alongside name for ASV feedback logging
                results.setdefault("scores", {})[best_match] = best_score
                print(f"[voiceprint] ✅ {speaker_id} → matched '{best_match}' (score={best_score:.3f}, "
                      f"averaged over {len(sampled_embs)} segment(s))")
            else:
                # Unknown speaker — record metadata for agent labeling
                results["unknown"].append({
                    "speaker_id": speaker_id,
                    "segments": [{"start": s["start"], "end": s["end"]} for s in segments],
                    "sample_segment": {"start": first["start"], "end": first["end"]},
                })
                print(f"[voiceprint] ❓ {speaker_id} → unknown (best score={best_score:.3f}, "
                      f"threshold={threshold}, {len(sampled_embs)} segment(s) averaged)")

        return results

    def _get_known_embeddings(self, attendees: List[str]) -> Dict[str, np.ndarray]:
        """Look up stored voiceprint embeddings for a list of attendees.

        Uses a single batched query (email IN (...) OR speaker_name IN (...))
        instead of N individual queries.
        """
        if not attendees:
            return {}

        conn = self._get_conn()
        placeholders = ",".join("?" for _ in attendees)
        rows = conn.execute(
            f"""
            SELECT DISTINCT speaker_name, email, embedding
            FROM voiceprints
            WHERE email IN ({placeholders}) OR speaker_name IN ({placeholders})
            """,
            (*attendees, *attendees),
        ).fetchall()

        # Build result set — deduplicate if email and name match different rows
        seen_names = set()
        known = {}
        for name, email, blob in rows:
            if name not in seen_names:
                seen_names.add(name)
                known[name] = pickle.loads(blob)
        return known

    def save_voiceprint(self, name: str, email: str, embedding: np.ndarray,
                        sample_job_id: str = None,
                        sample_start: float = None,
                        sample_end: float = None):
        """Store or update a voiceprint. Uses email as the unique key (upsert).

        Args:
            sample_job_id: Job ID where the sample clip is located.
            sample_start: Start time in seconds of the sample clip.
            sample_end: End time in seconds of the sample clip.
        """
        conn = self._get_conn()
        conn.execute("""
            INSERT INTO voiceprints (speaker_name, email, embedding,
                                     sample_job_id, sample_start, sample_end)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                speaker_name=excluded.speaker_name, embedding=excluded.embedding,
                sample_job_id=excluded.sample_job_id,
                sample_start=excluded.sample_start,
                sample_end=excluded.sample_end,
                updated_at=CURRENT_TIMESTAMP
        """, (name, email, pickle.dumps(embedding),
              sample_job_id, sample_start, sample_end))
        conn.commit()

    def list_voiceprints(self) -> List[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT speaker_name, email, created_at, updated_at, "
            "sample_job_id, sample_start, sample_end "
            "FROM voiceprints ORDER BY speaker_name"
        ).fetchall()
        return [{
            "name": r[0], "email": r[1],
            "created_at": r[2], "updated_at": r[3],
            "sample_job_id": r[4], "sample_start": r[5], "sample_end": r[6],
        } for r in rows]

    def delete_voiceprint(self, email: str):
        conn = self._get_conn()
        conn.execute("DELETE FROM voiceprints WHERE email = ?", (email,))
        conn.commit()

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Compute cosine similarity between two embedding vectors.

        Formula: dot(a, b) / (||a|| * ||b||)
        Result: 1.0 = identical, 0.0 = orthogonal, -1.0 = opposite.
        The threshold of 0.75 used for matching means vectors must be within
        ~41 degrees of each other.
        """
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
