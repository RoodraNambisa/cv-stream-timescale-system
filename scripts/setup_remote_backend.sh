#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

REMOTE_PIP_INDEX_URLS="${REMOTE_PIP_INDEX_URLS:-https://pypi.tuna.tsinghua.edu.cn/simple https://mirrors.aliyun.com/pypi/simple https://pypi.mirrors.ustc.edu.cn/simple https://pypi.org/simple}"

ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" \
  "REMOTE_PROJECT_DIR='$REMOTE_PROJECT_DIR' REMOTE_PYTHON='$REMOTE_PYTHON' REMOTE_PIP_INDEX_URLS='$REMOTE_PIP_INDEX_URLS' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$REMOTE_PROJECT_DIR"

missing_packages="$("$REMOTE_PYTHON" - <<'PY'
import importlib.util

checks = [
    ('fastapi', 'fastapi'),
    ('uvicorn', 'uvicorn'),
    ('pydantic_settings', 'pydantic-settings'),
    ('asyncpg', 'asyncpg'),
    ('aiosqlite', 'aiosqlite'),
    ('httpx', 'httpx'),
    ('multipart', 'python-multipart'),
]

print(' '.join(package for module, package in checks if importlib.util.find_spec(module) is None))
PY
)"

if [ -n "$missing_packages" ]; then
  installed=0
  for index_url in $REMOTE_PIP_INDEX_URLS; do
    echo "trying pip index: $index_url"
    if command -v timeout >/dev/null 2>&1; then
      timeout 180 "$REMOTE_PYTHON" -m pip install \
        --disable-pip-version-check \
        --timeout 20 \
        --retries 1 \
        -i "$index_url" \
        $missing_packages && installed=1 && break
    else
      "$REMOTE_PYTHON" -m pip install \
        --disable-pip-version-check \
        --timeout 20 \
        --retries 1 \
        -i "$index_url" \
        $missing_packages && installed=1 && break
    fi
  done

  if [ "$installed" -ne 1 ]; then
    echo "failed to install missing packages: $missing_packages" >&2
    exit 1
  fi
else
  echo "remote backend Python packages already available"
fi

"$REMOTE_PYTHON" - <<'PY'
import importlib.util

required = [
    'fastapi',
    'uvicorn',
    'pydantic_settings',
    'asyncpg',
    'aiosqlite',
    'httpx',
    'multipart',
    'cv2',
    'torch',
    'ultralytics',
]

for name in required:
    print(name, 'ok' if importlib.util.find_spec(name) else 'missing')
PY
REMOTE_SCRIPT
