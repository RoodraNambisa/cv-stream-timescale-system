#!/usr/bin/env bash

REMOTE_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_COMMON_ROOT="$(cd "$REMOTE_COMMON_DIR/.." && pwd)"

for env_file in "$REMOTE_COMMON_ROOT/runtime/remote_connection.env" "$REMOTE_COMMON_ROOT/runtime/remote_database.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
done

REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_LOGIN="${REMOTE_LOGIN:-}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_KEY="${REMOTE_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_PROJECT_DIR="${REMOTE_PROJECT_DIR:-cv-stream-timescale-system}"
REMOTE_PYTHON="${REMOTE_PYTHON:-python3}"
REMOTE_API_HOST="${REMOTE_API_HOST:-0.0.0.0}"
REMOTE_API_PORT="${REMOTE_API_PORT:-8000}"
REMOTE_API_HEALTH_HOST="${REMOTE_API_HEALTH_HOST:-$REMOTE_API_HOST}"
if [ "$REMOTE_API_HEALTH_HOST" = "0.0.0.0" ] || [ "$REMOTE_API_HEALTH_HOST" = "::" ]; then
  REMOTE_API_HEALTH_HOST="127.0.0.1"
fi
REMOTE_CONNECT_TIMEOUT="${REMOTE_CONNECT_TIMEOUT:-8}"
REMOTE_PIP_INDEX_URLS="${REMOTE_PIP_INDEX_URLS:-https://pypi.tuna.tsinghua.edu.cn/simple https://mirrors.aliyun.com/pypi/simple https://pypi.mirrors.ustc.edu.cn/simple https://pypi.org/simple}"
REMOTE_PIP_TRUSTED_HOSTS="${REMOTE_PIP_TRUSTED_HOSTS:-}"
REMOTE_PIP_PROXY="${REMOTE_PIP_PROXY:-}"
REMOTE_POSTGRES_START_SCRIPT='
if command -v pg_lsclusters >/dev/null 2>&1 && command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_lsclusters --no-header | while read -r pg_version pg_name _; do
    if [ -n "$pg_version" ] && [ -n "$pg_name" ]; then
      pg_ctlcluster "$pg_version" "$pg_name" start >/dev/null 2>&1 || true
    fi
  done
fi
'

if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_LOGIN" ]; then
  echo "Missing REMOTE_HOST or REMOTE_LOGIN. Set environment variables or create runtime/remote_connection.env." >&2
  exit 1
fi

SSH_ARGS=(
  -i "$REMOTE_KEY"
  -o BatchMode=yes
  -o ConnectTimeout="$REMOTE_CONNECT_TIMEOUT"
  -o IdentitiesOnly=yes
  -o PubkeyAcceptedAlgorithms=+ssh-rsa
  -o HostkeyAlgorithms=+ssh-rsa
  -p "$REMOTE_PORT"
  -l "$REMOTE_LOGIN"
)

remote_ssh() {
  ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" "$@"
}
