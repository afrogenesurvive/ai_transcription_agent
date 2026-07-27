#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# update-dsmon-gist.sh
#
# Sidecar script for the DS-mon host machine. Runs alongside ngrok to
# automatically broadcast the current tunnel URL to a GitHub Gist so that
# remote agent-runner instances can discover the URL via DSMON_GIST_RAW_URL.
#
# Requirements:
#   - curl, jq
#   - A GitHub Personal Access Token (classic) with "gist" scope
#   - A pre-created secret Gist with a file named "dsmon-tunnel-url.txt"
#
# Usage (env vars override hardcoded defaults):
#   export DSMON_PORT=18080
#   ./scripts/update-dsmon-gist.sh
#
# Can be run in a loop (e.g. via cron, launchd, or alongside ngrok):
#   watch -n 30 ./scripts/update-dsmon-gist.sh
#
# Or as a one-shot (e.g. triggered after ngrok start in a launcher script):
#   ./scripts/update-dsmon-gist.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Hardcoded defaults (override via env vars) ──
GITHUB_TOKEN="${GITHUB_TOKEN:-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}"
GIST_ID="${GIST_ID:-35f2d48d11f40af54c91154a2067a700}"

NGROK_API="${NGROK_API:-http://127.0.0.1:4040}"
DSMON_PORT="${DSMON_PORT:-18888}"
GIST_FILE="${GIST_FILE:-dsmon-tunnel-url.txt}"

# ── Step 1: Get the current ngrok tunnel URL ──
TUNNEL_URL=$(curl -sf "${NGROK_API}/api/tunnels" | jq -r '.tunnels[0].public_url // empty')

if [ -z "$TUNNEL_URL" ]; then
  echo "[dsmon-gist] No ngrok tunnel found (is ngrok running?)"
  exit 1
fi

# Strip trailing slash if present, append port and path
TUNNEL_URL="${TUNNEL_URL%/}"
PUSH_URL="${TUNNEL_URL}:${DSMON_PORT}/sync/push"

# ── Step 2: Check if the Gist already has this value ──
CURRENT=$(curl -sf "https://api.github.com/gists/${GIST_ID}" | jq -r ".files[\"${GIST_FILE}\"].content // empty")

if [ "$PUSH_URL" = "$CURRENT" ]; then
  echo "[dsmon-gist] URL unchanged: ${PUSH_URL}"
  exit 0
fi

# ── Step 3: Update the Gist ──
echo "[dsmon-gist] Updating Gist ${GIST_ID}..."
echo "[dsmon-gist]   Old: ${CURRENT:-"(empty)"}"
echo "[dsmon-gist]   New: ${PUSH_URL}"

RESP=$(curl -sf -X PATCH "https://api.github.com/gists/${GIST_ID}" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg content "$PUSH_URL" --arg file "$GIST_FILE" '{files: {($file): {content: $content}}}')")

echo "[dsmon-gist] ✅ Gist updated successfully"
