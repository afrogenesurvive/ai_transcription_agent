#!/usr/bin/env bash
#
# build-agent-runner.sh
#
# Installs agent-runner deps and bundles the runner into a single esbuild
# output (agent-runner/dist/bundle.js). electron-builder then ships only that
# bundle as an extraResource instead of the full node_modules tree.
#
# Usage:
#   ./scripts/build-agent-runner.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent-runner"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   📦  Building Agent Runner (esbuild bundle)             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

echo "   📥 Installing agent-runner dependencies (npm ci)..."
npm ci

echo "   🔨 Bundling agent-runner with esbuild..."
npm run build

echo ""
echo "   ✅ Agent runner bundle ready:"
echo "      agent-runner/dist/bundle.js"
du -sh "$ROOT/agent-runner/dist"
echo ""
