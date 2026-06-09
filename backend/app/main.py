import secrets
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .analysis import analysis_summary
from .capture import CaptureManager, CaptureStartRequest
from .config import (
    LOCKED_WHILE_CAPTURE_KEYS,
    PROJECT_ROOT,
    get_settings,
    preview_settings,
    reload_settings,
    update_dotenv,
)
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
WEB_DIST_DIR = PROJECT_ROOT / "apps" / "web" / "dist"
GRAFANA_PROXY_BASE_URL = "http://127.0.0.1:3000"
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class ConfigUpdateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(
    title="CV Stream Timescale API",
    version=settings.service_version,
)

@app.middleware("http")
async def apply_cors_and_require_api_token(request: Request, call_next):
    current_settings = get_settings()
    if request.method == "OPTIONS":
        response = JSONResponse(status_code=200, content={})
        _add_cors_headers(request, response)
        return response

    path = request.url.path
    token = current_settings.api_auth_token.strip()
    if not token or not path.startswith("/api/") or path in AUTH_EXEMPT_PATHS:
        response = await call_next(request)
        _add_cors_headers(request, response)
        return response

    provided = _request_token(request)
    if provided and secrets.compare_digest(provided, token):
        response = await call_next(request)
        _add_cors_headers(request, response)
        return response

    response = JSONResponse(
        status_code=401,
        content={"detail": "API token required"},
    )
    _add_cors_headers(request, response)
    return response


def _request_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "").strip()
    if authorization.casefold().startswith("bearer "):
        return authorization[7:].strip()

    return request.headers.get("x-api-key", "").strip()


def _add_cors_headers(request: Request, response) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return

    request_headers = request.headers.get(
        "access-control-request-headers",
        "Authorization, X-API-Key, Content-Type",
    )
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = request_headers


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
    return await collect_environment(get_settings(), await capture.status())


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


@app.get("/api/capture/frame.jpg")
async def capture_frame() -> Response:
    frame, frame_version = await capture.latest_frame()
    if frame is None:
        raise HTTPException(status_code=404, detail="No captured frame is available")

    return Response(
        content=frame,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Frame-Version": str(frame_version),
        },
    )


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


@app.get("/grafana")
async def grafana_root_redirect() -> RedirectResponse:
    return RedirectResponse("/grafana/")


@app.api_route(
    "/grafana/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def grafana_proxy(path: str, request: Request) -> Response:
    target_url = f"{GRAFANA_PROXY_BASE_URL}/grafana/{path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    headers = _proxy_request_headers(request)
    body = await request.body()
    async with httpx.AsyncClient(follow_redirects=False, timeout=30) as client:
        upstream = await client.request(
            request.method,
            target_url,
            content=body,
            headers=headers,
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_proxy_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )


def _proxy_request_headers(request: Request) -> dict[str, str]:
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
    }
    forwarded_host = request.headers.get("host", "")
    if forwarded_host:
        headers["x-forwarded-host"] = forwarded_host
    headers["host"] = "127.0.0.1:3000"
    headers["x-forwarded-proto"] = request.url.scheme
    headers["x-forwarded-prefix"] = "/grafana"
    return headers


def _proxy_response_headers(headers: httpx.Headers) -> dict[str, str]:
    proxied = {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
        and key.lower() not in {"content-encoding", "content-length"}
    }
    location = proxied.get("location")
    if location and location.startswith(GRAFANA_PROXY_BASE_URL):
        proxied["location"] = location.removeprefix(GRAFANA_PROXY_BASE_URL)
    return proxied


if WEB_DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST_DIR, html=True), name="web")
