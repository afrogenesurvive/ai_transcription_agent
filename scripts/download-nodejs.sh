#!/usr/bin/env bash
#
# download-nodejs.sh
#
# Downloads the Node.js binary for the current platform and places it in
# dist-resources/node-bin/ so electron-builder can bundle it as extraResource.
#
# Usage:
#   ./scripts/download-nodejs.sh [version]
#
# Default version: v24.19.0 (LTS). On Windows (MINGW/MSYS/CYGWIN) the script also
# downloads Node v20.18.0 as node20.exe — a fallback for CrossOver/Wine, where the
# newer primary crashes at startup (rc=768). The Electron main process probes the
# primary and falls back to node20.exe only when it can't run.
#
# The output structure:
#   dist-resources/node-bin/
#   ├── node          (macOS / Linux)
#   ├── node.exe      (Windows — primary, Node 24 LTS)
#   └── node20.exe    (Windows — CrossOver/Wine fallback, Node 20.18.0)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-v24.19.0}"
OUTDIR="$ROOT/dist-resources/node-bin"

OS="$(uname -s)"
ARCH="$(uname -m)"

# ── Map platform → Node.js distribution suffix ──

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  SUFFIX="darwin-arm64" ;;
      x86_64) SUFFIX="darwin-x64"   ;;
      *)      echo "❌ Unsupported macOS arch: $ARCH"; exit 1 ;;
    esac
    EXTRACT_DIR="node-${VERSION}-${SUFFIX}"
    ARCHIVE="${EXTRACT_DIR}.tar.gz"
    BINARY="node"
    BIN_SUBDIR="bin"   # macOS/Linux tarballs keep the binary at bin/node
    ;;
  Linux)
    case "$ARCH" in
      x86_64) SUFFIX="linux-x64"   ;;
      aarch64|arm64) SUFFIX="linux-arm64" ;;
      *)      echo "❌ Unsupported Linux arch: $ARCH"; exit 1 ;;
    esac
    EXTRACT_DIR="node-${VERSION}-${SUFFIX}"
    ARCHIVE="${EXTRACT_DIR}.tar.gz"
    BINARY="node"
    BIN_SUBDIR="bin"   # macOS/Linux tarballs keep the binary at bin/node
    ;;
  MINGW*|MSYS*|CYGWIN*)
    SUFFIX="win-x64"
    EXTRACT_DIR="node-${VERSION}-${SUFFIX}"
    ARCHIVE="${EXTRACT_DIR}.zip"
    BINARY="node.exe"
    BIN_SUBDIR=""   # Windows zips keep node.exe at the archive root
    ;;
  *)
    echo "❌ Unknown OS: $OS"
    exit 1
    ;;
esac

URL="https://nodejs.org/dist/${VERSION}/${ARCHIVE}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   ⬇️  Download Node.js ${VERSION} for ${SUFFIX}            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "   Platform: $OS / $ARCH"
echo "   URL:      $URL"
echo "   Output:   $OUTDIR/$BINARY"
echo ""

mkdir -p "$OUTDIR"

# ── Download & extract ──

TMPDIR=$(mktemp -d)
trap "rm -rf \"$TMPDIR\"" EXIT

echo "   📥 Downloading..."
if command -v curl &>/dev/null; then
  curl -fsSL "$URL" -o "$TMPDIR/$ARCHIVE"
elif command -v wget &>/dev/null; then
  wget -q "$URL" -O "$TMPDIR/$ARCHIVE"
else
  echo "❌ Neither curl nor wget found — install one of them first."
  exit 1
fi

echo "   📦 Extracting..."
case "$ARCHIVE" in
  *.zip)
    unzip -q "$TMPDIR/$ARCHIVE" -d "$TMPDIR"
    ;;
  *.tar.gz)
    tar -xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR"
    ;;
esac

# ── Copy the binary ──

cp "$TMPDIR/$EXTRACT_DIR/${BIN_SUBDIR:+$BIN_SUBDIR/}$BINARY" "$OUTDIR/$BINARY"
chmod +x "$OUTDIR/$BINARY"

# ── Verify ──

echo "   ✅ Node.js bundled:"
"$OUTDIR/$BINARY" --version

echo ""
echo "   📍  $OUTDIR/$BINARY"
echo ""

# ── Windows fallback: also bundle Node 20.18.0 as node20.exe ──
# The v24 primary crashes at process startup under CrossOver/Wine (rc=768, empty
# output). Native Windows is fine with v24; the Electron main process probes the
# primary and falls back to node20.exe only when it can't run. Non-fatal if this
# download fails — the app then has no Wine fallback (native Windows unaffected).

if [[ "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* ]]; then
  FALLBACK_VERSION="v20.18.0"
  FALLBACK_ARCHIVE="node-${FALLBACK_VERSION}-win-x64.zip"
  FALLBACK_URL="https://nodejs.org/dist/${FALLBACK_VERSION}/${FALLBACK_ARCHIVE}"
  echo ""
  echo "   ⬇️  Downloading fallback Node.js ${FALLBACK_VERSION} → node20.exe (Wine/CrossOver)"
  if command -v curl &>/dev/null; then
    curl -fsSL "$FALLBACK_URL" -o "$TMPDIR/$FALLBACK_ARCHIVE" \
      || echo "   ⚠️  Fallback download failed — no Wine fallback bundled."
  elif command -v wget &>/dev/null; then
    wget -q "$FALLBACK_URL" -O "$TMPDIR/$FALLBACK_ARCHIVE" \
      || echo "   ⚠️  Fallback download failed — no Wine fallback bundled."
  else
    echo "   ⚠️  Neither curl nor wget found — skipping fallback."
  fi
  if [ -f "$TMPDIR/$FALLBACK_ARCHIVE" ]; then
    unzip -q "$TMPDIR/$FALLBACK_ARCHIVE" -d "$TMPDIR"
    cp "$TMPDIR/node-${FALLBACK_VERSION}-win-x64/node.exe" "$OUTDIR/node20.exe"
    chmod +x "$OUTDIR/node20.exe"
    echo "   ✅ Fallback bundled:"
    "$OUTDIR/node20.exe" --version
  fi
fi
