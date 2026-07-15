"""
Voiceprint management — speaker embedding extraction, matching, and storage

How it works:
1. Each speaker has a unique "voiceprint" — a high-dimensional embedding vector
   extracted from a short audio sample using pyannote's embedding model.
2. Voiceprints are stored in a local SQLite DB (voiceprints.db) keyed by email.
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

── Write & Overwrite Contract ──

Storage schema (voiceprints table):
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  speaker_name  TEXT UNIQUE          — human-readable label
  email         TEXT UNIQUE          — THE upsert key (unique constraint)
  embedding     BLOB                 — pickle-dumped numpy array
  sample_job_id TEXT / start / end   — reference to the audio clip used
  created_at / updated_at            — timestamps

Upsert rule (ON CONFLICT(email) DO UPDATE SET):
  • Same email → OVERWRITE embedding, speaker_name, sample ref, updated_at
  • New email  → INSERT new row

Email resolution (_make_email):
  • Real email provided → used as-is (the join key across meetings)
  • No email provided   → derives "{slugified_name}@voiceprint.local"
    so each named speaker always gets a unique, deterministic email key.
    This prevents the historic bug where multiple speakers all passed "",
    collided on the same empty key, and silently overwrote each other.

Three save paths:
  1. label_and_resume (user via SpeakerLabelModal)
     └─ Real embedding extracted from speaker's longest audio segment
     └─ Email from user input (or empty → @voiceprint.local fallback)
  2. agent_label_speakers (LLM in agent pipeline)
     └─ Real embedding extracted from audio (if available)
     └─ Email empty → @voiceprint.local fallback
  3. transcribe_label_speaker tool (agent bridge)
     └─ Same as #2 — proxies through to agent_label_speakers

Conflict checking (POST /voiceprints/check-conflicts):
  Before saving, the SpeakerLabelModal checks whether any entered name or email
  already has an enrolled voiceprint under a DIFFERENT name. If so, a conflict
  dialog asks the user whether to overwrite or keep the existing record.
"""

import os
import sqlite3
import pickle
import threading
import numpy as np
import torch
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

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

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
            from pyannote.audio import Inference, Model
            print(f"[voiceprint] Loading embedding model ({config.EMBEDDING_MODEL})...")

            # Pre-load the Model object ourselves so we can detect a None return
            # (gated model / terms not accepted) before passing it to Inference.
            # Inference.__init__ calls Model.from_pretrained internally and then
            # chain-calls self.model.eval() — if from_pretrained returns None,
            # that crashes with AttributeError: 'NoneType' object has no attribute 'eval'.
            device = self._device

            hf_token = config.HUGGING_FACE_TOKEN or None

            # Attempt 1: configured device, online
            try:
                pyannote_model = Model.from_pretrained(
                    config.EMBEDDING_MODEL,
                    map_location=torch.device(device) if device else None,
                    use_auth_token=hf_token,
                )
            except Exception as _first_err:
                if is_network_error(_first_err):
                    # Network issue — fall back to local cache on same device
                    print(f"[voiceprint] ⚠️  HuggingFace unreachable ({_first_err}). "
                          f"Falling back to local cache...")
                    pyannote_model = Model.from_pretrained(
                        config.EMBEDDING_MODEL,
                        map_location=torch.device(device) if device else None,
                        use_auth_token=hf_token,
                        local_files_only=True,
                    )
                elif device and device != "cpu":
                    # Device-level error (e.g. MPS op not supported) — retry on CPU
                    print(f"[voiceprint] ⚠️  Model load failed on {device} ({_first_err}). "
                          f"Retrying with CPU fallback...")
                    device = "cpu"
                    pyannote_model = Model.from_pretrained(
                        config.EMBEDDING_MODEL,
                        map_location=torch.device("cpu"),
                        use_auth_token=hf_token,
                    )
                else:
                    raise

            if pyannote_model is None:
                raise RuntimeError(
                    f"Model '{config.EMBEDDING_MODEL}' could not be loaded. "
                    "This is likely a gated model — make sure you have:\n"
                    f"  1. Visited https://hf.co/{config.EMBEDDING_MODEL} "
                    "and accepted the user conditions\n"
                    "  2. Set HUGGING_FACE_TOKEN in your .env file"
                )

            self._embedding_model = Inference(
                pyannote_model, window="whole",
            )

            print(f"[voiceprint] Embedding model loaded" +
                  (f" on device='{device}'" if device else ""))

        # Minimum segment duration required by the embedding model's SincNet
        # layers. Very short segments (<~1s) cause "kernel size > input size"
        # errors in conv1d. We expand short segments symmetrically.
        MIN_DURATION = 1.0  # seconds — safe for all SincNet variants

        if segment:
            from pyannote.core import Segment
            start, end = segment
            duration = end - start
            if duration < MIN_DURATION:
                mid = (start + end) / 2.0
                half = MIN_DURATION / 2.0
                start = max(0.0, mid - half)
                end = mid + half
                print(f"[voiceprint] ⚠️  Segment ({segment[0]:.2f}s–{segment[1]:.2f}s, "
                      f"{duration:.2f}s) too short for embedding model. "
                      f"Expanded to {start:.2f}s–{end:.2f}s ({MIN_DURATION:.1f}s)")
            emb = self._embedding_model.crop(audio_path, Segment(start, end))
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

        # Cap the attendee list to prevent performance degradation from
        # extremely large registries. The first N names are used; the rest
        # are logged as skipped so the pipeline log is auditable.
        MAX_ATTENDEES_FOR_MATCHING = 50
        if len(attendees) > MAX_ATTENDEES_FOR_MATCHING:
            print(f"[voiceprint] ⚠️  Attendee list ({len(attendees)}) exceeds cap "
                  f"({MAX_ATTENDEES_FOR_MATCHING}). Truncating to first {MAX_ATTENDEES_FOR_MATCHING} "
                  f"for matching. Skipped: {attendees[MAX_ATTENDEES_FOR_MATCHING:]}")
            attendees = attendees[:MAX_ATTENDEES_FOR_MATCHING]

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
        conn = self._get_conn()

        if not attendees:
            # No attendees provided — try loading ALL voiceprints so previously
            # enrolled speakers can still be matched.
            rows = conn.execute(
                "SELECT DISTINCT speaker_name, email, embedding FROM voiceprints"
            ).fetchall()
        else:
            placeholders = ",".join("?" for _ in attendees)
            rows = conn.execute(
                f"""
                SELECT DISTINCT speaker_name, email, embedding
                FROM voiceprints
                WHERE email IN ({placeholders}) OR speaker_name IN ({placeholders})
                """,
                (*attendees, *attendees),
            ).fetchall()

        # Build result set — deduplicate by email (primary key), then by name.
        # The SQL query may return the same row twice if an attendee matches
        # both the email IN (...) and speaker_name IN (...) clauses. Also handle
        # the edge case where different names map to the same email alias.
        seen_emails = set()
        seen_names = set()
        known = {}
        for name, email, blob in rows:
            # Dedup by email first (most reliable — it's the unique key)
            email_key = (email or "").lower()
            if email_key and email_key in seen_emails:
                continue
            if email_key:
                seen_emails.add(email_key)
            # Also dedup by name (for rows without email)
            if name in seen_names:
                continue
            seen_names.add(name)
            try:
                emb = pickle.loads(blob)
            except Exception:
                continue
            if emb is None:
                continue
            known[name] = emb
        return known

    @staticmethod
    def _make_email(name: str, email: str) -> str:
        """Return a valid unique email for the voiceprint upsert key.

        If a real email is provided, use it as-is.  Otherwise derive a
        deterministic placeholder from the speaker name so that multiple
        named speakers never collide on the UNIQUE(email) constraint.
        """
        if email and email.strip():
            return email.strip()
        # Slugify the name into an email-like key
        slug = name.strip().lower().replace(" ", ".").replace("_", ".")
        # Strip any characters that aren't alphanumeric, dot, or hyphen
        slug = "".join(c for c in slug if c.isalnum() or c in ".-")
        return f"{slug}@voiceprint.local"

    def save_voiceprint(self, name: str, email: str, embedding: np.ndarray,
                        sample_job_id: str = None,
                        sample_start: float = None,
                        sample_end: float = None):
        """Store or update a voiceprint. Uses email as the unique key (upsert).

        When *email* is empty/falsy, a deterministic placeholder is derived
        from *name* (``{slug}@voiceprint.local``) so multiple named speakers
        never collide on the UNIQUE(email) constraint.

        Args:
            sample_job_id: Job ID where the sample clip is located.
            sample_start: Start time in seconds of the sample clip.
            sample_end: End time in seconds of the sample clip.
        """
        resolved_email = self._make_email(name, email)
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
        """, (name, resolved_email, pickle.dumps(embedding),
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

    def get_voiceprint(self, name_or_email: str) -> Optional[dict]:
        """Fetch existing voiceprint by speaker_name or email."""
        conn = self._get_conn()
        row = conn.execute(
            "SELECT speaker_name, email, sample_job_id, sample_start, sample_end "
            "FROM voiceprints WHERE speaker_name = ? OR email = ? LIMIT 1",
            (name_or_email, name_or_email),
        ).fetchone()
        if not row:
            return None
        return {
            "name": row[0], "email": row[1],
            "sample_job_id": row[2],
            "sample_start": row[3], "sample_end": row[4],
        }

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
