#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

remote_ssh "
  set -e
  echo 'project_dir: configured'
  test -d '$REMOTE_PROJECT_DIR'
  cd '$REMOTE_PROJECT_DIR'

  echo 'python:'
  '$REMOTE_PYTHON' --version

  echo 'python modules:'
  '$REMOTE_PYTHON' - <<'PY'
import importlib.util

for name in ['fastapi', 'uvicorn', 'pydantic_settings', 'asyncpg', 'aiosqlite', 'httpx', 'cv2', 'torch', 'ultralytics']:
    print(name, 'ok' if importlib.util.find_spec(name) else 'missing')
PY

  echo 'cuda:'
  '$REMOTE_PYTHON' - <<'PY'
import torch

print('torch', torch.__version__)
print('cuda_available', torch.cuda.is_available())
print('cuda_version', torch.version.cuda)
print('device_count', torch.cuda.device_count())
for index in range(torch.cuda.device_count()):
    print('gpu', index, torch.cuda.get_device_name(index))
PY

  echo 'postgres:'
  $REMOTE_POSTGRES_START_SCRIPT
  runuser -u postgres -- psql -tAc \"select case when exists (select 1 from pg_extension where extname = 'timescaledb') then 'timescaledb_present' else 'timescaledb_missing' end;\" cv_stream 2>/dev/null || true
  runuser -u postgres -- psql -tAc \"select 'schema_table_count ' || count(*) from information_schema.tables where table_schema='public' and table_name in ('device','cv_task','cv_result_meta','cv_detection_stream');\" cv_stream 2>/dev/null || true

  echo 'api:'
  '$REMOTE_PYTHON' - <<'PY'
import json
import urllib.error
import urllib.request

try:
    with urllib.request.urlopen('http://$REMOTE_API_HEALTH_HOST:$REMOTE_API_PORT/api/health', timeout=3) as response:
        print(json.dumps(json.load(response), ensure_ascii=False))
except urllib.error.URLError as exc:
    print('not_running', exc)
PY
"
