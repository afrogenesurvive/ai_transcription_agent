/**
 * Sanitize — input validation and prompt injection protection
 *
 * Provides two tiers of sanitization:
 *   TIER 1 — Mandatory (third-party API responses)
 *     Strips credentials, tokens, HTML/script injection, limits nesting + string length.
 *   TIER 2 — Optional (transcript text before LLM)
 *     Strips prompt injection patterns from ASR output before it reaches the model.
 *     Controlled by TRANSCRIPTION_SANITIZE_PROMPT env var.
 */

// ── Patterns ──

/** Prompt injection patterns — things that could hijack the LLM */
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|commands|directions)/gi,
  /\bforget\s+(everything|all|previous)/gi,
  /\bnew\s+(instructions|prompt|system\s+message)\s*[:\-]/gi,
  /\byou\s+are\s+(now|not\s+required\s+to)\b/i,
  /\brewrite\s+(the\s+)?(transcript|summary|output)/gi,
  /\bdisregard\b/i,
  /```[\s\S]*?```/g, // Code blocks — strip to prevent context leakage
];

/** Sensitive data patterns — things to redact from API responses */
const SENSITIVE_PATTERNS = [
  /\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/g, // Base64 blobs (tokens, keys)
  /\b(?:sk-[A-Za-z0-9]{20,})\b/g, // OpenAI/DeepSeek keys
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\b(?:xox[abpors]-)[A-Za-z0-9-]{24,}\b/g, // Slack tokens
  /\b(?:[A-Za-z0-9+/]{40,}==)\b/g, // More base64
];

/** HTML/script injection */
const HTML_TAG = /<script[\s>][\s\S]*?<\/script\s*>/gi;
const ON_ATTR = /\s(on\w+)\s*=\s*["'][^"']*["']/gi;

// ── Max limits ──

const MAX_STRING_LENGTH = 2000;
const MAX_NESTING_DEPTH = 5;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;

// ── TIER 1: Mandatory — Sanitize third-party API responses ──

/**
 * Deep-sanitize an API response object.
 * Strips credentials, limits string length, flattens deep nesting.
 * Use this on ALL data received from external services before it reaches the LLM.
 *
 * @param {any} data — Raw API response
 * @param {object} [opts]
 * @param {number} [opts.depth=0] — Internal recursion depth tracker
 * @returns {any} Sanitized clone
 */
export function sanitizeApiResponse(data, opts = {}) {
  const depth = opts.depth || 0;

  if (depth > MAX_NESTING_DEPTH) {
    return "[truncated: max depth]";
  }

  if (typeof data === "string") {
    let cleaned = data.slice(0, MAX_STRING_LENGTH);
    cleaned = cleaned.replace(HTML_TAG, "");
    cleaned = cleaned.replace(ON_ATTR, "");
    cleaned = cleaned.replace(SENSITIVE_PATTERNS, "[REDACTED]");
    return cleaned;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    const items = data.slice(0, MAX_ARRAY_ITEMS);
    return items.map((item) => sanitizeApiResponse(item, { depth: depth + 1 }));
  }

  if (typeof data === "object") {
    const keys = Object.keys(data).slice(0, MAX_OBJECT_KEYS);
    const result = {};
    // Key redaction list — never expose these from third-party responses
    const REDACT_KEYS = new Set([
      "access_token",
      "refresh_token",
      "api_key",
      "secret",
      "password",
      "passwd",
      "token",
      "authorization",
      "auth",
      "credentials",
      "client_secret",
      "client_id",
      "private_key",
    ]);
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (REDACT_KEYS.has(lower)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = sanitizeApiResponse(data[key], { depth: depth + 1 });
    }
    return result;
  }

  return data;
}

// ── TIER 2: Optional — Sanitize transcript text before LLM ──

const SANITIZE_ENABLED = () => process.env.TRANSCRIPTION_SANITIZE_PROMPT === "true";

/**
 * Sanitize a single text string for prompt injection before sending to the LLM.
 * Only active when TRANSCRIPTION_SANITIZE_PROMPT=true.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizePromptText(text) {
  if (!SANITIZE_ENABLED()) return text;
  if (!text || typeof text !== "string") return text;

  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[redacted]");
  }
  // Remove any remaining control characters except newlines/tabs
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return cleaned;
}

/**
 * Sanitize an array of transcript segments before sending to the LLM.
 * Only active when TRANSCRIPTION_SANITIZE_PROMPT=true.
 *
 * @param {Array<{speaker:string, text:string, start:number, end:number}>} segments
 * @returns {Array} Sanitized copy of segments
 */
export function sanitizeTranscriptSegments(segments) {
  if (!SANITIZE_ENABLED()) return segments;
  if (!Array.isArray(segments)) return segments;

  return segments.map((seg) => ({
    ...seg,
    text: sanitizePromptText(seg.text || ""),
    speaker: sanitizePromptText(seg.speaker || ""),
  }));
}

/**
 * Sanitize a single line of LLM context (title, attendee name, etc.)
 * Only active when TRANSCRIPTION_SANITIZE_PROMPT=true.
 */
export function sanitizeContextString(str) {
  if (!SANITIZE_ENABLED()) return str;
  return sanitizePromptText(str);
}
