#!/usr/bin/env bash
#
# write-version.sh
#
# Writes the current git branch name (or the exact tag when on a detached
# HEAD, e.g. CI tag builds) to electron/version.json so the packaged app
# can display it as the app version at runtime.
#
# Usage:
#   ./scripts/write-version.sh
#
# Output:
#   electron/version.json
#   {"version": "0.0.2", "branch": "0.0.2", "sha": "abc1234"}
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/electron/version.json"

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

# ── Detached HEAD (e.g. CI tag builds) → use the exact tag, not "HEAD" ──
# actions/checkout checks out tags in a detached HEAD, so rev-parse returns
# "HEAD" and the status bar would show vHEAD. Resolve the tag name instead
# and strip the leading "v" to match the branch/package.json convention.
if [ "$BRANCH" = "HEAD" ]; then
  TAG="$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [ -z "$TAG" ]; then
    TAG="$(git -C "$ROOT" tag --points-at HEAD 2>/dev/null | head -1 || true)"
  fi
  [ -n "$TAG" ] && BRANCH="${TAG#v}"
fi

# ── Version consistency guard ──
# The version shown in the UI (version.json / branch name) should match
# electron/package.json, which electron-updater compares against release tags.
# A mismatch means the UI displays one version while the updater acts on another.
PKG_VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/electron/package.json" | head -1)"
if [ -n "$PKG_VERSION" ] && [ "$BRANCH" != "unknown" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ] && [ "$BRANCH" != "$PKG_VERSION" ]; then
  echo ""
  echo "⚠️  Version mismatch: branch '$BRANCH' ≠ package.json version '$PKG_VERSION'"
  echo "   The packaged app will DISPLAY '$BRANCH' but electron-updater will"
  echo "   compare against '$PKG_VERSION'. For a release, create a tag matching"
  echo "   the package.json version (e.g. v$PKG_VERSION) and upload latest.yml"
  echo "   alongside the installer."
  echo ""
fi

cat > "$OUTPUT" <<EOF
{
  "version": "$BRANCH",
  "branch": "$BRANCH",
  "sha": "$SHA"
}
EOF

echo "✅ Wrote version $BRANCH ($SHA) → $OUTPUT"
