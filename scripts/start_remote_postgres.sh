#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

remote_ssh "
  set -e
  $REMOTE_POSTGRES_START_SCRIPT
  echo 'postgres clusters checked'
"
