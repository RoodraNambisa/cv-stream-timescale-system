#!/usr/bin/env bash

REMOTE_HOST="${REMOTE_HOST:-REMOTE_HOST}"
REMOTE_LOGIN="${REMOTE_LOGIN:-REMOTE_LOGIN}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_KEY="${REMOTE_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_PROJECT_DIR="${REMOTE_PROJECT_DIR:-REMOTE_PROJECT_DIR}"
REMOTE_PYTHON="${REMOTE_PYTHON:-python3}"
REMOTE_API_HOST="${REMOTE_API_HOST:-127.0.0.1}"
REMOTE_API_PORT="${REMOTE_API_PORT:-8000}"

SSH_ARGS=(
  -i "$REMOTE_KEY"
  -o IdentitiesOnly=yes
  -o PubkeyAcceptedAlgorithms=+ssh-rsa
  -o HostkeyAlgorithms=+ssh-rsa
  -p "$REMOTE_PORT"
  -l "$REMOTE_LOGIN"
)

remote_ssh() {
  ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" "$@"
}
