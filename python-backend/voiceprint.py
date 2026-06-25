"""
Voiceprint management — speaker embedding extraction, matching, and storage
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
        self._embedding_model = None
        self._init_db()

    def _init_db(self):
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
        if self._embedding_model is None:
            from pyannote.audio import Inference
            self._embedding_model = Inference(config.EMBEDDING_MODEL, window="whole")

        if segment:
            start, end = segment
            return self._embedding_model(audio_path, start=start, end=end)
        return self._embedding_model(audio_path)

    def match_against_attendees(
        self, audio_path: str, speaker_segments: dict,
        attendees: List[str], threshold: float = None
    ) -> dict:
        if threshold is None:
            threshold = config.VOICEPRINT_THRESHOLD

        known_embeddings = self._get_known_embeddings(attendees)
        results = {"known": {}, "unknown": []}

        for speaker_id, segments in speaker_segments.items():
            first = segments[0]
            emb = self.extract_embedding(audio_path, segment=(first.start, first.end))

            best_match, best_score = None, 0
            for name, stored in known_embeddings.items():
                sim = self._cosine_similarity(emb, stored)
                if sim > threshold and sim > best_score:
                    best_match, best_score = name, sim

            if best_match:
                results["known"][best_match] = segments
            else:
                results["unknown"].append({
                    "speaker_id": speaker_id,
                    "segments": [{"start": s.start, "end": s.end} for s in segments],
                    "sample_segment": {"start": first.start, "end": first.end},
                })

        return results

    def _get_known_embeddings(self, attendees: List[str]) -> Dict[str, np.ndarray]:
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
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
