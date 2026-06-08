from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from .config import Settings, parse_detection_class_filter


async def analysis_summary(settings: Settings) -> dict[str, Any]:
    window_minutes = settings.analysis_time_range_minutes
    class_filter = sorted(parse_detection_class_filter(settings.detection_class_filter))
    empty_payload = {
        "window_minutes": window_minutes,
        "class_filter": class_filter,
        "top_classes": [],
        "buckets": [],
        "result_meta": [],
        "recent": [],
    }

    if not settings.database_url:
        return {
            "status": "skipped",
            "message": "数据库未配置",
            **empty_payload,
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
            **empty_payload,
        }

    try:
        top_classes = await _fetch_top_classes(connection, window_minutes, class_filter)
        buckets = await _fetch_time_buckets(connection, window_minutes, class_filter)
        result_meta = await _fetch_result_meta(connection, window_minutes, class_filter)
        recent = await _fetch_recent(connection, window_minutes, class_filter)
    except Exception as exc:
        return {
            "status": "error",
            "message": "分析查询失败",
            "error": str(exc),
            **empty_payload,
        }
    finally:
        await connection.close()

    return {
        "status": "ok",
        "message": "分析查询完成",
        "window_minutes": window_minutes,
        "class_filter": class_filter,
        "top_classes": [_row_to_plain(row) for row in top_classes],
        "buckets": [_row_to_plain(row) for row in buckets],
        "result_meta": [_row_to_plain(row) for row in result_meta],
        "recent": [_row_to_plain(row) for row in recent],
    }


async def _fetch_top_classes(
    connection: asyncpg.Connection,
    window_minutes: int,
    class_filter: list[str],
) -> list[asyncpg.Record]:
    return await connection.fetch(
        """
        SELECT
          object_class,
          count(*)::int AS detection_count,
          round(avg(confidence)::numeric, 4)::float AS avg_confidence
        FROM cv_detection_stream
        WHERE time >= now() - ($1::int * INTERVAL '1 minute')
          AND ($2::text[] IS NULL OR lower(object_class) = ANY($2::text[]))
        GROUP BY object_class
        ORDER BY detection_count DESC, object_class
        LIMIT 8
        """,
        window_minutes,
        class_filter or None,
    )


async def _fetch_time_buckets(
    connection: asyncpg.Connection,
    window_minutes: int,
    class_filter: list[str],
) -> list[asyncpg.Record]:
    return await connection.fetch(
        """
        SELECT
          time_bucket('10 seconds', time) AS bucket,
          count(*)::int AS detection_count,
          round(avg(confidence)::numeric, 4)::float AS avg_confidence
        FROM cv_detection_stream
        WHERE time >= now() - ($1::int * INTERVAL '1 minute')
          AND ($2::text[] IS NULL OR lower(object_class) = ANY($2::text[]))
        GROUP BY bucket
        ORDER BY bucket
        LIMIT 120
        """,
        window_minutes,
        class_filter or None,
    )


async def _fetch_recent(
    connection: asyncpg.Connection,
    window_minutes: int,
    class_filter: list[str],
) -> list[asyncpg.Record]:
    return await connection.fetch(
        """
        SELECT
          time,
          device_id,
          task_id,
          object_class,
          round(confidence::numeric, 4)::float AS confidence,
          frame_index,
          inference_device
        FROM cv_detection_stream
        WHERE time >= now() - ($1::int * INTERVAL '1 minute')
          AND ($2::text[] IS NULL OR lower(object_class) = ANY($2::text[]))
        ORDER BY time DESC
        LIMIT 20
        """,
        window_minutes,
        class_filter or None,
    )


async def _fetch_result_meta(
    connection: asyncpg.Connection,
    window_minutes: int,
    class_filter: list[str],
) -> list[asyncpg.Record]:
    return await connection.fetch(
        """
        SELECT
          stat_time,
          task_id,
          object_class,
          round(avg_confidence::numeric, 4)::float AS avg_confidence,
          total_count,
          stat_window_seconds
        FROM cv_result_meta
        WHERE stat_time >= now() - ($1::int * INTERVAL '1 minute')
          AND ($2::text[] IS NULL OR lower(object_class) = ANY($2::text[]))
        ORDER BY stat_time DESC, total_count DESC, object_class
        LIMIT 20
        """,
        window_minutes,
        class_filter or None,
    )


def _row_to_plain(row: asyncpg.Record) -> dict[str, Any]:
    plain = dict(row)
    for key, value in list(plain.items()):
        if isinstance(value, datetime):
            plain[key] = value.isoformat()
    return plain
