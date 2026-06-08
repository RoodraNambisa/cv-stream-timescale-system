import secrets
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from .analysis import analysis_summary
from .capture import CaptureManager, CaptureStartRequest
from .config import LOCKED_WHILE_CAPTURE_KEYS, get_settings, preview_settings, reload_settings, update_dotenv
from .detections import DetectionBatch, DetectionRecord
from .environment import collect_environment, config_summary
from .inference import infer_image_bytes, inference_status
from .remote_ops import RemoteActionRequest, run_remote_action
from .spool import DetectionSpool
from .video import probe_video_source, video_config_summary

settings = get_settings()
spool = DetectionSpool()
capture = CaptureManager(spool)
AUTH_EXEMPT_PATHS = {"/api/health"}


class ConfigUpdateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(
    title="CV Stream Timescale API",
    version=settings.service_version,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    token = get_settings().api_auth_token.strip()
    if not token or not path.startswith("/api/") or path in AUTH_EXEMPT_PATHS:
        return await call_next(request)

    provided = _request_token(request)
    if provided and secrets.compare_digest(provided, token):
        return await call_next(request)

    return JSONResponse(
        status_code=401,
        content={"detail": "API token required"},
    )


def _request_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "").strip()
    if authorization.casefold().startswith("bearer "):
        return authorization[7:].strip()

    return request.headers.get("x-api-key", "").strip()


@app.on_event("startup")
async def startup() -> None:
    await spool.start(get_settings())


@app.on_event("shutdown")
async def shutdown() -> None:
    await capture.shutdown()
    await spool.stop()


@app.get("/api/health")
async def health() -> dict[str, str]:
    current_settings = get_settings()
    return {
        "service": current_settings.service_name,
        "status": "ok",
        "version": current_settings.service_version,
    }


@app.get("/api/config")
async def config() -> dict:
    return config_summary(get_settings())


@app.post("/api/config/reload")
async def reload_config() -> dict:
    current_settings = reload_settings()
    return {
        "status": "ok",
        "config": config_summary(current_settings),
    }


@app.post("/api/config")
async def update_config(request: ConfigUpdateRequest) -> dict:
    capture_state = await capture.status()
    incoming_keys = {key.strip().upper() for key in request.values}
    locked_changes = sorted(incoming_keys & LOCKED_WHILE_CAPTURE_KEYS)
    if capture_state["status"] in {"running", "stopping"} and locked_changes:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "采集运行中不能修改启动时锁定配置",
                "locked_keys": locked_changes,
            },
        )

    try:
        updated = update_dotenv(request.values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc

    current_settings = reload_settings()
    return {
        "status": "ok",
        "updated": updated,
        "config": config_summary(current_settings),
    }


@app.get("/api/environment")
async def environment() -> dict:
    return await collect_environment(get_settings())


@app.post("/api/environment/probe")
async def environment_probe(request: ConfigUpdateRequest) -> dict:
    try:
        settings_preview = preview_settings(request.values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc

    result = await collect_environment(settings_preview)
    result["status"] = "ok"
    result["preview"] = True
    return result


@app.post("/api/detections")
async def ingest_detection(record: DetectionRecord) -> dict:
    row_ids = await spool.enqueue([record], get_settings())
    return {
        "status": "queued",
        "queued": len(row_ids),
        "spool_ids": row_ids,
    }


@app.post("/api/detections/batch")
async def ingest_detection_batch(batch: DetectionBatch) -> dict:
    row_ids = await spool.enqueue(batch.records, get_settings())
    return {
        "status": "queued",
        "queued": len(row_ids),
        "spool_ids": row_ids,
    }


@app.get("/api/spool/status")
async def spool_status() -> dict:
    return await spool.status(get_settings())


@app.get("/api/analysis/summary")
async def get_analysis_summary() -> dict:
    return await analysis_summary(get_settings())


@app.post("/api/spool/flush")
async def flush_spool() -> dict:
    return await spool.flush(get_settings())


@app.get("/api/capture/status")
async def capture_status() -> dict:
    return await capture.status()


@app.post("/api/capture/start")
async def start_capture(request: Optional[CaptureStartRequest] = None) -> dict:
    return await capture.start(request)


@app.post("/api/capture/stop")
async def stop_capture() -> dict:
    return await capture.stop()


@app.get("/api/video/config")
async def video_config() -> dict:
    return video_config_summary(get_settings())


@app.post("/api/video/probe")
async def video_probe() -> dict:
    return await probe_video_source(get_settings(), max_frames=1)


@app.get("/api/inference/status")
async def get_inference_status() -> dict:
    return await inference_status(get_settings())


@app.post("/api/inference/image")
async def infer_image(file: UploadFile = File(...)) -> dict:
    image_bytes = await file.read()
    return await infer_image_bytes(get_settings(), image_bytes, file.filename or "frame.jpg")


@app.post("/api/remote/{action}")
async def remote_action(action: str, request: Optional[RemoteActionRequest] = None) -> dict:
    return await run_remote_action(action, get_settings(), request)
