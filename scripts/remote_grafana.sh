#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=remote_common.sh
. "$ROOT_DIR/scripts/remote_common.sh"

GRAFANA_VERSION="${REMOTE_GRAFANA_VERSION:-13.0.2}"
GRAFANA_PACKAGE_URL="${REMOTE_GRAFANA_PACKAGE_URL:-https://dl.grafana.com/grafana/release/13.0.2/grafana_13.0.2_26816849631_linux_amd64.tar.gz}"
GRAFANA_PACKAGE_SHA256="${REMOTE_GRAFANA_PACKAGE_SHA256:-6720d8b0b48d92e2b33b7bf30b38480c12964ccd87285e5e754aa554165edf2d}"

case "$ACTION" in
  install|start|stop|restart|status|logs)
    ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac

remote_ssh "
  PROJECT_DIR='$REMOTE_PROJECT_DIR' \
  REMOTE_PYTHON='$REMOTE_PYTHON' \
  GRAFANA_VERSION='$GRAFANA_VERSION' \
  GRAFANA_PACKAGE_URL='$GRAFANA_PACKAGE_URL' \
  GRAFANA_PACKAGE_SHA256='$GRAFANA_PACKAGE_SHA256' \
  bash -s -- '$ACTION'
" <<'REMOTE'
set -euo pipefail

ACTION="${1:-status}"
cd "$PROJECT_DIR"

RUNTIME_DIR="$PROJECT_DIR/runtime/grafana"
DOWNLOAD_DIR="$RUNTIME_DIR/downloads"
INSTALL_ROOT="$RUNTIME_DIR/bin"
CURRENT_HOME="$INSTALL_ROOT/current"
PID_FILE="$PROJECT_DIR/runtime/grafana.pid"
LOG_FILE="$RUNTIME_DIR/grafana.log"

update_remote_env() {
  "$REMOTE_PYTHON" - <<'PY'
from pathlib import Path

updates = {
    "GRAFANA_BASE_URL": "http://127.0.0.1:3000",
    "GRAFANA_DASHBOARD_URL": "/grafana/d/cv-stream-timescale/cv-stream-timescale",
}
path = Path(".env")
lines = path.read_text().splitlines() if path.exists() else []
seen = set()
next_lines = []
for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        next_lines.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        next_lines.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        next_lines.append(line)
for key, value in updates.items():
    if key not in seen:
        next_lines.append(f"{key}={value}")
path.write_text("\n".join(next_lines).rstrip() + "\n")
PY
}

database_exports() {
  "$REMOTE_PYTHON" - <<'PY'
import shlex
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

def read_env_value(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            return value
    return ""

database_url = read_env_value(Path(".env"), "DATABASE_URL")
if not database_url:
    raise SystemExit("DATABASE_URL is empty in remote .env")

parsed = urlparse(database_url)
if parsed.scheme not in {"postgres", "postgresql"}:
    raise SystemExit("DATABASE_URL must use postgres/postgresql")

query = parse_qs(parsed.query)
sslmode = query.get("sslmode", ["disable"])[0] or "disable"
values = {
    "GRAFANA_PG_HOST": parsed.hostname or "127.0.0.1",
    "GRAFANA_PG_PORT": str(parsed.port or 5432),
    "GRAFANA_PG_DATABASE": unquote(parsed.path.lstrip("/")),
    "GRAFANA_PG_USER": unquote(parsed.username or ""),
    "GRAFANA_PG_PASSWORD": unquote(parsed.password or ""),
    "GRAFANA_PG_SSLMODE": sslmode,
}
if not values["GRAFANA_PG_DATABASE"] or not values["GRAFANA_PG_USER"]:
    raise SystemExit("DATABASE_URL is missing database or user")

for key, value in values.items():
    print(f"export {key}={shlex.quote(value)}")
PY
}

configure_runtime() {
  mkdir -p \
    "$RUNTIME_DIR/data" \
    "$RUNTIME_DIR/logs" \
    "$RUNTIME_DIR/plugins" \
    "$RUNTIME_DIR/provisioning/alerting" \
    "$RUNTIME_DIR/provisioning/dashboards" \
    "$RUNTIME_DIR/provisioning/datasources" \
    "$RUNTIME_DIR/provisioning/plugins" \
    "$RUNTIME_DIR/dashboards"

  cp deploy/grafana/provisioning/datasources/timescaledb.yml \
    "$RUNTIME_DIR/provisioning/datasources/timescaledb.yml"
  cp deploy/grafana/dashboards/cv-stream.json \
    "$RUNTIME_DIR/dashboards/cv-stream.json"
  cat > "$RUNTIME_DIR/provisioning/dashboards/cv-stream.yml" <<YAML
apiVersion: 1

providers:
  - name: cv-stream
    orgId: 1
    folder: CV Stream
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: $RUNTIME_DIR/dashboards
YAML
  update_remote_env
}

install_runtime() {
  mkdir -p "$DOWNLOAD_DIR" "$INSTALL_ROOT"
  package_file="$DOWNLOAD_DIR/$(basename "$GRAFANA_PACKAGE_URL")"

  if [ ! -f "$package_file" ]; then
    tmp_file="$package_file.part"
    curl -fL --connect-timeout 15 --retry 3 --retry-delay 3 \
      "$GRAFANA_PACKAGE_URL" -o "$tmp_file"
    mv "$tmp_file" "$package_file"
  fi

  actual_sha="$(sha256sum "$package_file" | awk '{print $1}')"
  if [ "$actual_sha" != "$GRAFANA_PACKAGE_SHA256" ]; then
    echo "grafana package checksum mismatch" >&2
    exit 1
  fi

  if [ ! -d "$INSTALL_ROOT/grafana-$GRAFANA_VERSION" ]; then
    tmp_dir="$INSTALL_ROOT/.extract-$GRAFANA_VERSION"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"
    tar -xzf "$package_file" -C "$tmp_dir"
    extracted_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    test -n "$extracted_dir"
    rm -rf "$INSTALL_ROOT/grafana-$GRAFANA_VERSION"
    mv "$extracted_dir" "$INSTALL_ROOT/grafana-$GRAFANA_VERSION"
    rm -rf "$tmp_dir"
  fi

  ln -sfn "grafana-$GRAFANA_VERSION" "$CURRENT_HOME"
  configure_runtime
  echo "grafana installed under runtime/grafana"
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1
}

start_grafana() {
  install_runtime >/dev/null
  if is_running; then
    echo "grafana already running"
    return
  fi
  rm -f "$PID_FILE"

  grafana_bin="$CURRENT_HOME/bin/grafana"
  if [ ! -x "$grafana_bin" ]; then
    echo "missing grafana executable" >&2
    exit 1
  fi

  eval "$(database_exports)"
  export GRAFANA_PG_HOST GRAFANA_PG_PORT GRAFANA_PG_DATABASE
  export GRAFANA_PG_USER GRAFANA_PG_PASSWORD GRAFANA_PG_SSLMODE
  export GF_PATHS_DATA="$RUNTIME_DIR/data"
  export GF_PATHS_LOGS="$RUNTIME_DIR/logs"
  export GF_PATHS_PLUGINS="$RUNTIME_DIR/plugins"
  export GF_PATHS_PROVISIONING="$RUNTIME_DIR/provisioning"
  export GF_SERVER_HTTP_ADDR="127.0.0.1"
  export GF_SERVER_HTTP_PORT="3000"
  export GF_SERVER_DOMAIN="127.0.0.1"
  export GF_SERVER_ROOT_URL="http://127.0.0.1:3000/grafana/"
  export GF_SERVER_SERVE_FROM_SUB_PATH="true"
  export GF_AUTH_ANONYMOUS_ENABLED="true"
  export GF_AUTH_ANONYMOUS_ORG_ROLE="Viewer"
  export GF_USERS_ALLOW_SIGN_UP="false"
  export GF_ANALYTICS_REPORTING_ENABLED="false"
  export GF_ANALYTICS_CHECK_FOR_UPDATES="false"
  export GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES="false"
  export GF_PLUGINS_PREINSTALL=""
  export GF_PLUGINS_PREINSTALL_SYNC=""
  export GF_PLUGINS_PREINSTALL_DISABLED="true"
  export GF_PLUGINS_PREINSTALL_AUTO_UPDATE="false"

  nohup "$grafana_bin" server --homepath "$CURRENT_HOME" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  "$REMOTE_PYTHON" - <<'PY'
import json
import time
import urllib.request

url = "http://127.0.0.1:3000/grafana/api/health"
last_error = None
for _ in range(120):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            print(json.dumps(json.load(response), ensure_ascii=False))
            break
    except Exception as exc:
        last_error = exc
        time.sleep(0.5)
else:
    raise SystemExit(f"grafana health check failed: {last_error}")
PY
}

stop_grafana() {
  if is_running; then
    pid="$(cat "$PID_FILE")"
    kill "$pid"
    for _ in $(seq 1 45); do
      if kill -0 "$pid" >/dev/null 2>&1; then
        sleep 1
      else
        break
      fi
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -KILL "$pid"
      sleep 1
    fi
    rm -f "$PID_FILE"
    echo "grafana stopped"
  else
    rm -f "$PID_FILE"
    echo "grafana not running"
  fi
}

status_grafana() {
  if is_running; then
    echo "pid: $(cat "$PID_FILE")"
  else
    echo "grafana not running"
  fi
  "$REMOTE_PYTHON" - <<'PY'
import json
import urllib.error
import urllib.request

checks = {
    "health": "http://127.0.0.1:3000/grafana/api/health",
    "dashboard": "http://127.0.0.1:3000/grafana/api/search?query=cv-stream",
}
for name, url in checks.items():
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.load(response)
            if name == "dashboard":
                payload = [
                    {"title": item.get("title"), "url": item.get("url"), "type": item.get("type")}
                    for item in payload
                    if item.get("type") == "dash-db"
                ]
            print(json.dumps({name: payload}, ensure_ascii=False))
    except urllib.error.URLError as exc:
        print(json.dumps({name: "failed", "error": str(exc)}, ensure_ascii=False))
PY
}

case "$ACTION" in
  install)
    install_runtime
    ;;
  start)
    start_grafana
    ;;
  stop)
    stop_grafana
    ;;
  restart)
    stop_grafana
    start_grafana
    ;;
  status)
    status_grafana
    ;;
  logs)
    tail -n 100 "$LOG_FILE"
    ;;
esac
REMOTE
