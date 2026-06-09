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
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np


ROOT = Path.cwd()
DOTENV_PATH = ROOT / ".env"
ENV_KEYS = {
    "API_AUTH_TOKEN",
    "CORS_ALLOWED_ORIGINS",
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
    "STREAM_RECEIVER_KIND",
    "STREAM_RECEIVER_STATUS_URL",
    "STREAM_USERNAME",
    "STREAM_PASSWORD",
    "INFERENCE_ENDPOINT",
    "INFERENCE_API_TOKEN",
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
    "REMOTE_PIP_INDEX_URLS",
    "REMOTE_PIP_TRUSTED_HOSTS",
    "REMOTE_PIP_PROXY",
    "GRAFANA_BASE_URL",
    "GRAFANA_DASHBOARD_URL",
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


class OptionalServiceHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/receiver/status":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/api/health":
            body = json.dumps({"database": "ok", "version": "test"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        return


class FakeDatabaseConnection:
    async def fetchval(self, query, *args):
        normalized = " ".join(query.lower().split())
        if "select version" in normalized:
            return "PostgreSQL fake"
        if "pg_extension" in normalized and "timescaledb" in normalized:
            return "fake"
        if "timescaledb_information.hypertables" in normalized:
            return True
        if "timescaledb_information.continuous_aggregates" in normalized:
            return True
        return None

    async def fetch(self, query, *args):
        table_names = args[0] if args else []
        return [{"table_name": table_name} for table_name in table_names]

    async def close(self):
        return None


async def fake_database_connect(*args, **kwargs):
    return FakeDatabaseConnection()


async def main() -> None:
    video_path = ROOT / "runtime" / "local_api_smoke_video.avi"
    spool_path = ROOT / "runtime" / "local_api_smoke_spool.db"
    for path in (video_path, spool_path):
        if path.exists():
            path.unlink()
    write_test_video(video_path)

    optional_server = ThreadingHTTPServer(("127.0.0.1", 0), OptionalServiceHandler)
    optional_thread = threading.Thread(target=optional_server.serve_forever, daemon=True)
    optional_thread.start()
    optional_base_url = f"http://127.0.0.1:{optional_server.server_port}"

    original_dotenv = DOTENV_PATH.read_bytes() if DOTENV_PATH.exists() else None
    original_env = {key: os.environ.get(key) for key in ENV_KEYS}
    for key in ENV_KEYS:
        os.environ.pop(key, None)

    DOTENV_PATH.write_text(
        "\n".join(
            [
                "CAPTURE_SOURCE_KIND=file",
                "API_AUTH_TOKEN=",
                'CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173 http://localhost:5173"',
                f"CAPTURE_SOURCE_URL={video_path}",
                "CAPTURE_FPS_LIMIT=20",
                "CAPTURE_DEVICE_ID=1",
                "CAPTURE_TASK_ID=1",
                "STREAM_MODE=pull",
                "STREAM_PROTOCOL=http_mjpeg",
                "STREAM_RECEIVER_KIND=mediamtx",
                f"STREAM_RECEIVER_STATUS_URL={optional_base_url}/receiver/status",
                "INFERENCE_ENDPOINT=",
                "INFERENCE_API_TOKEN=",
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
                "REMOTE_PIP_INDEX_URLS=https://pypi.tuna.tsinghua.edu.cn/simple https://pypi.org/simple",
                "REMOTE_PIP_TRUSTED_HOSTS=pypi.tuna.tsinghua.edu.cn",
                "REMOTE_PIP_PROXY=",
                f"GRAFANA_BASE_URL={optional_base_url}",
                f"GRAFANA_DASHBOARD_URL={optional_base_url}/d/api-smoke",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    import backend.app.capture as capture_module
    import backend.app.config as config_module
    import backend.app.environment as environment_module
    import backend.app.inference as inference_module
    import backend.app.main as app_main
    import backend.app.remote_ops as remote_ops_module

    original_capture_infer = capture_module.infer_image_bytes
    original_environment_connect = environment_module.asyncpg.connect
    original_local_image_inference = inference_module._local_image_inference
    original_remote_actions = remote_ops_module.REMOTE_ACTIONS.copy()
    capture_module.infer_image_bytes = fake_capture_infer
    environment_module.asyncpg.connect = fake_database_connect
    inference_module._local_image_inference = fake_local_image_inference
    remote_ops_module.REMOTE_ACTIONS["apply_schema"] = (
        [
            "bash",
            "-c",
            "test \"$DATABASE_URL\" = 'postgresql://cv_user:secret@db.local:5432/cv_stream' && echo schema-direct",
        ],
        10,
    )

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
            assert config["security"]["api_auth_token"] == "", config
            assert "127.0.0.1:5173" in config["security"]["cors_allowed_origins"], config
            assert config["capture"]["source_kind"] == "file", config
            assert config["database"]["configured"] is False, config
            assert config["stream"]["receiver_kind"] == "mediamtx", config
            assert config["observability"]["grafana_configured"] is True, config
            assert "pypi.tuna.tsinghua.edu.cn" in config["remote"]["pip_index_urls"], config
            assert config["remote"]["pip_proxy_configured"] is False, config

            auth_update = assert_status(
                await client.post("/api/config", json={"values": {"API_AUTH_TOKEN": "smoke-token"}}),
                200,
            )
            assert "API_AUTH_TOKEN" in auth_update["updated"], auth_update
            cors_preflight = await client.options(
                "/api/config",
                headers={
                    "Origin": "http://127.0.0.1:5173",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "Authorization, X-API-Key",
                },
            )
            assert cors_preflight.status_code == 200, (cors_preflight.status_code, cors_preflight.text)
            assert cors_preflight.headers["access-control-allow-origin"] == "http://127.0.0.1:5173", cors_preflight.headers
            assert "Authorization" in cors_preflight.headers["access-control-allow-headers"], cors_preflight.headers
            blocked = await client.get("/api/config", headers={"Origin": "http://127.0.0.1:5173"})
            assert blocked.status_code == 401, (blocked.status_code, blocked.text)
            assert blocked.headers["access-control-allow-origin"] == "http://127.0.0.1:5173", blocked.headers
            health_without_token = assert_status(await client.get("/api/health"), 200)
            assert health_without_token["status"] == "ok", health_without_token
            client.headers["Authorization"] = "Bearer smoke-token"
            authed_config = assert_status(await client.get("/api/config"), 200)
            assert authed_config["security"]["api_auth_token"] == "smoke-token", authed_config

            environment = assert_status(await client.get("/api/environment"), 200)
            checks = {item["name"]: item for item in environment["checks"]}
            assert checks["stream_receiver"]["status"] == "ok", checks["stream_receiver"]
            assert checks["grafana"]["status"] == "ok", checks["grafana"]

            probe = assert_status(
                await client.post(
                    "/api/environment/probe",
                    json={
                        "values": {
                            "CAPTURE_SOURCE_KIND": "file",
                            "CAPTURE_SOURCE_URL": str(video_path),
                            "STREAM_RECEIVER_KIND": "mediamtx",
                            "STREAM_RECEIVER_STATUS_URL": f"{optional_base_url}/receiver/status",
                            "GRAFANA_BASE_URL": optional_base_url,
                            "DATABASE_URL": "",
                            "CONFIDENCE_THRESHOLD": 0.77,
                        }
                    },
                ),
                200,
            )
            probe_checks = {item["name"]: item for item in probe["checks"]}
            assert probe["preview"] is True, probe
            assert probe_checks["video_source"]["status"] == "ok", probe_checks["video_source"]
            assert probe_checks["stream_receiver"]["status"] == "ok", probe_checks["stream_receiver"]
            assert probe_checks["grafana"]["status"] == "ok", probe_checks["grafana"]
            assert probe["config"]["inference"]["confidence_threshold"] == 0.77, probe
            config_after_probe = assert_status(await client.get("/api/config"), 200)
            assert config_after_probe["inference"]["confidence_threshold"] == 0.5, config_after_probe

            schema_probe = assert_status(
                await client.post(
                    "/api/environment/probe",
                    json={
                        "values": {
                            "DATABASE_URL": "postgresql://cv_user:secret@db.local:5432/cv_stream",
                            "DATABASE_CONNECT_TIMEOUT": 1,
                        }
                    },
                ),
                200,
            )
            schema_checks = {item["name"]: item for item in schema_probe["checks"]}
            assert schema_checks["database"]["status"] == "ok", schema_checks["database"]
            assert schema_checks["timescaledb"]["status"] == "ok", schema_checks["timescaledb"]
            assert schema_checks["database_schema"]["status"] == "ok", schema_checks["database_schema"]
            assert schema_checks["database_schema"]["details"]["hypertable_exists"] is True, schema_checks["database_schema"]

            db_config = assert_status(
                await client.post(
                    "/api/config",
                    json={"values": {"DATABASE_URL": "postgresql://cv_user:secret@db.local:5432/cv_stream"}},
                ),
                200,
            )
            assert "DATABASE_URL" in db_config["updated"], db_config
            apply_schema = assert_status(await client.post("/api/remote/apply_schema", json={}), 200)
            assert apply_schema["status"] == "ok", apply_schema
            assert "schema-direct" in apply_schema["stdout"], apply_schema
            cleared_db = assert_status(
                await client.post("/api/config", json={"values": {"DATABASE_URL": ""}}),
                200,
            )
            assert "DATABASE_URL" in cleared_db["updated"], cleared_db

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
        environment_module.asyncpg.connect = original_environment_connect
        inference_module._local_image_inference = original_local_image_inference
        remote_ops_module.REMOTE_ACTIONS.clear()
        remote_ops_module.REMOTE_ACTIONS.update(original_remote_actions)
        if started:
            await app_main.shutdown()
        if original_dotenv is None:
            DOTENV_PATH.unlink(missing_ok=True)
        else:
            DOTENV_PATH.write_bytes(original_dotenv)
        optional_server.shutdown()
        optional_thread.join(timeout=2)
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        config_module.reload_settings()


asyncio.run(main())
PY
