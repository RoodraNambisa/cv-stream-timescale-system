from functools import lru_cache
import re
from pathlib import Path
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DOTENV_PATH = PROJECT_ROOT / ".env"

EDITABLE_ENV_KEYS = {
    "API_AUTH_TOKEN",
    "CORS_ALLOWED_ORIGINS",
    "CAPTURE_SOURCE_KIND",
    "CAPTURE_SOURCE_URL",
    "CAPTURE_USERNAME",
    "CAPTURE_PASSWORD",
    "CAPTURE_FPS_LIMIT",
    "CAPTURE_DEVICE_ID",
    "CAPTURE_TASK_ID",
    "STREAM_MODE",
    "STREAM_PROTOCOL",
    "STREAM_PUSH_URL",
    "STREAM_RECEIVER_KIND",
    "STREAM_RECEIVER_STATUS_URL",
    "STREAM_USERNAME",
    "STREAM_PASSWORD",
    "INFERENCE_ENDPOINT",
    "INFERENCE_API_TOKEN",
    "INFERENCE_DEVICE",
    "INFERENCE_MODEL",
    "CONFIDENCE_THRESHOLD",
    "FRAME_INTERVAL",
    "DETECTION_CLASS_FILTER",
    "ANALYSIS_TIME_RANGE_MINUTES",
    "DATABASE_URL",
    "DATABASE_CONNECT_TIMEOUT",
    "DATABASE_BATCH_SIZE",
    "DATABASE_FLUSH_INTERVAL_MS",
    "SPOOL_SQLITE_PATH",
    "REMOTE_API_BASE_URL",
    "REMOTE_API_HOST",
    "REMOTE_API_PORT",
    "REMOTE_SSH_HOST",
    "REMOTE_SSH_PORT",
    "REMOTE_SSH_USER",
    "REMOTE_SSH_KEY_PATH",
    "REMOTE_PIP_INDEX_URLS",
    "REMOTE_PIP_TRUSTED_HOSTS",
    "REMOTE_PIP_PROXY",
    "GRAFANA_BASE_URL",
    "GRAFANA_DASHBOARD_URL",
}

LOCKED_WHILE_CAPTURE_KEYS = {
    "CAPTURE_SOURCE_KIND",
    "CAPTURE_SOURCE_URL",
    "STREAM_MODE",
    "STREAM_PROTOCOL",
    "STREAM_PUSH_URL",
    "STREAM_RECEIVER_KIND",
    "INFERENCE_ENDPOINT",
    "INFERENCE_MODEL",
    "DATABASE_URL",
    "SPOOL_SQLITE_PATH",
}


class Settings(BaseSettings):
    service_name: str = "cv-stream-timescale-api"
    service_version: str = "0.1.0"
    api_auth_token: str = ""
    cors_allowed_origins: str = "http://127.0.0.1:5173 http://localhost:5173"

    capture_source_kind: str = "http_mjpeg"
    capture_source_url: str = ""
    capture_username: str = ""
    capture_password: str = ""
    capture_fps_limit: int = 15
    capture_device_id: int = 1
    capture_task_id: int = 1

    stream_mode: str = "pull"
    stream_protocol: str = "http_mjpeg"
    stream_push_url: str = ""
    stream_receiver_kind: str = "none"
    stream_receiver_status_url: str = ""
    stream_username: str = ""
    stream_password: str = ""

    inference_endpoint: str = ""
    inference_api_token: str = ""
    inference_device: str = "auto"
    inference_model: str = "yolov8n.pt"
    confidence_threshold: float = 0.5
    frame_interval: int = 10
    detection_class_filter: str = ""
    analysis_time_range_minutes: int = Field(default=30, ge=1)

    database_url: str = ""
    database_connect_timeout: int = 5
    database_batch_size: int = 50
    database_flush_interval_ms: int = 1000

    spool_sqlite_path: Path = Field(default=Path("runtime/spool.db"))

    remote_api_base_url: str = ""
    remote_api_host: str = "0.0.0.0"
    remote_api_port: int = 8000
    remote_ssh_host: str = ""
    remote_ssh_port: int = 22
    remote_ssh_user: str = ""
    remote_ssh_key_path: str = ""
    remote_pip_index_urls: str = "https://pypi.tuna.tsinghua.edu.cn/simple https://mirrors.aliyun.com/pypi/simple https://pypi.mirrors.ustc.edu.cn/simple https://pypi.org/simple"
    remote_pip_trusted_hosts: str = ""
    remote_pip_proxy: str = ""

    grafana_base_url: str = ""
    grafana_dashboard_url: str = ""

    model_config = SettingsConfigDict(
        env_file=DOTENV_PATH,
        env_file_encoding="utf-8",
        extra="ignore",
    )


def update_dotenv(values: dict[str, Any]) -> list[str]:
    normalized = _normalize_update_values(values)
    if not normalized:
        return []

    _validate_settings(normalized)
    lines = DOTENV_PATH.read_text(encoding="utf-8").splitlines() if DOTENV_PATH.exists() else []
    output: list[str] = []
    written: set[str] = set()

    for line in lines:
        key = _dotenv_key(line)
        if key in normalized:
            output.append(f"{key}={_quote_dotenv_value(normalized[key])}")
            written.add(key)
        else:
            output.append(line)

    if output and output[-1].strip():
        output.append("")

    for key in sorted(normalized):
        if key not in written:
            output.append(f"{key}={_quote_dotenv_value(normalized[key])}")

    DOTENV_PATH.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    return sorted(normalized)


def preview_settings(values: dict[str, Any]) -> Settings:
    normalized = _normalize_update_values(values)
    current = get_settings().model_dump()
    update = {key.lower(): value for key, value in normalized.items()}
    return Settings(**{**current, **update})


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reload_settings() -> Settings:
    get_settings.cache_clear()
    return get_settings()


def parse_detection_class_filter(value: str) -> set[str]:
    return {
        item.strip().casefold()
        for item in re.split(r"[,;，、\n]+", value or "")
        if item.strip()
    }


def parse_list_setting(value: str) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"[,;，、\s]+", value or "")
        if item.strip()
    ]


def _normalize_update_values(values: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}

    for raw_key, value in values.items():
        key = raw_key.strip().upper()
        if key not in EDITABLE_ENV_KEYS:
            raise ValueError(f"unsupported_config_key:{key}")
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
        normalized[key] = value

    return normalized


def _validate_settings(values: dict[str, Any]) -> None:
    current = get_settings().model_dump()
    update = {key.lower(): value for key, value in values.items()}
    Settings(**{**current, **update})


def _dotenv_key(line: str) -> str | None:
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[7:]

    match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=", stripped)
    return match.group(1) if match else None


def _quote_dotenv_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"

    text = str(value).replace("\r", " ").replace("\n", " ")
    if text == "":
        return ""

    if re.search(r"\s|#|\"|'", text):
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'

    return text
