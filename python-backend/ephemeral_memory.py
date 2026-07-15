"""
Ephemeral Memory — SQLite-backed cross-meeting context store.

Stores structured data extracted from meetings so the agent can retrieve context
across sessions: action items, contacts, budgets, decisions, and free-form notes.

All data is keyed by a semantic "topic" for easy agent lookup.
"""

import os
import json
import sqlite3
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

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.path.join(config.STORAGE_PATH, "ephemeral_memory.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    def _get_conn(self) -> sqlite3.Connection:
        """Get a thread-local SQLite connection. Creates one if this thread
        hasn't connected yet. Connections are NOT closed between operations
        — they are reused until the thread exits or close() is called."""
        if not hasattr(self._thread_local, "conn") or self._thread_local.conn is None:
            conn = sqlite3.connect(self.db_path)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._thread_local.conn = conn
        return self._thread_local.conn

    def close(self):
        """Close the thread-local connection if open. Safe to call multiple times."""
        conn = getattr(self._thread_local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._thread_local.conn = None

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL DEFAULT 'Untitled Meeting',
                result          TEXT NOT NULL DEFAULT 'pending',
                attendees       TEXT NOT NULL DEFAULT '[]',
                email_recipients TEXT NOT NULL DEFAULT '[]',
                pipeline_steps  TEXT NOT NULL DEFAULT '[]',
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
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

            CREATE INDEX IF NOT EXISTS idx_action_status ON action_items(status);
            CREATE INDEX IF NOT EXISTS idx_action_assignee ON action_items(assignee);
            CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
            CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic);
            CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category);
            CREATE INDEX IF NOT EXISTS idx_attendees_name ON attendees(name);
            CREATE INDEX IF NOT EXISTS idx_attendees_job ON attendees(job_id);
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

        # Check for config_snapshot column on jobs table
        jobs_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "config_snapshot" not in jobs_cols:
            try:
                conn.execute("ALTER TABLE jobs ADD COLUMN config_snapshot TEXT DEFAULT NULL")
                print(f"[ephemeral] Migration: added `config_snapshot` column to jobs table")
            except Exception as e:
                print(f"[ephemeral] ⚠️  Migration failed to add config_snapshot: {e}")
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
                          job_id: Optional[str] = None):
        """Insert or update an attendee record.

        *source* indicates how the attendee was entered:
          - ``"new_job_form"``   — from the UploadPanel at job creation
          - ``"manual_labeling"`` — from the SpeakerLabelModal mid-pipeline

        Dedup strategy (widened key):
          - When a real email is provided → upsert on ``(name, email)``.
            Same person entered from different sources → single row.
          - When email is empty → fall back to ``(name, source)`` as before.
          - ``last_seen`` is always bumped so the registry tracks recency.
          - ``last_job_id`` is always updated to the most recent job.
        """
        conn = self._get_conn()

        if email and email.strip():
            # Real email: upsert on (name, email) — strongest dedup
            existing = conn.execute(
                "SELECT id FROM attendees WHERE name=? AND email=?",
                (name, email.strip()),
            ).fetchone()
        else:
            # No email: fall back to (name, source)
            existing = conn.execute(
                "SELECT id FROM attendees WHERE name=? AND source=?",
                (name, source),
            ).fetchone()

        now = datetime.utcnow().isoformat()
        if existing:
            conn.execute(
                "UPDATE attendees SET email=?, source=?, job_id=?, "
                "last_job_id=?, last_seen=CURRENT_TIMESTAMP WHERE id=?",
                (email, source, job_id, job_id, existing[0]),
            )
        else:
            conn.execute(
                "INSERT INTO attendees (name, email, source, job_id, last_job_id, created_at, last_seen) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (name, email, source, job_id, job_id, now, now),
            )
        conn.commit()

    def register_attendees(self, names: List[str], emails: List[str] = None,
                           source: str = "new_job_form",
                           job_id: Optional[str] = None):
        """Bulk-register multiple attendees at once."""
        emails = emails or []
        for i, name in enumerate(names):
            email = emails[i] if i < len(emails) else ""
            self.register_attendee(name, email, source=source, job_id=job_id)

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
        if table not in ("jobs", "attendees", "action_items", "contacts", "budgets", "decisions", "notes"):
            return []
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
        elif q and table != "notes":
            rows = conn.execute(
                f"SELECT * FROM {table} WHERE description LIKE ? OR assignee LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        elif q and table == "notes":
            rows = conn.execute(
                "SELECT * FROM notes WHERE topic LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{q}%", f"%{q}%", limit),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM {table} ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def row_count(self, table: str) -> int:
        """Return the total number of rows in a table using COUNT(*).

        Avoids fetching all rows into memory (unlike query_all with a large limit).
        """
        table = table.lower()
        if table not in ("jobs", "attendees", "action_items", "contacts", "budgets", "decisions", "notes"):
            return 0
        conn = self._get_conn()
        row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
        return row[0] if row else 0

    def close_action_item(self, item_id: int):
        conn = self._get_conn()
        conn.execute("UPDATE action_items SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?", (item_id,))
        conn.commit()
