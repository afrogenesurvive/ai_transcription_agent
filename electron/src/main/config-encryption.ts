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
import * as openpgp from "openpgp";

const ENVELOPE_VERSION = "v1";
const AT_REST_ALGO = "aes-256-gcm";
const KEY_SALT = "transcription-agent:config:v1:";

// ── Key derivation ────────────────────────────────────────────────────────────

export function deriveConfigKey(licenseKey: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(KEY_SALT + licenseKey)
    .digest();
}

// ── At-rest envelope (AES-256-GCM, sync) ──────────────────────────────────────

export function encryptConfigEnvelope(plaintext: string, licenseKey: string): string {
  const key = deriveConfigKey(licenseKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AT_REST_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptConfigEnvelope(envelope: string, licenseKey: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unsupported config envelope format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = deriveConfigKey(licenseKey);
  const decipher = crypto.createDecipheriv(AT_REST_ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function writeEncryptedFileAtRest(filePath: string, plaintext: string, licenseKey: string): void {
  fs.writeFileSync(filePath, encryptConfigEnvelope(plaintext, licenseKey), "utf8");
}

export function readEncryptedFileAtRest(filePath: string, licenseKey: string): string {
  const envelope = fs.readFileSync(filePath, "utf8");
  return decryptConfigEnvelope(envelope, licenseKey);
}

/**
 * Migrate a legacy plaintext config.json → config.json.gpg.
 * Only runs when the .gpg does not exist and config.json looks like JSON.
 * Keeps config.json.bak until the caller confirms the new file is readable.
 */
export function migratePlaintextConfig(configPath: string, gpgPath: string, licenseKey: string): { migrated: boolean; backupPath?: string } {
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
  writeEncryptedFileAtRest(gpgPath, trimmed, licenseKey);
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
