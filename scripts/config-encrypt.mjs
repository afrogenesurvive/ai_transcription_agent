#!/usr/bin/env node
/**
 * Encrypt a config file for distribution alongside built files.
 *
 * Produces a gpg-compatible OpenPGP symmetric .gpg file whose passphrase is the
 * license key — so the config that travels with the build is never naked, and
 * can be inspected/recovered with gpg itself:
 *
 *   gpg --decrypt --passphrase "<license key>" config.json.gpg
 *
 * Usage:
 *   node scripts/config-encrypt.mjs <config.json> --key "<license key>" [--out config.json.gpg]
 *
 * The input may be a raw config JSON (like the Config Panel export bundle or a
 * plain config.json). The output is OpenPGP armored text with a .gpg extension.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, "..", "electron", "package.json"));
const openpgp = require("openpgp");

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  node scripts/config-encrypt.mjs <config.json> --key "<license key>" [--out config.json.gpg]
  node scripts/config-encrypt.mjs --help`);
    process.exit(0);
  }

  const input = argv[0];
  const key = argValue(argv, "--key");
  if (!input) {
    console.error('Missing input file:  node scripts/config-encrypt.mjs <config.json> --key "<license key>"');
    process.exit(1);
  }
  if (!key) {
    console.error("Missing --key (the license key used as the encryption passphrase).");
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`Input file not found: ${input}`);
    process.exit(1);
  }

  const plaintext = fs.readFileSync(input, "utf8");
  // Sanity: the input should be JSON.
  try {
    JSON.parse(plaintext);
  } catch {
    console.warn("Warning: input does not parse as JSON — encrypting raw text anyway.");
  }

  const outPath = argValue(argv, "--out") || input.replace(/\.json$/, "") + ".gpg";

  openpgp
    .createMessage({ text: plaintext })
    .then((message) => openpgp.encrypt({ message, passwords: [key], format: "armored" }))
    .then((armored) => {
      fs.writeFileSync(outPath, String(armored), "utf8");
      console.log(`Encrypted → ${outPath}`);
      console.log(`Decrypt with: gpg --decrypt --passphrase "<license key>" ${outPath}`);
    })
    .catch((err) => {
      console.error(`Encryption failed: ${err.message}`);
      process.exit(1);
    });
}

main();
