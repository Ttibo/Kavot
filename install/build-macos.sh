#!/bin/sh
# Builds the Kavot macOS disk image (install/dist/Kavot-<version>-macos-<arch>.dmg).
# Requirements: Python 3.10+, Node.js 20.19+ with npm, Xcode command line tools.
# Optional signing: export KAVOT_CODESIGN_IDENTITY="Developer ID Application: …".
# Build on the architecture you target (arm64 or x86_64).
# Usage: sh install/build-macos.sh [--skip-frontend] [--bundle-only]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$HERE/build/venv"
PYTHON="${KAVOT_PYTHON:-python3}"

# A dedicated environment keeps the bundle free of unrelated packages.
[ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -e "$ROOT[desktop,build]"
exec "$VENV/bin/python" "$HERE/build.py" "$@"
