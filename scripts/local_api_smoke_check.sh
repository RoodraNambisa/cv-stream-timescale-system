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
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np


ROOT = Path.cwd()
DOTENV_PATH = ROOT / ".env"
ENV_KEYS = {
    "CAPTURE_SOURCE_KIND",
    "CAPTURE_SOURCE_URL",
    "CAPTURE_USERNAME",
    "CAPTURE_PASSWORD",
    "CAPTURE_FPS_LIMIT",
    "CAPTURE_DEVICE_ID",
    "CAPTURE_TASK_ID",
    "STREAM_MODE",
    "STREAM_PROTOCOL",
    "STREAM_PUSH_URL",
    "STREAM_USERNAME",
    "STREAM_PASSWORD",
    "INFERENCE_ENDPOINT",
    "INFERENCE_DEVICE",
    "INFERENCE_MODEL",
    "CONFIDENCE_THRESHOLD",
    "FRAME_INTERVAL",
    "DETECTION_CLASS_FILTER",
    "ANALYSIS_TIME_RANGE_MINUTES",
    "DATABASE_URL",
    "DATABASE_CONNECT_TIMEOUT",
    "DATABASE_BATCH_SIZE",
    "DATABASE_FLUSH_INTERVAL_MS",
    "SPOOL_SQLITE_PATH",
    "REMOTE_API_BASE_URL",
    "REMOTE_API_HOST",
    "REMOTE_API_PORT",
    "REMOTE_SSH_HOST",
    "REMOTE_SSH_PORT",
    "REMOTE_SSH_USER",
    "REMOTE_SSH_KEY_PATH",
}


def write_test_video(path: Path, frames: int = 48) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        10,
        (160, 120),
    )
    if not writer.isOpened():
        raise RuntimeError("test video writer failed")

    try:
        for index in range(frames):
            frame = np.zeros((120, 160, 3), dtype=np.uint8)
            frame[:, :, 0] = 25 + index % 90
            frame[:, :, 1] = 45
            cv2.rectangle(frame, (30, 24), (96, 98), (255, 255, 255), 2)
            cv2.putText(frame, str(index), (12, 112), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
            writer.write(frame)
    finally:
        writer.release()


def encode_frame() -> bytes:
    frame = np.zeros((96, 128, 3), dtype=np.uint8)
    cv2.rectangle(frame, (20, 18), (78, 84), (255, 255, 255), 2)
    ok, buffer = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buffer.tobytes()


def detection_payload(mode: str = "api-smoke") -> dict[str, Any]:
    return {
        "status": "ok",
        "mode": mode,
        "image": {"width": 128, "height": 96},
        "detections": [
            {
                "object_class": "person",
                "confidence": 0.88,
                "bbox_x1": 20,
                "bbox_y1": 18,
                "bbox_x2": 78,
                "bbox_y2": 84,
                "bbox_center_x": 49,
                "bbox_center_y": 51,
            }
        ],
    }


async def fake_capture_infer(settings, image_bytes, filename):
    await asyncio.sleep(0.02)
    return detection_payload("api-smoke-capture")


def fake_local_image_inference(settings, image_bytes):
    return detection_payload()


def assert_status(response: httpx.Response, status_code: int) -> dict[str, Any]:
    assert response.status_code == status_code, (response.status_code, response.text)
    if response.content:
        return response.json()
    return {}


async def main() -> None:
    video_path = ROOT / "runtime" / "local_api_smoke_video.avi"
    spool_path = ROOT / "runtime" / "local_api_smoke_spool.db"
    for path in (video_path, spool_path):
        if path.exists():
            path.unlink()
    write_test_video(video_path)

    original_dotenv = DOTENV_PATH.read_bytes() if DOTENV_PATH.exists() else None
    original_env = {key: os.environ.get(key) for key in ENV_KEYS}
    for key in ENV_KEYS:
        os.environ.pop(key, None)

    DOTENV_PATH.write_text(
        "\n".join(
            [
                "CAPTURE_SOURCE_KIND=file",
                f"CAPTURE_SOURCE_URL={video_path}",
                "CAPTURE_FPS_LIMIT=20",
                "CAPTURE_DEVICE_ID=1",
                "CAPTURE_TASK_ID=1",
                "STREAM_MODE=pull",
                "STREAM_PROTOCOL=http_mjpeg",
                "INFERENCE_ENDPOINT=",
                "INFERENCE_DEVICE=cpu",
                "INFERENCE_MODEL=yolov8n.pt",
                "CONFIDENCE_THRESHOLD=0.5",
                "FRAME_INTERVAL=1",
                "DETECTION_CLASS_FILTER=person",
                "ANALYSIS_TIME_RANGE_MINUTES=5",
                "DATABASE_URL=",
                "DATABASE_CONNECT_TIMEOUT=1",
                "DATABASE_BATCH_SIZE=5",
                "DATABASE_FLUSH_INTERVAL_MS=10000",
                f"SPOOL_SQLITE_PATH={spool_path}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    import backend.app.capture as capture_module
    import backend.app.config as config_module
    import backend.app.inference as inference_module
    import backend.app.main as app_main

    original_capture_infer = capture_module.infer_image_bytes
    original_local_image_inference = inference_module._local_image_inference
    capture_module.infer_image_bytes = fake_capture_infer
    inference_module._local_image_inference = fake_local_image_inference

    started = False
    try:
        config_module.reload_settings()
        await app_main.startup()
        started = True

        transport = httpx.ASGITransport(app=app_main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://local-api-smoke") as client:
            health = assert_status(await client.get("/api/health"), 200)
            assert health["status"] == "ok", health

            config = assert_status(await client.get("/api/config"), 200)
            assert config["capture"]["source_kind"] == "file", config
            assert config["database"]["configured"] is False, config

            update = assert_status(
                await client.post(
                    "/api/config",
                    json={
                        "values": {
                            "CONFIDENCE_THRESHOLD": 0.6,
                            "FRAME_INTERVAL": 1,
                            "DATABASE_BATCH_SIZE": 3,
                        }
                    },
                ),
                200,
            )
            assert set(update["updated"]) == {"CONFIDENCE_THRESHOLD", "DATABASE_BATCH_SIZE", "FRAME_INTERVAL"}, update

            image_result = assert_status(
                await client.post(
                    "/api/inference/image",
                    files={"file": ("frame.jpg", encode_frame(), "image/jpeg")},
                ),
                200,
            )
            assert image_result["status"] == "ok", image_result
            assert image_result["detections"][0]["object_class"] == "person", image_result

            record = {
                "time": datetime.now(timezone.utc).isoformat(),
                "device_id": 1,
                "task_id": 1,
                "object_class": "person",
                "confidence": 0.88,
                "bbox_x1": 20,
                "bbox_y1": 18,
                "bbox_x2": 78,
                "bbox_y2": 84,
                "bbox_center_x": 49,
                "bbox_center_y": 51,
                "frame_index": 1,
                "source_kind": "file",
                "inference_device": "api-smoke",
            }
            queued = assert_status(await client.post("/api/detections", json=record), 200)
            assert queued["queued"] == 1, queued

            spool_status = assert_status(await client.get("/api/spool/status"), 200)
            assert spool_status["counts"]["pending"] >= 1, spool_status

            flush = assert_status(await client.post("/api/spool/flush"), 200)
            assert flush["status"] == "skipped", flush
            assert flush["selected"] >= 1, flush

            analysis = assert_status(await client.get("/api/analysis/summary"), 200)
            assert analysis["status"] == "skipped", analysis
            assert analysis["result_meta"] == [], analysis

            start = assert_status(
                await client.post("/api/capture/start", json={"max_frames": 24, "frame_interval": 1}),
                200,
            )
            assert start["status"] == "ok", start

            locked = await client.post(
                "/api/config",
                json={"values": {"CAPTURE_SOURCE_URL": str(video_path.with_name("changed.avi"))}},
            )
            assert locked.status_code == 409, (locked.status_code, locked.text)
            assert "CAPTURE_SOURCE_URL" in locked.text, locked.text

            for _ in range(50):
                capture_status = assert_status(await client.get("/api/capture/status"), 200)
                if capture_status["frames_inferred"] >= 2:
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError(f"capture did not infer frames: {capture_status}")

            stop = assert_status(await client.post("/api/capture/stop"), 200)
            assert stop["status"] in {"ok", "idle"}, stop

            capture_status = assert_status(await client.get("/api/capture/status"), 200)
            assert capture_status["frames_read"] > 0, capture_status
            assert capture_status["detections_queued"] > 0, capture_status
            assert capture_status["recent_detections"], capture_status

        print("local_api_smoke_check_ok")
    finally:
        capture_module.infer_image_bytes = original_capture_infer
        inference_module._local_image_inference = original_local_image_inference
        if started:
            await app_main.shutdown()
        if original_dotenv is None:
            DOTENV_PATH.unlink(missing_ok=True)
        else:
            DOTENV_PATH.write_bytes(original_dotenv)
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        config_module.reload_settings()


asyncio.run(main())
PY
