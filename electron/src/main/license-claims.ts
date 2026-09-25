/**
 * Seat claims — optional fields the key manager can add to a TA1 cert.
 *
 * A cert may now carry three extra, optional fields:
 *   email?: string   — the mailbox this seat belongs to (lower-cased, shape-validated)
 *   pwdv?: string    — a scrypt password VERIFIER, never a password
 *   metaV?: number   — 1; present only when the cert carries claims
 *
 * Claims are additive at `v: 1`, so `LICENSE_VERSION` is deliberately NOT bumped:
 * a claimed key still verifies on any build that ignores the extra fields, and a
 * claim-less key is byte-identical to what the key manager produced before.
 *
 * This module is deliberately Electron-free (only `node:crypto`) so the password
 * contract can be tested without booting the app — see
 * `electron/tests/license-claims.spec.ts`.
 *
 * CONTRACT PARITY: `personal_key_manager/src/creds.mjs` is the source of truth.
 * The verifier is WRITTEN there and READ here, in two languages, so a change on
 * either side has to be mirrored on the other:
 *   - the cost parameters come from the verifier string itself;
 *   - the password is UTF-8 exactly as typed, with NO Unicode normalisation
 *     (normalising on one side only would silently reject correct passwords);
 *   - the comparison is constant-time over the raw hash bytes.
 */
import crypto from "crypto";

/** The claim subset this module needs; certs carry more (see `LicenseClaims`). */
export interface PasswordClaim {
  /** scrypt password VERIFIER — never a password. Absent unless one was set. */
  pwdv?: string;
}

const PWDV_ALGO = "scrypt";

/**
 * `128 * N * r` is exactly 32 MiB at the default parameters — which is also
 * node's default `maxmem` cap, so relying on the default can throw
 * `Invalid scrypt params`. Always pass an explicit, larger cap.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Refuse absurd parameters read back from a (possibly hostile) verifier. */
const MAX_N = 2 ** 22;

/**
 * `Buffer.from(x, "base64url")` ignores junk instead of throwing, so the
 * charset has to be checked by hand before decoding.
 */
const B64U_RE = /^[A-Za-z0-9_-]+$/;

export interface ParsedPasswordVerifier {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Parse a `scrypt$N$r$p$b64url(salt)$b64url(hash)` verifier.
 * Returns null when it is not one we know how to check (never throws).
 */
export function parsePasswordVerifier(verifier: string | null | undefined): ParsedPasswordVerifier | null {
  const parts = String(verifier ?? "").split("$");
  if (parts.length !== 6) return null;
  const [algo, n, r, p, saltB64, hashB64] = parts;
  if (algo !== PWDV_ALGO) return null;
  const N = Number(n);
  const rN = Number(r);
  const pN = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(rN) || !Number.isInteger(pN)) return null;
  if (N < 2 || N > MAX_N || rN < 1 || pN < 1) return null;
  if (!B64U_RE.test(saltB64) || !B64U_RE.test(hashB64)) return null;
  const salt = Buffer.from(saltB64, "base64url");
  const hash = Buffer.from(hashB64, "base64url");
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r: rN, p: pN, salt, hash };
}

/**
 * Constant-time check of a password against the verifier carried in a cert.
 *
 * False for a missing or malformed verifier, or an empty password — never
 * throws, so callers can use it directly in a verification chain.
 *
 * ~100 ms at the standard parameters (N=32768, r=8, p=1). Use an async variant
 * (`crypto.scrypt`) if this ever runs on the main thread while the UI is live;
 * the hash is identical either way, because scrypt is deterministic given its
 * parameters.
 */
export function verifyPasswordClaim(claims: PasswordClaim | null | undefined, password: string): boolean {
  const parsed = parsePasswordVerifier(claims?.pwdv);
  if (!parsed) return false;
  const value = String(password ?? "");
  if (!value) return false;
  let candidate: Buffer;
  try {
    candidate = crypto.scryptSync(Buffer.from(value, "utf8"), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false; // bad params from a hostile verifier, or a memory failure
  }
  return candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
}
