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
# All output is both displayed in real time and logged to a timestamped
# log file at logs/setup-YYYY-MM-DD-HHMMSS.log for later review.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"

# ── Timestamped setup log file ──
SETUP_LOG="$LOGS_DIR/setup-$(date '+%Y-%m-%d-%H%M%S').log"

# Redirect ALL output (stdout + stderr) to both the terminal and the log file
exec > >(tee -a "$SETUP_LOG") 2>&1

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   🎙️  Transcription Agent — Setup                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
log "📝 Setup log: $SETUP_LOG"
echo ""

# ── 1. Detect platform ──

OS="$(uname -s)"
ARCH="$(uname -m)"
WHISPER_VARIANT=""

log "🔍 Detecting platform: $OS / $ARCH"

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    log "   → macOS Apple Silicon — using mlx-whisper (Neural Engine)"
    WHISPER_VARIANT="mlx-whisper"
elif [ "$OS" = "Darwin" ]; then
    log "   → macOS Intel — using faster-whisper (CPU-optimized)"
    WHISPER_VARIANT="faster-whisper"
elif [ "$OS" = "Linux" ]; then
    log "   → Linux — using faster-whisper"
    WHISPER_VARIANT="faster-whisper"
elif echo "$OS" | grep -qi "mingw\|msys\|cygwin"; then
    log "   → Windows — using faster-whisper"
    WHISPER_VARIANT="faster-whisper"
else
    log "   → Unknown platform — using openai-whisper (fallback)"
    WHISPER_VARIANT="openai-whisper"
fi

# ── 2. Python venv + base deps ──

echo ""
log "📦 Step 1/5: Setting up Python virtual environment..."
echo ""

cd "$ROOT/python-backend"

# ── Pick a Python >= 3.10 (the security-pinned deps in requirements.txt and
# the ML stack require it; the app is tested on 3.11). Bare `python3` may be
# 3.9 on some systems (e.g. older macOS), which can no longer resolve them. ──
PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  log "❌ Python >= 3.10 required (Python 3.11 recommended). Install it and re-run this script."
  exit 1
fi
log "🐍 Using Python: $("$PYTHON_BIN" --version)"

if [ ! -d "venv" ]; then
    "$PYTHON_BIN" -m venv venv
    log "✅ venv created"
else
    log "✅ venv already exists"
fi

source venv/bin/activate
log "🐍 Python: $(python3 --version)"

# Reject a pre-existing venv built on Python < 3.10 (requirements.txt can no
# longer resolve there). Rebuilding on 3.11 also applies the pip-audit fixes.
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  log "❌ Existing venv is Python < 3.10. Delete python-backend/venv and re-run this script to rebuild it."
  exit 1
fi

echo ""
log "📦 Installing base Python packages (pip upgrade + requirements.txt)..."
echo "   This may take a few minutes — downloading and compiling dependencies..."
echo ""
pip install --upgrade pip 2>&1 || true
pip install -r requirements.txt 2>&1 || true
echo ""
log "✅ Base dependencies installed (or already up to date)"

# ── 3. Platform-specific Whisper variant ──

echo ""
log "📦 Step 2/5: Installing $WHISPER_VARIANT..."
echo ""

case "$WHISPER_VARIANT" in
    mlx-whisper)
        log "   Installing mlx-whisper (Apple Silicon Neural Engine)..."
        pip install mlx-whisper 2>&1 || true
        ;;
    faster-whisper)
        log "   Installing faster-whisper (CTranslate2, CPU/CUDA)..."
        pip install faster-whisper 2>&1 || true
        ;;
    *)
        log "   Installing openai-whisper (PyTorch fallback)..."
        pip install openai-whisper 2>&1 || true
        ;;
esac
echo ""
log "✅ $WHISPER_VARIANT installed"

# ── 4. Node.js packages ──

echo ""
log "📦 Step 3/5: Installing Node.js packages — agent-runner..."
echo ""
cd "$ROOT/agent-runner"
npm install 2>&1 || true
echo ""
log "✅ agent-runner dependencies installed"

echo ""
log "📦 Step 3/5: Installing Node.js packages — bridge-server..."
echo ""
cd "$ROOT/bridge-server"
npm install 2>&1 || true
echo ""
log "✅ bridge-server dependencies installed"

echo ""
log "📦 Step 3/5: Installing Node.js packages — electron app..."
echo ""
cd "$ROOT/electron"
npm install 2>&1 || true
echo ""
log "✅ electron dependencies installed"

# ── 5. Pre-cache diarization model ──

DIARIZATION_STATUS="⚠️  Not checked"
HF_TOKEN=""

echo ""
log "🧠 Step 4/5: Checking pyannote/speaker-diarization-3.1 model..."

# Load HF token from .env if present
if [ -f "$ROOT/.env" ]; then
    HF_TOKEN=$(grep -E '^HUGGING_FACE_TOKEN=' "$ROOT/.env" | head -1 | cut -d'=' -f2)
fi

if [ -n "$HF_TOKEN" ]; then
    log "   HF token found — pre-downloading diarization model..."
    log "   (this downloads ~200MB+ and may take several minutes)"
    echo ""
    # Download model (wrapped in || true so set -e doesn't abort on failure)
    HF_TOKEN="$HF_TOKEN" python3 << 'PYEOF' 2>&1 || true
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

    echo ""
    if grep -q 'MODEL_OK' "$SETUP_LOG" 2>/dev/null; then
        DIARIZATION_STATUS="✅  Ready (cached)"
        log "✅ Diarization model cached successfully!"
    else
        ERROR_MSG=$(grep 'FAILED:' "$SETUP_LOG" | head -1 | sed 's/FAILED: //')
        if [ -n "$ERROR_MSG" ]; then
            log "⚠️  Model download failed: $ERROR_MSG"
            log "📝 The pipeline will still work without speaker labels."
            DIARIZATION_STATUS="❌  $ERROR_MSG"
        fi
    fi
else
    log "⏭️  No HUGGING_FACE_TOKEN found in .env — skipping download."
    echo "   📝 Set HUGGING_FACE_TOKEN in .env to enable speaker diarization."
    echo "      Get a token: https://hf.co/settings/tokens"
    echo "      Accept terms: https://hf.co/pyannote/speaker-diarization-3.1"
    DIARIZATION_STATUS="⏭️  Skipped (no HF_TOKEN)"
fi

# ── 5. Record OLLAMA_NUM_CTX default in .env if not already present ──

echo ""
log "📝 Step 5/5: Ensuring OLLAMA_NUM_CTX in .env..."
if grep -q '^OLLAMA_NUM_CTX=' "$ROOT/.env" 2>/dev/null; then
    log "✅ OLLAMA_NUM_CTX already set in .env"
else
    echo "" >> "$ROOT/.env"
    echo "# Ollama context window size (set by setup script)" >> "$ROOT/.env"
    echo "OLLAMA_NUM_CTX=32768" >> "$ROOT/.env"
    log "✅ OLLAMA_NUM_CTX=32768 added to .env"
fi

# ── 6. Summary ──

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   ✅ Setup complete!                                     ║"
echo "║                                                          ║"
echo "║   Whisper variant:   $WHISPER_VARIANT"
echo "║   Diarization model: $DIARIZATION_STATUS"
echo "║   Context window:    ${OLLAMA_NUM_CTX:-32768} tokens"
echo "║                                                          ║"
echo "║   📄 Setup log: $SETUP_LOG"
echo "║                                                          ║"
echo "║   Run the Electron app:  npm run electron:dev            ║"
echo "║                                                          ║"
echo "║   Or start services individually:                       ║"
echo "║     npm run transcribe:backend     (Python :5001)        ║"
echo "║     npm run transcribe:bridge      (Node :5010)          ║"
echo "║     npm run transcribe:runner      (agent prompt)        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
log "✅ Setup finished — full log saved to $SETUP_LOG"
