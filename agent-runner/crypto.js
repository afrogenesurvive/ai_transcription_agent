/**
 * crypto.js — shared AES-256-GCM envelope for DS-mon payloads.
 *
 * Every request/response body sent between the Transcription Agent and DS-mon
 * can be wrapped in a single envelope so usage + license data is encrypted in
 * transit (defence-in-depth on top of the bearer token / HTTPS tunnel):
 *
 *   { "kid": "<key id>", "v": 1, "nonce": "<b64url>", "tag": "<b64url>", "ct": "<b64url>" }
 *
 * Both sides hold the same 32-byte AES-256 key, identified by `kid`:
 *   - Transcription Agent: DSMON_ENCRYPTION_KEY (base64 32-byte) in config
 *     (SECRET_CONFIG_KEYS), associated with DSMON_ENCRYPTION_KEY_ID.
 *   - DS-mon: afrogene/dsmon.key (gitignored) — see docs/safe/dsmon_integration.md.
 *
 * Backward compatible: when no key is configured the payload is sent as plain
 * JSON (same as today). When a key IS configured the payload is always an
 * envelope.
 */
import crypto from "crypto";

const toB64 = (b) => Buffer.from(b).toString("base64url");
const fromB64 = (s) => Buffer.from(s, "base64url");

/** True when `x` looks like an encryption envelope. */
export function isEnvelope(x) {
  return !!x && typeof x === "object" && x.v === 1 && typeof x.nonce === "string" && typeof x.tag === "string" && typeof x.ct === "string";
}

/**
 * Encrypt a JSON-serializable payload into an envelope.
 * @param {string} kid - key identifier (echoed so the receiver can route keys)
 * @param {string} keyB64 - base64url 32-byte AES-256 key
 * @param {object} payload - JSON-serializable object
 */
export function encryptEnvelope(kid, keyB64, payload) {
  const key = crypto.createSecretKey(fromB64(keyB64));
  const nonce = crypto.randomBytes(12); // 96-bit standard GCM IV
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { kid, v: 1, nonce: toB64(nonce), tag: toB64(tag), ct: toB64(ct) };
}

/**
 * Decrypt an envelope back into the original payload object.
 * Throws on auth failure (tampered/ wrong key).
 * @param {string} keyB64 - base64url 32-byte AES-256 key
 * @param {object} envelope - { v, nonce, tag, ct }
 */
export function decryptEnvelope(keyB64, envelope) {
  if (!isEnvelope(envelope)) throw new Error("Not an encryption envelope");
  const key = crypto.createSecretKey(fromB64(keyB64));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64(envelope.nonce));
  decipher.setAuthTag(fromB64(envelope.tag));
  return JSON.parse(Buffer.concat([decipher.update(fromB64(envelope.ct)), decipher.final()]).toString("utf8"));
}
