"""
Ephemeral Memory — SQLite-backed cross-meeting context store.

Stores structured data extracted from meetings so the agent can retrieve context
across sessions: action items, contacts, budgets, decisions, and free-form notes.

All data is keyed by a semantic "topic" for easy agent lookup.
"""

import os
import json
import sqlite3
import time
import threading
from typing import List, Optional, Union
from datetime import datetime
from config import config


class EphemeralMemory:
    """Lightweight SQLite store for cross-meeting context.

    Tables:
      - jobs:           job metadata (title, result, tokens, costs, delivery, etc.)
      - attendees:      people registered as meeting attendees (name, email, source, job_id → jobs)
      - action_items:   extracted to-dos with assignee, deadline, status
      - contacts:       people mentioned across meetings (name, email, org, role)
      - budgets:        financial figures mentioned (amount, currency, context)
      - decisions:      key decisions made (description, rationale)
      - notes:          free-form context notes (key-value pairs)
      - events:         queue events for agent runner (pending, processing, completed, failed, dlq)

    Uses ``threading.local()`` to reuse SQLite connections per thread,
    avoiding the overhead of open/close per operation. Each thread gets
    its own connection, which is safe since SQLite in WAL mode supports
    concurrent readers.

    Can be used as a context manager::

        with EphemeralMemory() as mem:
            mem.save_note(...)
        # connection automatically closed on exit
    """

    _thread_local = threading.local()

    @staticmethod
    def _cleanup_companion_files(db_path: str, force: bool = False):
        """Remove stale SQLite WAL/shm companion files that can cause
        'disk I/O error' on re-created databases.

        See https://sqlite.org/wal.html for details on the mechanism.

        Args:
            db_path: Path to the SQLite database file.
            force: When True, delete companion files unconditionally. Only
                safe when no other connection holds the database open.
                When False, companions are only deleted if the main database
                file itself does not exist (a fresh create — always safe).
        """
        if not force and os.path.exists(db_path):
            # Live database — do NOT delete companions. A connection from
            # another thread/process may still hold them and would hit
            # "disk I/O error" if the files vanish underneath it.
            return
        for suffix in ("-wal", "-shm"):
            path = db_path + suffix
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass  # Non-critical — may be in use by another process

    def _retry_on_io_error(self, fn, max_retries=3, delay=0.5):
        """Retry a callable if it raises ``sqlite3.OperationalError`` with
        'disk I/O error'. Uses exponential backoff between retries.

        Before each retry the SQLite connection is reset, so the retried
        callable runs against a freshly opened connection — re-running on the
        same broken connection keeps failing on WAL companion-file races.

        Returns the callable's result, or re-raises the last exception.
        """
        last_exc = None
        for attempt in range(max_retries):
            try:
                return fn()
            except sqlite3.OperationalError as e:
                if "disk I/O error" not in str(e) or attempt >= max_retries - 1:
                    raise
                wait = delay * (2 ** attempt)
                print(f"[ephemeral] ⚠️  disk I/O error on attempt {attempt + 1}/{max_retries}, "
                      f"retrying in {wait:.1f}s: {e}")
                time.sleep(wait)
                # Reset the connection — a fresh connect re-creates the WAL/shm
                # companion files cleanly instead of reusing the broken one.
                self._reset_conn()
                # Guarded recovery: try a WAL checkpoint first; only delete the
                # companion files if the checkpoint itself fails.
                try:
                    _tmp = sqlite3.connect(self.db_path)
                    _tmp.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    _tmp.close()
                except Exception:
                    self._cleanup_companion_files(self.db_path, force=False)
                last_exc = e
        raise last_exc  # type: ignore[misc] — only reached if all retries failed

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.path.join(config.STORAGE_PATH, "ephemeral_memory.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        # Track every connection this instance creates so they can all be
        # closed before the DB file or its WAL companions are removed.
        self._conns: set = set()
        self._conns_lock = threading.Lock()
        # Close any connections other threads may still hold (e.g. when this
        # instance is re-initialized via /storage/ephemeral) before we touch
        # the database file.
        self.close_all()
        # Open the DB normally. Only if that fails (e.g. stale -wal/-shm from
        # a prior crash) delete the companion files and retry once — never
        # delete them while the DB might still be in active use.
        try:
            self._init_db()
        except Exception:
            self.close_all()
            self._cleanup_companion_files(self.db_path, force=True)
            self._init_db()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    def _get_conn(self) -> sqlite3.Connection:
        """Get a thread-local SQLite connection. Creates one if this thread
        hasn't connected yet. Connections are NOT closed between operations
        — they are reused until the thread exits or close() is called.

        The cached connection is validated on reuse: if it has been closed or
        points at a different database file (e.g. after the DB was deleted and
        re-initialized), it is discarded and a fresh one is created. Every
        created connection is registered so ``close_all()`` can close them
        across all threads before the DB file is removed.
        """
        conn = getattr(self._thread_local, "conn", None)
        if conn is not None:
            if getattr(self._thread_local, "conn_db_path", None) != self.db_path:
                self.close()  # stale — points at a different DB
                conn = None
            else:
                try:
                    conn.execute("SELECT 1")  # still usable?
                except sqlite3.Error:
                    self.close()  # dead/stale — discard and recreate
                    conn = None
        if conn is None:
            conn = sqlite3.connect(self.db_path)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._thread_local.conn = conn
            self._thread_local.conn_db_path = self.db_path
            with self._conns_lock:
                self._conns.add(conn)
        return conn

    def close(self):
        """Close the thread-local connection if open. Safe to call multiple times."""
        conn = getattr(self._thread_local, "conn", None)
        if conn is not None:
            conns = getattr(self, "_conns", None)
            lock = getattr(self, "_conns_lock", None)
            if conns is not None and lock is not None:
                with lock:
                    conns.discard(conn)
            try:
                conn.close()
            except Exception:
                pass
            self._thread_local.conn = None
            self._thread_local.conn_db_path = None

    def close_all(self):
        """Close every registered SQLite connection across all threads.

        Called before the database file or its WAL companions are deleted, so
        no live connection can hit 'disk I/O error' from files vanishing
        underneath it.
        """
        with self._conns_lock:
            conns = list(self._conns)
            self._conns.clear()
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass
        # Drop this thread's cached reference (it may have been one of them)
        self._thread_local.conn = None
        self._thread_local.conn_db_path = None

    def _reset_conn(self):
        """Close and discard this thread's SQLite connection so the next
        ``_get_conn()`` creates a fresh one (recovers from WAL 'disk I/O
        error' conditions)."""
        self.close()

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        # Recover any uncommitted WAL writes from a prior crash, then
        # truncate the WAL files so a new crash doesn't leave stale
        # .db-shm / .db-wal files that block subsequent startup.
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception as exc:
            print(f"[ephemeral] ⚠️  WAL checkpoint failed at startup: {exc}")

        # Quick integrity check — catches stale/corrupt databases early
        try:
            row = conn.execute("PRAGMA integrity_check").fetchone()
            if row and row[0] != "ok":
                print(f"[ephemeral] ⚠️  Integrity check failed: {row[0]}")
        except Exception:
            pass

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL DEFAULT 'Untitled Meeting',
                result          TEXT NOT NULL DEFAULT 'pending',
                attendees       TEXT NOT NULL DEFAULT '[]',
                email_recipients TEXT NOT NULL DEFAULT '[]',
                pipeline_steps  TEXT NOT NULL DEFAULT '[]',
                original_filename TEXT DEFAULT NULL,
                audio_url       TEXT DEFAULT NULL,
                audio_size_bytes INTEGER DEFAULT NULL,
                audio_duration_sec REAL DEFAULT NULL,
                error_message   TEXT DEFAULT NULL,
                transcript_segment_count  INTEGER DEFAULT 0,
                transcript_char_count     INTEGER DEFAULT 0,
                summary_char_count        INTEGER DEFAULT 0,
                has_analysis              INTEGER DEFAULT 0,
                analysis_char_count       INTEGER DEFAULT 0,
                total_prompt_tokens      INTEGER DEFAULT 0,
                total_completion_tokens  INTEGER DEFAULT 0,
                total_tokens             INTEGER DEFAULT 0,
                llm_provider             TEXT DEFAULT 'deepseek',
                llm_model                TEXT DEFAULT 'deepseek-v4-flash',
                input_cost               REAL DEFAULT 0.0,
                output_cost              REAL DEFAULT 0.0,
                total_cost               REAL DEFAULT 0.0,
                delivery_attempted       INTEGER DEFAULT 0,
                delivery_results         TEXT DEFAULT '[]',
                event_type              TEXT DEFAULT 'internal',
                whisper_model           TEXT DEFAULT 'medium',
                diarization_available   INTEGER DEFAULT 0,
                device                  TEXT DEFAULT 'mps',
                config_snapshot         TEXT DEFAULT NULL,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP DEFAULT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_result      ON jobs(result);
            CREATE INDEX IF NOT EXISTS idx_jobs_created_at  ON jobs(created_at);

            CREATE TABLE IF NOT EXISTS attendees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT DEFAULT '',
                source TEXT NOT NULL DEFAULT 'new_job_form',
                job_id TEXT DEFAULT NULL REFERENCES jobs(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_non_speaking INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS action_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                description TEXT NOT NULL,
                assignee TEXT DEFAULT '',
                deadline TEXT DEFAULT '',
                status TEXT DEFAULT 'open',
                priority TEXT DEFAULT 'medium',
                source_meeting TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT DEFAULT '',
                organization TEXT DEFAULT '',
                role TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                source_meeting TEXT DEFAULT '',
                first_mentioned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_mentioned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS budgets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                description TEXT NOT NULL,
                amount REAL,
                currency TEXT DEFAULT 'USD',
                category TEXT DEFAULT '',
                source_meeting TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                description TEXT NOT NULL,
                rationale TEXT DEFAULT '',
                made_by TEXT DEFAULT '',
                source_meeting TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(job_id, topic)
            );

            CREATE TABLE IF NOT EXISTS events (
                id              TEXT PRIMARY KEY,
                source          TEXT NOT NULL DEFAULT 'transcription',
                type            TEXT NOT NULL,
                data            TEXT NOT NULL DEFAULT '{}',
                status          TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','processing','completed','failed','dlq')),
                priority        INTEGER NOT NULL DEFAULT 0,
                retry_count     INTEGER NOT NULL DEFAULT 0,
                max_retries     INTEGER NOT NULL DEFAULT 5,
                error_message   TEXT DEFAULT NULL,
                queued_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                claimed_at      TIMESTAMP DEFAULT NULL,
                completed_at    TIMESTAMP DEFAULT NULL,
                ttl_seconds     INTEGER DEFAULT 86400
            );

            CREATE INDEX IF NOT EXISTS idx_action_status ON action_items(status);
            CREATE INDEX IF NOT EXISTS idx_action_assignee ON action_items(assignee);
            CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
            CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic);
            CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category);
            CREATE INDEX IF NOT EXISTS idx_attendees_name ON attendees(name);
            CREATE INDEX IF NOT EXISTS idx_attendees_job ON attendees(job_id);
            CREATE INDEX IF NOT EXISTS idx_events_status      ON events(status);
            CREATE INDEX IF NOT EXISTS idx_events_queued_at   ON events(queued_at);
            CREATE INDEX IF NOT EXISTS idx_events_type_status ON events(type, status);
        """)
        # ── Schema migrations for existing databases ──
        # Check which columns the attendees table actually has before attempting ALTER.
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(attendees)").fetchall()}
        if "last_seen" not in existing_cols:
            try:
                conn.execute("ALTER TABLE attendees ADD COLUMN last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
                print(f"[ephemeral] Migration: added `last_seen` column to attendees table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add last_seen: {e}")
        if "last_job_id" not in existing_cols:
            try:
                conn.execute("ALTER TABLE attendees ADD COLUMN last_job_id TEXT DEFAULT NULL")
                print(f"[ephemeral] Migration: added `last_job_id` column to attendees table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add last_job_id: {e}")
        if "is_non_speaking" not in existing_cols:
            try:
                conn.execute("ALTER TABLE attendees ADD COLUMN is_non_speaking INTEGER NOT NULL DEFAULT 0")
                print(f"[ephemeral] Migration: added `is_non_speaking` column to attendees table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add is_non_speaking: {e}")

        # Check for config_snapshot column on jobs table
        jobs_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "config_snapshot" not in jobs_cols:
            try:
                conn.execute("ALTER TABLE jobs ADD COLUMN config_snapshot TEXT DEFAULT NULL")
                print(f"[ephemeral] Migration: added `config_snapshot` column to jobs table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add config_snapshot: {e}")
        if "original_filename" not in jobs_cols:
            try:
                conn.execute("ALTER TABLE jobs ADD COLUMN original_filename TEXT DEFAULT NULL")
                print(f"[ephemeral] Migration: added `original_filename` column to jobs table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add original_filename: {e}")

        # Check for events table (added in 0.4.10 — queue migration)
        existing_tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "events" not in existing_tables:
            try:
                conn.executescript("""
                    CREATE TABLE IF NOT EXISTS events (
                        id              TEXT PRIMARY KEY,
                        source          TEXT NOT NULL DEFAULT 'transcription',
                        type            TEXT NOT NULL,
                        data            TEXT NOT NULL DEFAULT '{}',
                        status          TEXT NOT NULL DEFAULT 'pending'
                                        CHECK(status IN ('pending','processing','completed','failed','dlq')),
                        priority        INTEGER NOT NULL DEFAULT 0,
                        retry_count     INTEGER NOT NULL DEFAULT 0,
                        max_retries     INTEGER NOT NULL DEFAULT 5,
                        error_message   TEXT DEFAULT NULL,
                        queued_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        claimed_at      TIMESTAMP DEFAULT NULL,
                        completed_at    TIMESTAMP DEFAULT NULL,
                        ttl_seconds     INTEGER DEFAULT 86400
                    );
                    CREATE INDEX IF NOT EXISTS idx_events_status      ON events(status);
                    CREATE INDEX IF NOT EXISTS idx_events_queued_at   ON events(queued_at);
                    CREATE INDEX IF NOT EXISTS idx_events_type_status ON events(type, status);
                """)
                print(f"[ephemeral] Migration: created `events` table for SQLite-backed queue")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to create events table: {e}")
        conn.commit()
        conn.close()

    # ── Jobs (meeting job metadata) ──

    def upsert_job(self, job_id: str, updates: dict) -> dict:
        """Insert or update a job record. Only columns present in *updates*
        are changed — safe for partial updates from multiple touchpoints.
        Always bumps ``updated_at = CURRENT_TIMESTAMP``.

        Returns the full row after the upsert.
        """
        allowed = {
            "title", "result", "attendees", "email_recipients", "pipeline_steps",
            "original_filename",
            "audio_url", "audio_size_bytes", "audio_duration_sec", "error_message",
            "transcript_segment_count", "transcript_char_count",
            "summary_char_count", "has_analysis", "analysis_char_count",
            "total_prompt_tokens", "total_completion_tokens", "total_tokens",
            "llm_provider", "llm_model", "input_cost", "output_cost", "total_cost",
            "delivery_attempted", "delivery_results",
            "event_type", "whisper_model", "diarization_available", "device",
            "config_snapshot",
            "completed_at",
        }
        # Build SET clause + INSERT columns from provided updates
        set_parts = []
        all_params = [job_id]  # ? for id in INSERT
        insert_cols_list = ["id"]
        for key, value in updates.items():
            if key in allowed:
                set_parts.append(f"{key} = ?")
                all_params.append(value)
                insert_cols_list.append(key)
        if not set_parts:
            return self.get_job(job_id) or {}

        # updated_at is always bumped (literal SQL — no parameter)
        set_parts.append("updated_at = CURRENT_TIMESTAMP")

        conn = self._get_conn()
        insert_cols = ", ".join(insert_cols_list)
        insert_placeholders = ", ".join("?" for _ in insert_cols_list)
        # SET params = all values except the initial job_id (reused from INSERT)
        set_clause = ", ".join(set_parts)
        conn.execute(
            f"""INSERT INTO jobs ({insert_cols})
                VALUES ({insert_placeholders})
                ON CONFLICT(id) DO UPDATE SET {set_clause}""",
            all_params + all_params[1:],  # [job_id, vals...] + [vals...]
        )
        conn.commit()
        return self.get_job(job_id) or {}

    def get_job(self, job_id: str) -> Optional[dict]:
        """Fetch a single job by ID. Returns None if not found."""
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        return dict(row) if row else None

    def query_jobs(self, limit: int = 100, offset: int = 0,
                   result_filter: Optional[str] = None) -> List[dict]:
        """List jobs, newest first. Optionally filter by result."""
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if result_filter:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE result = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (result_filter, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Attendees (registered meeting participants) ──

    def register_attendee(self, name: str, email: str = "",
                          source: str = "new_job_form",
                          job_id: Optional[str] = None,
                          is_non_speaking: bool = False):
        """Insert or update an attendee record.

        *source* indicates how the attendee was entered:
          - ``"new_job_form"``   — from the UploadPanel at job creation
          - ``"manual_labeling"`` — from the SpeakerLabelModal mid-pipeline

        *is_non_speaking* marks the attendee as present-but-silent for the
        most recent meeting this record was touched by (``True``) or as a
        speaking attendee (``False``). See the per-meeting caveat in
        ``register_attendees``.

        Dedup strategy:
          - Always dedup on ``(name, resolved_email)`` where resolved_email is
            the provided email or a deterministic ``@voiceprint.local`` fallback.
            This prevents duplicate rows when the same person is registered from
            different ``source`` values (``new_job_form`` vs ``manual_labeling``).
          - ``last_seen`` is always bumped so the registry tracks recency.
          - ``last_job_id`` is always updated to the most recent job.
        """
        def _do_single():
            conn = self._get_conn()

            # Resolve empty emails to a deterministic key so dedup never falls
            # back to (name, source), which creates duplicate rows.
            if email and email.strip():
                resolved_email = email.strip()
            else:
                slug = name.strip().lower().replace(" ", ".").replace("_", ".")
                slug = "".join(c for c in slug if c.isalnum() or c in ".-")
                resolved_email = f"{slug}@voiceprint.local"

            existing = conn.execute(
                "SELECT id FROM attendees WHERE name=? AND email=?",
                (name, resolved_email),
            ).fetchone()

            now = datetime.utcnow().isoformat()
            if existing:
                conn.execute(
                    "UPDATE attendees SET email=?, source=?, job_id=?, "
                    "last_job_id=?, is_non_speaking=?, last_seen=CURRENT_TIMESTAMP WHERE id=?",
                    (resolved_email, source, job_id, job_id, int(is_non_speaking), existing[0]),
                )
            else:
                conn.execute(
                    "INSERT INTO attendees (name, email, source, job_id, last_job_id, created_at, last_seen, is_non_speaking) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (name, resolved_email, source, job_id, job_id, now, now, int(is_non_speaking)),
                )
            conn.commit()

        try:
            self._retry_on_io_error(_do_single)
        except sqlite3.OperationalError as e:
            print(f"[ephemeral] ⚠️  Failed to register attendee '{name}': "
                  f"{e} (sqlite3_code={getattr(e, 'sqlite_errorcode', 'N/A')})")
            raise

    def register_attendees(self, names: List[str], emails: List[str] = None,
                           source: str = "new_job_form",
                           job_id: Optional[str] = None,
                           non_speaking: Optional[set] = None):
        """Bulk-register multiple attendees at once.

        *non_speaking* is an optional set of attendee names (case-insensitive)
        that were present but did not speak in the meeting. They are flagged
        ``is_non_speaking=1``; everyone else gets ``0``. Because attendees dedup
        on ``(name, email)`` keeping the most recent row, this column reflects
        the *latest* meeting this attendee was registered for — per-meeting
        speaking status lives in the job's ``metadata.json``
        (``non_speaking_attendees``).

        Performs a single commit for the whole batch (instead of one per
        attendee), then runs a passive WAL checkpoint to keep the WAL file
        trimmed. Retries on transient disk I/O errors.
        """
        emails = emails or []
        non_speaking_lower = {n.strip().lower() for n in (non_speaking or set())}

        def _do_batch():
            conn = self._get_conn()
            for i, name in enumerate(names):
                email = emails[i] if i < len(emails) else ""
                is_ns = int(name.strip().lower() in non_speaking_lower)
                if email and email.strip():
                    existing = conn.execute(
                        "SELECT id FROM attendees WHERE name=? AND email=?",
                        (name, email.strip()),
                    ).fetchone()
                else:
                    existing = conn.execute(
                        "SELECT id FROM attendees WHERE name=? AND source=?",
                        (name, source),
                    ).fetchone()

                now = datetime.utcnow().isoformat()
                if existing:
                    conn.execute(
                        "UPDATE attendees SET email=?, source=?, job_id=?, "
                        "last_job_id=?, is_non_speaking=?, last_seen=CURRENT_TIMESTAMP WHERE id=?",
                        (email, source, job_id, job_id, is_ns, existing[0]),
                    )
                else:
                    conn.execute(
                        "INSERT INTO attendees (name, email, source, job_id, "
                        "last_job_id, created_at, last_seen, is_non_speaking) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (name, email, source, job_id, job_id, now, now, is_ns),
                    )
            conn.commit()
            # Trim WAL after batch write to prevent unbounded growth
            try:
                conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            except Exception:
                pass

        try:
            self._retry_on_io_error(_do_batch)
        except sqlite3.OperationalError as e:
            print(f"[ephemeral] ⚠️  Failed to register {len(names)} attendee(s): "
                  f"{e} (sqlite3_code={getattr(e, 'sqlite_errorcode', 'N/A')})")
            raise

    def delete_attendee_by_name(self, name: str):
        """Remove an attendee record by name.

        Used when a voiceprint is overwritten during re-labeling and the old
        attendee registration becomes stale. Call this alongside
        delete_voiceprint_by_name to keep both DBs in sync.
        """
        conn = self._get_conn()
        # DIAGNOSTIC: check what we're about to delete
        _before = conn.execute(
            "SELECT id, name, email, source, job_id FROM attendees WHERE name=?",
            (name,)
        ).fetchall()
        cursor = conn.execute("DELETE FROM attendees WHERE name = ?", (name,))
        conn.commit()
        if cursor.rowcount > 0:
            print(f"[ephemeral] 🗑️  Deleted attendee '{name}': "
                  f"{[dict(id=r[0], name=r[1], email=r[2]) for r in _before]}")
        else:
            print(f"[ephemeral] 🗑️  Attempted delete of attendee '{name}' but 0 rows matched. "
                  f"Existing rows with that name: {[dict(id=r[0], name=r[1], email=r[2]) for r in _before]}")

    def query_attendees(self, name: str = "", limit: int = 50) -> List[dict]:
        """Search registered attendees by name (substring match)."""
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if name:
            rows = conn.execute(
                "SELECT * FROM attendees WHERE name LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (f"%{name}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM attendees ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_attendees(self, limit: int = 100) -> List[dict]:
        """List all registered attendees, newest first."""
        return self.query_attendees("", limit=limit)

    # ── Action Items ──

    def save_action_items(self, job_id: str, items: List[dict], meeting_title: str = ""):
        """Bulk-save action items extracted from a meeting.

        Every entry is preserved with an automatic `created_at` timestamp for
        full audit history. Repeated action items across meetings are kept
        intentionally — repetition signals unresolved or recurring work.
        """
        conn = self._get_conn()
        conn.execute(
            "UPDATE action_items SET status='completed' WHERE source_meeting=? AND status='open'",
            (meeting_title,),
        )
        for item in items:
            conn.execute(
                """INSERT INTO action_items
                   (job_id, description, assignee, deadline, priority, source_meeting)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    job_id,
                    item.get("description", ""),
                    item.get("assignee", ""),
                    item.get("deadline", ""),
                    item.get("priority", "medium"),
                    meeting_title,
                ),
            )
        conn.commit()
        print(f"[ephemeral] Saved {len(items)} action items for '{meeting_title}' (job={job_id[:8]})")

    def query_action_items(
        self, assignee: str = "", status: str = "", limit: int = 20
    ) -> List[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        parts = ["SELECT * FROM action_items WHERE 1=1"]
        params = []
        if assignee:
            parts.append("AND assignee LIKE ?")
            params.append(f"%{assignee}%")
        if status:
            parts.append("AND status = ?")
            params.append(status)
        parts.append("ORDER BY created_at DESC LIMIT ?")
        params.append(limit)
        rows = conn.execute(" ".join(parts), params).fetchall()
        return [dict(r) for r in rows]

    # ── Contacts ──

    def upsert_contact(self, name: str, email: str = "", org: str = "",
                       role: str = "", phone: str = "", meeting: str = ""):
        conn = self._get_conn()
        existing = conn.execute(
            "SELECT id FROM contacts WHERE name=? OR (email!='' AND email=?)",
            (name, email),
        ).fetchone()
        if existing:
            conn.execute(
                """UPDATE contacts SET email=COALESCE(NULLIF(?,''),email),
                   organization=COALESCE(NULLIF(?,''),organization),
                   role=COALESCE(NULLIF(?,''),role),
                   phone=COALESCE(NULLIF(?,''),phone),
                   last_mentioned=CURRENT_TIMESTAMP
                   WHERE id=?""",
                (email, org, role, phone, existing[0]),
            )
        else:
            conn.execute(
                "INSERT INTO contacts (name, email, organization, role, phone, source_meeting) VALUES (?,?,?,?,?,?)",
                (name, email, org, role, phone, meeting),
            )
        conn.commit()

    def query_contacts(self, name: str = "", limit: int = 20) -> List[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if name:
            rows = conn.execute(
                "SELECT * FROM contacts WHERE name LIKE ? ORDER BY last_mentioned DESC LIMIT ?",
                (f"%{name}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM contacts ORDER BY last_mentioned DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Budgets ──

    def save_budgets(self, job_id: str, budgets: List[dict], meeting_title: str = ""):
        """Bulk-save budget items.

        Every entry is preserved with an automatic `created_at` timestamp.
        Repeated budget items across meetings are kept intentionally — seeing
        "Server costs — $15,000" in three meetings tells you it was a recurring topic.
        """
        conn = self._get_conn()
        for b in budgets:
            conn.execute(
                """INSERT INTO budgets (job_id, description, amount, currency, category, source_meeting)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    job_id,
                    b.get("description", ""),
                    b.get("amount"),
                    b.get("currency", "USD"),
                    b.get("category", ""),
                    meeting_title,
                ),
            )
        conn.commit()
        print(f"[ephemeral] Saved {len(budgets)} budget items for '{meeting_title}' (job={job_id[:8]})")

    def query_budgets(self, category: str = "", limit: int = 20) -> List[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if category:
            rows = conn.execute(
                "SELECT * FROM budgets WHERE category LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{category}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM budgets ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Decisions ──

    def save_decisions(self, job_id: str, decisions: List[dict], meeting_title: str = ""):
        """Bulk-save decisions.

        Every entry is preserved with an automatic `created_at` timestamp.
        Repeated decisions across meetings are kept intentionally — revisiting
        a decision is meaningful context.
        """
        conn = self._get_conn()
        for d in decisions:
            conn.execute(
                """INSERT INTO decisions (job_id, description, rationale, made_by, source_meeting)
                   VALUES (?, ?, ?, ?, ?)""",
                (job_id, d.get("description", ""), d.get("rationale", ""),
                 d.get("made_by", ""), meeting_title),
            )
        conn.commit()
        print(f"[ephemeral] Saved {len(decisions)} decisions for '{meeting_title}' (job={job_id[:8]})")

    def query_decisions(self, keyword: str = "", limit: int = 20) -> List[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if keyword:
            rows = conn.execute(
                "SELECT * FROM decisions WHERE description LIKE ? OR rationale LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{keyword}%", f"%{keyword}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Notes (free-form key-value) ──

    def save_note(self, job_id: str, topic: str, content: str):
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO notes (job_id, topic, content)
               VALUES (?, ?, ?)
               ON CONFLICT(job_id, topic) DO UPDATE SET content=excluded.content,
               created_at=CURRENT_TIMESTAMP""",
            (job_id, topic, content),
        )
        conn.commit()

    def query_notes(self, topic: str = "") -> List[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if topic:
            rows = conn.execute(
                "SELECT * FROM notes WHERE topic LIKE ? ORDER BY created_at DESC", (f"%{topic}%",)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM notes ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

    # ── General query (agent-friendly) ──

    def query_all(self, table: str, q: str = "", limit: int = 10) -> List[dict]:
        """Unified search across any table by keyword."""
        table = table.lower()
        if table not in ("jobs", "attendees", "action_items", "contacts", "budgets", "decisions", "notes", "events"):
            return []
        # Not every table has a `created_at` column (contacts → last_mentioned,
        # events → queued_at for the SQLite-backed queue). Map each table to its
        # closest timestamp column so ORDER BY never hits "no such column".
        sort_col = {"contacts": "last_mentioned", "events": "queued_at"}.get(table, "created_at")
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        if q and table == "jobs":
            rows = conn.execute(
                "SELECT * FROM jobs WHERE title LIKE ? OR id LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "attendees":
            rows = conn.execute(
                "SELECT * FROM attendees WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "action_items":
            rows = conn.execute(
                "SELECT * FROM action_items WHERE description LIKE ? OR assignee LIKE ? OR deadline LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "budgets":
            rows = conn.execute(
                "SELECT * FROM budgets WHERE description LIKE ? OR category LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "decisions":
            rows = conn.execute(
                "SELECT * FROM decisions WHERE description LIKE ? OR rationale LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "contacts":
            rows = conn.execute(
                f"SELECT * FROM contacts WHERE name LIKE ? OR email LIKE ? OR organization LIKE ? OR role LIKE ? ORDER BY {sort_col} DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "notes":
            rows = conn.execute(
                "SELECT * FROM notes WHERE topic LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM {table} ORDER BY {sort_col} DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def row_count(self, table: str) -> int:
        """Return the total number of rows in a table using COUNT(*).

        Avoids fetching all rows into memory (unlike query_all with a large limit).
        """
        table = table.lower()
        if table not in ("jobs", "attendees", "action_items", "contacts", "budgets", "decisions", "notes", "events"):
            return 0
        conn = self._get_conn()
        row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
        return row[0] if row else 0

    def table_columns(self, table: str) -> List[str]:
        """Return the actual column names of a table in DB order.

        Uses PRAGMA table_info so the DevPanel always reflects the live schema
        (self-heals when migrations add new columns). The table name is checked
        against a fixed allow-list before interpolation.
        """
        table = table.lower()
        if table not in ("jobs", "attendees", "action_items", "contacts", "budgets", "decisions", "notes", "events"):
            return []
        conn = self._get_conn()
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return [r[1] for r in rows]

    def close_action_item(self, item_id: int):
        conn = self._get_conn()
        conn.execute("UPDATE action_items SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?", (item_id,))
        conn.commit()

    # ── Queue / Events (SQLite-backed event queue) ──

    def enqueue_event(self, source: str, event_type: str, data: dict,
                      priority: int = 0, ttl_seconds: int = 86400,
                      max_retries: int = 5) -> str:
        """Insert a new pending event into the queue.

        Args:
            source: Event origin ('transcription' or 'agent-runner')
            event_type: Event type ('ready_for_processing', 'labeling_needed',
                        'failed', 'delivery_approved', etc.)
            data: Arbitrary JSON-serializable payload
            priority: Higher = processed first (default 0)
            ttl_seconds: Auto-delete after this many seconds post-completion
                         (default 86400 = 24h; None = never expire)
            max_retries: Max retry attempts before moving to DLQ (default 5)

        Returns:
            The generated event ID (UUID4 hex)
        """
        import uuid
        event_id = str(uuid.uuid4())
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO events (id, source, type, data, priority, max_retries, ttl_seconds)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (event_id, source, event_type, json.dumps(data), priority, max_retries, ttl_seconds),
        )
        conn.commit()
        return event_id

    def claim_event(self, types_filter: Optional[list] = None) -> Optional[dict]:
        """Atomically claim the highest-priority pending event.

        Uses BEGIN IMMEDIATE + single-statement UPDATE with subquery to
        prevent race conditions between the Python backend and agent runner,
        both of which may call this concurrently.

        Args:
            types_filter: Optional list of event types to restrict claiming to
                          (e.g. ['ready_for_processing']). None = claim any type.

        Returns:
            The claimed event as a dict, or None if no pending events match.
        """
        conn = self._get_conn()
        conn.execute("BEGIN IMMEDIATE")
        try:
            if types_filter:
                placeholders = ",".join("?" for _ in types_filter)
                row = conn.execute(
                    f"""SELECT id FROM events
                        WHERE status='pending'
                          AND type IN ({placeholders})
                        ORDER BY priority DESC, queued_at ASC
                        LIMIT 1""",
                    types_filter,
                ).fetchone()
            else:
                row = conn.execute(
                    """SELECT id FROM events
                       WHERE status='pending'
                       ORDER BY priority DESC, queued_at ASC
                       LIMIT 1"""
                ).fetchone()

            if row is None:
                conn.commit()
                return None

            event_id = row[0]
            now = datetime.utcnow().isoformat()
            conn.execute(
                "UPDATE events SET status='processing', claimed_at=? WHERE id=?",
                (now, event_id),
            )

            # Fetch the full row
            conn.row_factory = sqlite3.Row
            full = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            conn.commit()
            result = dict(full) if full else None
            # Parse the data JSON string back to a dict
            if result and isinstance(result.get("data"), str):
                try:
                    result["data"] = json.loads(result["data"])
                except (json.JSONDecodeError, TypeError):
                    pass
            return result
        except Exception:
            conn.rollback()
            raise

    def complete_event(self, event_id: str) -> bool:
        """Mark an event as completed.

        Returns True if a row was updated, False if not found or not in processing state.
        """
        conn = self._get_conn()
        now = datetime.utcnow().isoformat()
        cursor = conn.execute(
            "UPDATE events SET status='completed', completed_at=? WHERE id=? AND status='processing'",
            (now, event_id),
        )
        conn.commit()
        return cursor.rowcount > 0

    def fail_event(self, event_id: str, error_message: str = "") -> bool:
        """Mark an event as failed.

        If retry_count < max_retries: resets to 'pending' for re-delivery.
        If exhausted: moves to 'failed' status (dead letter).

        Returns True if a row was updated, False if not found or not in processing state.
        """
        conn = self._get_conn()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT retry_count, max_retries FROM events WHERE id=? AND status='processing'",
                (event_id,),
            ).fetchone()
            if row is None:
                conn.commit()
                return False

            retry_count = row[0] + 1
            max_retries = row[1]

            if retry_count < max_retries:
                conn.execute(
                    """UPDATE events SET status='pending', retry_count=?,
                         error_message=?, claimed_at=NULL
                       WHERE id=?""",
                    (retry_count, error_message, event_id),
                )
            else:
                conn.execute(
                    "UPDATE events SET status='failed', retry_count=?, error_message=? WHERE id=?",
                    (retry_count, error_message, event_id),
                )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise

    def reclaim_stale_events(self, max_age_seconds: int = 300) -> int:
        """Reset events stuck in 'processing' for too long back to 'pending'.

        Handles crash recovery — if the agent runner died mid-job, its claimed
        events are released after ``max_age_seconds``.

        Args:
            max_age_seconds: Age threshold in seconds (default 300 = 5 min)

        Returns:
            Number of events reclaimed.
        """
        conn = self._get_conn()
        cutoff = (datetime.utcnow() - __import__('datetime').timedelta(seconds=max_age_seconds)).isoformat()
        cursor = conn.execute(
            "UPDATE events SET status='pending', retry_count=retry_count+1, claimed_at=NULL,"
            " error_message='Reclaimed after timeout' "
            "WHERE status='processing' AND claimed_at < ?",
            (cutoff,),
        )
        conn.commit()
        count = cursor.rowcount
        if count:
            print(f"[ephemeral] Reclaimed {count} stale event(s) stuck in 'processing'")
        return count

    def requeue_dlq_event(self, event_id: str) -> bool:
        """Move a failed (DLQ) event back to pending for reprocessing.

        Resets retry_count to 0 so it gets a full set of retry attempts again.
        Returns True if a row was updated.
        """
        conn = self._get_conn()
        cursor = conn.execute(
            "UPDATE events SET status='pending', retry_count=0, error_message=NULL WHERE id=? AND status='failed'",
            (event_id,),
        )
        conn.commit()
        return cursor.rowcount > 0

    def cleanup_expired_events(self) -> int:
        """Delete completed events older than their ttl_seconds.

        Events with ttl_seconds IS NULL are never deleted.
        Called periodically by the lifespan cleanup task.

        Returns:
            Number of events deleted.
        """
        conn = self._get_conn()
        now = datetime.utcnow().isoformat()
        # Delete completed events where (completed_at + ttl_seconds) < now
        cursor = conn.execute(
            """DELETE FROM events
               WHERE status='completed'
                 AND ttl_seconds IS NOT NULL
                 AND completed_at IS NOT NULL
                 AND datetime(completed_at, '+' || ttl_seconds || ' seconds') < ?""",
            (now,),
        )
        conn.commit()
        count = cursor.rowcount
        if count:
            print(f"[ephemeral] Cleaned up {count} expired completed event(s)")
        return count

    def get_queue_stats(self) -> dict:
        """Return queue depth by status.

        Returns:
            dict with keys: pending, processing, completed, failed, dlq, total
        """
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM events GROUP BY status"
        ).fetchall()
        stats = {"pending": 0, "processing": 0, "completed": 0, "failed": 0, "dlq": 0, "total": 0}
        for row in rows:
            s = row[0]
            c = row[1]
            if s in stats:
                stats[s] = c
            stats["total"] += c
        return stats
