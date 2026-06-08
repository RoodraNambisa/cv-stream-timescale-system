#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

echo "Syncing $ROOT_DIR to $REMOTE_LOGIN@$REMOTE_HOST:$REMOTE_PROJECT_DIR"

COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --exclude .git \
  --exclude .DS_Store \
  --exclude .env \
  --exclude .venv \
  --exclude 'apps/web/node_modules' \
  --exclude 'apps/web/dist' \
  --exclude 'backend/app/__pycache__' \
  --exclude 'runtime/*' \
  --exclude '*.pyc' \
  -C "$ROOT_DIR" \
  -cf - . \
  | ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" "
      set -e
      mkdir -p '$REMOTE_PROJECT_DIR'
      tar -xf - -C '$REMOTE_PROJECT_DIR'
      mkdir -p '$REMOTE_PROJECT_DIR/runtime'
    "

remote_ssh "cd '$REMOTE_PROJECT_DIR' && find . -maxdepth 2 -type f | wc -l"
