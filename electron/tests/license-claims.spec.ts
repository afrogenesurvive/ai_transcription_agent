/**
 * Seat-claim contract tests — `electron/src/main/license-claims.ts`.
 *
 * Pure Node: the module under test is deliberately Electron-free, so Playwright
 * is only the runner here (no browser, no app launch). `npm run test` picks this
 * up alongside the screenshot specs under tests/screenshots/.
 *
 * The verifier strings are built at RUNTIME rather than committed as fixtures —
 * a `scrypt$N$r$p$salt$hash` literal, even a fake one, is a public-safety
 * scanner BLOCKER in this repo (scripts/check-public-safety.mjs).
 *
 * Contract source of truth: `personal_key_manager/src/creds.mjs` (the issuer).
 * A change to the password rules must be mirrored on both sides.
 */
import { test, expect } from "@playwright/test";
import crypto from "crypto";
import { parsePasswordVerifier, verifyPasswordClaim } from "../src/main/license-claims";

/** Same cap the implementation passes — 128*N*r is exactly 32 MiB at defaults. */
const MAXMEM = 64 * 1024 * 1024;
/** The issuer's production parameters. */
const PRODUCTION = { N: 32768, r: 8, p: 1 };
const PASSWORD = "correct horse battery staple";

/** Build a real verifier for `password` (random salt unless one is supplied). */
function makeVerifier(password: string, params = PRODUCTION, salt = crypto.randomBytes(16)): string {
  const { N, r, p } = params;
  const hash = crypto.scryptSync(Buffer.from(password, "utf8"), salt, 32, { N, r, p, maxmem: MAXMEM });
  return ["scrypt", N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * Assemble a verifier-shaped string from parts, so a test case can be malformed
 * on purpose without writing a `scrypt$…` literal into this file.
 */
function claimLike(...parts: Array<string | number>): string {
  return ["scrypt", ...parts].join("$");
}

test.describe("verifyPasswordClaim", () => {
  test("accepts the password it was made from and rejects a different one", () => {
    // Production parameters: without an explicit `maxmem` this call throws
    // (128*32768*8 = exactly node's 32 MiB default cap), so this also pins the
    // maxmem trap. It is a real ~100 ms hash, not a stub.
    const pwdv = makeVerifier(PASSWORD);
    expect(verifyPasswordClaim({ pwdv }, PASSWORD)).toBe(true);
    expect(verifyPasswordClaim({ pwdv }, PASSWORD + "!")).toBe(false);
    expect(verifyPasswordClaim({ pwdv }, PASSWORD.toUpperCase())).toBe(false);
    expect(verifyPasswordClaim({ pwdv }, " " + PASSWORD)).toBe(false);
  });

  test("reads the cost parameters from the verifier, not from defaults", () => {
    const pwdv = makeVerifier(PASSWORD, { N: 1024, r: 8, p: 1 });
    expect(parsePasswordVerifier(pwdv)).toMatchObject({ N: 1024, r: 8, p: 1 });
    expect(verifyPasswordClaim({ pwdv }, PASSWORD)).toBe(true);
  });

  test("never normalises Unicode — NFC and NFD are different passwords", () => {
    const nfc = "caf\u00e9"; // café
    const nfd = "cafe\u0301"; // cafe + combining acute
    expect(nfc).not.toBe(nfd);
    const pwdv = makeVerifier(nfc);
    expect(verifyPasswordClaim({ pwdv }, nfc)).toBe(true);
    expect(verifyPasswordClaim({ pwdv }, nfd)).toBe(false);
  });

  test("returns false for a missing, empty or non-verifier claim", () => {
    expect(verifyPasswordClaim({}, PASSWORD)).toBe(false);
    expect(verifyPasswordClaim({ pwdv: undefined }, PASSWORD)).toBe(false);
    expect(verifyPasswordClaim({ pwdv: "" }, PASSWORD)).toBe(false);
    expect(verifyPasswordClaim({ pwdv: "not-a-verifier" }, PASSWORD)).toBe(false);
    expect(verifyPasswordClaim(null, PASSWORD)).toBe(false);
    expect(verifyPasswordClaim(undefined, PASSWORD)).toBe(false);
  });

  test("returns false for an empty password rather than treating it as 'no password'", () => {
    const pwdv = makeVerifier(PASSWORD);
    expect(verifyPasswordClaim({ pwdv }, "")).toBe(false);
    expect(verifyPasswordClaim({ pwdv }, undefined as unknown as string)).toBe(false);
  });

  test("rejects malformed verifiers without throwing", () => {
    const salt = crypto.randomBytes(16).toString("base64url");
    const hash = crypto.randomBytes(32).toString("base64url");
    const good = makeVerifier(PASSWORD);
    const [, N, r, p] = good.split("$");

    const cases: string[] = [
      claimLike(N, r, salt, hash), // too few parts
      claimLike(N, r, p, salt, hash, "extra"), // too many parts
      claimLike(N, r, p, salt), // missing hash
      claimLike("notanumber", r, p, salt, hash), // N is not an integer
      claimLike(N, "notanumber", p, salt, hash), // r is not an integer
      claimLike(N, r, "notanumber", salt, hash), // p is not an integer
      claimLike(1, r, p, salt, hash), // N below the floor
      claimLike(2 ** 22 + 1, r, p, salt, hash), // N above the ceiling (refused, never hashed)
      claimLike(N, 0, p, salt, hash), // r below 1
      claimLike(N, r, 0, salt, hash), // p below 1
      claimLike(N, r, p, "***", hash), // salt violates the b64url charset
      claimLike(N, r, p, salt, "***"), // hash violates it
      claimLike(N, r, p, "", hash), // empty salt
      claimLike(N, r, p, salt, ""), // empty hash
      ["bcrypt", N, r, salt, hash].join("$"), // not a `scrypt` verifier at all
    ];
    for (const pwdv of cases) {
      expect(parsePasswordVerifier(pwdv), `parse: ${pwdv}`).toBeNull();
      expect(verifyPasswordClaim({ pwdv }, PASSWORD), `verify: ${pwdv}`).toBe(false);
    }
    // Sanity control: the loop above is not passing because everything is broken.
    expect(verifyPasswordClaim({ pwdv: good }, PASSWORD)).toBe(true);
  });
});
