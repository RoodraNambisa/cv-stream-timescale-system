#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

LOCAL_API_PORT="${LOCAL_API_PORT:-18000}"

echo "Optional inference/API tunnel: http://127.0.0.1:$LOCAL_API_PORT -> $REMOTE_API_HOST:$REMOTE_API_PORT"
echo "Prefer direct INFERENCE_ENDPOINT=http://API_HOST:API_PORT for local capture with remote GPU inference."
echo "Use this only when SSH port forwarding is available and the API cannot be reached directly."

ssh -L "$LOCAL_API_PORT:$REMOTE_API_HOST:$REMOTE_API_PORT" \
  "${SSH_ARGS[@]}" \
  "$REMOTE_HOST"
