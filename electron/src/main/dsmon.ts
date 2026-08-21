/**
 * DS-mon License Authority Check — optional startup/periodic verification that
 * the current seat has NOT been revoked by the central DS-mon instance.
 *
 * Trust model (Hybrid — user decision 2026-08-20):
 *   Offline Ed25519 verification in license.ts stays the PRIMARY gate. DS-mon
 *   acts as an ADDITIONAL revocation authority: it holds the host-side
 *   revoked-seats registry and answers `POST /license/check` with
 *   `{ ok: true, revoked: boolean, seat, checkedAt }`. DS-mon never holds
 *   master keys — signature verification remains fully offline in this app.
 *
 * Failure semantics ("continue but flag prominently"):
 *   - Feature disabled (default)           -> enabled:false, no impact.
 *   - No license installed                 -> enabled, seat:null (no-op).
 *   - DS-mon unreachable / HTTP error      -> reachable:false, revoked:null
 *     (unknown) — the app keeps the offline verdict and the UI shows a warning.
 *   - DS-mon reports revoked:true          -> revoked:true — the app treats the
 *     seat as unlicensed (locked mode) and flags prominently.
 *
 * The check host is derived from DSMON_PUSH_URL (same static tunnel/LAN URL the
 * runner pushes usage to) with the path replaced by /license/check. Auth uses
 * the same DSMON_PUSH_TOKEN bearer token as /sync/push. When
 * DSMON_ENCRYPTION_KEY is set, the request + response are wrapped in an
 * AES-256-GCM envelope (kid/v/nonce/tag/ct) — plaintext fallback otherwise.
 */
import crypto from "crypto";
import { EventEmitter } from "events";
import { getConfig } from "./config";
import { readStoredLicenseKey, LICENSE_KEY_RE } from "./license";
import { addLog } from "./logger";

export interface DsmonAuthorityState {
  /** Whether DSMON_LICENSE_CHECK_ENABLED=true. */
  enabled: boolean;
  /** True when DS-mon answered the license check. */
  reachable: boolean | null;
  /** DS-mon's verdict; null when unknown (disabled / unreachable / no license). */
  revoked: boolean | null;
  /** DS-mon's authoritative expiry verdict: a non-null exp > 0 that has passed = expired. */
  expired: boolean | null;
  /** DS-mon's authoritative seat expiry (unix seconds; 0 = unlimited); null when unknown. */
  exp: number | null;
  /** Epoch ms of the last check attempt. */
  checkedAt: number | null;
  /** Short human-readable reason when not fully confirmed (disabled|no-license|no-push-url|HTTP <n>|unreachable). */
  error?: string;
}

const DS_MON_CHECK_TIMEOUT_MS = 8000;

/**
 * DS-mon license-authority re-check interval, read from config each cycle so a
 * change to DSMON_LICENSE_CHECK_INTERVAL applies without a restart. Default 12h.
 */
function checkIntervalMs(): number {
  const raw = (getConfig().DSMON_LICENSE_CHECK_INTERVAL || "").trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60000 ? n : 12 * 60 * 60 * 1000;
}

let cached: DsmonAuthorityState = { enabled: false, reachable: null, revoked: null, expired: null, exp: null, checkedAt: null };
let inFlight: Promise<DsmonAuthorityState> | null = null;
let monitorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fired whenever the DS-mon authoritative verdict CHANGES in a way that
 * affects UI gating (revoked/expired flipped, or reachability flipped).
 * Payload: the new DsmonAuthorityState. The main process subscribes so it can
 * push `license:status-changed` to the renderer (panels re-obscure / unlock).
 */
export const dsmonEvents = new EventEmitter();
export const DSMON_VERDICT_CHANGED = "verdict-changed";

/** Last verdict that was broadcast (used to only emit on real transitions). */
let lastBroadcastVerdict = "";

function broadcastIfChanged(state: DsmonAuthorityState): void {
  // Verdict key: locked (revoked/expired), or the reachability+error state.
  // Emits only when the gating-relevant values actually change.
  const key = `${state.revoked === true || state.expired === true ? "locked" : "open"}:${state.reachable}:${state.enabled}`;
  if (key !== lastBroadcastVerdict) {
    lastBroadcastVerdict = key;
    dsmonEvents.emit(DSMON_VERDICT_CHANGED, state);
  }
}

// ── Optional payload encryption (shared AES-256-GCM envelope) ──
// When DSMON_ENCRYPTION_KEY is set (base64url 32-byte), the /license/check
// request + response bodies are wrapped in { kid, v, nonce, tag, ct } so
// license data is encrypted in transit. Plaintext fallback when unset. The key
// matches DS-mon's afrogene/dsmon.key (gitignored).
const encB64 = (b: Buffer) => b.toString("base64url");
const decB64 = (s: string) => Buffer.from(s, "base64url");

interface Envelope {
  kid: string;
  v: number;
  nonce: string;
  tag: string;
  ct: string;
}

function isEnvelope(x: unknown): x is Envelope {
  const e = x as Envelope;
  return !!e && typeof e === "object" && e.v === 1 && typeof e.nonce === "string" && typeof e.tag === "string" && typeof e.ct === "string";
}

function encryptEnvelope(kid: string, keyB64: string, payload: unknown): object {
  const key = crypto.createSecretKey(decB64(keyB64));
  const nonce = crypto.randomBytes(12); // 96-bit standard GCM IV
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { kid, v: 1, nonce: encB64(nonce), tag: encB64(tag), ct: encB64(ct) };
}

function decryptEnvelope(keyB64: string, env: Envelope): any {
  const key = crypto.createSecretKey(decB64(keyB64));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, decB64(env.nonce));
  decipher.setAuthTag(decB64(env.tag));
  return JSON.parse(Buffer.concat([decipher.update(decB64(env.ct)), decipher.final()]).toString("utf8"));
}

/** Current cached authority state (never blocks). */
export function getDsmonAuthorityState(): DsmonAuthorityState {
  return cached;
}

/** Derive { sub, kid } from the installed license key, or null when absent. */
function seatIdentity(): { sub: string; kid: string } | null {
  const key = readStoredLicenseKey();
  if (!key) return null;
  const m = LICENSE_KEY_RE.exec(key);
  if (!m) return null;
  try {
    const [, certB64] = m;
    const cert = JSON.parse(Buffer.from(certB64, "base64url").toString("utf8"));
    if (cert && typeof cert.sub === "string" && typeof cert.kid === "string") {
      return { sub: cert.sub, kid: cert.kid };
    }
  } catch {
    // malformed cert — treat as no identity
  }
  return null;
}

/** DS-mon /license/check URL derived from DSMON_PUSH_URL, or null. */
function licenseCheckUrl(): string | null {
  const pushUrl = (getConfig().DSMON_PUSH_URL || "").trim().replace(/\/+$/, "");
  if (!pushUrl) return null;
  try {
    return `${new URL(pushUrl).origin}/license/check`;
  } catch {
    return null;
  }
}

/**
 * Perform (or join) a DS-mon authority check and update the cached state.
 * Non-blocking failure — never throws.
 */
export async function checkDsmonAuthority(): Promise<DsmonAuthorityState> {
  const enabled = getConfig().DSMON_LICENSE_CHECK_ENABLED === "true";
  if (!enabled) {
    cached = { enabled: false, reachable: null, revoked: null, expired: null, exp: null, checkedAt: null, error: "disabled" };
    broadcastIfChanged(cached);
    return cached;
  }

  const seat = seatIdentity();
  if (!seat) {
    cached = { enabled, reachable: null, revoked: null, expired: null, exp: null, checkedAt: null, error: "no-license" };
    broadcastIfChanged(cached);
    return cached;
  }

  const url = licenseCheckUrl();
  if (!url) {
    cached = { enabled, reachable: null, revoked: null, expired: null, exp: null, checkedAt: null, error: "no-push-url" };
    broadcastIfChanged(cached);
    return cached;
  }

  // Deduplicate concurrent calls (e.g. startup + manual re-check).
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = (getConfig().DSMON_PUSH_TOKEN || "").trim();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const encKey = (getConfig().DSMON_ENCRYPTION_KEY || "").trim();
      // Envelope `kid` is the encryption KEY id (matches usage-tracker's push
      // envelope and DS-mon's EnvelopeCrypto.keyID), NOT the seat's master kid.
      const encKeyId = (getConfig().DSMON_ENCRYPTION_KEY_ID || "").trim() || "dsmon";
      const payload = { sub: seat.sub, kid: seat.kid, ts: Math.floor(Date.now() / 1000) };
      const body = encKey ? JSON.stringify(encryptEnvelope(encKeyId, encKey, payload)) : JSON.stringify(payload);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DS_MON_CHECK_TIMEOUT_MS),
      });
      if (res.ok) {
        // Accept an encrypted envelope when a key is configured, else plaintext.
        let data: any = {};
        try {
          const parsed = JSON.parse(await res.text());
          data = encKey && isEnvelope(parsed) ? decryptEnvelope(encKey, parsed) : parsed;
        } catch {
          data = {};
        }
        const revoked = data?.revoked === true;
        // DS-mon's authoritative expiry (unix seconds; 0 = unlimited). A past
        // non-zero exp means the seat has been extended-then-expired → expired.
        const exp = typeof data?.exp === "number" ? data.exp : null;
        const expired = exp !== null && exp > 0 && exp * 1000 <= Date.now();
        cached = { enabled, reachable: true, revoked, expired, exp, checkedAt: Date.now() };
        broadcastIfChanged(cached);
        addLog(
          "main",
          revoked || expired ? "warn" : "info",
          `[DSMON] License authority: ${revoked ? "REVOKED" : expired ? "EXPIRED" : "valid"} (sub=${seat.sub}${
            exp ? `, exp=${new Date(exp * 1000).toISOString()}` : ""
          })`,
        );
      } else {
        cached = { enabled, reachable: false, revoked: null, expired: null, exp: null, checkedAt: Date.now(), error: `HTTP ${res.status}` };
        broadcastIfChanged(cached);
        addLog("main", "warn", `[DSMON] License authority check failed: HTTP ${res.status}`);
      }
    } catch (err: any) {
      cached = { enabled, reachable: false, revoked: null, expired: null, exp: null, checkedAt: Date.now(), error: err?.message || "unreachable" };
      broadcastIfChanged(cached);
      addLog("main", "warn", `[DSMON] License authority unreachable: ${err?.message || "unknown"}`);
    } finally {
      inFlight = null;
    }
    return cached;
  })();
  return inFlight;
}

/**
 * Start the startup check + periodic re-check (configurable interval, default
 * 12h). Safe to call once at app startup (idempotent). Also returns the initial
 * state synchronously.
 */
export function startDsmonLicenseMonitor(): DsmonAuthorityState {
  if (!monitorTimer) {
    // Recursive setTimeout re-reads the interval from config each cycle, so a
    // changed DSMON_LICENSE_CHECK_INTERVAL takes effect without an app restart.
    const schedule = () => {
      monitorTimer = setTimeout(() => {
        monitorTimer = null;
        checkDsmonAuthority().catch(() => {});
        schedule();
      }, checkIntervalMs());
    };
    schedule();
  }
  // Fire the initial check without blocking startup.
  checkDsmonAuthority().catch(() => {});
  return getDsmonAuthorityState();
}
