"""Transcript refinement helpers extracted from main.py (Phase 0).

Pure functions — they depend only on ``re`` and on each other. No service
singletons, no global state, no file I/O.
"""

import re

# ── Filler words / discourse markers to strip from transcript text ──
# These are common hesitation sounds and speech artifacts. Each pattern
# consumes trailing punctuation and whitespace so that "um, like," becomes
# just "," after removal rather than leaving orphans like " ,".
_FILLER_PATTERNS = [
    r'\bum+\b[\s,.]*',
    r'\buh+\b[\s,.]*',
    r'\bah+\b[\s,.]*',
    r'\bhmm+\b[\s,.]*',
    r'\bmm[- ]hmm+\b[\s,.]*',
    r'\buh[- ]huh+\b[\s,.]*',
    r'\bah[- ]hah?\b[\s,.]*',
    r'\buh[- ]oh\b[\s,.]*',
    r'\byou know\b[\s,.]*',
    r'\bi mean\b[\s,.]*',
    r'\byou see\b[\s,.]*',
    r'\blike\b(?!\s+to\b)[\s,.]*',           # "like" as filler, not "like to"
    r'\bkind of\b[\s,.]*',
    r'\bsort of\b[\s,.]*',
    r'\bso basically\b[\s,.]*',
    r'\bbasically\b[\s,.]*',
    r'\bactually\b[\s,.]*',
    r'\bobviously\b[\s,.]*',
    r'\bright\b[\s,.]*',
    r'\bokay\b[\s,.]*',
    r'\balright\b(?!\s+so\b)[\s,.]*',
]


def _auto_refine(segments: list[dict], custom_rules: list[str], keep_timestamps: bool = True) -> list[dict]:
    """Apply automatic transcript refinement to every segment.

    ``start`` and ``end`` fields are always preserved so the UI can display
    timestamps even when ``keep_timestamps`` is False. The flag only controls
    whether the optional ``duration`` field is kept.

    For each segment:
      1. Strip filler words and discourse markers from the text.
      2. Redact PII (emails, phones, SSN, credit cards, account numbers).
      3. Apply any additional custom redaction rules passed by the LLM.
      4. Collapse multiple spaces and trim.

    Returns a new list of refined segment dicts (the original is not mutated).
    """
    fillers_re = re.compile('|'.join(_FILLER_PATTERNS), re.IGNORECASE)
    refined = []
    for seg in segments:
        # Always preserve speaker, start, end — these are structural fields
        # needed by the UI, not secrets/PII.
        clean = {
            "speaker": seg.get("speaker", "Unknown"),
            "start": seg.get("start"),
            "end": seg.get("end"),
        }
        if keep_timestamps:
            # Also preserve optional duration
            if "duration" in seg:
                clean["duration"] = seg["duration"]
        text = seg.get("text", "")

        # 2. Strip filler words
        text = fillers_re.sub('', text)

        # 3. Clean up punctuation orphans left by filler removal
        #    e.g. "um, like," → after removing fillers → " , ," → clean → ""
        text = re.sub(r'\s+[,.;:!?]+', ',', text)   # ", word" → ", word"
        text = re.sub(r'[,.;:!?]+(?!\S)', '', text)  # trailing punctuation cleanup
        text = re.sub(r'\s+', ' ', text)             # collapse spaces

        # 4. Redact PII automatically
        text = _redact_pii(text)

        # 5. Apply any custom LLM-provided redaction rules
        for rule in custom_rules:
            text = _redact_custom(text, rule)

        # 6. Final whitespace collapse and trim
        text = re.sub(r'\s+', ' ', text).strip()

        clean["text"] = text
        refined.append(clean)

    return refined


def _redact_pii(text: str) -> str:
    """Automatically redact common PII patterns from text."""
    # Email addresses
    text = re.sub(r'[\w.+-]+@[\w.-]+\.\w{2,}', '[EMAIL REDACTED]', text)
    # Phone numbers (various formats)
    text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    # SSN-like patterns (###-##-####)
    text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN REDACTED]', text)
    # Credit-card-like patterns (####-####-####-#### or ################)
    text = re.sub(r'\b(?:\d{4}[-\s]?){3}\d{4}\b', '[CARD REDACTED]', text)
    text = re.sub(r'\b\d{16}\b', '[CARD REDACTED]', text)
    # Long digit sequences (account numbers / banking)
    text = re.sub(r'\b\d{8,}\b', '[ACCOUNT REDACTED]', text)
    return text


def _redact_custom(text: str, rule: str) -> str:
    """Apply a single LLM-provided custom redaction rule."""
    rule_lower = rule.lower()
    if "account" in rule_lower or "banking" in rule_lower:
        text = re.sub(r'\b\d{4,}\b', '[REDACTED]', text)
    if "email" in rule_lower or "phone" in rule_lower or "contact" in rule_lower:
        text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL REDACTED]', text)
        text = re.sub(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE REDACTED]', text)
    if "name" in rule_lower or "person" in rule_lower:
        text = re.sub(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', '[NAME REDACTED]', text)
    return text
