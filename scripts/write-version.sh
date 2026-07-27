#!/usr/bin/env bash
#
# write-version.sh
#
# Writes the current git branch name to electron/version.json so the
# packaged app can display it as the app version at runtime.
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

cat > "$OUTPUT" <<EOF
{
  "version": "$BRANCH",
  "branch": "$BRANCH",
  "sha": "$SHA"
}
EOF

echo "✅ Wrote version $BRANCH ($SHA) → $OUTPUT"
