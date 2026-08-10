"""Shared constants extracted from main.py (Phase 0).

Pure data only — nothing here reads service singletons or mutates global state.
``PIPELINE_TIMEOUT_SECONDS`` keeps the same import-time snapshot of
``config.PIPELINE_TIMEOUT_SECONDS`` that main.py used (it does not refresh if
the Config UI rewrites the env at runtime — behavior is identical to before).
"""

from config import config

# Inter-job cooldown (seconds) between sequential ML pipeline runs so MPS
# fragmented memory can settle. Only applied when KEEP_MODELS_WARM is enabled.
_MIN_INTERJOB_COOLDOWN_SEC = 20.0

# ML pipeline statuses that indicate a job is actively running in the pipeline.
# Shared across upload endpoints, active job listing, and cleanup logic.
# NOTE: pending_raw_review and pending_delivery_review are intentionally
# excluded — they are post-ML-pipeline human review gates that should
# survive backend restarts. The upload-blocking variant below includes
# them so new uploads are still blocked while a job awaits review.
ML_PIPELINE_STATUSES = frozenset({
    "uploaded", "initializing", "processing_diarization",
    "matching_voiceprints", "processing_transcription", "aligning",
    "paused_for_labeling", "resuming",
})

# Extended set for upload guards only — includes review-gate states so
# new uploads are blocked while a job is paused for user review.
ML_UPLOAD_BLOCKING_STATUSES = frozenset({
    *ML_PIPELINE_STATUSES,
    "pending_raw_review", "pending_delivery_review",
})

# Maximum wall-clock time (seconds) for the entire ML pipeline before
# it's considered hung and fails itself. Prevents silent MPS hangs when
# multiple pipelines contend for GPU resources.
# Editable from the Config UI as "Pipeline/Polling Timeout (minutes)".
PIPELINE_TIMEOUT_SECONDS = config.PIPELINE_TIMEOUT_SECONDS

# ── Simplified step messages for the mini live log ──
# Maps backend status values → short human-readable messages shown in the UI.
_STATUS_MESSAGES = {
    "uploaded":                 "📤 Uploading audio...",
    "initializing":             "🔧 Setting up transcription engine",
    "processing_diarization":   "🔬 Diarizing speakers...",
    "matching_voiceprints":     "🧬 Matching voice prints",
    "paused_for_labeling":      "⏸️ Paused — waiting for speaker labels",
    "resuming":                 "▶️ Resuming pipeline after labeling",
    "processing_transcription": "🎤 Transcribing audio...",
    "aligning":                 "🔗 Aligning transcript to speakers",
    "transcribed":              "✅ Transcript ready — sending to AI",
    "pending_raw_review":       "⏸️ Paused — waiting for transcript review",
    "ready_for_agent":          "🤖 Starting AI agent processing",
    "pending_delivery_review":  "⏸️ Paused — waiting for delivery review",
    "delivered":                "📬 Results delivered!",
    "complete":                 "✅ All done!",
    "complete_with_warning":    "⚠️ Completed with warning — attendee registration failed",
    "failed":                   "❌ Pipeline failed",
}
_MAX_STEP_MESSAGES = 30

# Table metadata for the DevPanel ephemeral DB browser. Columns are derived
# live from the schema via ephemeral_memory.table_columns() so new columns
# (e.g. migration-added ones) always show up — never hardcode them here.
EPHEMERAL_TABLES = {
    "jobs": {"label": "Jobs"},
    "attendees": {"label": "Attendees"},
    "action_items": {"label": "Action Items"},
    "contacts": {"label": "Contacts"},
    "budgets": {"label": "Budgets"},
    "decisions": {"label": "Decisions"},
    "notes": {"label": "Notes"},
    "events": {"label": "Events"},
}

# ── Stop words for keyword overlap analysis ──
_STOP_WORDS = {
    "the", "and", "for", "that", "this", "with", "have", "will", "was",
    "are", "not", "but", "from", "they", "you", "all", "can", "has",
    "had", "its", "than", "been", "more", "also", "very", "just",
    "about", "over", "into", "them", "then", "some", "what", "when",
    "where", "which", "their", "there", "these", "those", "would",
    "could", "should", "after", "such", "only", "other", "each",
    "well", "did", "does", "done", "going", "make", "made", "take",
    "took", "think", "know", "like", "need", "want", "see", "way",
    "back", "much", "still", "also", "even", "may", "might", "must",
    "new", "now", "one", "two", "use", "used", "get", "got", "say",
    "said", "tell", "told", "ask", "asked", "put", "set", "let",
    "come", "came", "went", "go", "yes", "sure", "okay", "right",
    "look", "looks", "looking", "thing", "things", "really", "actually",
    "basically", "probably", "maybe", "please", "thank", "thanks",
    "yes", "no", "well", "good", "great", "best", "better", "first",
    "last", "next", "previous", "following", "done", "doing", "does",
    "being", "been", "having", "getting", "making", "taking",
}
