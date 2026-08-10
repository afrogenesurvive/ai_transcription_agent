/**
 * Queue Poller — claims pending events from the SQLite-backed event queue
 * via HTTP endpoints on the Python backend.
 *
 * Replaces the former JSONL file queue (transcription.jsonl) with atomic
 * SQLite operations for ACID guarantees, retry tracking, and DLQ support.
 *
 * The Python backend exposes:
 *   POST /queue/claim      — atomically claim next pending event
 *   POST /queue/complete/{id} — mark as completed
 *   POST /queue/fail/{id}  — mark as failed (with retry/DLQ logic)
 *   POST /queue/enqueue    — write a new event
 *   GET  /queue/stats      — queue depth by status
 */

const BACKEND_URL = process.env.TRANSCRIPTION_BACKEND_URL || "http://127.0.0.1:5001";

/**
 * Atomically claim the next pending queue event.
 *
 * @param {string[]} [typesFilter] - Optional list of event types to restrict claiming to
 * @returns {object|null} The claimed event object, or null if none pending
 */
export async function claimPendingEvent(typesFilter) {
  try {
    const resp = await fetch(`${BACKEND_URL}/queue/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ types_filter: typesFilter || undefined }),
    });
    if (!resp.ok) {
      console.error(`   ❌ [POLLER] claim failed (HTTP ${resp.status})`);
      return null;
    }
    const data = await resp.json();
    if (!data.event) {
      console.log(`   [POLLER] No pending events`);
      return null;
    }
    const event = data.event;
    console.log(`   [POLLER] Claimed ${event.id?.slice(0, 8)} — ${event.type} (priority=${event.priority})`);
    return event;
  } catch (err) {
    // undici wraps the real network error (ECONNREFUSED etc.) in err.cause —
    // surface it so the log shows why the poller can't reach the backend.
    const cause = err?.cause?.message || err?.message || err;
    const code = err?.cause?.code ? ` (${err.cause.code})` : "";
    console.error(`   ❌ [POLLER] claim error: ${cause}${code}`);
    return null;
  }
}

/**
 * Mark a claimed event as completed.
 *
 * @param {string} eventId - The event ID to complete
 * @returns {boolean} True if the event was successfully completed
 */
export async function completeEvent(eventId) {
  const tag = eventId?.slice(0, 8) || "???";
  try {
    const resp = await fetch(`${BACKEND_URL}/queue/complete/${eventId}`, {
      method: "POST",
    });
    if (!resp.ok) {
      console.error(`   ❌ [POLLER] complete ${tag} failed (HTTP ${resp.status})`);
      return false;
    }
    const data = await resp.json();
    console.log(`   ✅ [POLLER] ${tag} completed (${data.success ? "ok" : "not updated"})`);
    return !!data.success;
  } catch (err) {
    console.error(`   ❌ [POLLER] complete ${tag} error: ${err.message}`);
    return false;
  }
}

/**
 * Mark a claimed event as failed. Handles retry/DLQ internally on the backend.
 *
 * @param {string} eventId - The event ID to fail
 * @param {string} [error] - Optional error message
 * @returns {boolean} True if the event was updated
 */
export async function failEvent(eventId, error) {
  const tag = eventId?.slice(0, 8) || "???";
  try {
    const resp = await fetch(`${BACKEND_URL}/queue/fail/${eventId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error || "" }),
    });
    if (!resp.ok) {
      console.error(`   ❌ [POLLER] fail ${tag} failed (HTTP ${resp.status})`);
      return false;
    }
    const data = await resp.json();
    console.log(`   ❌ [POLLER] ${tag} failed (${data.success ? "ok" : "not updated"})`);
    return !!data.success;
  } catch (err) {
    console.error(`   ❌ [POLLER] fail ${tag} error: ${err.message}`);
    return false;
  }
}

/**
 * Enqueue a new event via the Python backend.
 *
 * @param {string} source - Event source ('transcription' or 'agent-runner')
 * @param {string} type - Event type
 * @param {object} data - Event payload
 * @param {object} [options] - Additional options
 * @param {number} [options.priority] - Priority (default 0)
 * @param {number} [options.ttlSeconds] - TTL in seconds (default 86400)
 * @param {number} [options.maxRetries] - Max retries (default 5)
 * @returns {string|null} The generated event ID, or null on failure
 */
export async function enqueueEvent(source, type, data, options = {}) {
  const tag = data?.jobId?.slice(0, 8) || type?.slice(0, 8) || "???";
  try {
    const resp = await fetch(`${BACKEND_URL}/queue/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: source || "agent-runner",
        type: type,
        data: data || {},
        priority: options.priority ?? 0,
        ttl_seconds: options.ttlSeconds ?? 86400,
        max_retries: options.maxRetries ?? 5,
      }),
    });
    if (!resp.ok) {
      console.error(`   ❌ [POLLER] enqueue ${tag} failed (HTTP ${resp.status})`);
      return null;
    }
    const result = await resp.json();
    console.log(`   📝 [POLLER] Enqueued ${result.event_id?.slice(0, 8)} — ${type} (${tag})`);
    return result.event_id || null;
  } catch (err) {
    console.error(`   ❌ [POLLER] enqueue ${tag} error: ${err.message}`);
    return null;
  }
}

/**
 * Get queue statistics from the backend.
 *
 * @returns {object|null} Queue stats object, or null on failure
 */
export async function getQueueStats() {
  try {
    const resp = await fetch(`${BACKEND_URL}/queue/stats`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
