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
import numpy as np
from typing import List, Optional, Dict
from config import config


class VoiceprintManager:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or config.VOICEPRINT_DB
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._embedding_model = None  # Lazy-loaded pyannote Inference model
        self._init_db()

    def _init_db(self):
        """Create the SQLite voiceprints table if it doesn't exist.

        Schema:
          speaker_name — human-readable label (e.g. "Alice Johnson")
          email        — unique identifier for upsert
          embedding    — pickle-dumped numpy array of ~512 floats
        """
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS voiceprints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                speaker_name TEXT UNIQUE,
                email TEXT UNIQUE,
                embedding BLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
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
            self._embedding_model = Inference(config.EMBEDDING_MODEL, window="whole")
            print(f"[voiceprint] Embedding model loaded")

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
        2. For each diarized speaker cluster, take the first segment and
           extract its embedding.
        3. Compute cosine similarity against every known embedding.
        4. If best match above threshold → label as that person.
        5. Otherwise → add to unknown list for agent resolution.
        """
        if threshold is None:
            threshold = config.VOICEPRINT_THRESHOLD

        # Step 1: Load stored embeddings for attendees who have voiceprints enrolled
        known_embeddings = self._get_known_embeddings(attendees)
        print(f"[voiceprint] Found {len(known_embeddings)} stored voiceprints for attendees: {list(known_embeddings.keys())}")
        results = {"known": {}, "unknown": []}

        # Step 2-5: Match each speaker cluster
        for speaker_id, segments in speaker_segments.items():
            first = segments[0]
            # Extract embedding from the first segment of this speaker's audio
            emb = self.extract_embedding(audio_path, segment=(first.start, first.end))

            # Find the best matching known voiceprint
            best_match, best_score = None, 0
            for name, stored in known_embeddings.items():
                sim = self._cosine_similarity(emb, stored)
                if sim > threshold and sim > best_score:
                    best_match, best_score = name, sim

            if best_match:
                # Known speaker — assign all their segments
                results["known"][best_match] = segments
                print(f"[voiceprint] ✅ {speaker_id} → matched '{best_match}' (score={best_score:.3f})")
            else:
                # Unknown speaker — record metadata for agent labeling
                results["unknown"].append({
                    "speaker_id": speaker_id,
                    "segments": [{"start": s.start, "end": s.end} for s in segments],
                    "sample_segment": {"start": first.start, "end": first.end},
                })
                print(f"[voiceprint] ❓ {speaker_id} → unknown (best score={best_score:.3f}, threshold={threshold})")

        return results

    def _get_known_embeddings(self, attendees: List[str]) -> Dict[str, np.ndarray]:
        """Look up stored voiceprint embeddings for a list of attendees.

        Searches by email first, then by speaker_name.
        """
        conn = sqlite3.connect(self.db_path)
        known = {}
        for attendee in attendees:
            for col in ("email", "speaker_name"):
                row = conn.execute(
                    f"SELECT speaker_name, embedding FROM voiceprints WHERE {col} = ?",
                    (attendee,),
                ).fetchone()
                if row:
                    known[row[0]] = pickle.loads(row[1])
                    break
        conn.close()
        return known

    def save_voiceprint(self, name: str, email: str, embedding: np.ndarray):
        """Store or update a voiceprint. Uses email as the unique key (upsert)."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            INSERT INTO voiceprints (speaker_name, email, embedding)
            VALUES (?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                speaker_name=excluded.speaker_name, embedding=excluded.embedding,
                updated_at=CURRENT_TIMESTAMP
        """, (name, email, pickle.dumps(embedding)))
        conn.commit()
        conn.close()

    def list_voiceprints(self) -> List[dict]:
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT speaker_name, email, created_at, updated_at FROM voiceprints ORDER BY speaker_name"
        ).fetchall()
        conn.close()
        return [{"name": r[0], "email": r[1], "created_at": r[2], "updated_at": r[3]} for r in rows]

    def delete_voiceprint(self, email: str):
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM voiceprints WHERE email = ?", (email,))
        conn.commit()
        conn.close()

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Compute cosine similarity between two embedding vectors.

        Formula: dot(a, b) / (||a|| * ||b||)
        Result: 1.0 = identical, 0.0 = orthogonal, -1.0 = opposite.
        The threshold of 0.75 used for matching means vectors must be within
        ~41 degrees of each other.
        """
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
