from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any

from .config import Settings


def video_config_summary(settings: Settings) -> dict[str, Any]:
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
        "supported_inputs": ["http_mjpeg", "rtsp", "rtmp", "camera", "file"],
        "supported_push_protocols": ["rtsp", "rtmp"],
    }


async def probe_video_source(settings: Settings, max_frames: int = 1) -> dict[str, Any]:
    return await asyncio.to_thread(_probe_video_source_sync, settings, max_frames)


def _probe_video_source_sync(settings: Settings, max_frames: int) -> dict[str, Any]:
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
            "details": {"source_kind": source_kind},
        }

    if source_kind == "file" and not Path(str(source)).exists():
        return {
            "status": "error",
            "message": "视频文件不存在",
            "details": {"source_kind": source_kind, "source": str(source)},
        }

    capture = cv2.VideoCapture()
    set_capture_timeout(capture, cv2, 3000)

    opened = capture.open(source)
    if not opened:
        capture.release()
        return {
            "status": "error",
            "message": "视频源打开失败",
            "details": {"source_kind": source_kind, "source": str(source)},
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
                "source_kind": source_kind,
                "source": str(source),
                "width": width,
                "height": height,
                "fps": fps,
            },
        }

    return {
        "status": "ok",
        "message": "视频源可读取",
        "details": {
            "source_kind": source_kind,
            "source": str(source),
            "frames_read": frame_count,
            "width": width,
            "height": height,
            "fps": fps,
        },
    }


def resolve_video_source(settings: Settings) -> str | int | None:
    source_kind = settings.capture_source_kind

    if source_kind == "camera":
        if not settings.capture_source_url:
            return 0
        if settings.capture_source_url.isdigit():
            return int(settings.capture_source_url)
        return settings.capture_source_url

    if not settings.capture_source_url:
        return None

    return settings.capture_source_url


def set_capture_timeout(capture: Any, cv2: Any, timeout_ms: int) -> None:
    for prop_name in ("CAP_PROP_OPEN_TIMEOUT_MSEC", "CAP_PROP_READ_TIMEOUT_MSEC"):
        if hasattr(cv2, prop_name):
            capture.set(getattr(cv2, prop_name), timeout_ms)
