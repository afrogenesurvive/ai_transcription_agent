# Attendee / Voiceprint Conflict Resolution — Expected Behavior

## Scenario Setup

1. **Job 001** is created with 4 speakers: **A, B, C, D** and completed successfully.  
   → Voiceprints enrolled for A, B, C, D.  
   → Attendee records created for A, B, C, D.

2. **Job 002** is created with the **same audio file** as Job 001, but the new job form has:
   - Existing registered attendees w/ voiceprints: **B, D**
   - New attendees: **E, F**

3. Diarization detects **4 speakers** (same audio → same 4 voices). Voiceprint matching finds:
   - Speakers matching **B** and **D** → pre-fill normally (no conflict).
   - Speakers matching **A** and **C** → **conflicted** because the form has E and F, but the voice matches A and C.

4. The **[`SpeakerLabelModal`](../../electron/src/renderer/components/SpeakerLabelModal.tsx#L103)** shows A/B radio selectors for the 2 conflicted speakers.

---

## Core Invariant

**In all scenarios, the final DB must have exactly 4 voiceprints and 4 attendee records.** There are only 4 unique people in the audio. The backend enforces this through:

| Mechanism                | Description                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Overwrite cleanup**    | For names in `overwrite_names`: deletes old voiceprint + attendee record before saving the new one |
| **Upsert via email key** | `ON CONFLICT(email) DO UPDATE` — same email → update; new email → insert                           |
| **Speaker-name cleanup** | `DELETE WHERE speaker_name=? AND email!=?` before each save prevents UNIQUE collisions             |
| **Dedup sweep**          | [`_dedup_attendees()`](../../python-backend/reconciliation.py#L480) removes duplicate attendee rows after registration                            |

---

## Case (a) — Overwrite BOTH Conflicts

User picks **"Use form entry"** for both conflicted speakers (E replaces A, F replaces C).

| Speaker slot | User choice               | Labels submitted | `overwrite_names` |
| ------------ | ------------------------- | ---------------- | ----------------- |
| (voice of A) | Use form entry: **E**     | E                | ✅ E in list      |
| B            | (pre-filled, no conflict) | B                | —                 |
| (voice of C) | Use form entry: **F**     | F                | ✅ F in list      |
| D            | (pre-filled, no conflict) | D                | —                 |

### Backend processing

1. **Drift audit** skips E and F (they're in `overwrite_names`).
2. **Overwrite cleanup** deletes old voiceprint **A** + attendee **A**.
3. **Overwrite cleanup** deletes old voiceprint **C** + attendee **C**.
4. **Batch save** creates new voiceprints for **E** and **F** (fresh INSERTs).
5. **Batch save** upserts **B** and **D** (existing rows UPDATE'd with new embeddings).

### Final DB state — 4 records each

| Voiceprints        | Attendees          |
| ------------------ | ------------------ |
| B                  | B                  |
| D                  | D                  |
| **E** (new, was A) | **E** (new, was A) |
| **F** (new, was C) | **F** (new, was C) |

---

## Case (b) — Overwrite 1, Keep 1

User picks **"Use form entry"** for E (overwrite A) but **"Use voice owner"** for C (keep C).

| Speaker slot | User choice            | Labels submitted | `overwrite_names` |
| ------------ | ---------------------- | ---------------- | ----------------- |
| (voice of A) | Use form entry: **E**  | E                | ✅ E in list      |
| B            | (pre-filled)           | B                | —                 |
| (voice of C) | Use voice owner: **C** | C                | ❌ not in list    |
| D            | (pre-filled)           | D                | —                 |

### Backend processing

1. **Drift audit** skips E (in `overwrite_names`).
2. **Overwrite cleanup** deletes old voiceprint **A** + attendee **A**.
3. **Drift audit** for C: embedding matches existing voiceprint C → `has_exact_name_match = true` → no drift reported ✓
4. **Batch save**: E gets a **new INSERT**, C gets an **UPDATE** (same name, refreshed embedding).

### Final DB state — 4 records each

| Voiceprints        | Attendees          |
| ------------------ | ------------------ |
| B                  | B                  |
| D                  | D                  |
| **E** (new, was A) | **E** (new, was A) |
| **C** (updated)    | **C** (updated)    |

---

## Case (c) — Keep BOTH Existing

User picks **"Use voice owner"** for both conflicted speakers (keep A, keep C).

| Speaker slot | User choice            | Labels submitted | `overwrite_names` |
| ------------ | ---------------------- | ---------------- | ----------------- |
| (voice of A) | Use voice owner: **A** | A                | ❌ not in list    |
| B            | (pre-filled)           | B                | —                 |
| (voice of C) | Use voice owner: **C** | C                | ❌ not in list    |
| D            | (pre-filled)           | D                | —                 |

### Backend processing

1. **Drift audit** for A: embedding matches existing voiceprint A → `has_exact_name_match = true` → no drift ✓
2. **Drift audit** for C: same → `has_exact_name_match = true` → no drift ✓
3. **No overwrite cleanup** runs (`overwrite_names` is empty).
4. **Batch save**: A, B, C, D all get **UPDATE**d with refreshed embeddings.

### Final DB state — 4 records each (identical set to Job 001)

| Voiceprints   | Attendees     |
| ------------- | ------------- |
| A (refreshed) | A (refreshed) |
| B (refreshed) | B (refreshed) |
| C (refreshed) | C (refreshed) |
| D (refreshed) | D (refreshed) |

---

## What Happens to Unused Form Entries (E and F)?

In cases (b) and (c), the E and F names typed into the new job form but **never assigned to a speaker slot** are **never persisted** — not to the attendee registry, not to `metadata.json`, and not to delivery. They only existed transiently in:

- React state (`labels`, `emails`)
- `form_entry_name` / `form_entry_email` fields on `SpeakerInfo` objects
- `excludedNonSpeaking` (frontend) → `excluded_non_speaking` (backend payload)

They are never committed to the attendee registry or voiceprint DB, and their names/emails are also stripped from the job's `metadata.json` (`attendees`, `attendeeEmails`, `email_recipients`) so they never appear in the meeting record or receive delivery.

---

## Cross-Meeting Status Changes & On-the-Fly Adoption (0.6.9-1)

The Speaker Label modal exposes the full registered-attendee registry via a per-speaker **"Assign known attendee…"** dropdown with two groups:

- **Voiceprint owners** — attendees with an enrolled voiceprint (from any prior meeting), tagged with the source job id.
- **Registered, no voiceprint** — attendees in the registry with no enrolled print (typically people who were present-but-silent in a prior meeting).

### Case (d) — No voiceprint in a prior meeting, speaking now

John was non-speaking in Job 001 (registered, `is_non_speaking=1`, **no voiceprint**). In Job 002 John speaks. The user selects John from the "Registered, no voiceprint" group → name/email auto-fill → on confirm a fresh voiceprint is enrolled for John (INSERT by email). From Job 003 onward John is a known voiceprint owner. Because John has no prior print, **no overwrite is needed** and no confirmation is shown.

If John was (wrongly) classified as non-speaking in Job 002's reconciliation (pre-ASR positional heuristic), assigning him to a speaker slot **live-hides him from the "Also present but did not speak" list** — the list now excludes any name assigned to a speaker slot.

### Case (e) — Adopting a voiceprint owner whose voice doesn't match (drift guard)

> **Proactive overwrite warning (before any drift check):** picking an attendee from the **"Voiceprint owners"** dropdown group (an attendee with a `sample_job_id`) immediately highlights the speaker row (`speaker-item--vp-overwrite`) and shows _"{name} already has an enrolled voiceprint (from job xxxxxxxx). Confirming this label will overwrite it with this recording."_ This fires on selection regardless of whether the voice matches, so the user knows the same-email upsert will replace the enrolled print before they even reach the drift/conflict checks below. Selecting a no-voiceprint attendee clears it; editing the name clears it. The dropdown group label reads **"Voiceprint owners — selecting overwrites (N)"**.

The user picks "Mike" (voiceprint owner from Job 001) for a speaker slot, but the current voice does **not** match Mike's enrolled print (similarity below [`VOICEPRINT_THRESHOLD`](../../python-backend/config.py#L92)). Without a guard, [`label_and_resume`](../../python-backend/routes/labeling.py#L934)'s email-key upsert would **silently replace** Mike's voiceprint with this new (mismatched) voice. [`verify_labels`](../../python-backend/routes/labeling.py#L313) now returns a `voice_drift_conflicts` entry for this case, and the modal shows an advisory inline notice (not a gate):

> ⚠️ **Mike** has an enrolled voiceprint from job 001…, but this voice doesn't match it (18% similarity). Saving will overwrite Mike's enrolled voiceprint. **[Use "Mike" & overwrite voiceprint]**

- **Use & overwrite** → Mike is added to `overwrite_names`; the drift audit skips him and the batch save upserts his print with this recording (email key preserved, `sample_job_id` → current job).

**Destructive-consequence note:** if the current voice matches a _different_ enrolled person (cross-match, e.g. John at 92%) and the user nevertheless insists on "Mike & overwrite", the overwrite cleanup deletes John's voiceprint (same semantics as the existing "Use form entry" overwrite). The dialog copy states the consequence.

### Warning-only attendee-presence check (new)

A new advisory check now runs during speaker-label verification. If an attendee was added to the job form but no speaker label in the current audio matched them, the backend returns an `attendee_presence_warnings` entry and the modal shows a non-blocking notice:

> ⚠️ “Alice was listed as an attendee for this meeting, but no speaker label in the current audio matched them.”

This is intentionally warning-only. It does not block submission, does not change the existing voiceprint conflict handling, and does not alter the existing overwrite / drift semantics. It simply helps the user notice when a listed attendee appears to be absent from the recording.

### Email-fill rule & the `@voiceprint.local` trap

When a dropdown attendee is selected:

- If they're in the current job's form (`in_form`), the **form email** is filled — the backend's email-mismatch correction ([`_inner_label_and_resume`](../../python-backend/routes/labeling.py#L975)) would force it anyway.
- Otherwise the **enrolled email** is used, preserving the voiceprint join key and avoiding an orphaned `@voiceprint.local` print created under a new email.

### Case (f) — Enrolled voiceprint present but not matched in this recording

An attendee typed into the job form who **has an enrolled voiceprint from a previous meeting** but whose voice was **not matched to any voice in this recording** (e.g. dialed in from a different device, or a stale attendee list) is handled deliberately:

- **No data in any input.** [`get_speaker_clips`](../../python-backend/routes/labeling.py#L607) Pass 3's positional fallback **skips** these attendees, so their name/email are **not** auto-filled into a speaker input — and the modal's mount pre-fill also guards against them (both the `form_entry_email` fill and the positional `suggestedEmails[i]` email fallback skip any email belonging to an unmatched enrolled attendee). (Previously `drone001`/`drone002` — enrolled but absent — got filled into empty speaker slots even though their voice wasn't in the audio.)
- **"Enrolled voiceprint not found in this recording" section.** They are surfaced in a dedicated section of the labeling modal, each with a **radio** to add them as a _present-but-did-not-speak_ attendee:
  - **Checked** → included in the meeting record + delivery as non-speaking (same as the "Also present but did not speak" list), with green feedback "✓ added as non-speaking — click to undo".
  - **Unchecked** → added to `excluded_non_speaking` and dropped from the meeting record + delivery (their voice wasn't in the audio).
  - **Tooltip** on each radio describes its action ("Mark … as present but did not speak", "Remove … from non-speaking attendees", or the assigned-state note).
  - **Deselect** — clicking an already-checked radio toggles it off (native radios don't fire `change` on re-click, so an `onClick` handler clears it).
- **Assigned state.** If the user assigns one of them to a speaker via the "Assign known attendee…" dropdown, the radio is **disabled**, the row is amber-highlighted, and a note reads "assigned to a speaker — this attendee's voiceprint will be overwritten". Assigning also clears any pending "add as non-speaking" mark.
- **Clear button per speaker (✕).** Each speaker's name/email set has a **clear** button (shown once a name or email is entered). Clicking it empties **both** inputs and resets all per-speaker conflict, drift, overwrite, A/B-choice, accepted-match, and warning state. If the cleared speaker was assigned one of these unmatched enrolled attendees, that attendee is **released** back to the "Enrolled voiceprint not found" section: the radio is re-enabled and **deselected** (not auto-checked), so the user can re-opt them in as non-speaking or leave them out of the record entirely.

### Scope of the drift guard

The drift check runs on every [`verify_labels`](../../python-backend/routes/labeling.py#L313) call (dropdown selection, name blur, and the pre-submit verification pass), so **typing** an enrolled attendee's name with a mismatched voice surfaces the notice too — not just dropdown picks.

Two mechanisms guarantee this:

1. **A/B conflict losers are auto-excluded.** When the user resolves a conflict by choosing **"Use voice owner"** (the existing voiceprint owner wins), the form entry that lost is automatically added to `excluded_non_speaking`. Since that form entry's voice was never in the audio, it must not be treated as a "present but did not speak" attendee.
2. **Manual removal via the X button.** In the "Also present but did not speak" section of the labeling modal, each non-speaking attendee has an **X** button. Removing one adds it to `excluded_non_speaking`, so it is excluded from the meeting record and delivery.

`excluded_non_speaking` is sent with the speaker-labeling request and the backend drops those names from the reconciled attendee list in **both** the post-ASR and pre-ASR/resumed labeling paths, and prunes their emails from `email_recipients`.

> **Bug fixed (0.5.11+):** Previously, unused form entries (e.g. `mike`, `smart mike`) were classified as `non_speaking_attendees` by [`_reconcile_attendees()`](../../python-backend/reconciliation.py#L19) and persisted into `metadata.json`/delivery even though the DB stayed clean — producing 6 attendees / 6 delivery emails for an audio file with only 4 real people. The DB registration already deferred on A/B conflicts; now metadata + delivery apply the same exclusion.
>
> **Follow-up fix (0.5.10-5):** The pre-ASR/resumed labeling path still leaked excluded entries' emails into `email_recipients`. [`_run_pipeline_resumed_sync()`](../../python-backend/services/pipeline.py#L813) stripped the excluded names from the reconciliation _before_ [`_update_metadata_with_reconciliation()`](../../python-backend/reconciliation.py#L213) ran, so its email-prune was a no-op (0 overwrites → 6 deliveries, 1 overwrite → 5). The metadata writer now resolves each excluded name's email from the original form data and prunes it, so every variant converges to **4 attendees / 4 deliveries**. Also fixed a latent `NameError` in the resumed path's re-pause branch (an undefined `unregistered` variable) by reusing the `voiceprint_matches_by_speaker` map saved during the initial pre-ASR pause. The renderer now actually sends `excluded_non_speaking`: [`App.tsx`](../../electron/src/renderer/App.tsx#L684) forwards `excludedNonSpeaking` to `label_and_resume` (it was previously dropped, leaving the exclusion empty — 6 attendees / 6 deliveries), and the voice-match-warnings dialog records replaced form entries as conflict losers.

---

## Guard: Duplicate Name Rejection

Before submitting, the frontend rejects submissions where two speakers share the same name:

```
Two speakers cannot share the same name — the backend would lose
one speaker's segment data in the `known` dict during label application.
```

The [`handleConfirm`](../../electron/src/renderer/components/SpeakerLabelModal.tsx#L458) function checks `nameCounts` and sets inline errors for duplicates, preventing submission.

---

## Architectural Flow

```
UploadPanel (form: B, D, E, F)
  │
  ▼
Pipeline pauses for labeling
  │
  ▼
SpeakerLabelModal (mount)
  ├─ Voiceprint matching → 4 slots
  │   ├─ B ✓ (pre-filled)
  │   ├─ D ✓ (pre-filled)
  │   ├─ A→E ⚠️ (conflict — A/B selector)
  │   └─ C→F ⚠️ (conflict — A/B selector)
  │
  ▼
User makes A/B choices per conflicted slot
  │
  ▼
handleConfirm()
  ├─ Checks duplicate names
  ├─ Checks voiceprint name/email conflicts
  ├─ Voice-match verification
  ├─ Computes excludedNonSpeaking:
  │    ├─ A/B conflict losers (form entry lost to "use voice owner")
  │    └─ Non-speaking attendees removed via the X button
  └─ Calls onConfirm(result, { overwriteNames, excludedNonSpeaking })
      │
      ▼
the speaker-labeling endpoint  (body: labels, overwrite_names, excluded_non_speaking)
  ├─ Extract embeddings for all 4 labels
  ├─ Drift audit (skip overwrite_names)
  ├─ Overwrite cleanup → delete old voiceprint + attendee
  ├─ Batch-save 4 voiceprints (INSERT or UPDATE)
  ├─ Drop excluded_non_speaking from the non-speaking attendee list
  │    (post-ASR inline block + pre-ASR/resumed _run_pipeline_resumed_sync)
  ├─ Prune excluded attendees' emails from email_recipients
  ├─ Build reconciled attendee list (4 names)
  ├─ Register 4 attendees (with dedup sweep)
  └─ Continue pipeline
```

---

## Debugging: How to Verify DB State

```bash
# Path to storage
STORAGE=~/Library/Application\ Support/Transcription\ Agent/storage

# Check voiceprints DB
sqlite3 "$STORAGE/voiceprints.db" \
  "SELECT id, speaker_name, email, sample_job_id FROM voiceprints;"

# Check attendees DB (the attendee registry lives in ephemeral_memory.db —
# there is no separate attendees.db; a stray attendees.db file is a leftover
# from an old version of this debugging command and is never written to)
sqlite3 "$STORAGE/ephemeral_memory.db" \
  "SELECT id, name, email, source, job_id, last_seen FROM attendees ORDER BY name;"

# Check job metadata for a specific job
cat "$STORAGE/<job_id>/metadata.json" | jq '.attendees'
```

> **Note:** Since `0.5.10-3`, attendee-registration failures are no longer
> silent. If the registry write fails (e.g. transient SQLite `disk I/O error`),
> the job is flagged with a `warnings` entry in status.json and [`complete_job()`](../../python-backend/routes/jobs.py#L156)
> refuses to mark it `complete` until the records are rebuilt from
> `metadata.json` (auto-repaired on the next backend start via the startup
> sweep). A terminal `complete_with_warning` status means the repair has not
> succeeded yet.

> **Note:** Since `0.5.10-8`, the startup sweep also repairs otherwise-complete
> jobs whose attendee registry is silently short — registrations deferred on A/B
> conflicts in the pre-ASR labeling path never re-register and leave no warning
> flag. [`_job_attendee_shortfall()`](../../python-backend/reconciliation.py#L557) detects the shortfall without bumping
> `last_seen` for healthy jobs and only re-registers names that still have an
> enrolled voiceprint (so overwritten/replaced attendees are not resurrected),
> and [`complete_job()`](../../python-backend/routes/jobs.py#L156) now always reconciles the registry from `metadata.json`
> before marking a job complete.

> **Note:** Since `0.5.10-7`, the [`VoiceprintManager`](../../python-backend/voiceprint.py#L80) applies the same
> [`_retry_on_io_error()`](../../python-backend/voiceprint.py#L216) treatment (reset the SQLite connection between retries)
> to _every_ voiceprint DB operation, and [`_get_known_embeddings()`](../../python-backend/voiceprint.py#L592) dedupes the
> conflict-matching load by email first (the unique key), then by name.

## Expected Counts Summary

| Scenario                | Voiceprints        | Attendees          | Notes                               |
| ----------------------- | ------------------ | ------------------ | ----------------------------------- |
| (a) Overwrite both      | **4** (B, D, E, F) | **4** (B, D, E, F) | A and C deleted entirely            |
| (b) Overwrite 1, keep 1 | **4** (B, D, E, C) | **4** (B, D, E, C) | A deleted; C refreshed              |
| (c) Keep both           | **4** (A, B, C, D) | **4** (A, B, C, D) | All refreshed; E, F never persisted |

<!-- ------
I just manually tested the following scenario:

1. Job 001 is created with 4 speakers: A, B, C, D and completed successfully.
2. Job 002 is created with the **same audio file** as Job 001, but the new job form has:
   - Existing registered attendees w/ voiceprints: **B, D**
   - New attendees: **E, F**
3. The SpeakerLabelModal appears with 4 speaker slots.

There were 2 conflicts.
mike and smart mike replaced leila and bob smith.
However, the attendees db has 6 records and the voiceprints db has 5 records.

Check the user data storage for job files and investigate why? -->
