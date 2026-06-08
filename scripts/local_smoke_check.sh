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

from backend.app.analysis import analysis_summary
from backend.app.capture import CaptureStartRequest, _detections_to_records
from backend.app.config import Settings
from backend.app.inference import _filter_inference_payload
from backend.app.spool import DetectionSpool


async def main() -> None:
    spool_path = Path("runtime/local_smoke_spool.db")
    if spool_path.exists():
        spool_path.unlink()

    settings = Settings(
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
    finally:
        await spool.stop()

    print("local_smoke_check_ok")


asyncio.run(main())
PY
