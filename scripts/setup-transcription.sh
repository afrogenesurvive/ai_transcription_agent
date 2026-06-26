#!/usr/bin/env bash
#
# Setup script for the transcription agent Python backend.
#
# Auto-detects the platform and installs the optimal Whisper variant:
#   macOS Apple Silicon  → mlx-whisper   (Apple Neural Engine)
#   macOS Intel          → faster-whisper (CPU-optimized CTranslate2)
#   Windows (MINGW)      → faster-whisper
#   Linux                → faster-whisper (CPU or CUDA)
#   Fallback             → openai-whisper (guaranteed to work)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   🎙️  Transcription Agent — Setup                        ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── 1. Detect platform ──

OS="$(uname -s)"
ARCH="$(uname -m)"
WHISPER_VARIANT=""

echo ""
echo "   Detecting platform: $OS / $ARCH"

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    echo "   → macOS Apple Silicon — using mlx-whisper (Neural Engine)"
    WHISPER_VARIANT="mlx-whisper"
elif [ "$OS" = "Darwin" ]; then
    echo "   → macOS Intel — using faster-whisper (CPU-optimized)"
    WHISPER_VARIANT="faster-whisper"
elif [ "$OS" = "Linux" ]; then
    echo "   → Linux — using faster-whisper"
    WHISPER_VARIANT="faster-whisper"
elif echo "$OS" | grep -qi "mingw\|msys\|cygwin"; then
    echo "   → Windows — using faster-whisper"
    WHISPER_VARIANT="faster-whisper"
else
    echo "   → Unknown platform — using openai-whisper (fallback)"
    WHISPER_VARIANT="openai-whisper"
fi

# ── 2. Python venv + base deps ──

echo ""
echo "   📦 Setting up Python virtual environment..."

cd "$ROOT/python-backend"

if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "   ✅ venv created"
else
    echo "   ✅ venv already exists"
fi

source venv/bin/activate
echo "   🐍 Python: $(python3 --version)"

echo ""
echo "   📦 Installing base dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "   ✅ Base dependencies installed"

# ── 3. Platform-specific Whisper variant ──

echo ""
echo "   📦 Installing $WHISPER_VARIANT..."

case "$WHISPER_VARIANT" in
    mlx-whisper)
        # mlx-whisper is pip-installable; it bundles its own deps (mlx)
        pip install --quiet mlx-whisper
        ;;
    faster-whisper)
        # faster-whisper uses CTranslate2, works on CUDA or CPU
        pip install --quiet faster-whisper
        ;;
    *)
        # openai-whisper (original) — heavy but guaranteed
        pip install --quiet openai-whisper
        ;;
esac
echo "   ✅ $WHISPER_VARIANT installed"

# ── 4. Node.js packages ──

echo ""
echo "   📦 Installing agent-runner dependencies..."
cd "$ROOT/agent-runner"
npm install --silent 2>/dev/null
echo "   ✅ agent-runner dependencies installed"

echo ""
echo "   📦 Installing bridge-server dependencies..."
cd "$ROOT/bridge-server"
npm install --silent 2>/dev/null
echo "   ✅ bridge-server dependencies installed"

# ── 5. Summary ──

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   ✅ Setup complete!                                     ║"
echo "║                                                          ║"
echo "║   Whisper variant: $WHISPER_VARIANT"
echo "║                                                          ║"
echo "║   Start all services:  npm run transcribe:all            ║"
echo "║   Or individually:                                      ║"
echo "║     npm run transcribe:backend     (Python :5001)        ║"
echo "║     npm run transcribe:bridge      (Node :5010)          ║"
echo "║     npm run transcribe:runner      (agent prompt)        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
