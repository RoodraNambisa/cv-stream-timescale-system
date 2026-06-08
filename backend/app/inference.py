from __future__ import annotations

import importlib
import importlib.util
from typing import Any

import httpx

from .config import Settings


_MODEL_CACHE: dict[str, Any] = {}


async def inference_status(settings: Settings) -> dict[str, Any]:
    if settings.inference_endpoint:
        return await _remote_inference_status(settings)

    return _local_inference_status(settings)


async def infer_image_bytes(
    settings: Settings,
    image_bytes: bytes,
    filename: str,
) -> dict[str, Any]:
    if settings.inference_endpoint:
        return await _remote_image_inference(settings, image_bytes, filename)

    return _local_image_inference(settings, image_bytes)


async def _remote_inference_status(settings: Settings) -> dict[str, Any]:
    base_url = settings.inference_endpoint.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{base_url}/api/inference/status")
    except Exception as exc:
        return {
            "status": "error",
            "mode": "remote",
            "message": "远端推理 API 连接失败",
            "details": {"endpoint": base_url, "error": str(exc)},
        }

    if response.status_code >= 400:
        return {
            "status": "error",
            "mode": "remote",
            "message": "远端推理 API 状态异常",
            "details": {"endpoint": base_url, "status_code": response.status_code},
        }

    payload = response.json()
    payload.setdefault("mode", "remote")
    return payload


async def _remote_image_inference(
    settings: Settings,
    image_bytes: bytes,
    filename: str,
) -> dict[str, Any]:
    base_url = settings.inference_endpoint.rstrip("/")
    files = {"file": (filename or "frame.jpg", image_bytes, "application/octet-stream")}

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(f"{base_url}/api/inference/image", files=files)

    if response.status_code >= 400:
        return {
            "status": "error",
            "mode": "remote",
            "message": "远端推理失败",
            "details": {"endpoint": base_url, "status_code": response.status_code},
        }

    payload = response.json()
    payload.setdefault("mode", "remote")
    return payload


def _local_inference_status(settings: Settings) -> dict[str, Any]:
    torch_available = importlib.util.find_spec("torch") is not None
    ultralytics_available = importlib.util.find_spec("ultralytics") is not None

    details: dict[str, Any] = {
        "model": settings.inference_model,
        "device": settings.inference_device,
        "torch_available": torch_available,
        "ultralytics_available": ultralytics_available,
    }

    if torch_available:
        torch = importlib.import_module("torch")
        details["torch_version"] = torch.__version__
        details["cuda_available"] = bool(torch.cuda.is_available())
        details["cuda_version"] = getattr(torch.version, "cuda", None)
        details["gpu_names"] = [
            torch.cuda.get_device_name(index)
            for index in range(torch.cuda.device_count())
        ]

    if ultralytics_available:
        ultralytics = importlib.import_module("ultralytics")
        details["ultralytics_version"] = ultralytics.__version__

    if torch_available and ultralytics_available:
        return {
            "status": "ok",
            "mode": "local",
            "message": "本地 YOLO 推理依赖可用",
            "details": details,
        }

    return {
        "status": "warn",
        "mode": "local",
        "message": "本地 YOLO 推理依赖未安装完整",
        "details": details,
    }


def _local_image_inference(settings: Settings, image_bytes: bytes) -> dict[str, Any]:
    if importlib.util.find_spec("ultralytics") is None:
        return {
            "status": "error",
            "mode": "local",
            "message": "Ultralytics 未安装",
            "detections": [],
        }

    if importlib.util.find_spec("cv2") is None or importlib.util.find_spec("numpy") is None:
        return {
            "status": "error",
            "mode": "local",
            "message": "OpenCV 或 NumPy 未安装",
            "detections": [],
        }

    import cv2
    import numpy as np
    from ultralytics import YOLO

    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        return {
            "status": "error",
            "mode": "local",
            "message": "图像解码失败",
            "detections": [],
        }

    model = _MODEL_CACHE.get(settings.inference_model)
    if model is None:
        model = YOLO(settings.inference_model)
        _MODEL_CACHE[settings.inference_model] = model

    device = None if settings.inference_device == "auto" else settings.inference_device
    results = model.predict(
        image,
        conf=settings.confidence_threshold,
        device=device,
        verbose=False,
    )

    detections: list[dict[str, Any]] = []
    for result in results:
        names = result.names
        for box in result.boxes:
            class_id = int(box.cls[0])
            confidence = float(box.conf[0])
            x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
            detections.append(
                {
                    "object_class": names.get(class_id, str(class_id)),
                    "confidence": confidence,
                    "bbox_x1": x1,
                    "bbox_y1": y1,
                    "bbox_x2": x2,
                    "bbox_y2": y2,
                    "bbox_center_x": (x1 + x2) / 2,
                    "bbox_center_y": (y1 + y2) / 2,
                }
            )

    height, width = image.shape[:2]
    return {
        "status": "ok",
        "mode": "local",
        "message": "推理完成",
        "image": {"width": width, "height": height},
        "detections": detections,
    }
