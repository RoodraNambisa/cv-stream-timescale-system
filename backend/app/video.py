from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from .config import Settings

SUPPORTED_STREAM_MODES = {"pull", "push"}
SUPPORTED_PUSH_PROTOCOLS = {"rtsp", "rtmp"}
NETWORK_CAPTURE_KINDS = {"http_mjpeg", "rtsp", "rtmp"}


def video_config_summary(settings: Settings) -> dict[str, Any]:
    return {
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
            "receiver_status_url": settings.stream_receiver_status_url,
            "username": settings.stream_username,
            "password": settings.stream_password,
        },
        "supported_stream_modes": sorted(SUPPORTED_STREAM_MODES),
        "supported_inputs": ["http_mjpeg", "rtsp", "rtmp", "camera", "file"],
        "supported_push_protocols": sorted(SUPPORTED_PUSH_PROTOCOLS),
    }


async def probe_video_source(settings: Settings, max_frames: int = 1) -> dict[str, Any]:
    return await asyncio.to_thread(_probe_video_source_sync, settings, max_frames)


def _probe_video_source_sync(settings: Settings, max_frames: int) -> dict[str, Any]:
    stream_mode = (settings.stream_mode or "pull").strip().lower()
    if stream_mode not in SUPPORTED_STREAM_MODES:
        return {
            "status": "error",
            "message": "流模式不支持",
            "details": {"stream_mode": settings.stream_mode},
        }

    if stream_mode == "push":
        return _probe_push_stream_settings_sync(settings)

    if importlib.util.find_spec("cv2") is None:
        return {
            "status": "warn",
            "message": "OpenCV 未安装，无法探测视频源",
            "details": {"source_kind": settings.capture_source_kind},
        }

    import cv2

    source_kind = settings.capture_source_kind
    source = resolve_video_source(settings)

    if source is None:
        return {
            "status": "warn",
            "message": "视频源未配置",
            "details": {"stream_mode": stream_mode, "source_kind": source_kind},
        }

    if source_kind == "file" and not Path(str(source)).exists():
        return {
            "status": "error",
            "message": "视频文件不存在",
            "details": {
                "stream_mode": stream_mode,
                "source_kind": source_kind,
                "source": _mask_url(str(source)),
            },
        }

    capture = cv2.VideoCapture()
    set_capture_timeout(capture, cv2, 3000)

    opened = capture.open(source)
    if not opened:
        capture.release()
        return {
            "status": "error",
            "message": "视频源打开失败",
            "details": {
                "stream_mode": stream_mode,
                "source_kind": source_kind,
                "source": _mask_url(str(source)),
            },
        }

    frame_count = 0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)

    for _ in range(max(max_frames, 1)):
        ok, frame = capture.read()
        if not ok:
            break
        frame_count += 1
        if frame is not None and (width == 0 or height == 0):
            height, width = frame.shape[:2]

    capture.release()

    if frame_count == 0:
        return {
            "status": "error",
            "message": "视频源可打开，但未读到帧",
            "details": {
                "stream_mode": stream_mode,
                "source_kind": source_kind,
                "source": _mask_url(str(source)),
                "width": width,
                "height": height,
                "fps": fps,
            },
        }

    return {
        "status": "ok",
        "message": "视频源可读取",
        "details": {
            "stream_mode": stream_mode,
            "source_kind": source_kind,
            "source": _mask_url(str(source)),
            "frames_read": frame_count,
            "width": width,
            "height": height,
            "fps": fps,
        },
    }


def _probe_push_stream_settings_sync(settings: Settings) -> dict[str, Any]:
    protocol = (settings.stream_protocol or "").strip().lower()
    push_url = settings.stream_push_url.strip()
    capture_source_url = settings.capture_source_url.strip()
    details = {
        "stream_mode": "push",
        "stream_protocol": protocol,
        "push_url": _mask_url(push_url),
        "stream_username_set": bool(settings.stream_username),
        "stream_password_set": bool(settings.stream_password),
        "capture_source_kind": settings.capture_source_kind,
        "capture_source_url": _mask_url(capture_source_url),
        "capture_read_configured": bool(capture_source_url),
    }

    if protocol not in SUPPORTED_PUSH_PROTOCOLS:
        return {
            "status": "error",
            "message": "推流协议不支持",
            "details": {**details, "supported_push_protocols": sorted(SUPPORTED_PUSH_PROTOCOLS)},
        }

    if not push_url:
        return {
            "status": "warn",
            "message": "推流接收地址未配置",
            "details": details,
        }

    parsed = urlsplit(push_url)
    if parsed.scheme.lower() != protocol:
        return {
            "status": "error",
            "message": "推流地址协议与配置不一致",
            "details": {**details, "url_scheme": parsed.scheme},
        }

    if not parsed.netloc:
        return {
            "status": "error",
            "message": "推流地址缺少主机或端口",
            "details": details,
        }

    if not capture_source_url:
        return {
            "status": "warn",
            "message": "推流入口已配置，采集读取地址未配置",
            "details": {
                **details,
                "read_hint": "把接收服务的 RTSP/RTMP 播放地址填入 CAPTURE_SOURCE_URL",
            },
        }

    return {
        "status": "ok",
        "message": "推流配置可用，等待设备推送视频",
        "details": details,
    }


def resolve_video_source(settings: Settings) -> str | int | None:
    source_kind = settings.capture_source_kind

    if source_kind == "camera":
        if not settings.capture_source_url:
            return 0
        if settings.capture_source_url.isdigit():
            return int(settings.capture_source_url)
        return _apply_capture_credentials(settings)

    if not settings.capture_source_url:
        return None

    if source_kind in NETWORK_CAPTURE_KINDS:
        return _apply_capture_credentials(settings)

    return settings.capture_source_url


def set_capture_timeout(capture: Any, cv2: Any, timeout_ms: int) -> None:
    for prop_name in ("CAP_PROP_OPEN_TIMEOUT_MSEC", "CAP_PROP_READ_TIMEOUT_MSEC"):
        if hasattr(cv2, prop_name):
            capture.set(getattr(cv2, prop_name), timeout_ms)


def _mask_url(value: str) -> str:
    if not value:
        return ""

    parts = urlsplit(value)
    if not parts.password:
        return value

    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"

    if parts.username:
        host = f"{parts.username}:***@{host}"

    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def _apply_capture_credentials(settings: Settings) -> str:
    source_url = settings.capture_source_url.strip()
    username = settings.capture_username.strip()
    password = settings.capture_password.strip()
    if not username:
        return source_url

    parts = urlsplit(source_url)
    if not parts.scheme or not parts.netloc or parts.username:
        return source_url

    userinfo = quote(username, safe="")
    if password:
        userinfo = f"{userinfo}:{quote(password, safe='')}"

    return urlunsplit(
        (
            parts.scheme,
            f"{userinfo}@{parts.netloc}",
            parts.path,
            parts.query,
            parts.fragment,
        )
    )
