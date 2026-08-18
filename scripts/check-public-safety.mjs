#!/usr/bin/env node
/**
 * check-public-safety.mjs — pre-commit safety gate for the PUBLIC repo.
 *
 * Scans the files that WOULD be committed (staged + unstaged + new untracked, plus a
 * `git ls-files` sanity check) for sensitive data inappropriate for a public repo:
 *   - secret values (GitHub/OpenAI/HF/Slack/AWS tokens, long base64 blobs, private keys)
 *   - exact secret-storage paths + token/PAT mechanics (public docs)
 *   - references to the internal `docs/safe/` bucket from public content
 *   - known-bad paths that must never be committed (docs/safe/, storage/, logs/, .env, ...)
 *
 * Usage:  node scripts/check-public-safety.mjs
 * Exit:   0 = clean
 *         1 = [BLOCKER] found  -> the agent MUST STOP and ask the user to
 *                                 approve-and-continue or cancel the whole wrap-up
 *         2 = only [WARN] findings -> review each with the user before proceeding
 *
 * The wrap-up prompt (wrap up.prompt.md) gates the commit/push on this result.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BLOCKERS = [];
const WARNINGS = [];

function blocker(file, line, label, match) {
  BLOCKERS.push({ file, line, label, match });
}
function warn(file, line, label, match) {
  WARNINGS.push({ file, line, label, match });
}

/** Truncate a long matched value for display (never dump the whole blob). */
function trunc(s) {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** Looks like an example/placeholder value, not a real secret. */
function looksLikePlaceholder(s) {
  const m = s.toLowerCase();
  return (
    /(your|example|sample|placeholder|xxxx|redacted|demo|changeme|todo|fake|dummy)/.test(m) ||
    /^(.)\1{5,}$/.test(s) ||
    /<[^>]*>/.test(s)
  );
}

/** A long base64 blob can also be a SHA/hash — downgrade pure hex to WARN. */
function classifyBase64(match) {
  if (looksLikePlaceholder(match)) return "warn";
  if (/^[0-9a-fA-F]{40,64}$/.test(match)) return "warn"; // ambiguous SHA/hash, not obviously a secret
  return "blocker";
}

/** Content patterns that are [BLOCKER] unless the value looks like a placeholder. */
const BLOCKER_PATTERNS = [
  { re: /\bgh[opsur]_[A-Za-z0-9]{20,}\b/g, label: "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "OpenAI/DeepSeek-style API key (sk-…)" },
  { re: /\bhf_[A-Za-z0-9]{20,}\b/g, label: "HuggingFace token (hf_…)" },
  { re: /\bxox[abpors]-[A-Za-z0-9-]{20,}\b/g, label: "Slack token (xox…-…)" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS access key ID (AKIA…)" },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: "Long base64 blob (possible token/key)", classify: classifyBase64 },
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, label: "Private key block" },
];

/**
 * Content patterns that are always [WARN] (need human review).
 * The storage-path and docs/safe/ reference checks only apply to .md files —
 * they target PUBLIC DOCS attack surface, not app source code.
 */
const WARN_PATTERNS = [
  {
    mdOnly: true,
    re: /(?:~\/Library\/Application Support|%APPDATA%|Application Support\/[A-Za-z0-9 _-]+\/config\.json)/g,
    label: "Exact secret-storage path",
  },
  { re: /\b(?:GH_TOKEN|GITHUB_TOKEN)\s*=/g, label: "Token/PAT environment assignment" },
  {
    mdOnly: true,
    re: /\bdocs\/safe\//g,
    label: "Reference to internal docs/safe/ in public content",
  },
  {
    re: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|passwd|password|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}["']?/gi,
    label: "Possible credential assignment (key=value)",
  },
];

/** Paths that must NEVER be committed to the public repo. */
const BAD_PATH_PATTERNS = [
  { re: /(^|\/)docs\/safe\//, label: "docs/safe/ — full internal docs (gitignored, never commit)" },
  { re: /(^|\/)storage\//, label: "storage/ — runtime data (transcripts, memory DB)" },
  { re: /(^|\/)logs\//, label: "logs/ — runtime logs" },
  { re: /(^|\/)queue\/transcription\.jsonl$/, label: "queue/transcription.jsonl — transcript queue" },
  { re: /(^|\/)\.env(?:$|\.(?:local|.*\.local))/, label: ".env — environment/secret file (not .env.example, which is a public template)" },
  { re: /(^|\/)safe\//, label: "safe/ — local build data" },
  { re: /(^|\/)chat\.json$/, label: "chat.json — Copilot chat history" },
  { re: /\.log$/, label: "log file" },
  { re: /(^|\/)agent-config\/(pipeline\.json|tools\.json|system-prompt\.md|\.defaults\/)/, label: "agent-config live files (per-user secrets/customization)" },
  { re: /(^|\/)version\.json$/, label: "version.json — generated branch version" },
  { re: /(^|\/)electron\/(test-results|docs)\//, label: "electron test artifacts" },
  { re: /\.(pem|key|p12|pfx)$/, label: "certificate/private-key file" },
  { re: /(^|\/)dist-resources\//, label: "dist-resources/ — generated backend bundle" },
  { re: /(^|\/)node_modules\//, label: "node_modules/ — dependencies" },
  { re: /(^|\/)dist\//, label: "dist/ — build output" },
];

function git(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** Files that would be committed: staged + unstaged-modified + new untracked. */
function collectCandidates() {
  let out;
  try {
    out = git("git -c core.quotepath=false status --porcelain=v1 -uall");
  } catch (e) {
    console.error("error: unable to run git status — is this a git repo?");
    console.error(String((e.stderr && e.stderr.toString()) || e.message));
    process.exit(1); // fail closed: treat as a blocker so the agent stops and asks
  }
  const candidates = new Map(); // path -> { staged, untracked }
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.includes(" -> ")) p = p.split(" -> ").pop(); // rename/copy: keep destination
    if (!p) continue;
    candidates.set(p, {
      staged: xy[0] !== " " && xy[0] !== "?",
      untracked: xy === "??",
    });
  }
  return candidates;
}

function checkBadPath(p, why) {
  for (const { re, label } of BAD_PATH_PATTERNS) {
    if (re.test(p)) {
      blocker(p, null, `${label} (${why})`);
      return;
    }
  }
}

/** Sanity check: any known-bad path already tracked in the repo. */
function checkTrackedBadPaths() {
  let out;
  try {
    out = git("git ls-files");
  } catch {
    return;
  }
  for (const p of out.split("\n")) {
    if (!p.trim()) continue;
    for (const { re, label } of BAD_PATH_PATTERNS) {
      if (re.test(p)) {
        blocker(p, null, `${label} — ALREADY TRACKED (pre-existing leak; remove from history before public push)`);
        break;
      }
    }
  }
}

function scanFile(p) {
  const abs = path.join(ROOT, p);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return; // deleted/renamed away — nothing on disk to scan
  }
  if (buf.includes(0)) return; // binary — skip content scan (path checks still applied)

  const content = buf.toString("utf8");
  const lines = content.split("\n");
  const isMd = p.endsWith(".md");

  lines.forEach((line, i) => {
    const ln = i + 1;
    for (const { re, label, classify } of BLOCKER_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const val = m[0];
        const level = classify ? classify(val) : looksLikePlaceholder(val) ? "warn" : "blocker";
        if (level === "blocker") blocker(p, ln, label, trunc(val));
        else warn(p, ln, `${label} (placeholder/example — verify it is not a real secret)`, trunc(val));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    for (const { re, label, mdOnly } of WARN_PATTERNS) {
      if (mdOnly && !isMd) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        warn(p, ln, label, trunc(m[0]));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  });

  // Endpoint-catalog heuristic for public markdown docs.
  if (isMd && !/docs\/safe\//.test(p)) {
    const verbs = lines.filter((l) => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//i.test(l.trim())).length;
    if (verbs >= 5) {
      warn(p, null, `possible full unauthenticated endpoint catalog (${verbs} HTTP-verb lines) — verify the public doc is a summary`);
    }
  }
}

function main() {
  const candidates = collectCandidates();
  const files = [...candidates.keys()];

  // 1. known-bad path check on what would be committed
  for (const p of files) {
    const c = candidates.get(p);
    checkBadPath(p, c.untracked ? "untracked — would be added" : c.staged ? "staged — would be committed" : "modified — would be committed");
  }

  // 2. git ls-files sanity check
  checkTrackedBadPaths();

  // 3. content scan
  for (const p of files) scanFile(p);

  // output
  console.log(`Public-safety scan: ${files.length} file(s) that would be committed:`);
  if (files.length === 0) {
    console.log("  (no uncommitted changes — nothing to scan)");
  } else {
    for (const p of files) {
      const c = candidates.get(p);
      const tag = c.untracked ? "[new]    " : c.staged ? "[staged] " : "[mod]    ";
      console.log(`  ${tag}${p}`);
    }
  }

  console.log("");
  if (BLOCKERS.length === 0 && WARNINGS.length === 0) {
    console.log("CLEAN — no sensitive data detected.");
    process.exit(0);
  }
  for (const f of BLOCKERS) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`[BLOCKER] ${loc}  —  ${f.label}`);
    if (f.match) console.log(`          ${f.match}`);
  }
  for (const f of WARNINGS) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`[WARN]    ${loc}  —  ${f.label}`);
    if (f.match) console.log(`          ${f.match}`);
  }
  console.log("");
  if (BLOCKERS.length > 0) {
    console.log(`RESULT: ${BLOCKERS.length} BLOCKER(s) + ${WARNINGS.length} WARN(s) → STOP; ask the user to approve-and-continue or cancel before commit/push.`);
    process.exit(1);
  }
  console.log(`RESULT: ${WARNINGS.length} WARN(s) only → review each with the user before proceeding.`);
  process.exit(2);
}

main();
