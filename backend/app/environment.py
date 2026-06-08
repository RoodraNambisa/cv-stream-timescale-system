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

from .config import Settings
from .inference import inference_status
from .video import probe_video_source


Check = dict[str, Any]


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
        ]

    try:
        version = await connection.fetchval("select version();")
        timescale_version = await connection.fetchval(
            "select extversion from pg_extension where extname = 'timescaledb';"
        )
    finally:
        await connection.close()

    checks = [
        ok("database", "数据库连接成功", {"url": safe_url, "version": version}),
    ]

    if timescale_version:
        checks.append(ok("timescaledb", f"TimescaleDB {timescale_version}"))
    else:
        checks.append(warn("timescaledb", "数据库未启用 TimescaleDB 扩展"))

    return checks


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


def config_summary(settings: Settings) -> dict[str, Any]:
    return {
        "capture": {
            "source_kind": settings.capture_source_kind,
            "source_url": settings.capture_source_url,
            "username_set": bool(settings.capture_username),
            "password_set": bool(settings.capture_password),
            "fps_limit": settings.capture_fps_limit,
            "device_id": settings.capture_device_id,
            "task_id": settings.capture_task_id,
        },
        "stream": {
            "mode": settings.stream_mode,
            "protocol": settings.stream_protocol,
            "push_url": settings.stream_push_url,
            "username_set": bool(settings.stream_username),
            "password_set": bool(settings.stream_password),
        },
        "inference": {
            "endpoint": settings.inference_endpoint,
            "device": settings.inference_device,
            "model": settings.inference_model,
            "confidence_threshold": settings.confidence_threshold,
            "frame_interval": settings.frame_interval,
        },
        "database": {
            "configured": bool(settings.database_url),
            "url": mask_url(settings.database_url),
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
    checks.append(await check_inference_endpoint(settings))

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
