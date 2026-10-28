#!/bin/sh
# Builds the Kavot Linux packages (install/dist/Kavot-<version>-linux-<arch>.tar.gz, plus an
# .AppImage when appimagetool is on the PATH).
# Requirements: Python 3.10+, Node.js 20.19+ with npm. The window uses Qt WebEngine,
# installed in the build environment through pywebview[qt].
# Usage: sh install/build-linux.sh [--skip-frontend] [--bundle-only]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$HERE/build/venv"
PYTHON="${KAVOT_PYTHON:-python3}"

# A dedicated environment keeps the bundle free of unrelated packages.
[ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -e "$ROOT[desktop,build]" "pywebview[qt]>=6.0,<7.0"
exec "$VENV/bin/python" "$HERE/build.py" "$@"
