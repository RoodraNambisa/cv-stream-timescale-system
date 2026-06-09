#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

remote_ssh "
  set -e
  '$REMOTE_PYTHON' - <<'PY'
import torch
import ultralytics

print('remote python environment ready')
print('torch', torch.__version__)
print('cuda_available', torch.cuda.is_available())
print('cuda_version', torch.version.cuda)
print('device_count', torch.cuda.device_count())
for index in range(torch.cuda.device_count()):
    print('gpu', index, torch.cuda.get_device_name(index))
print('ultralytics', ultralytics.__version__)
PY
"
