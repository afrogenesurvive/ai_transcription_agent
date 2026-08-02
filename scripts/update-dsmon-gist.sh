#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# update-dsmon-gist.sh
#
# Sidecar script for the DS-mon host machine. Runs alongside a tunnel to
# automatically broadcast the current tunnel URL to a GitHub Gist so that
# remote agent-runner instances can discover the URL via DSMON_GIST_RAW_URL.
#
# Supports:
#   - Cloudflare quick tunnels (trycloudflare.com) via CLOUDFLARED_URL_FILE
#   - ngrok tunnels via ngrok local API (legacy)
#
# Requirements:
#   - curl, jq
#   - A GitHub Personal Access Token (classic) with "gist" scope
#   - GIST_ID (env var or ~/.config/dsmon/gist-id) of a pre-created secret Gist
#     with a file named "dsmon-tunnel-url.txt"
#
# Usage (env vars override defaults):
#   export DSMON_PORT=18888
#   export GIST_ID='<gist-id>'
#   ./scripts/update-dsmon-gist.sh
#
# Can be run in a loop (e.g. via cron, launchd, or alongside the tunnel):
#   watch -n 30 ./scripts/update-dsmon-gist.sh
#
# Or as a one-shot (e.g. triggered after tunnel start):
#   ./scripts/update-dsmon-gist.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ──
# GIST_ID is resolved below from env var or ~/.config/dsmon/gist-id — never hardcoded.

# Resolve GITHUB_TOKEN: env var > ~/.config/dsmon/gist-token > error
if [ -z "${GITHUB_TOKEN:-}" ]; then
  TOKEN_FILE="$HOME/.config/dsmon/gist-token"
  if [ -f "$TOKEN_FILE" ]; then
    GITHUB_TOKEN="$(cat "$TOKEN_FILE" | tr -d '\n')"
  fi
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[dsmon-gist] ERROR: GITHUB_TOKEN is not set."
  echo "  Set it via: export GITHUB_TOKEN='ghp_...'"
  echo "  Or save it to: echo 'ghp_...' > ~/.config/dsmon/gist-token && chmod 600 ~/.config/dsmon/gist-token"
  exit 1
fi

# Resolve GIST_ID: env var > ~/.config/dsmon/gist-id > error
if [ -z "${GIST_ID:-}" ]; then
  GIST_ID_FILE="$HOME/.config/dsmon/gist-id"
  if [ -f "$GIST_ID_FILE" ]; then
    GIST_ID="$(cat "$GIST_ID_FILE" | tr -d '\n')"
  fi
fi

if [ -z "${GIST_ID:-}" ]; then
  echo "[dsmon-gist] ERROR: GIST_ID is not set."
  echo "  Set it via: export GIST_ID='<gist-id>'"
  echo "  Or save it to: echo '<gist-id>' > ~/.config/dsmon/gist-id && chmod 600 ~/.config/dsmon/gist-id"
  exit 1
fi

CLOUDFLARED_URL_FILE="${CLOUDFLARED_URL_FILE:-}"
NGROK_API="${NGROK_API:-http://127.0.0.1:4040}"
DSMON_PORT="${DSMON_PORT:-18888}"
GIST_FILE="${GIST_FILE:-dsmon-tunnel-url.txt}"

# ── Step 1: Get the current tunnel URL ──
# Priority: cloudflared URL file > ngrok API
TUNNEL_URL=""

if [ -n "$CLOUDFLARED_URL_FILE" ] && [ -f "$CLOUDFLARED_URL_FILE" ]; then
  TUNNEL_URL="$(cat "$CLOUDFLARED_URL_FILE" | tr -d '\n' | xargs)"
  echo "[dsmon-gist] Read cloudflare URL from ${CLOUDFLARED_URL_FILE}: ${TUNNEL_URL}"
fi

if [ -z "$TUNNEL_URL" ]; then
  TUNNEL_URL=$(curl -sf "${NGROK_API}/api/tunnels" 2>/dev/null | jq -r '.tunnels[0].public_url // empty' 2>/dev/null || true)
  if [ -n "$TUNNEL_URL" ]; then
    echo "[dsmon-gist] Read ngrok tunnel URL from API: ${TUNNEL_URL}"
  fi
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "[dsmon-gist] No tunnel URL found (cloudflared URL file missing and ngrok not running)"
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
