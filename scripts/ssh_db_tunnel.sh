#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

LOCAL_DB_PORT="${LOCAL_DB_PORT:-15432}"

echo "Optional database tunnel: 127.0.0.1:$LOCAL_DB_PORT -> 127.0.0.1:5432"
echo "Prefer direct DATABASE_URL=postgresql://user:password@DB_HOST:5432/db_name."
echo "Use this only when SSH port forwarding is available and the database cannot be reached directly."

ssh -L "$LOCAL_DB_PORT:127.0.0.1:5432" \
  "${SSH_ARGS[@]}" \
  "$REMOTE_HOST"
