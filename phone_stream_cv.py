from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from backend.app.capture import CaptureManager
from backend.app.spool import DetectionSpool
from backend.app.ui_events import sanitize_payload
from backend.app.write_flow import WriteFlowOptions, run_write_flow


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
    spool = DetectionSpool()
    capture = CaptureManager(spool)

    async def emit(_level: str, event: str, _message: str, payload: dict[str, Any]) -> None:
        _print_event(event, payload)

    result = await run_write_flow(
        capture,
        spool,
        WriteFlowOptions(
            max_frames=args.max_frames or 120,
            frame_interval=args.frame_interval,
            device_id=args.device_id,
            task_id=args.task_id,
            status_interval=args.status_interval,
            flush_on_exit=not args.no_flush_on_exit,
            shutdown_capture_on_exit=True,
            stop_spool_on_exit=True,
        ),
        emit,
    )
    return 0 if result["status"] == "ok" else 1


def _print_event(event: str, payload: Any) -> None:
    print(
        json.dumps(
            {"event": event, "payload": sanitize_payload(payload)},
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
