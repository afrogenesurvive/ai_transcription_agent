"""
Ephemeral Memory — SQLite-backed cross-meeting context store.

Stores structured data extracted from meetings so the agent can retrieve context
across sessions: action items, contacts, budgets, decisions, and free-form notes.

All data is keyed by a semantic "topic" for easy agent lookup.
"""

import os
import json
import sqlite3
from typing import List, Optional, Dict, Any
from datetime import datetime
from config import config


class EphemeralMemory:
    """Lightweight SQLite store for cross-meeting context.

    Tables:
      - action_items:   extracted to-dos with assignee, deadline, status
      - contacts:       people mentioned across meetings (name, email, org, role)
      - budgets:        financial figures mentioned (amount, currency, context)
      - decisions:      key decisions made (description, rationale)
      - notes:          free-form context notes (key-value pairs)
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.path.join(config.STORAGE_PATH, "ephemeral_memory.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")

        conn.executescript("""
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
        """)
        conn.commit()
        conn.close()

    # ── Action Items ──

    def save_action_items(self, job_id: str, items: List[dict], meeting_title: str = ""):
        """Bulk-save action items extracted from a meeting.

        Every entry is preserved with an automatic `created_at` timestamp for
        full audit history. Repeated action items across meetings are kept
        intentionally — repetition signals unresolved or recurring work.
        """
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        print(f"[ephemeral] Saved {len(items)} action items for '{meeting_title}' (job={job_id[:8]})")

    def query_action_items(
        self, assignee: str = "", status: str = "", limit: int = 20
    ) -> List[dict]:
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        return [dict(r) for r in rows]

    # ── Contacts ──

    def upsert_contact(self, name: str, email: str = "", org: str = "",
                       role: str = "", phone: str = "", meeting: str = ""):
        conn = sqlite3.connect(self.db_path)
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
        conn.close()

    def query_contacts(self, name: str = "", limit: int = 20) -> List[dict]:
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        return [dict(r) for r in rows]

    # ── Budgets ──

    def save_budgets(self, job_id: str, budgets: List[dict], meeting_title: str = ""):
        """Bulk-save budget items.

        Every entry is preserved with an automatic `created_at` timestamp.
        Repeated budget items across meetings are kept intentionally — seeing
        "Server costs — $15,000" in three meetings tells you it was a recurring topic.
        """
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        print(f"[ephemeral] Saved {len(budgets)} budget items for '{meeting_title}' (job={job_id[:8]})")

    def query_budgets(self, category: str = "", limit: int = 20) -> List[dict]:
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        return [dict(r) for r in rows]

    # ── Decisions ──

    def save_decisions(self, job_id: str, decisions: List[dict], meeting_title: str = ""):
        """Bulk-save decisions.

        Every entry is preserved with an automatic `created_at` timestamp.
        Repeated decisions across meetings are kept intentionally — revisiting
        a decision is meaningful context.
        """
        conn = sqlite3.connect(self.db_path)
        for d in decisions:
            conn.execute(
                """INSERT INTO decisions (job_id, description, rationale, made_by, source_meeting)
                   VALUES (?, ?, ?, ?, ?)""",
                (job_id, d.get("description", ""), d.get("rationale", ""),
                 d.get("made_by", ""), meeting_title),
            )
        conn.commit()
        conn.close()
        print(f"[ephemeral] Saved {len(decisions)} decisions for '{meeting_title}' (job={job_id[:8]})")

    def query_decisions(self, keyword: str = "", limit: int = 20) -> List[dict]:
        conn = sqlite3.connect(self.db_path)
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
        conn.close()
        return [dict(r) for r in rows]

    # ── Notes (free-form key-value) ──

    def save_note(self, job_id: str, topic: str, content: str):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """INSERT INTO notes (job_id, topic, content)
               VALUES (?, ?, ?)
               ON CONFLICT(job_id, topic) DO UPDATE SET content=excluded.content,
               created_at=CURRENT_TIMESTAMP""",
            (job_id, topic, content),
        )
        conn.commit()
        conn.close()

    def query_notes(self, topic: str = "") -> List[dict]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        if topic:
            rows = conn.execute(
                "SELECT * FROM notes WHERE topic LIKE ? ORDER BY created_at DESC", (f"%{topic}%",)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM notes ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ── General query (agent-friendly) ──

    def query_all(self, table: str, q: str = "", limit: int = 10) -> List[dict]:
        """Unified search across any table by keyword."""
        table = table.lower()
        if table not in ("action_items", "contacts", "budgets", "decisions", "notes"):
            return []
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        if q and table != "notes":
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
        conn.close()
        return [dict(r) for r in rows]

    def close_action_item(self, item_id: int):
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE action_items SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?", (item_id,))
        conn.commit()
        conn.close()
