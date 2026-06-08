from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class DetectionRecord(BaseModel):
    time: datetime = Field(default_factory=utc_now)
    device_id: int
    task_id: int
    object_class: str
    confidence: float = Field(ge=0, le=1)
    bbox_x1: Optional[float] = None
    bbox_y1: Optional[float] = None
    bbox_x2: Optional[float] = None
    bbox_y2: Optional[float] = None
    bbox_center_x: Optional[float] = None
    bbox_center_y: Optional[float] = None
    frame_index: Optional[int] = None
    source_kind: str = "http_mjpeg"
    inference_device: str = "auto"


class DetectionBatch(BaseModel):
    records: list[DetectionRecord]
