from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, Field

from .capture import CaptureManager, CaptureStartRequest
from .config import Settings, get_settings
from .spool import DetectionSpool
from .ui_events import UiEventLog, sanitize_payload


EventEmitter = Callable[[str, str, str, dict[str, Any]], Awaitable[None]]


class WriteRunStartRequest(BaseModel):
    max_frames: int = Field(default=120, ge=1, le=10_000)
    frame_interval: int | None = Field(default=None, ge=1, le=10_000)
    device_id: int | None = Field(default=None, ge=1)
    task_id: int | None = Field(default=None, ge=1)
    status_interval: float = Field(default=2.0, ge=0.5, le=30)


@dataclass
class WriteFlowOptions:
    max_frames: int = 120
    frame_interval: int | None = None
    device_id: int | None = None
    task_id: int | None = None
    status_interval: float = 2.0
    flush_on_exit: bool = True
    shutdown_capture_on_exit: bool = False
    stop_spool_on_exit: bool = False


class WriteRunManager:
    def __init__(
        self,
        capture: CaptureManager,
        spool: DetectionSpool,
        event_log: UiEventLog,
    ) -> None:
        self._capture = capture
        self._spool = spool
        self._event_log = event_log
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._run_id = ""
        self._status = "idle"
        self._message = "采集写入流程未运行"
        self._started_at: datetime | None = None
        self._finished_at: datetime | None = None
        self._last_result: dict[str, Any] | None = None

    async def start(self, request: WriteRunStartRequest | None = None) -> dict[str, Any]:
        request = request or WriteRunStartRequest()
        async with self._lock:
            if self._task is not None and not self._task.done():
                return {"status": "running", "message": "采集写入流程正在运行", "run": self._snapshot_locked()}

            capture_state = await self._capture.status()
            if capture_state.get("status") in {"running", "stopping"}:
                self._status = "blocked"
                self._message = "当前采集任务正在运行"
                return {"status": "blocked", "message": self._message, "run": self._snapshot_locked()}

            self._run_id = uuid4().hex[:12]
            self._status = "running"
            self._message = "采集写入流程已启动"
            self._started_at = datetime.now(timezone.utc)
            self._finished_at = None
            self._last_result = None
            options = WriteFlowOptions(
                max_frames=request.max_frames,
                frame_interval=request.frame_interval,
                device_id=request.device_id,
                task_id=request.task_id,
                status_interval=request.status_interval,
            )
            self._task = asyncio.create_task(self._run(options, self._run_id))
            return {"status": "ok", "message": self._message, "run": self._snapshot_locked()}

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            running = self._task is not None and not self._task.done()
            if not running:
                return {"status": "idle", "message": "采集写入流程未运行", "run": self._snapshot_locked()}
            self._status = "stopping"
            self._message = "正在停止采集写入流程"

        stop_result = await self._capture.stop()
        await self._event_log.append(
            source="write",
            level="warn",
            event="write_run_stop_requested",
            message="已请求停止采集写入流程",
            details=stop_result,
        )
        return {"status": "ok", "message": "已请求停止", "run": await self.status()}

    async def status(self) -> dict[str, Any]:
        async with self._lock:
            return self._snapshot_locked()

    async def _run(self, options: WriteFlowOptions, run_id: str) -> None:
        async def emit(level: str, event: str, message: str, payload: dict[str, Any]) -> None:
            await self._event_log.append(
                source=_source_for_event(event),
                level=level,
                event=event,
                message=message,
                details={"run_id": run_id, **payload},
            )

        try:
            result = await run_write_flow(self._capture, self._spool, options, emit)
        except Exception as exc:
            result = {"status": "error", "message": "采集写入流程异常退出", "error": str(exc)}
            await self._event_log.append(
                source="write",
                level="error",
                event="write_run_error",
                message="采集写入流程异常退出",
                details={"run_id": run_id, "error": str(exc)},
            )
        async with self._lock:
            self._last_result = result
            self._finished_at = datetime.now(timezone.utc)
            self._status = "error" if result.get("status") == "error" else "stopped"
            self._message = str(result.get("message") or "采集写入流程已结束")

    def _snapshot_locked(self) -> dict[str, Any]:
        return {
            "run_id": self._run_id,
            "status": self._status,
            "message": self._message,
            "started_at": _isoformat(self._started_at),
            "finished_at": _isoformat(self._finished_at),
            "last_result": self._last_result,
        }


async def run_write_flow(
    capture: CaptureManager,
    spool: DetectionSpool,
    options: WriteFlowOptions,
    emit: EventEmitter,
) -> dict[str, Any]:
    settings = get_settings()
    await spool.start(settings)

    request = CaptureStartRequest(
        max_frames=options.max_frames,
        frame_interval=options.frame_interval,
        device_id=options.device_id,
        task_id=options.task_id,
    )

    had_error = False
    final_state: dict[str, Any] = {}

    try:
        await emit("info", "settings", "运行配置已加载", _settings_summary(settings))
        start_result = await capture.start(request)
        start_level = "ok" if start_result.get("status") in {"ok", "running"} else "error"
        await emit(start_level, "capture_start", str(start_result.get("message") or "采集任务启动"), start_result)
        if start_result.get("status") not in {"ok", "running"}:
            had_error = True

        while True:
            state = await capture.status()
            final_state = state
            status = str(state.get("status") or "")
            level = _level_for_capture_state(state)
            await emit(level, "capture_status", _capture_status_message(state), state)
            if status == "error":
                had_error = True
            if status not in {"running", "stopping"}:
                break
            await asyncio.sleep(max(options.status_interval, 0.5))
    finally:
        stop_result = await capture.stop()
        await emit("ok", "capture_stop", str(stop_result.get("message") or "采集任务已停止"), stop_result)

        if options.flush_on_exit:
            flush_result = await spool.flush(get_settings())
            flush_level = _level_for_flush(flush_result)
            await emit(flush_level, "spool_flush", _flush_message(flush_result), flush_result)
            if flush_result.get("status") == "failed":
                had_error = True

        if options.shutdown_capture_on_exit:
            await capture.shutdown()
        if options.stop_spool_on_exit:
            await spool.stop()

    if not final_state:
        final_state = await capture.status()

    status = "error" if had_error or final_state.get("status") == "error" else "ok"
    message = "采集写入流程异常结束" if status == "error" else "采集写入流程已完成"
    await emit(status, "write_run_complete", message, {"final_state": final_state})
    return {"status": status, "message": message, "final_state": sanitize_payload(final_state)}


def _settings_summary(settings: Settings) -> dict[str, Any]:
    return {
        "capture_source_kind": settings.capture_source_kind,
        "capture_source_url": settings.capture_source_url,
        "capture_rotate_degrees": settings.capture_rotate_degrees,
        "inference_mode": "remote" if settings.inference_endpoint else "local",
        "inference_endpoint": settings.inference_endpoint,
        "inference_model": settings.inference_model,
        "inference_device": settings.inference_device,
        "frame_interval": settings.frame_interval,
        "database_configured": bool(settings.database_url),
        "spool_sqlite_path": str(settings.spool_sqlite_path),
    }


def _capture_status_message(state: dict[str, Any]) -> str:
    status = str(state.get("status") or "unknown")
    frames_read = state.get("frames_read", 0)
    frames_inferred = state.get("frames_inferred", 0)
    detections_queued = state.get("detections_queued", 0)
    if state.get("last_error"):
        return f"{status} · {state.get('message')} · {state.get('last_error')}"
    return f"{status} · 读取 {frames_read} · 推理 {frames_inferred} · 入队 {detections_queued}"


def _level_for_capture_state(state: dict[str, Any]) -> str:
    status = str(state.get("status") or "")
    if status == "error":
        return "error"
    if status in {"running", "stopping"}:
        return "info"
    return "ok"


def _level_for_flush(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "")
    if status == "failed":
        return "error"
    if status == "skipped":
        return "warn"
    return "ok"


def _flush_message(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "")
    selected = result.get("selected", 0)
    synced = result.get("synced", 0)
    failed = result.get("failed", 0)
    if status == "skipped":
        return "数据库未配置，检测结果保留在缓存队列"
    return f"批量写库 {status} · 选中 {selected} · 同步 {synced} · 失败 {failed}"


def _source_for_event(event: str) -> str:
    if event.startswith("capture"):
        return "capture"
    if event.startswith("spool"):
        return "spool"
    if event.startswith("settings") or event.startswith("write"):
        return "write"
    return "system"


def _isoformat(value: datetime | None) -> str | None:
    return value.isoformat() if value else None
