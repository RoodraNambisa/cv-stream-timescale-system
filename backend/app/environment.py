from __future__ import annotations

import importlib
import importlib.util
import os
import platform
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx

from .config import Settings
from .inference import inference_status
from .video import probe_video_source


Check = dict[str, Any]
CORE_SCHEMA_TABLES = (
    "device",
    "cv_task",
    "cv_result_meta",
    "cv_detection_stream",
)


def ok(name: str, message: str, details: dict[str, Any] | None = None) -> Check:
    return {"name": name, "status": "ok", "message": message, "details": details or {}}


def warn(name: str, message: str, details: dict[str, Any] | None = None) -> Check:
    return {"name": name, "status": "warn", "message": message, "details": details or {}}


def error(name: str, message: str, details: dict[str, Any] | None = None) -> Check:
    return {"name": name, "status": "error", "message": message, "details": details or {}}


def mask_url(url: str) -> str:
    if not url:
        return ""

    parts = urlsplit(url)
    if not parts.password:
        return url

    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"

    if parts.username:
        host = f"{parts.username}:***@{host}"

    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def check_python() -> Check:
    return ok(
        "python",
        f"Python {platform.python_version()}",
        {
            "executable": sys.executable,
            "platform": platform.platform(),
        },
    )


def check_opencv() -> Check:
    if importlib.util.find_spec("cv2") is None:
        return warn("opencv", "OpenCV 未安装，视频采集轮次会补齐依赖")

    cv2 = importlib.import_module("cv2")
    return ok("opencv", f"OpenCV {cv2.__version__}")


def check_torch() -> Check:
    if importlib.util.find_spec("torch") is None:
        return warn("torch", "PyTorch 未安装，推理轮次会补齐依赖")

    torch = importlib.import_module("torch")
    cuda_available = bool(torch.cuda.is_available())
    gpu_names: list[str] = []

    if cuda_available:
        gpu_names = [
            torch.cuda.get_device_name(index)
            for index in range(torch.cuda.device_count())
        ]

    status = "ok" if cuda_available else "warn"
    message = "CUDA 可用" if cuda_available else "PyTorch 可用，CUDA 不可用"
    result = ok("torch", message) if status == "ok" else warn("torch", message)
    result["details"] = {
        "torch_version": torch.__version__,
        "cuda_available": cuda_available,
        "cuda_version": getattr(torch.version, "cuda", None),
        "gpu_names": gpu_names,
    }
    return result


def check_spool(settings: Settings) -> Check:
    path = Path(settings.spool_sqlite_path)
    parent = path.parent if path.parent != Path("") else Path(".")

    if not parent.exists():
        return warn(
            "spool",
            "SQLite 缓存目录不存在",
            {"path": str(path), "parent": str(parent)},
        )

    if not os.access(parent, os.W_OK):
        return error(
            "spool",
            "SQLite 缓存目录不可写",
            {"path": str(path), "parent": str(parent)},
        )

    return ok("spool", "SQLite 缓存目录可写", {"path": str(path)})


async def check_database(settings: Settings) -> list[Check]:
    if not settings.database_url:
        return [
            warn("database", "数据库未配置"),
            warn("timescaledb", "TimescaleDB 未检测"),
            warn("database_schema", "数据库 schema 未检测"),
        ]

    safe_url = mask_url(settings.database_url)

    try:
        connection = await asyncpg.connect(
            settings.database_url,
            timeout=settings.database_connect_timeout,
        )
    except Exception as exc:
        return [
            error("database", "数据库连接失败", {"url": safe_url, "error": str(exc)}),
            warn("timescaledb", "数据库未连接，无法检测 TimescaleDB"),
            warn("database_schema", "数据库未连接，无法检测 schema"),
        ]

    try:
        version = await connection.fetchval("select version();")
        timescale_version = await connection.fetchval(
            "select extversion from pg_extension where extname = 'timescaledb';"
        )
        schema_check = await check_database_schema(connection, bool(timescale_version))
    finally:
        await connection.close()

    checks = [
        ok("database", "数据库连接成功", {"url": safe_url, "version": version}),
    ]

    if timescale_version:
        checks.append(ok("timescaledb", f"TimescaleDB {timescale_version}"))
    else:
        checks.append(warn("timescaledb", "数据库未启用 TimescaleDB 扩展"))

    checks.append(schema_check)

    return checks


async def check_database_schema(connection: asyncpg.Connection, timescale_enabled: bool) -> Check:
    try:
        rows = await connection.fetch(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY($1::text[])
            """,
            list(CORE_SCHEMA_TABLES),
        )
        existing_tables = {row["table_name"] for row in rows}
        missing_tables = sorted(set(CORE_SCHEMA_TABLES) - existing_tables)

        hypertable_exists = False
        aggregate_exists = False
        if timescale_enabled:
            hypertable_exists = bool(
                await connection.fetchval(
                    """
                    SELECT EXISTS (
                      SELECT 1
                      FROM timescaledb_information.hypertables
                      WHERE hypertable_name = 'cv_detection_stream'
                    )
                    """
                )
            )
            aggregate_exists = bool(
                await connection.fetchval(
                    """
                    SELECT EXISTS (
                      SELECT 1
                      FROM timescaledb_information.continuous_aggregates
                      WHERE view_name = 'minutely_object_stats'
                    )
                    """
                )
            )

        details = {
            "required_tables": list(CORE_SCHEMA_TABLES),
            "existing_tables": sorted(existing_tables),
            "missing_tables": missing_tables,
            "hypertable_exists": hypertable_exists,
            "continuous_aggregate_exists": aggregate_exists,
        }

        if missing_tables:
            return warn("database_schema", "数据库 schema 未完整应用", details)

        if not timescale_enabled:
            return warn("database_schema", "TimescaleDB 未启用，无法确认超表和连续聚合", details)

        if not hypertable_exists or not aggregate_exists:
            return warn("database_schema", "TimescaleDB 对象未完整应用", details)

        return ok("database_schema", "数据库 schema 已就绪", details)
    except Exception as exc:
        return warn("database_schema", "数据库 schema 检测失败", {"error": str(exc)})


async def check_video_source(settings: Settings) -> Check:
    probe = await probe_video_source(settings, max_frames=1)
    return {
        "name": "video_source",
        "status": probe["status"],
        "message": probe["message"],
        "details": probe["details"],
    }


async def check_inference_endpoint(settings: Settings) -> Check:
    status = await inference_status(settings)
    return {
        "name": "inference",
        "status": status["status"],
        "message": status["message"],
        "details": status["details"],
    }


async def check_remote_api(settings: Settings) -> Check:
    if not settings.remote_api_base_url:
        return warn("remote_api", "远端 API 未配置")

    base_url = settings.remote_api_base_url.rstrip("/")
    safe_url = mask_url(base_url)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{base_url}/api/health")
    except Exception as exc:
        return error("remote_api", "远端 API 连接失败", {"url": safe_url, "error": str(exc)})

    if response.status_code >= 400:
        return error(
            "remote_api",
            "远端 API 状态异常",
            {"url": safe_url, "status_code": response.status_code},
        )

    try:
        payload = response.json()
    except ValueError:
        payload = {}

    return ok(
        "remote_api",
        "远端 API 可达",
        {
            "url": safe_url,
            "service": payload.get("service"),
            "version": payload.get("version"),
        },
    )


async def check_stream_receiver(settings: Settings) -> Check:
    receiver_kind = settings.stream_receiver_kind.strip() or "none"
    status_url = settings.stream_receiver_status_url.strip()
    if receiver_kind == "none" and not status_url:
        return warn("stream_receiver", "流媒体接收器未配置")

    details = {
        "receiver_kind": receiver_kind,
        "status_url": mask_url(status_url),
        "stream_mode": settings.stream_mode,
        "stream_protocol": settings.stream_protocol,
    }
    if not status_url:
        return warn("stream_receiver", "流媒体接收器已标记，未配置状态 URL", details)

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(status_url)
    except Exception as exc:
        return error("stream_receiver", "流媒体接收器状态 URL 连接失败", {**details, "error": str(exc)})

    if response.status_code >= 400:
        return error(
            "stream_receiver",
            "流媒体接收器状态异常",
            {**details, "status_code": response.status_code},
        )

    return ok(
        "stream_receiver",
        "流媒体接收器状态 URL 可达",
        {
            **details,
            "status_code": response.status_code,
            "content_type": response.headers.get("content-type", ""),
        },
    )


async def check_grafana(settings: Settings) -> Check:
    if not settings.grafana_base_url:
        return warn("grafana", "Grafana 未配置")

    base_url = settings.grafana_base_url.rstrip("/")
    safe_url = mask_url(base_url)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{base_url}/api/health")
    except Exception as exc:
        return error("grafana", "Grafana 连接失败", {"url": safe_url, "error": str(exc)})

    if response.status_code >= 400:
        return error(
            "grafana",
            "Grafana 状态异常",
            {"url": safe_url, "status_code": response.status_code},
        )

    try:
        payload = response.json()
    except ValueError:
        payload = {}

    return ok(
        "grafana",
        "Grafana 可达",
        {
            "url": safe_url,
            "dashboard_url": mask_url(settings.grafana_dashboard_url),
            "version": payload.get("version"),
            "database": payload.get("database"),
        },
    )


def config_summary(settings: Settings) -> dict[str, Any]:
    return {
        "security": {
            "auth_required": bool(settings.api_auth_token),
            "api_auth_token": settings.api_auth_token,
        },
        "capture": {
            "source_kind": settings.capture_source_kind,
            "source_url": settings.capture_source_url,
            "username": settings.capture_username,
            "password": settings.capture_password,
            "fps_limit": settings.capture_fps_limit,
            "device_id": settings.capture_device_id,
            "task_id": settings.capture_task_id,
        },
        "stream": {
            "mode": settings.stream_mode,
            "protocol": settings.stream_protocol,
            "push_url": settings.stream_push_url,
            "receiver_kind": settings.stream_receiver_kind,
            "receiver_status_url": mask_url(settings.stream_receiver_status_url),
            "username": settings.stream_username,
            "password": settings.stream_password,
        },
        "inference": {
            "endpoint": settings.inference_endpoint,
            "api_token": settings.inference_api_token,
            "device": settings.inference_device,
            "model": settings.inference_model,
            "confidence_threshold": settings.confidence_threshold,
            "frame_interval": settings.frame_interval,
            "class_filter": settings.detection_class_filter,
        },
        "analysis": {
            "time_range_minutes": settings.analysis_time_range_minutes,
        },
        "database": {
            "configured": bool(settings.database_url),
            "url": settings.database_url,
            "connect_timeout": settings.database_connect_timeout,
            "batch_size": settings.database_batch_size,
            "flush_interval_ms": settings.database_flush_interval_ms,
        },
        "spool": {
            "sqlite_path": str(settings.spool_sqlite_path),
        },
        "remote": {
            "api_base_url": settings.remote_api_base_url,
            "api_host": settings.remote_api_host,
            "api_port": settings.remote_api_port,
            "ssh_configured": bool(
                settings.remote_ssh_host
                and settings.remote_ssh_user
                and settings.remote_ssh_key_path
            ),
            "ssh_host": settings.remote_ssh_host,
            "ssh_port": settings.remote_ssh_port,
            "ssh_user": settings.remote_ssh_user,
            "ssh_key_path": settings.remote_ssh_key_path,
            "pip_index_urls": settings.remote_pip_index_urls,
            "pip_trusted_hosts": settings.remote_pip_trusted_hosts,
            "pip_proxy_configured": bool(settings.remote_pip_proxy),
            "pip_proxy_url": settings.remote_pip_proxy,
        },
        "observability": {
            "grafana_configured": bool(settings.grafana_base_url),
            "grafana_base_url": mask_url(settings.grafana_base_url),
            "grafana_dashboard_url": mask_url(settings.grafana_dashboard_url),
        },
    }


async def collect_environment(settings: Settings) -> dict[str, Any]:
    checks: list[Check] = [
        check_python(),
        check_opencv(),
        check_torch(),
        check_spool(settings),
    ]

    checks.extend(await check_database(settings))
    checks.append(await check_video_source(settings))
    checks.append(await check_stream_receiver(settings))
    checks.append(await check_inference_endpoint(settings))
    checks.append(await check_remote_api(settings))
    checks.append(await check_grafana(settings))

    summary = {
        "ok": sum(1 for item in checks if item["status"] == "ok"),
        "warn": sum(1 for item in checks if item["status"] == "warn"),
        "error": sum(1 for item in checks if item["status"] == "error"),
    }

    return {
        "summary": summary,
        "checks": checks,
        "config": config_summary(settings),
    }
