#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

case "$ACTION" in
  start)
    remote_ssh "
      set -e
      cd '$REMOTE_PROJECT_DIR'
      test -f .env || { echo 'missing remote .env; run scripts/configure_remote_database.sh first' >&2; exit 1; }
      $REMOTE_POSTGRES_START_SCRIPT
      mkdir -p runtime
      if [ -f runtime/remote_api.pid ] && kill -0 \$(cat runtime/remote_api.pid) >/dev/null 2>&1; then
        echo 'remote api already running'
        exit 0
      fi
      nohup '$REMOTE_PYTHON' -m uvicorn backend.app.main:app --host '$REMOTE_API_HOST' --port '$REMOTE_API_PORT' > runtime/remote_api.log 2>&1 &
      echo \$! > runtime/remote_api.pid
      sleep 2
      '$REMOTE_PYTHON' - <<'PY'
import json
import urllib.request

with urllib.request.urlopen('http://$REMOTE_API_HEALTH_HOST:$REMOTE_API_PORT/api/health', timeout=5) as response:
    print(json.dumps(json.load(response), ensure_ascii=False))
PY
    "
    ;;
  stop)
    remote_ssh "
      set -e
      cd '$REMOTE_PROJECT_DIR'
      if [ -f runtime/remote_api.pid ] && kill -0 \$(cat runtime/remote_api.pid) >/dev/null 2>&1; then
        kill \$(cat runtime/remote_api.pid)
        rm -f runtime/remote_api.pid
        echo 'remote api stopped'
      else
        echo 'remote api not running'
      fi
    "
    ;;
  status)
    remote_ssh "
      set -e
      cd '$REMOTE_PROJECT_DIR'
      if [ -f runtime/remote_api.pid ] && kill -0 \$(cat runtime/remote_api.pid) >/dev/null 2>&1; then
        echo 'pid:' \$(cat runtime/remote_api.pid)
      else
        echo 'remote api not running'
      fi
      '$REMOTE_PYTHON' - <<'PY'
import json
import urllib.error
import urllib.request

try:
    with urllib.request.urlopen('http://$REMOTE_API_HEALTH_HOST:$REMOTE_API_PORT/api/health', timeout=3) as response:
        print(json.dumps(json.load(response), ensure_ascii=False))
except urllib.error.URLError as exc:
    print('health_check_failed', exc)
PY
    "
    ;;
  logs)
    remote_ssh "cd '$REMOTE_PROJECT_DIR' && tail -n 80 runtime/remote_api.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|logs}" >&2
    exit 2
    ;;
esac
