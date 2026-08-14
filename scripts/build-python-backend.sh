#!/usr/bin/env bash
#
# build-python-backend.sh
#
# Compiles the Python backend into a standalone executable using PyInstaller.
# The output is placed in dist-resources/python-backend/ so electron-builder
# can bundle it as extraResource.
#
# Prerequisites:
#   - Python venv must already exist (run `npm run transcribe:setup` first)
#   - All pip dependencies should be installed
#
# Usage:
#   ./scripts/build-python-backend.sh
#
# Output:
#   dist-resources/python-backend/
#   └── main/                                  ← bundle directory (name matches --name)
#       ├── main          (or main.exe on Windows)  ← standalone executable
#       └── _internal/                              ← bundled dependencies
#
# Note: The electron app's resolvePythonBin() checks both this nested layout
#       and a flat layout (<distpath>/main.exe) for compatibility across
#       different PyInstaller versions and platforms.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/python-backend"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   🐍  Building Python Backend (PyInstaller)              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Determine platform ──

IS_WIN=false
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    IS_WIN=true
    ;;
esac

# Windows venvs use Scripts/ + Lib/; Unix venvs use bin/ + lib/python3*/.
# NOTE: speechbrain is bundled with `--collect-all "speechbrain"` (NOT --add-data):
# speechbrain lazy-imports submodules (speechbrain.lobes.*) and PyInstaller's static
# analysis can't see them. A bare --add-data glob produced a double-nested
# `_internal/speechbrain/speechbrain/` layout and omitted `lobes/`, which made
# `import speechbrain.lobes` fail with [Errno 2] at runtime (pyannote diarization
# unavailable). --collect-all bundles the package + its data/binaries/submodules in
# the correct flat layout — the same approach Windows CI uses (see build-win.yml).
if [ "$IS_WIN" = true ]; then
  VENV_PYTHON="venv/Scripts/python.exe"
  BINARY_NAME="main.exe"
else
  VENV_PYTHON="venv/bin/python3"
  BINARY_NAME="main"
fi

# ── 2. Verify venv ──

if [ ! -d "venv" ]; then
  echo "❌ No venv found at python-backend/venv/"
  echo "   Run 'npm run transcribe:setup' or 'python3 -m venv venv' first."
  exit 1
fi
if [ ! -f "$VENV_PYTHON" ]; then
  echo "❌ Python not found at $VENV_PYTHON"
  echo "   On Windows, create the venv with:  python -m venv venv"
  exit 1
fi

echo "   🐍 Python: $("$VENV_PYTHON" --version)"
echo "   📍 Venv:   $(cd "$ROOT/python-backend" && pwd)/venv"
echo ""

# ── 3. Install PyInstaller in venv ──

echo "   📦 Installing PyInstaller..."
"$VENV_PYTHON" -m pip install --quiet pyinstaller 2>&1 | tail -1
echo "   ✅ PyInstaller $("$VENV_PYTHON" -m PyInstaller --version)"
echo ""

OUTDIR="$ROOT/dist-resources/python-backend"
mkdir -p "$OUTDIR"

# ── 4. Run PyInstaller ──
#
# Using --onedir (not --onefile) for faster startup and easier debugging.
# Models (whisper, pyannote) are downloaded at runtime from HuggingFace
# and don't need to be bundled.
#
# Hidden imports are needed because PyInstaller's static analysis can't
# always detect dynamically imported modules.
#
# --collect-all for lightning_fabric / pytorch_lightning / pyannote.audio / speechbrain
# is required: those packages read DATA files at import time (e.g.
# lightning_fabric/version.info) and dynamically import submodules (e.g.
# speechbrain.lobes.*). Without it, `import pyannote.audio` raises FileNotFoundError
# in the packaged backend (diarization reported unavailable).

echo "   🔨 Running PyInstaller (this may take a few minutes)..."
echo ""

"$VENV_PYTHON" -m PyInstaller \
  --onedir \
  --name "main" \
  --distpath "$OUTDIR" \
  --workpath "$ROOT/python-backend/build/pyinstaller" \
  --specpath "$ROOT/python-backend/build" \
  --hidden-import "uvicorn" \
  --hidden-import "uvicorn.logging" \
  --hidden-import "uvicorn.loops" \
  --hidden-import "uvicorn.loops.auto" \
  --hidden-import "uvicorn.protocols" \
  --hidden-import "uvicorn.protocols.http" \
  --hidden-import "uvicorn.protocols.http.httptools_impl" \
  --hidden-import "uvicorn.protocols.websockets" \
  --hidden-import "uvicorn.protocols.websockets.wsproto_impl" \
  --hidden-import "uvicorn.middleware" \
  --hidden-import "uvicorn.middleware.proxy_headers" \
  --hidden-import "fastapi" \
  --hidden-import "fastapi.routing" \
  --hidden-import "pydantic" \
  --hidden-import "pydantic.json" \
  --hidden-import "multipart" \
  --hidden-import "python_multipart" \
  --hidden-import "soundfile" \
  --hidden-import "numpy" \
  --hidden-import "torch" \
  --hidden-import "torchaudio" \
  --hidden-import "pyannote.audio" \
  --hidden-import "pyannote.audio.pipelines" \
  --hidden-import "pyannote.audio.pipelines.speaker_diarization" \
  --hidden-import "chromadb" \
  --hidden-import "sentence_transformers" \
  --hidden-import "dotenv" \
  --hidden-import "json" \
  --hidden-import "threading" \
  --hidden-import "warnings" \
  --hidden-import "asyncio" \
  --hidden-import "os" \
  --hidden-import "sys" \
  --hidden-import "shutil" \
  --hidden-import "glob" \
  --hidden-import "uuid" \
  --hidden-import "datetime" \
  --hidden-import "pathlib" \
  --hidden-import "sqlite3" \
  --hidden-import "hashlib" \
  --hidden-import "logging" \
  --hidden-import "inspect" \
  --hidden-import "contextlib" \
  --hidden-import "collections" \
  --hidden-import "functools" \
  --hidden-import "typing" \
  --hidden-import "email.mime.text" \
  --hidden-import "email.mime.multipart" \
  --hidden-import "email.mime.base" \
  --hidden-import "httpx" \
  --hidden-import "anyio" \
  --hidden-import "sniffio" \
  --hidden-import "starlette" \
  --hidden-import "starlette.middleware" \
  --hidden-import "starlette.middleware.cors" \
  --hidden-import "starlette.routing" \
  --hidden-import "starlette.applications" \
  --hidden-import "starlette.requests" \
  --hidden-import "starlette.responses" \
  --hidden-import "starlette.datastructures" \
  --hidden-import "multidict" \
  --collect-all "lightning_fabric" \
  --collect-all "pytorch_lightning" \
  --collect-all "pyannote.audio" \
  --collect-all "speechbrain" \
  main.py 2>&1

echo ""
echo "   ✅ PyInstaller completed"

# ── 5. Clean up build artifacts ──

echo "   🧹 Cleaning up build artifacts..."
rm -rf "$ROOT/python-backend/build"
echo ""

# ── 6. Verify ──

# PyInstaller output layout varies by version: nested (main/main.exe) or flat (main.exe)
BINARY_PATH=""
for candidate in "$OUTDIR/$BINARY_NAME" "$OUTDIR/main/$BINARY_NAME"; do
  if [ -f "$candidate" ]; then
    BINARY_PATH="$candidate"
    break
  fi
done
if [ -n "$BINARY_PATH" ]; then
  echo "   ✅ Standalone Python backend built:"
  echo "      $BINARY_PATH"
  if [ "$IS_WIN" = false ]; then
    file "$BINARY_PATH"
  fi
  du -sh "$OUTDIR"
else
  echo "   ❌ Build failed — binary not found under $OUTDIR"
  exit 1
fi

echo ""
echo "   📍  $OUTDIR/"
echo "      ├── $BINARY_NAME"
echo "      └── _internal/"
echo ""
