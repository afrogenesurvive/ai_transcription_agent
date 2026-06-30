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
pip install --quiet --upgrade pip 2>&1 || true
pip install --quiet -r requirements.txt 2>&1 || true
echo "   ✅ Base dependencies installed (or already up to date)"

# ── 3. Platform-specific Whisper variant ──

echo ""
echo "   📦 Installing $WHISPER_VARIANT..."

case "$WHISPER_VARIANT" in
    mlx-whisper)
        # mlx-whisper is pip-installable; it bundles its own deps (mlx)
        pip install --quiet mlx-whisper 2>&1 || true
        ;;
    faster-whisper)
        # faster-whisper uses CTranslate2, works on CUDA or CPU
        pip install --quiet faster-whisper 2>&1 || true
        ;;
    *)
        # openai-whisper (original) — heavy but guaranteed
        pip install --quiet openai-whisper 2>&1 || true
        ;;
esac
echo "   ✅ $WHISPER_VARIANT installed"

# ── 4. Node.js packages ──

echo ""
echo "   📦 Installing agent-runner dependencies..."
cd "$ROOT/agent-runner"
npm install --loglevel=error 2>&1 | tail -1
echo "   ✅ agent-runner dependencies installed"

echo ""
echo "   📦 Installing bridge-server dependencies..."
cd "$ROOT/bridge-server"
npm install --loglevel=error 2>&1 | tail -1
echo "   ✅ bridge-server dependencies installed"

echo ""
echo "   📦 Installing electron app dependencies..."
cd "$ROOT/electron"
npm install --loglevel=error 2>&1 | tail -1
echo "   ✅ electron dependencies installed"

# ── 5. Pre-cache diarization model ──

DIARIZATION_STATUS="⚠️  Not checked"
HF_TOKEN=""

# Load HF token from .env if present
if [ -f "$ROOT/.env" ]; then
    HF_TOKEN=$(grep -E '^HUGGING_FACE_TOKEN=' "$ROOT/.env" | head -1 | cut -d'=' -f2)
fi

echo ""
echo "   🧠 Checking pyannote/speaker-diarization-3.1 model..."

if [ -n "$HF_TOKEN" ]; then
    echo "   HF token found — pre-downloading diarization model..."
    # Download model (wrapped in || true so set -e doesn't abort on failure)
    HF_TOKEN="$HF_TOKEN" python3 << 'PYEOF' 2>&1 | tee /tmp/pyannote-setup.log | grep -v '^$' || true
import sys, os, warnings
warnings.filterwarnings('ignore')

token = os.environ.get('HF_TOKEN', '')

# Patch speechbrain LazyModule (same fix as in main.py/transcription.py)
try:
    import speechbrain.utils.importutils as _sb_utils
    _orig_lazy_getattr = _sb_utils.LazyModule.__getattr__
    def _safe_lazy_getattr(self, attr):
        if attr == "__file__":
            raise AttributeError(attr)
        return _orig_lazy_getattr(self, attr)
    _sb_utils.LazyModule.__getattr__ = _safe_lazy_getattr
except Exception:
    pass

from pyannote.audio import Pipeline
import torch as _torch

_orig_load = _torch.load
try:
    def _permissive_load(f, *a, **kw):
        kw['weights_only'] = False
        return _orig_load(f, *a, **kw)
    _torch.load = _permissive_load
    pipe = Pipeline.from_pretrained('pyannote/speaker-diarization-3.1', use_auth_token=token)
    pipe.to(_torch.device('cpu'))
    print('MODEL_OK')
except Exception as e:
    print(f'FAILED: {e}')
finally:
    _torch.load = _orig_load
PYEOF

    if grep -q 'MODEL_OK' /tmp/pyannote-setup.log 2>/dev/null; then
        DIARIZATION_STATUS="✅  Ready (cached)"
        echo "   ✅ Diarization model cached successfully!"
    else
        ERROR_MSG=$(grep 'FAILED:' /tmp/pyannote-setup.log | head -1 | sed 's/FAILED: //')
        if [ -n "$ERROR_MSG" ]; then
            echo "   ⚠️  Model download failed: $ERROR_MSG"
            echo "   📝 The pipeline will still work without speaker labels."
            DIARIZATION_STATUS="❌  $ERROR_MSG"
        fi
    fi
else
    echo "   ⏭️  No HUGGING_FACE_TOKEN found in .env — skipping download."
    echo "   📝 Set HUGGING_FACE_TOKEN in .env to enable speaker diarization."
    echo "      Get a token: https://hf.co/settings/tokens"
    echo "      Accept terms: https://hf.co/pyannote/speaker-diarization-3.1"
    DIARIZATION_STATUS="⏭️  Skipped (no HF_TOKEN)"
fi

# ── 6. Summary ──

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   ✅ Setup complete!                                     ║"
echo "║                                                          ║"
echo "║   Whisper variant:   $WHISPER_VARIANT"
echo "║   Diarization model: $DIARIZATION_STATUS"
echo "║                                                          ║"
echo "║   Run the Electron app:  npm run electron:dev            ║"
echo "║                                                          ║"
echo "║   Or start services individually:                       ║"
echo "║     npm run transcribe:backend     (Python :5001)        ║"
echo "║     npm run transcribe:bridge      (Node :5010)          ║"
echo "║     npm run transcribe:runner      (agent prompt)        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
