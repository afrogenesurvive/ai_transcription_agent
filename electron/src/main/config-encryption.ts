/**
 * Config Encryption — at-rest + export/import encryption for the user config.
 *
 * Two mechanisms, two purposes:
 *
 * 1. AT-REST (userData/config.json.gpg) — AES-256-GCM via node:crypto (sync).
 *    Used by config.ts for every read/write once a license is active. Key is
 *    derived (sha256) from the active license key. NOT gpg-compatible — it's
 *    app-internal and must stay fast + synchronous (config.ts is fully sync).
 *
 * 2. EXPORT / IMPORT (portable .gpg files) — OpenPGP symmetric via openpgp.js
 *    (async). Passphrase = the license key. Produces standard OpenPGP armored
 *    output that gpg itself can decrypt:
 *        gpg --decrypt --passphrase "<license key>" file.gpg
 *
 * Migration: on first license activation, a legacy plaintext config.json is
 * encrypted to config.json.gpg and retained as config.json.bak until the new
 * file is verified readable.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as openpgp from "openpgp";
import { app, safeStorage } from "electron";

// v2 envelope: keyed by a per-machine random secret held ONLY in OS secure
// storage (Keychain/DPAPI). Decoupled from the license key — a license change
// or revocation never affects the at-rest config.
const ENVELOPE_VERSION_V2 = "v2";
// Legacy v1 envelope (pre-0.9): AES key derived from the license key. Kept only
// to decrypt older config.json.gpg files once during migration.
const LEGACY_ENVELOPE_VERSION = "v1";
const AT_REST_ALGO = "aes-256-gcm";
const LEGACY_KEY_SALT = "transcription-agent:config:v1:";
const CONFIG_SECRET_FILE_NAME = "config.key.enc";

// ── Per-machine config secret (safeStorage-backed; NEVER written in plaintext) ──
//
// A random 32-byte AES-256 key created once per machine and persisted only via
// Electron safeStorage. If safeStorage is unavailable we return null and the
// config is left plaintext rather than weakening the key material.

let _configSecretCache: Buffer | null | undefined; // undefined = not yet resolved

function configSecretPath(): string {
  return path.join(app.getPath("userData"), "secure", CONFIG_SECRET_FILE_NAME);
}

/** Resolve (creating on first use) the per-machine config secret, or null when safeStorage is unavailable. */
export function getOrCreateConfigSecret(): Buffer | null {
  if (_configSecretCache !== undefined) return _configSecretCache;
  if (!safeStorage.isEncryptionAvailable()) {
    _configSecretCache = null;
    return null;
  }
  try {
    const p = configSecretPath();
    if (fs.existsSync(p)) {
      const b64 = safeStorage.decryptString(fs.readFileSync(p));
      const secret = Buffer.from(b64, "base64");
      if (secret.length === 32) {
        _configSecretCache = secret;
        return secret;
      }
    }
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, safeStorage.encryptString(secret.toString("base64")));
    _configSecretCache = secret;
    return secret;
  } catch {
    _configSecretCache = null;
    return null;
  }
}

// ── At-rest envelope (AES-256-GCM, sync) ──────────────────────────────────────
// v2 envelope: key = the 32-byte per-machine config secret.

export function encryptConfigEnvelope(plaintext: string, secret: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AT_REST_ALGO, secret, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION_V2, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptConfigEnvelope(envelope: string, secret: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION_V2) {
    throw new Error("Unsupported config envelope format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(AT_REST_ALGO, secret, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Decrypt a legacy v1 envelope (AES key derived from the license key by older
 * builds). Used for the one-time migration to the v2 machine-secret scheme.
 */
export function decryptLegacyConfigEnvelope(envelope: string, licenseKey: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== LEGACY_ENVELOPE_VERSION) {
    throw new Error("Unsupported legacy config envelope format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = crypto.createHash("sha256").update(LEGACY_KEY_SALT + licenseKey).digest();
  const decipher = crypto.createDecipheriv(AT_REST_ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Envelope tag found on an at-rest config file (see the version constants above). */
export type ConfigEnvelopeVersion = "v2" | "v1" | "unknown";

/**
 * Read ONLY the envelope version tag of an encrypted file — cheaply, without
 * decrypting it and without needing a license.
 *
 * Why this exists: a **v1** config was keyed from the licence *string*, so
 * re-issuing (re-signing) that seat's key rewrites the only thing that can unlock
 * it. Knowing the version up front lets the operator see which machines would be
 * affected before re-signing a seat (About → License, `license.log`, and
 * `getConfigIntegrity().configEnvelope`). A **v2** config is keyed from the
 * per-machine secret and is unaffected by any licence change.
 */
export function readConfigEnvelopeVersion(filePath: string): ConfigEnvelopeVersion {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(8);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      const tag = head.subarray(0, n).toString("utf8").split(".")[0];
      if (tag === ENVELOPE_VERSION_V2) return "v2";
      if (tag === LEGACY_ENVELOPE_VERSION) return "v1";
      return "unknown";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unknown";
  }
}

export function writeEncryptedFileAtRest(filePath: string, plaintext: string, secret: Buffer): void {
  fs.writeFileSync(filePath, encryptConfigEnvelope(plaintext, secret), "utf8");
}

export function readEncryptedFileAtRest(filePath: string, secret: Buffer): string {
  const envelope = fs.readFileSync(filePath, "utf8");
  return decryptConfigEnvelope(envelope, secret);
}

/**
 * Migrate a legacy plaintext config.json → config.json.gpg (v2 envelope).
 * Only runs when the .gpg does not exist and config.json looks like JSON.
 * Keeps config.json.bak until the caller confirms the new file is readable.
 */
export function migratePlaintextConfig(configPath: string, gpgPath: string, secret: Buffer): { migrated: boolean; backupPath?: string } {
  if (fs.existsSync(gpgPath)) return { migrated: false };
  if (!fs.existsSync(configPath)) return { migrated: false };
  const raw = fs.readFileSync(configPath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return { migrated: false };
  try {
    JSON.parse(trimmed);
  } catch {
    return { migrated: false };
  }
  writeEncryptedFileAtRest(gpgPath, trimmed, secret);
  const backupPath = `${configPath}.bak`;
  fs.writeFileSync(backupPath, trimmed, "utf8");
  fs.unlinkSync(configPath);
  return { migrated: true, backupPath };
}

// ── Export / import (OpenPGP symmetric, gpg-compatible, async) ────────────────

export async function encryptOpenPgpText(text: string, passphrase: string): Promise<string> {
  const message = await openpgp.createMessage({ text });
  return (await openpgp.encrypt({ message, passwords: [passphrase], format: "armored" })) as unknown as string;
}

export async function decryptOpenPgpText(armored: string, passphrase: string): Promise<string> {
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const { data } = await openpgp.decrypt({ message, passwords: [passphrase], format: "utf8" });
  return data as unknown as string;
}
