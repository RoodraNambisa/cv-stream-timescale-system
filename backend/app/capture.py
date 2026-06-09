from __future__ import annotations

import asyncio
import importlib.util
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .config import parse_detection_class_filter
from .detections import DetectionRecord, utc_now
from .inference import infer_image_bytes
from .spool import DetectionSpool
from .video import resolve_video_source, set_capture_timeout


class CaptureStartRequest(BaseModel):
    max_frames: Optional[int] = Field(default=None, ge=1)
    frame_interval: Optional[int] = Field(default=None, ge=1)
    device_id: Optional[int] = Field(default=None, ge=1)
    task_id: Optional[int] = Field(default=None, ge=1)


@dataclass
class CaptureState:
    status: str = "stopped"
    message: str = "采集任务未启动"
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    last_frame_at: datetime | None = None
    frames_read: int = 0
    frames_inferred: int = 0
    detections_queued: int = 0
    last_error: str | None = None
    settings_locked: dict[str, Any] = field(default_factory=dict)
    recent_detections: list[dict[str, Any]] = field(default_factory=list)
    latest_frame_jpeg: bytes | None = None
    latest_frame_version: int = 0
    latest_frame_width: int = 0
    latest_frame_height: int = 0


class CaptureManager:
    def __init__(self, spool: DetectionSpool) -> None:
        self._spool = spool
        self._lock = asyncio.Lock()
        self._state = CaptureState()
        self._task: asyncio.Task | None = None
        self._stop_event: asyncio.Event | None = None
        self._inference_task: asyncio.Task | None = None

    async def start(self, request: CaptureStartRequest | None = None) -> dict[str, Any]:
        request = request or CaptureStartRequest()
        settings = get_settings()

        if importlib.util.find_spec("cv2") is None:
            await self._replace_state(
                status="error",
                message="OpenCV 未安装，无法启动采集",
                stopped_at=utc_now(),
                last_error="opencv_not_installed",
            )
            return {
                "status": "error",
                "message": "OpenCV 未安装，无法启动采集",
                "capture": await self.status(),
            }

        source = resolve_video_source(settings)
        if source is None:
            await self._replace_state(
                status="error",
                message="视频源未配置",
                stopped_at=utc_now(),
                last_error="capture_source_not_configured",
            )
            return {
                "status": "error",
                "message": "视频源未配置",
                "capture": await self.status(),
            }

        async with self._lock:
            if self._task is not None and not self._task.done():
                return {
                    "status": "running",
                    "message": "采集任务已在运行",
                    "capture": self._snapshot_locked(),
                }

            locked_settings = _locked_settings(settings, request, source)
            self._state = CaptureState(
                status="running",
                message="采集任务已启动",
                started_at=utc_now(),
                stopped_at=None,
                settings_locked=locked_settings,
            )
            self._stop_event = asyncio.Event()
            self._task = asyncio.create_task(
                self._run(settings, request, source, self._stop_event)
            )

            return {
                "status": "ok",
                "message": "采集任务已启动",
                "capture": self._snapshot_locked(),
            }

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            if self._task is None or self._task.done():
                self._state.status = "stopped"
                self._state.message = "采集任务未运行"
                self._state.stopped_at = self._state.stopped_at or utc_now()
                return {
                    "status": "idle",
                    "message": "采集任务未运行",
                    "capture": self._snapshot_locked(),
                }

            self._state.status = "stopping"
            self._state.message = "正在停止采集任务"
            task = self._task
            inference_task = self._inference_task
            if self._stop_event is not None:
                self._stop_event.set()

        try:
            await asyncio.wait_for(task, timeout=5)
        except asyncio.TimeoutError:
            return {
                "status": "stopping",
                "message": "采集任务仍在停止中",
                "capture": await self.status(),
            }

        await _cancel_task(inference_task)
        return {
            "status": "ok",
            "message": "采集任务已停止",
            "capture": await self.status(),
        }

    async def status(self) -> dict[str, Any]:
        async with self._lock:
            return self._snapshot_locked()

    async def latest_frame(self) -> tuple[bytes | None, int]:
        async with self._lock:
            return self._state.latest_frame_jpeg, self._state.latest_frame_version

    def _inference_available(self) -> bool:
        return self._inference_task is None or self._inference_task.done()

    async def shutdown(self) -> None:
        async with self._lock:
            task = self._task
            inference_task = self._inference_task
            if self._stop_event is not None:
                self._stop_event.set()

        if task is None or task.done():
            return

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        await _cancel_task(inference_task)

    async def _run(
        self,
        settings: Settings,
        request: CaptureStartRequest,
        source: str | int,
        stop_event: asyncio.Event,
    ) -> None:
        import cv2

        capture = cv2.VideoCapture()
        set_capture_timeout(capture, cv2, 3000)
        opened = await asyncio.to_thread(capture.open, source)
        if not opened:
            await self._replace_state(
                status="error",
                message="视频源打开失败",
                stopped_at=utc_now(),
                last_error=f"open_failed:{source}",
            )
            await asyncio.to_thread(capture.release)
            return

        consecutive_read_failures = 0
        last_preview_at = 0.0

        try:
            while not stop_event.is_set():
                runtime_settings = get_settings()
                frame_interval = max(request.frame_interval or runtime_settings.frame_interval, 1)
                fps_sleep_seconds = (
                    1 / runtime_settings.capture_fps_limit
                    if runtime_settings.capture_fps_limit > 0
                    else 0.0
                )

                if request.max_frames is not None and self._state.frames_read >= request.max_frames:
                    await self._update_state(message="已达到本次采集帧数上限")
                    break

                ok, frame = await asyncio.to_thread(capture.read)
                if not ok or frame is None:
                    consecutive_read_failures += 1
                    if runtime_settings.capture_source_kind == "file":
                        await self._update_state(message="视频文件读取结束")
                        break
                    if consecutive_read_failures >= 25:
                        await self._replace_state(
                            status="error",
                            message="连续读取视频帧失败",
                            stopped_at=utc_now(),
                            last_error="read_frame_failed",
                        )
                        return
                    await asyncio.sleep(0.2)
                    continue

                consecutive_read_failures = 0
                frame_index = await self._bump_frame_read()
                image_bytes = None
                now = asyncio.get_running_loop().time()
                if now - last_preview_at >= _preview_interval_seconds(runtime_settings):
                    image_bytes = await asyncio.to_thread(_encode_jpeg, frame)
                    last_preview_at = now
                if image_bytes is not None:
                    height, width = frame.shape[:2]
                    await self._store_latest_frame(image_bytes, frame_index, width, height)

                if frame_index % frame_interval == 0 and self._inference_available():
                    self._inference_task = asyncio.create_task(
                        self._infer_and_enqueue(
                            runtime_settings,
                            request,
                            frame,
                            frame_index,
                            image_bytes,
                        )
                    )

                if fps_sleep_seconds > 0:
                    await asyncio.sleep(fps_sleep_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._replace_state(
                status="error",
                message="采集任务异常退出",
                stopped_at=utc_now(),
                last_error=str(exc),
            )
            return
        finally:
            await asyncio.to_thread(capture.release)

        await self._replace_state(
            status="stopped",
            message="采集任务已停止",
            stopped_at=utc_now(),
        )

    async def _infer_and_enqueue(
        self,
        settings: Settings,
        request: CaptureStartRequest,
        frame: Any,
        frame_index: int,
        image_bytes: bytes | None = None,
    ) -> None:
        try:
            image_bytes = image_bytes or await asyncio.to_thread(_encode_jpeg, frame)
            if image_bytes is None:
                await self._update_state(last_error="frame_encode_failed")
                return

            result = await infer_image_bytes(settings, image_bytes, f"frame-{frame_index}.jpg")
            await self._bump_counter("frames_inferred", 1)

            if result.get("status") != "ok":
                await self._update_state(
                    message=str(result.get("message") or "推理失败"),
                    last_error=str(result.get("message") or result),
                )
                return

            records = _detections_to_records(settings, request, result, frame_index)
            if records:
                await self._spool.enqueue(records, settings)
                await self._bump_counter("detections_queued", len(records))
                await self._remember_detections(records)

            await self._update_state(
                message=f"推理完成，检测到 {len(records)} 个目标",
                last_error=None,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._update_state(
                message="推理任务异常",
                last_error=str(exc),
            )
            return

    async def _bump_frame_read(self) -> int:
        async with self._lock:
            self._state.frames_read += 1
            self._state.last_frame_at = utc_now()
            return self._state.frames_read

    async def _store_latest_frame(
        self,
        image_bytes: bytes,
        frame_index: int,
        width: int,
        height: int,
    ) -> None:
        async with self._lock:
            self._state.latest_frame_jpeg = image_bytes
            self._state.latest_frame_version = frame_index
            self._state.latest_frame_width = width
            self._state.latest_frame_height = height

    async def _bump_counter(self, name: str, count: int) -> None:
        async with self._lock:
            current_value = getattr(self._state, name)
            setattr(self._state, name, current_value + count)

    async def _remember_detections(self, records: list[DetectionRecord]) -> None:
        snapshots = [_record_snapshot(record) for record in records]
        async with self._lock:
            self._state.recent_detections = [
                *snapshots,
                *self._state.recent_detections,
            ][:12]

    async def _replace_state(self, **updates: Any) -> None:
        async with self._lock:
            current = self._state
            self._state = CaptureState(
                status=updates.get("status", current.status),
                message=updates.get("message", current.message),
                started_at=updates.get("started_at", current.started_at),
                stopped_at=updates.get("stopped_at", current.stopped_at),
                last_frame_at=updates.get("last_frame_at", current.last_frame_at),
                frames_read=updates.get("frames_read", current.frames_read),
                frames_inferred=updates.get("frames_inferred", current.frames_inferred),
                detections_queued=updates.get("detections_queued", current.detections_queued),
                last_error=updates.get("last_error", current.last_error),
                settings_locked=updates.get("settings_locked", current.settings_locked),
                recent_detections=updates.get("recent_detections", current.recent_detections),
                latest_frame_jpeg=updates.get("latest_frame_jpeg", current.latest_frame_jpeg),
                latest_frame_version=updates.get("latest_frame_version", current.latest_frame_version),
                latest_frame_width=updates.get("latest_frame_width", current.latest_frame_width),
                latest_frame_height=updates.get("latest_frame_height", current.latest_frame_height),
            )

    async def _update_state(self, **updates: Any) -> None:
        async with self._lock:
            for key, value in updates.items():
                setattr(self._state, key, value)

    def _snapshot_locked(self) -> dict[str, Any]:
        return {
            "status": self._state.status,
            "message": self._state.message,
            "started_at": _isoformat(self._state.started_at),
            "stopped_at": _isoformat(self._state.stopped_at),
            "last_frame_at": _isoformat(self._state.last_frame_at),
            "frames_read": self._state.frames_read,
            "frames_inferred": self._state.frames_inferred,
            "detections_queued": self._state.detections_queued,
            "last_error": self._state.last_error,
            "settings_locked": self._state.settings_locked,
            "recent_detections": self._state.recent_detections,
            "latest_frame_version": self._state.latest_frame_version,
            "latest_frame_width": self._state.latest_frame_width,
            "latest_frame_height": self._state.latest_frame_height,
        }


def _locked_settings(
    settings: Settings,
    request: CaptureStartRequest,
    source: str | int,
) -> dict[str, Any]:
    return {
        "source_kind": settings.capture_source_kind,
        "source": str(source),
        "fps_limit": settings.capture_fps_limit,
        "frame_interval": request.frame_interval or settings.frame_interval,
        "device_id": request.device_id or settings.capture_device_id,
        "task_id": request.task_id or settings.capture_task_id,
        "inference_mode": "remote" if settings.inference_endpoint else "local",
        "inference_endpoint": settings.inference_endpoint,
        "inference_model": settings.inference_model,
        "database_configured": bool(settings.database_url),
        "spool_sqlite_path": str(settings.spool_sqlite_path),
    }


def _encode_jpeg(frame: Any) -> bytes | None:
    import cv2

    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
    if not ok:
        return None
    return buffer.tobytes()


def _preview_interval_seconds(settings: Settings) -> float:
    preview_fps = min(max(settings.capture_fps_limit, 1), 10)
    return 1 / preview_fps


async def _cancel_task(task: asyncio.Task | None) -> None:
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def _detections_to_records(
    settings: Settings,
    request: CaptureStartRequest,
    result: dict[str, Any],
    frame_index: int,
) -> list[DetectionRecord]:
    detections = result.get("detections")
    if not isinstance(detections, list):
        return []

    observed_at = utc_now()
    records: list[DetectionRecord] = []
    allowed_classes = parse_detection_class_filter(settings.detection_class_filter)

    for detection in detections:
        if not isinstance(detection, dict):
            continue

        confidence = _float_or_none(detection.get("confidence"))
        if confidence is None or confidence < settings.confidence_threshold or confidence > 1:
            continue

        object_class = (
            detection.get("object_class")
            or detection.get("class_name")
            or detection.get("label")
            or detection.get("class")
            or "unknown"
        )
        object_class_text = str(object_class)
        if allowed_classes and object_class_text.strip().casefold() not in allowed_classes:
            continue

        records.append(
            DetectionRecord(
                time=observed_at,
                device_id=request.device_id or settings.capture_device_id,
                task_id=request.task_id or settings.capture_task_id,
                object_class=object_class_text,
                confidence=confidence,
                bbox_x1=_float_or_none(detection.get("bbox_x1")),
                bbox_y1=_float_or_none(detection.get("bbox_y1")),
                bbox_x2=_float_or_none(detection.get("bbox_x2")),
                bbox_y2=_float_or_none(detection.get("bbox_y2")),
                bbox_center_x=_float_or_none(detection.get("bbox_center_x")),
                bbox_center_y=_float_or_none(detection.get("bbox_center_y")),
                frame_index=frame_index,
                source_kind=settings.capture_source_kind,
                inference_device=str(result.get("mode") or settings.inference_device),
            )
        )

    return records


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _record_snapshot(record: DetectionRecord) -> dict[str, Any]:
    return {
        "time": record.time.isoformat(),
        "object_class": record.object_class,
        "confidence": record.confidence,
        "bbox_x1": record.bbox_x1,
        "bbox_y1": record.bbox_y1,
        "bbox_x2": record.bbox_x2,
        "bbox_y2": record.bbox_y2,
        "bbox_center_x": record.bbox_center_x,
        "bbox_center_y": record.bbox_center_y,
        "frame_index": record.frame_index,
        "inference_device": record.inference_device,
    }


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()
