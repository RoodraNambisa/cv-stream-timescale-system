#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "final_local_review_failed: $*" >&2
  exit 1
}

run_step() {
  echo
  echo "==> $*"
  "$@"
}

require_file() {
  local path="$1"
  [ -f "$path" ] || fail "missing file: $path"
}

require_dir() {
  local path="$1"
  [ -d "$path" ] || fail "missing directory: $path"
}

check_tracked_outputs() {
  echo "==> checking tracked files"

  local forbidden
  forbidden="$(
    git ls-files \
      | grep -E '(^|/)(\.env($|\.)|runtime/|docs/)|\.(db|sqlite|sqlite3|log|pt|onnx|engine|mp4|mov|avi)$' \
      | grep -v '^\.env\.example$' \
      | grep -v '^runtime/\.gitkeep$' \
      || true
  )"
  if [ -n "$forbidden" ]; then
    echo "$forbidden" >&2
    fail "forbidden tracked file"
  fi

  local blocked_terms
  blocked_terms=(
    "作""业"
    "课""程"
    "大""作""业"
    "高级""软件""工程"
    "实""验"
    "报""告"
    "演""示"
    "截""图"
    "提交""物"
    "老""师"
    "学""校"
    "教""学"
    "stu""dent"
    "co""urse"
    "home""work"
    "assign""ment"
    "re""port"
    "de""mo"
    "screen""shot"
    "sub""mission"
  )
  local blocked_pattern
  blocked_pattern="$(IFS='|'; echo "${blocked_terms[*]}")"
  local blocked_matches
  blocked_matches="$(git grep -n -E "$blocked_pattern" -- . ':!docs' || true)"
  if [ -n "$blocked_matches" ]; then
    echo "$blocked_matches" >&2
    fail "forbidden tracked wording"
  fi

  local private_terms
  private_terms=(
    "hpc"".chzu"".edu"".cn"
    "Mq4""DaArR"
    "root""@""ssh"
    "300""22"
    "220""09"
    "220""10"
    "220""41"
    "PostgreSQL 14"".23"
    "TimescaleDB 2"".19"".3"
    "14"".23"
    "2"".19"".3"
    "/gemini""/code"
    "已验证""服务器"
    "本机""监听"
    "外部""映射"
  )
  local private_pattern
  private_pattern="$(IFS='|'; echo "${private_terms[*]}")"
  local private_matches
  private_matches="$(git grep -n -E "$private_pattern" -- . ':!docs' ':!scripts/final_local_review.sh' || true)"
  if [ -n "$private_matches" ]; then
    echo "$private_matches" >&2
    fail "private remote mapping leaked into tracked files"
  fi
}

check_project_shape() {
  echo "==> checking project shape"

  require_dir apps/web
  require_dir backend/app
  require_dir db
  require_dir deploy
  require_dir deploy/env
  require_dir scripts
  require_file runtime/.gitkeep
  require_file .env.example
  require_file db/schema.sql
  require_file db/analysis_queries.sql
  require_file deploy/env/local-all.env.example
  require_file deploy/env/edge-to-remote.env.example
  require_file deploy/env/server-all.env.example
  require_file deploy/mediamtx.yml
  require_file deploy/nginx-rtmp.conf
  require_file deploy/grafana/provisioning/datasources/timescaledb.yml
  require_file deploy/grafana/provisioning/dashboards/cv-stream.yml
  require_file deploy/grafana/dashboards/cv-stream.json
  require_file backend/app/main.py
  require_file apps/web/package.json
}

check_dependency_locations() {
  echo "==> checking dependency locations"

  if find . -path ./.git -prune -o -type d -name node_modules -print | grep -v -E '^./apps/web/node_modules(/.*)?$' | grep -q .; then
    find . -path ./.git -prune -o -type d -name node_modules -print >&2
    fail "node_modules outside apps/web"
  fi

  if find . -path ./.git -prune -o -type d -name '.venv' -print | grep -v '^./.venv$' | grep -q .; then
    find . -path ./.git -prune -o -type d -name '.venv' -print >&2
    fail ".venv outside project root"
  fi
}

check_runtime_paths_ignored() {
  echo "==> checking ignored runtime paths"

  git check-ignore -q .env || fail ".env is not ignored"
  git check-ignore -q runtime/spool.db || fail "runtime spool is not ignored"
  git check-ignore -q docs/local-notes.md || fail "docs materials are not ignored"
  git check-ignore -q yolov8n.pt || fail "model weights are not ignored"
}

check_scripts_executable() {
  echo "==> checking script modes"

  for script in \
    scripts/local_smoke_check.sh \
    scripts/local_api_smoke_check.sh \
    scripts/final_local_review.sh \
    scripts/run_backend.sh \
    scripts/run_web.sh \
    scripts/sync_remote_project.sh \
    scripts/remote_smoke_check.sh
  do
    [ -x "$script" ] || fail "script is not executable: $script"
  done
}

check_sql_assets() {
  echo "==> checking SQL assets"

  grep -q "CREATE EXTENSION IF NOT EXISTS timescaledb" db/schema.sql || fail "schema missing TimescaleDB extension"
  grep -q "CREATE TABLE IF NOT EXISTS device" db/schema.sql || fail "schema missing device table"
  grep -q "CREATE TABLE IF NOT EXISTS cv_task" db/schema.sql || fail "schema missing cv_task table"
  grep -q "CREATE TABLE IF NOT EXISTS cv_result_meta" db/schema.sql || fail "schema missing cv_result_meta table"
  grep -q "CREATE TABLE IF NOT EXISTS cv_detection_stream" db/schema.sql || fail "schema missing detection stream table"
  grep -q "create_hypertable" db/schema.sql || fail "schema missing hypertable call"
  grep -q "CREATE MATERIALIZED VIEW IF NOT EXISTS minutely_object_stats" db/schema.sql || fail "schema missing continuous aggregate"
  grep -q "time_bucket" db/analysis_queries.sql || fail "analysis queries missing time_bucket"
}

check_frontend_assets() {
  echo "==> checking frontend source"

  grep -q "总览" apps/web/src/App.tsx || fail "frontend missing overview tab"
  grep -q "配置" apps/web/src/App.tsx || fail "frontend missing config tab"
  grep -q "任务" apps/web/src/App.tsx || fail "frontend missing tasks tab"
  grep -q "分析" apps/web/src/App.tsx || fail "frontend missing analysis tab"
  grep -q "STREAM_RECEIVER_KIND" apps/web/src/App.tsx || fail "frontend missing stream receiver config"
  grep -q "API_AUTH_TOKEN" apps/web/src/App.tsx || fail "frontend missing API auth config"
  grep -q "CORS_ALLOWED_ORIGINS" apps/web/src/App.tsx || fail "frontend missing CORS config"
  grep -q "当前 API 要求 token" apps/web/src/App.tsx || fail "frontend missing API token prompt"
  grep -q "INFERENCE_API_TOKEN" apps/web/src/App.tsx || fail "frontend missing remote inference token config"
  grep -q "EyeOff" apps/web/src/App.tsx || fail "frontend missing sensitive reveal control"
  grep -q "前端 API 连接" apps/web/src/App.tsx || fail "frontend missing browser API panel"
  grep -q "GRAFANA_BASE_URL" apps/web/src/App.tsx || fail "frontend missing Grafana config"
  grep -q "REMOTE_PIP_INDEX_URLS" apps/web/src/App.tsx || fail "frontend missing remote pip config"
  grep -q "apply_schema" apps/web/src/App.tsx || fail "frontend missing schema apply action"
  grep -q "database_schema" apps/web/src/App.tsx || fail "frontend missing schema signal"
  grep -q "检测当前配置" apps/web/src/App.tsx || fail "frontend missing config probe action"
  grep -q "aria-live" apps/web/src/App.tsx || fail "frontend missing live regions"
  grep -q "prefers-reduced-motion" apps/web/src/App.css || fail "frontend missing reduced-motion handling"
  grep -q "当前表单预检" apps/web/README.md || fail "frontend README missing current workflow"
  local early_word
  early_word="第一""版"
  ! grep -q "$early_word" apps/web/README.md || fail "frontend README still describes an early skeleton"
}

check_backend_assets() {
  echo "==> checking backend source"

  grep -q '"/api/capture/start"' backend/app/main.py || fail "backend missing capture start endpoint"
  grep -q '"/api/spool/flush"' backend/app/main.py || fail "backend missing spool flush endpoint"
  grep -q '"/api/inference/image"' backend/app/main.py || fail "backend missing inference image endpoint"
  grep -q '"/api/environment/probe"' backend/app/main.py || fail "backend missing environment probe endpoint"
  grep -q '"/api/remote/{action}"' backend/app/main.py || fail "backend missing remote action endpoint"
  grep -q "StaticFiles" backend/app/main.py || fail "backend missing built frontend static hosting"
  grep -q "WEB_DIST_DIR" backend/app/main.py || fail "backend missing web dist mount"
  grep -q '"apply_schema"' backend/app/remote_ops.py || fail "remote actions missing schema apply"
  grep -q "DATABASE_URL" backend/app/config.py || fail "backend missing database config"
  grep -q "API_AUTH_TOKEN" backend/app/config.py || fail "backend missing API auth config"
  grep -q "CORS_ALLOWED_ORIGINS" backend/app/config.py || fail "backend missing CORS config"
  grep -q "api_auth_token" backend/app/main.py || fail "backend missing API token middleware"
  grep -q "parse_list_setting" backend/app/main.py || fail "backend missing dynamic CORS parser"
  grep -q "INFERENCE_ENDPOINT" backend/app/config.py || fail "backend missing inference endpoint config"
  grep -q "INFERENCE_API_TOKEN" backend/app/config.py || fail "backend missing remote inference token config"
  grep -q "CAPTURE_SOURCE_KIND" backend/app/config.py || fail "backend missing capture source config"
  grep -q "STREAM_RECEIVER_KIND" backend/app/config.py || fail "backend missing stream receiver config"
  grep -q "GRAFANA_BASE_URL" backend/app/config.py || fail "backend missing Grafana config"
  grep -q "check_stream_receiver" backend/app/environment.py || fail "backend missing stream receiver check"
  grep -q "check_grafana" backend/app/environment.py || fail "backend missing Grafana check"
  grep -q "check_database_schema" backend/app/environment.py || fail "backend missing schema readiness check"
  grep -q "remote_pip_index_urls" backend/app/config.py || fail "backend missing remote pip config"
  grep -q "REMOTE_PIP_PROXY" backend/app/remote_ops.py || fail "remote action missing pip proxy propagation"
  grep -q "REMOTE_PIP_PROXY" scripts/setup_remote_backend.sh || fail "remote setup missing pip proxy support"
  grep -q "REMOTE_API_HEALTH_HOST" scripts/remote_common.sh || fail "remote scripts missing API health host"
  grep -q 'REMOTE_API_HOST="${REMOTE_API_HOST:-0.0.0.0}"' scripts/remote_common.sh || fail "remote API should bind publicly by default"
  grep -q "REMOTE_PIP_INDEX_URLS" .env.example || fail "env example missing remote pip indexes"
  grep -q "CORS_ALLOWED_ORIGINS" .env.example || fail "env example missing CORS config"
  grep -q 'psql -v ON_ERROR_STOP=1 "$DATABASE_URL"' scripts/apply_remote_schema.sh || fail "schema script missing direct database path"
}

check_deploy_assets() {
  echo "==> checking optional deploy assets"

  grep -q "CAPTURE_SOURCE_KIND" deploy/env/local-all.env.example || fail "local env template missing capture config"
  grep -q "CORS_ALLOWED_ORIGINS" deploy/env/local-all.env.example || fail "local env template missing CORS config"
  grep -q "INFERENCE_ENDPOINT=" deploy/env/local-all.env.example || fail "local env template missing local inference config"
  grep -q "CORS_ALLOWED_ORIGINS" deploy/env/edge-to-remote.env.example || fail "edge env template missing CORS config"
  grep -q "INFERENCE_ENDPOINT=http://REMOTE_API_HOST:8000" deploy/env/edge-to-remote.env.example || fail "edge env template missing remote inference endpoint"
  grep -q "DATABASE_URL=postgresql://" deploy/env/edge-to-remote.env.example || fail "edge env template missing database URL"
  grep -q "CORS_ALLOWED_ORIGINS" deploy/env/server-all.env.example || fail "server env template missing CORS config"
  grep -q "STREAM_RECEIVER_KIND=mediamtx" deploy/env/server-all.env.example || fail "server env template missing stream receiver"
  grep -q "GRAFANA_BASE_URL" deploy/env/server-all.env.example || fail "server env template missing Grafana config"
  local mode_key
  mode_key="RUN""_MODE"
  if grep -R -n "$mode_key" deploy/env README.md .env.example >&2; then
    fail "env templates must use independent config keys"
  fi

  grep -q "apiAddress: :9997" deploy/mediamtx.yml || fail "MediaMTX template missing API port"
  grep -q "rtmpAddress: :1935" deploy/mediamtx.yml || fail "MediaMTX template missing RTMP port"
  grep -q "rtmp_stat all" deploy/nginx-rtmp.conf || fail "nginx-rtmp template missing stat endpoint"
  grep -q "timescaledb: true" deploy/grafana/provisioning/datasources/timescaledb.yml || fail "Grafana datasource missing TimescaleDB flag"
  grep -q "cv_detection_stream" deploy/grafana/dashboards/cv-stream.json || fail "Grafana dashboard missing detection stream query"
  grep -q "cv_result_meta" deploy/grafana/dashboards/cv-stream.json || fail "Grafana dashboard missing result meta query"

  .venv/bin/python -m json.tool deploy/grafana/dashboards/cv-stream.json >/dev/null
}

check_tracked_outputs
check_project_shape
check_dependency_locations
check_runtime_paths_ignored
check_scripts_executable
check_sql_assets
check_frontend_assets
check_backend_assets
check_deploy_assets

run_step bash -n scripts/*.sh
run_step .venv/bin/python -m compileall backend phone_stream_cv.py
run_step scripts/local_smoke_check.sh
run_step scripts/local_api_smoke_check.sh
run_step npm --prefix apps/web run lint
run_step npm --prefix apps/web run build
run_step git diff --check

echo
echo "final_local_review_ok"
