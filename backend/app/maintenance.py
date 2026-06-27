from __future__ import annotations

import re
from typing import Any

import asyncpg
from pydantic import BaseModel

from .config import Settings
from .spool import DetectionSpool
from .ui_events import UiEventLog


class ClearRuntimeDataRequest(BaseModel):
    clear_spool: bool = True
    clear_timescale: bool = False
    confirm: str = ""


async def clear_runtime_data(
    settings: Settings,
    spool: DetectionSpool,
    event_log: UiEventLog,
    request: ClearRuntimeDataRequest | None = None,
) -> dict[str, Any]:
    request = request or ClearRuntimeDataRequest()
    confirm = (request.confirm or "").strip().upper()
    if request.clear_timescale and confirm != "CLEAR_DATA":
        return {
            "status": "blocked",
            "message": "清空数据库记录需要确认码",
            "results": [],
        }

    results: list[dict[str, Any]] = []
    if request.clear_spool:
        spool_result = await spool.clear(settings)
        results.append({"target": "spool", **spool_result})
        await event_log.append(
            source="system",
            level="warn",
            event="spool_cleared",
            message=f"SQLite 缓存已清空，删除 {spool_result.get('deleted', 0)} 条记录",
            details=spool_result,
        )

    if request.clear_timescale:
        database_result = await _clear_timescale(settings)
        results.append({"target": "timescale", **database_result})
        await event_log.append(
            source="system",
            level="warn" if database_result["status"] == "ok" else "error",
            event="timescale_data_cleared",
            message=database_result["message"],
            details=database_result,
        )

    if not results:
        return {
            "status": "idle",
            "message": "没有选择需要清空的数据",
            "results": results,
        }

    status = "ok" if all(item.get("status") == "ok" for item in results) else "error"
    return {
        "status": status,
        "message": "数据清理完成" if status == "ok" else "部分数据清理失败",
        "results": results,
    }


async def _clear_timescale(settings: Settings) -> dict[str, Any]:
    if not settings.database_url:
        return {
            "status": "error",
            "message": "数据库未配置，无法清空 TimescaleDB 记录",
        }

    try:
        connection = await asyncpg.connect(
            settings.database_url,
            timeout=settings.database_connect_timeout,
        )
    except Exception as exc:
        return {
            "status": "error",
            "message": "数据库连接失败",
            "error": str(exc),
        }

    try:
        detection_result = await connection.execute("DELETE FROM cv_detection_stream")
        meta_result = await connection.execute("DELETE FROM cv_result_meta")
    except Exception as exc:
        await connection.close()
        return {
            "status": "error",
            "message": "数据库记录清空失败",
            "error": str(exc),
        }

    await connection.close()
    deleted_detections = _deleted_count(detection_result)
    deleted_meta = _deleted_count(meta_result)
    return {
        "status": "ok",
        "message": f"TimescaleDB 检测记录已清空，删除 {deleted_detections} 条明细、{deleted_meta} 条统计",
        "deleted_detections": deleted_detections,
        "deleted_result_meta": deleted_meta,
    }


def _deleted_count(command_result: str) -> int:
    match = re.search(r"(\d+)$", command_result or "")
    if not match:
        return 0
    return int(match.group(1))
