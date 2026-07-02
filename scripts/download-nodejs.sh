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
# Default version: v20.18.0 (LTS)
#
# The output structure:
#   dist-resources/node-bin/
#   ├── node          (macOS / Linux)
#   └── node.exe      (Windows)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-v20.18.0}"
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
    ;;
  MINGW*|MSYS*|CYGWIN*)
    SUFFIX="win-x64"
    EXTRACT_DIR="node-${VERSION}-${SUFFIX}"
    ARCHIVE="${EXTRACT_DIR}.zip"
    BINARY="node.exe"
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

cp "$TMPDIR/$EXTRACT_DIR/$BINARY" "$OUTDIR/$BINARY"
chmod +x "$OUTDIR/$BINARY"

# ── Verify ──

echo "   ✅ Node.js bundled:"
"$OUTDIR/$BINARY" --version

echo ""
echo "   📍  $OUTDIR/$BINARY"
echo ""
