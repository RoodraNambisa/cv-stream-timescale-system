#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -x ".venv/bin/python" ]; then
  echo "Missing .venv. Run scripts/setup_local_backend.sh first." >&2
  exit 1
fi

.venv/bin/python - <<'PY'
import asyncio
from pathlib import Path

import cv2
import numpy as np

from backend.app.analysis import analysis_summary
import backend.app.capture as capture_module
from backend.app.capture import CaptureManager, CaptureStartRequest, _detections_to_records
from backend.app.config import Settings
from backend.app.inference import _filter_inference_payload
from backend.app.spool import DetectionSpool


def write_test_video(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        8,
        (160, 120),
    )
    if not writer.isOpened():
        raise RuntimeError("test video writer failed")

    try:
        for index in range(8):
            frame = np.zeros((120, 160, 3), dtype=np.uint8)
            frame[:, :, 1] = 40 + index * 12
            cv2.rectangle(frame, (30 + index * 3, 25), (92 + index * 3, 96), (255, 255, 255), 2)
            cv2.putText(frame, f"f{index}", (12, 112), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
            writer.write(frame)
    finally:
        writer.release()


async def fake_infer_image_bytes(settings, image_bytes, filename):
    return _filter_inference_payload(
        settings,
        {
            "status": "ok",
            "mode": "local-smoke",
            "detections": [
                {
                    "object_class": "person",
                    "confidence": 0.82,
                    "bbox_x1": 30,
                    "bbox_y1": 25,
                    "bbox_x2": 92,
                    "bbox_y2": 96,
                },
                {"object_class": "car", "confidence": 0.91},
            ],
        },
    )


async def main() -> None:
    spool_path = Path("runtime/local_smoke_spool.db")
    video_path = Path("runtime/local_smoke_video.avi")
    if spool_path.exists():
        spool_path.unlink()
    if video_path.exists():
        video_path.unlink()
    write_test_video(video_path)

    settings = Settings(
        capture_source_kind="file",
        capture_source_url=str(video_path),
        database_url="",
        spool_sqlite_path=spool_path,
        confidence_threshold=0.5,
        detection_class_filter="person",
        analysis_time_range_minutes=10,
    )

    payload = {
        "status": "ok",
        "mode": "local",
        "detections": [
            {"object_class": "person", "confidence": 0.82, "bbox_x1": 1, "bbox_y1": 2},
            {"object_class": "car", "confidence": 0.91},
            {"object_class": "person", "confidence": 0.31},
        ],
    }
    filtered = _filter_inference_payload(settings, payload)
    records = _detections_to_records(settings, CaptureStartRequest(), filtered, frame_index=1)
    assert len(records) == 1, records
    assert records[0].object_class == "person"

    spool = DetectionSpool()
    await spool.start(settings)
    try:
        row_ids = await spool.enqueue(records, settings)
        assert len(row_ids) == 1, row_ids
        status = await spool.status(settings)
        assert status["counts"]["pending"] == 1, status
        flush_result = await spool.flush(settings)
        assert flush_result["status"] == "skipped", flush_result
        summary = await analysis_summary(settings)
        assert summary["status"] == "skipped", summary
        assert summary["class_filter"] == ["person"], summary

        capture_module.get_settings = lambda: settings
        capture_module.infer_image_bytes = fake_infer_image_bytes
        capture = CaptureManager(spool)
        start = await capture.start(CaptureStartRequest(max_frames=4, frame_interval=1))
        assert start["status"] == "ok", start
        for _ in range(20):
            state = await capture.status()
            if state["status"] not in {"running", "stopping"}:
                break
            await asyncio.sleep(0.1)
        await capture.stop()
        state = await capture.status()
        assert state["frames_read"] >= 4, state
        assert state["frames_inferred"] >= 4, state
        assert state["detections_queued"] >= 4, state
        assert state["recent_detections"], state
    finally:
        await spool.stop()

    print("local_smoke_check_ok")


asyncio.run(main())
PY
