from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from backend.app.capture import CaptureManager, CaptureStartRequest
from backend.app.config import get_settings
from backend.app.spool import DetectionSpool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run phone stream capture, CV inference, and TimescaleDB spool flushing.",
    )
    parser.add_argument("--max-frames", type=int, default=None)
    parser.add_argument("--frame-interval", type=int, default=None)
    parser.add_argument("--device-id", type=int, default=None)
    parser.add_argument("--task-id", type=int, default=None)
    parser.add_argument("--status-interval", type=float, default=2.0)
    parser.add_argument("--no-flush-on-exit", action="store_true")
    return parser.parse_args()


async def run() -> int:
    args = parse_args()
    settings = get_settings()
    spool = DetectionSpool()
    capture = CaptureManager(spool)

    await spool.start(settings)
    request = CaptureStartRequest(
        max_frames=args.max_frames,
        frame_interval=args.frame_interval,
        device_id=args.device_id,
        task_id=args.task_id,
    )

    had_error = False
    try:
        _print_event("settings", _settings_summary(settings))
        start_result = await capture.start(request)
        _print_event("capture_start", start_result)
        if start_result.get("status") not in {"ok", "running"}:
            had_error = True

        while True:
            state = await capture.status()
            _print_event("capture_status", state)
            if state["status"] == "error":
                had_error = True
            if state["status"] not in {"running", "stopping"}:
                break
            await asyncio.sleep(max(args.status_interval, 0.5))
    finally:
        stop_result = await capture.stop()
        _print_event("capture_stop", stop_result)
        if not args.no_flush_on_exit:
            flush_result = await spool.flush(get_settings())
            _print_event("spool_flush", flush_result)
        await capture.shutdown()
        await spool.stop()

    final_state = await capture.status()
    return 1 if had_error or final_state["status"] not in {"stopped", "idle"} else 0


def _settings_summary(settings: Any) -> dict[str, Any]:
    return {
        "capture_source_kind": settings.capture_source_kind,
        "capture_source_url": settings.capture_source_url,
        "inference_mode": "remote" if settings.inference_endpoint else "local",
        "inference_endpoint": settings.inference_endpoint,
        "database_configured": bool(settings.database_url),
        "spool_sqlite_path": str(settings.spool_sqlite_path),
    }


def _print_event(event: str, payload: Any) -> None:
    print(
        json.dumps(
            {"event": event, "payload": payload},
            ensure_ascii=False,
            default=str,
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(run()))
    except KeyboardInterrupt:
        raise SystemExit(130)
