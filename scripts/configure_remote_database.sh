#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

PASSWORD_SOURCE="provided"
if [ -z "${REMOTE_DB_PASSWORD:-}" ]; then
  PASSWORD_SOURCE="generated"
  LOCAL_PYTHON="python3"
  if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
    LOCAL_PYTHON="$ROOT_DIR/.venv/bin/python"
  fi
  REMOTE_DB_PASSWORD="$(
    "$LOCAL_PYTHON" - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
  )"
fi

REMOTE_DB_PASSWORD_B64="$(printf '%s' "$REMOTE_DB_PASSWORD" | base64 | tr -d '\n')"
export REMOTE_DB_PASSWORD_B64
REMOTE_DB_PUBLIC_HOST="${REMOTE_DB_PUBLIC_HOST:-REMOTE_HOST}"
REMOTE_DB_PUBLIC_PORT="${REMOTE_DB_PUBLIC_PORT:-5432}"

ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" "REMOTE_PROJECT_DIR='$REMOTE_PROJECT_DIR' REMOTE_DB_PASSWORD_B64='$REMOTE_DB_PASSWORD_B64' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DB_PASSWORD="$(printf '%s' "$REMOTE_DB_PASSWORD_B64" | base64 -d)"
true
mkdir -p "$REMOTE_PROJECT_DIR/runtime"

runuser -u postgres -- createdb cv_stream 2>/dev/null || true
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v db_password="$REMOTE_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE cv_user LOGIN PASSWORD %L', :'db_password')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = 'cv_user'
)\gexec
ALTER ROLE cv_user LOGIN PASSWORD :'db_password';
ALTER DATABASE cv_stream OWNER TO cv_user;
\c cv_stream
GRANT ALL PRIVILEGES ON DATABASE cv_stream TO cv_user;
GRANT USAGE, CREATE ON SCHEMA public TO cv_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cv_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO cv_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cv_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cv_user;
SQL

cat > "$REMOTE_PROJECT_DIR/.env" <<REMOTE_ENV
SERVICE_NAME=cv-stream-timescale-api
SERVICE_VERSION=0.1.0
CAPTURE_SOURCE_KIND=http_mjpeg
CAPTURE_SOURCE_URL=
CAPTURE_USERNAME=
CAPTURE_PASSWORD=
CAPTURE_FPS_LIMIT=15
CAPTURE_DEVICE_ID=1
CAPTURE_TASK_ID=1
STREAM_MODE=pull
STREAM_PROTOCOL=http_mjpeg
STREAM_PUSH_URL=
STREAM_USERNAME=
STREAM_PASSWORD=
INFERENCE_ENDPOINT=
INFERENCE_DEVICE=auto
INFERENCE_MODEL=yolov8n.pt
CONFIDENCE_THRESHOLD=0.5
FRAME_INTERVAL=10
DATABASE_URL=postgresql://cv_user:${REMOTE_DB_PASSWORD}@127.0.0.1:5432/cv_stream
DATABASE_CONNECT_TIMEOUT=5
DATABASE_BATCH_SIZE=50
DATABASE_FLUSH_INTERVAL_MS=1000
SPOOL_SQLITE_PATH=runtime/spool.db
REMOTE_API_BASE_URL=
REMOTE_API_HOST=127.0.0.1
REMOTE_API_PORT=8000
REMOTE_SSH_HOST=
REMOTE_SSH_PORT=22
REMOTE_SSH_USER=
REMOTE_SSH_KEY_PATH=
REMOTE_ENV
chmod 600 "$REMOTE_PROJECT_DIR/.env"
echo "remote database configured"
echo "remote env written: $REMOTE_PROJECT_DIR/.env"
REMOTE_SCRIPT

mkdir -p "$ROOT_DIR/runtime"
cat > "$ROOT_DIR/runtime/remote_database.env" <<LOCAL_ENV
DATABASE_URL=postgresql://cv_user:${REMOTE_DB_PASSWORD}@${REMOTE_DB_PUBLIC_HOST}:${REMOTE_DB_PUBLIC_PORT}/cv_stream
SERVER_DATABASE_URL=postgresql://cv_user:${REMOTE_DB_PASSWORD}@127.0.0.1:5432/cv_stream
LOCAL_ENV
chmod 600 "$ROOT_DIR/runtime/remote_database.env"

echo "database password source: $PASSWORD_SOURCE"
echo "local ignored direct database env: runtime/remote_database.env"
