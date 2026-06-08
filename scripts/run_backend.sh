#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -x ".venv/bin/python" ]; then
  echo "Missing .venv. Run scripts/setup_local_backend.sh first." >&2
  exit 1
fi

. .venv/bin/activate
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
