#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

if [ -n "${KAVOT_PYTHON:-}" ]; then
    PYTHON=$KAVOT_PYTHON
elif [ -x "$ROOT/.venv/bin/python" ]; then
    PYTHON="$ROOT/.venv/bin/python"
else
    PYTHON=python3
fi

case "${1:-desktop}" in
    desktop|web) MODE=${1:-desktop} ;;
    *) echo "Usage: sh app/scripts/run.sh [desktop|web]" >&2; exit 2 ;;
esac

"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Kavot requires Python 3.10 or later.")'

if [ "$MODE" = web ]; then
    exec "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
fi

if [ ! -f "$ROOT/frontend/static/index.html" ]; then
    echo "Build the interface: npm --prefix frontend ci && npm --prefix frontend run build" >&2
    exit 1
fi

exec "$PYTHON" "$ROOT/desktop.py"
