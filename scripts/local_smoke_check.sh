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
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

from backend.app.analysis import analysis_summary
from backend.app.environment import check_remote_api
import backend.app.capture as capture_module
import backend.app.spool as spool_module
from backend.app.capture import CaptureManager, CaptureStartRequest, _detections_to_records
from backend.app.config import Settings
from backend.app.inference import _filter_inference_payload
from backend.app.spool import DetectionSpool
from backend.app.video import probe_video_source, resolve_video_source


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


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/api/health":
            self.send_response(404)
            self.end_headers()
            return

        body = json.dumps(
            {"service": "local-smoke-api", "status": "ok", "version": "test"}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


class FakePgConnection:
    def __init__(self):
        self.calls = []
        self.closed = False

    async def execute(self, sql, *args):
        self.calls.append(("execute", sql, args))
        return "OK"

    async def executemany(self, sql, args):
        self.calls.append(("executemany", sql, args))

    async def close(self):
        self.closed = True


async def main() -> None:
    spool_path = Path("runtime/local_smoke_spool.db")
    alternate_spool_path = Path("runtime/local_smoke_spool_alt.db")
    fake_db_spool_path = Path("runtime/local_smoke_fake_db_spool.db")
    video_path = Path("runtime/local_smoke_video.avi")
    if spool_path.exists():
        spool_path.unlink()
    if alternate_spool_path.exists():
        alternate_spool_path.unlink()
    if fake_db_spool_path.exists():
        fake_db_spool_path.unlink()
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

    authenticated_source = resolve_video_source(
        settings.model_copy(
            update={
                "capture_source_kind": "rtsp",
                "capture_source_url": "rtsp://127.0.0.1:8554/live/camera-1",
                "capture_username": "viewer",
                "capture_password": "p@ss word",
            }
        )
    )
    assert authenticated_source == "rtsp://viewer:p%40ss%20word@127.0.0.1:8554/live/camera-1", authenticated_source

    existing_auth_source = resolve_video_source(
        settings.model_copy(
            update={
                "capture_source_kind": "rtsp",
                "capture_source_url": "rtsp://old:secret@127.0.0.1:8554/live/camera-1",
                "capture_username": "viewer",
                "capture_password": "changed",
            }
        )
    )
    assert existing_auth_source == "rtsp://old:secret@127.0.0.1:8554/live/camera-1", existing_auth_source

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

        remote_api_missing = await check_remote_api(settings)
        assert remote_api_missing["status"] == "warn", remote_api_missing

        server = ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            remote_api_settings = settings.model_copy(
                update={"remote_api_base_url": f"http://127.0.0.1:{server.server_port}"}
            )
            remote_api_ok = await check_remote_api(remote_api_settings)
            assert remote_api_ok["status"] == "ok", remote_api_ok
            assert remote_api_ok["details"]["service"] == "local-smoke-api", remote_api_ok
        finally:
            server.shutdown()
            thread.join(timeout=2)

        fake_connection = FakePgConnection()

        async def fake_connect(*args, **kwargs):
            return fake_connection

        original_connect = spool_module.asyncpg.connect
        spool_module.asyncpg.connect = fake_connect
        fake_db_spool = DetectionSpool()
        fake_db_settings = settings.model_copy(
            update={
                "database_url": "postgresql://cv_user:password@127.0.0.1:5432/cv_stream",
                "spool_sqlite_path": fake_db_spool_path,
                "capture_source_kind": "rtsp",
                "capture_source_url": "rtsp://127.0.0.1:8554/live/camera-1",
                "frame_interval": 5,
            }
        )
        try:
            fake_row_ids = await fake_db_spool.enqueue(records, fake_db_settings)
            assert len(fake_row_ids) == 1, fake_row_ids
            fake_flush = await fake_db_spool.flush(fake_db_settings)
            assert fake_flush["status"] == "ok", fake_flush
            assert fake_connection.closed is True, fake_connection.calls
            call_sql = [call[1] for call in fake_connection.calls]
            assert "INSERT INTO device" in call_sql[0], call_sql
            assert "INSERT INTO cv_task" in call_sql[1], call_sql
            assert "INSERT INTO cv_detection_stream" in call_sql[2], call_sql
            fake_db_status = await fake_db_spool.status(fake_db_settings)
            assert fake_db_status["counts"]["synced"] == 1, fake_db_status
        finally:
            spool_module.asyncpg.connect = original_connect

        alternate_settings = settings.model_copy(update={"spool_sqlite_path": alternate_spool_path})
        alternate_row_ids = await spool.enqueue(records, alternate_settings)
        assert len(alternate_row_ids) == 1, alternate_row_ids
        alternate_status = await spool.status(alternate_settings)
        assert alternate_status["counts"]["pending"] == 1, alternate_status

        push_settings = settings.model_copy(
            update={
                "stream_mode": "push",
                "stream_protocol": "rtmp",
                "stream_push_url": "rtmp://127.0.0.1/live/camera-1",
                "stream_username": "publisher",
                "stream_password": "secret",
                "capture_source_kind": "rtmp",
                "capture_source_url": "rtmp://127.0.0.1/live/camera-1",
            }
        )
        push_probe = await probe_video_source(push_settings)
        assert push_probe["status"] == "ok", push_probe
        assert push_probe["details"]["stream_username_set"] is True, push_probe
        assert push_probe["details"]["stream_password_set"] is True, push_probe

        push_without_read_source = push_settings.model_copy(update={"capture_source_url": ""})
        push_warning = await probe_video_source(push_without_read_source)
        assert push_warning["status"] == "warn", push_warning

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
