#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${DATABASE_URL:-}" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required when applying schema through DATABASE_URL" >&2
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < "$ROOT_DIR/db/schema.sql"
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < "$ROOT_DIR/db/analysis_queries.sql"
  echo "database schema applied through DATABASE_URL"
  exit 0
fi

# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" \
  "true; cd /tmp && runuser -u postgres -- createdb cv_stream 2>/dev/null || true"

ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" \
  "cd /tmp && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d cv_stream" \
  < "$ROOT_DIR/db/schema.sql"

ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" \
  "cd /tmp && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d cv_stream" \
  < "$ROOT_DIR/db/analysis_queries.sql"

remote_ssh "cd /tmp && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d cv_stream <<'SQL'
SELECT 'GRANT ALL PRIVILEGES ON DATABASE cv_stream TO cv_user'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cv_user')\gexec
SELECT 'GRANT USAGE, CREATE ON SCHEMA public TO cv_user'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cv_user')\gexec
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cv_user'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cv_user')\gexec
SELECT 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO cv_user'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cv_user')\gexec
SQL"
