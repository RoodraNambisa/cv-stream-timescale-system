from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from statistics import fmean
from typing import Any

import aiosqlite
import asyncpg

from .config import Settings, get_settings
from .detections import DetectionRecord


class DetectionSpool:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._initialized_paths: set[Path] = set()
        self._background_task: asyncio.Task | None = None
        self._memory_queue: asyncio.Queue[DetectionRecord] = asyncio.Queue()

    async def start(self, settings: Settings) -> None:
        await self.initialize(settings)
        if self._background_task is None or self._background_task.done():
            self._background_task = asyncio.create_task(self._flush_loop())

    async def stop(self) -> None:
        if self._background_task is None:
            return

        self._background_task.cancel()
        try:
            await self._background_task
        except asyncio.CancelledError:
            pass

    async def initialize(self, settings: Settings) -> None:
        path = self._spool_path(settings)
        if path in self._initialized_paths:
            return

        path.parent.mkdir(parents=True, exist_ok=True)

        async with aiosqlite.connect(path) as database:
            await database.execute(
                """
                CREATE TABLE IF NOT EXISTS detection_spool (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  payload TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'pending',
                  attempts INTEGER NOT NULL DEFAULT 0,
                  last_error TEXT,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  synced_at TEXT
                )
                """
            )
            await database.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_detection_spool_status_id
                ON detection_spool (status, id)
                """
            )
            await database.commit()

        self._initialized_paths.add(path)

    async def enqueue(self, records: list[DetectionRecord], settings: Settings) -> list[int]:
        await self.initialize(settings)

        for record in records:
            await self._memory_queue.put(record)

        return await self._drain_memory_queue(settings)

    async def status(self, settings: Settings) -> dict[str, Any]:
        await self.initialize(settings)

        path = self._spool_path(settings)
        counts = {"pending": 0, "synced": 0, "failed": 0}

        async with aiosqlite.connect(path) as database:
            async with database.execute(
                """
                SELECT status, count(*)
                FROM detection_spool
                GROUP BY status
                """
            ) as cursor:
                async for status, count in cursor:
                    counts[status] = count

        return {
            "sqlite_path": str(path),
            "memory_queue_size": self._memory_queue.qsize(),
            "counts": counts,
        }

    async def flush(self, settings: Settings, limit: int | None = None) -> dict[str, Any]:
        await self.initialize(settings)
        await self._drain_memory_queue(settings)

        batch_limit = limit or settings.database_batch_size
        rows = await self._load_pending(settings, batch_limit)

        if not rows:
            return {"status": "idle", "selected": 0, "synced": 0, "failed": 0}

        if not settings.database_url:
            return {
                "status": "skipped",
                "reason": "database_not_configured",
                "selected": len(rows),
                "synced": 0,
                "failed": 0,
            }

        try:
            connection = await asyncpg.connect(
                settings.database_url,
                timeout=settings.database_connect_timeout,
            )
        except Exception as exc:
            await self._mark_failed(settings, [row["id"] for row in rows], str(exc))
            return {
                "status": "failed",
                "reason": "database_connect_failed",
                "selected": len(rows),
                "synced": 0,
                "failed": len(rows),
                "error": str(exc),
            }

        try:
            await self._ensure_metadata(connection, settings, rows)
            await connection.executemany(
                """
                INSERT INTO cv_detection_stream (
                  time,
                  device_id,
                  task_id,
                  object_class,
                  confidence,
                  bbox_x1,
                  bbox_y1,
                  bbox_x2,
                  bbox_y2,
                  bbox_center_x,
                  bbox_center_y,
                  frame_index,
                  source_kind,
                  inference_device
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7,
                  $8, $9, $10, $11, $12, $13, $14
                )
                """,
                [row["values"] for row in rows],
            )
            await self._upsert_result_meta(connection, rows)
        except Exception as exc:
            await connection.close()
            await self._mark_failed(settings, [row["id"] for row in rows], str(exc))
            return {
                "status": "failed",
                "reason": "database_insert_failed",
                "selected": len(rows),
                "synced": 0,
                "failed": len(rows),
                "error": str(exc),
            }

        await connection.close()
        await self._mark_synced(settings, [row["id"] for row in rows])

        return {
            "status": "ok",
            "selected": len(rows),
            "synced": len(rows),
            "failed": 0,
        }

    async def _flush_loop(self) -> None:
        while True:
            settings = get_settings()
            interval = max(settings.database_flush_interval_ms / 1000, 0.25)
            await asyncio.sleep(interval)
            await self.flush(settings)

    async def _drain_memory_queue(self, settings: Settings) -> list[int]:
        async with self._lock:
            if self._memory_queue.empty():
                return []

            path = self._spool_path(settings)
            inserted_ids: list[int] = []

            async with aiosqlite.connect(path) as database:
                while not self._memory_queue.empty():
                    record = await self._memory_queue.get()
                    payload = record.model_dump(mode="json")
                    cursor = await database.execute(
                        """
                        INSERT INTO detection_spool (payload)
                        VALUES (?)
                        """,
                        (json.dumps(payload, ensure_ascii=False),),
                    )
                    inserted_ids.append(cursor.lastrowid)
                await database.commit()

            return inserted_ids

    async def _load_pending(
        self,
        settings: Settings,
        limit: int,
    ) -> list[dict[str, Any]]:
        path = self._spool_path(settings)
        rows: list[dict[str, Any]] = []

        async with aiosqlite.connect(path) as database:
            database.row_factory = aiosqlite.Row
            async with database.execute(
                """
                SELECT id, payload
                FROM detection_spool
                WHERE status IN ('pending', 'failed')
                ORDER BY id
                LIMIT ?
                """,
                (limit,),
            ) as cursor:
                async for row in cursor:
                    payload = json.loads(row["payload"])
                    rows.append(
                        {
                            "id": row["id"],
                            "values": self._payload_to_db_values(payload),
                        }
                    )

        return rows

    def _payload_to_db_values(self, payload: dict[str, Any]) -> tuple[Any, ...]:
        return (
            self._parse_datetime(payload["time"]),
            payload["device_id"],
            payload["task_id"],
            payload["object_class"],
            payload["confidence"],
            payload.get("bbox_x1"),
            payload.get("bbox_y1"),
            payload.get("bbox_x2"),
            payload.get("bbox_y2"),
            payload.get("bbox_center_x"),
            payload.get("bbox_center_y"),
            payload.get("frame_index"),
            payload.get("source_kind", "http_mjpeg"),
            payload.get("inference_device", "auto"),
        )

    def _parse_datetime(self, value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    async def _ensure_metadata(
        self,
        connection: asyncpg.Connection,
        settings: Settings,
        rows: list[dict[str, Any]],
    ) -> None:
        devices: dict[int, str] = {}
        tasks: dict[int, tuple[int, str]] = {}
        for row in rows:
            values = row["values"]
            device_id = int(values[1])
            task_id = int(values[2])
            source_kind = str(values[12])
            devices.setdefault(device_id, source_kind)
            tasks.setdefault(task_id, (device_id, source_kind))

        for device_id, source_kind in devices.items():
            urls = self._device_stream_urls(settings, source_kind)
            await connection.execute(
                """
                INSERT INTO device (
                  id,
                  device_name,
                  owner,
                  stream_protocol,
                  http_mjpeg_url,
                  rtsp_url,
                  rtmp_url
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE SET
                  stream_protocol = EXCLUDED.stream_protocol,
                  http_mjpeg_url = EXCLUDED.http_mjpeg_url,
                  rtsp_url = EXCLUDED.rtsp_url,
                  rtmp_url = EXCLUDED.rtmp_url
                """,
                device_id,
                f"Device {device_id}",
                "runtime",
                source_kind,
                urls["http_mjpeg_url"],
                urls["rtsp_url"],
                urls["rtmp_url"],
            )

        for task_id, (device_id, source_kind) in tasks.items():
            await connection.execute(
                """
                INSERT INTO cv_task (
                  task_id,
                  device_id,
                  task_name,
                  model_name,
                  confidence_threshold,
                  frame_interval,
                  source_kind,
                  source_url,
                  inference_endpoint,
                  status,
                  start_time
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', now())
                ON CONFLICT (task_id) DO UPDATE SET
                  device_id = EXCLUDED.device_id,
                  model_name = EXCLUDED.model_name,
                  confidence_threshold = EXCLUDED.confidence_threshold,
                  frame_interval = EXCLUDED.frame_interval,
                  source_kind = EXCLUDED.source_kind,
                  source_url = EXCLUDED.source_url,
                  inference_endpoint = EXCLUDED.inference_endpoint,
                  status = EXCLUDED.status,
                  start_time = COALESCE(cv_task.start_time, EXCLUDED.start_time)
                """,
                task_id,
                device_id,
                f"Task {task_id}",
                settings.inference_model,
                settings.confidence_threshold,
                settings.frame_interval,
                source_kind,
                settings.capture_source_url or None,
                settings.inference_endpoint or None,
            )

    def _device_stream_urls(self, settings: Settings, source_kind: str) -> dict[str, str | None]:
        urls = {
            "http_mjpeg_url": None,
            "rtsp_url": None,
            "rtmp_url": None,
        }
        if source_kind == "http_mjpeg":
            urls["http_mjpeg_url"] = settings.capture_source_url or None
        elif source_kind == "rtsp":
            urls["rtsp_url"] = settings.capture_source_url or None
        elif source_kind == "rtmp":
            urls["rtmp_url"] = settings.capture_source_url or None
        return urls

    async def _upsert_result_meta(
        self,
        connection: asyncpg.Connection,
        rows: list[dict[str, Any]],
    ) -> None:
        groups: dict[tuple[int, str, datetime], list[float]] = {}
        for row in rows:
            values = row["values"]
            observed_at = values[0].replace(second=0, microsecond=0)
            task_id = int(values[2])
            object_class = str(values[3])
            confidence = float(values[4])
            groups.setdefault((task_id, object_class, observed_at), []).append(confidence)

        if not groups:
            return

        values = [
            (task_id, object_class, fmean(confidences), len(confidences), stat_time, 60)
            for (task_id, object_class, stat_time), confidences in groups.items()
        ]

        await connection.executemany(
            """
            INSERT INTO cv_result_meta (
              task_id,
              object_class,
              avg_confidence,
              total_count,
              stat_time,
              stat_window_seconds
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (task_id, object_class, stat_time, stat_window_seconds)
            DO UPDATE SET
              avg_confidence = (
                (cv_result_meta.avg_confidence * cv_result_meta.total_count)
                + (EXCLUDED.avg_confidence * EXCLUDED.total_count)
              ) / (cv_result_meta.total_count + EXCLUDED.total_count),
              total_count = cv_result_meta.total_count + EXCLUDED.total_count
            """,
            values,
        )

    async def _mark_synced(self, settings: Settings, row_ids: list[int]) -> None:
        if not row_ids:
            return

        placeholders = ",".join("?" for _ in row_ids)
        path = self._spool_path(settings)

        async with aiosqlite.connect(path) as database:
            await database.execute(
                f"""
                UPDATE detection_spool
                SET status = 'synced',
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP,
                    synced_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
                """,
                row_ids,
            )
            await database.commit()

    async def _mark_failed(
        self,
        settings: Settings,
        row_ids: list[int],
        error_message: str,
    ) -> None:
        if not row_ids:
            return

        placeholders = ",".join("?" for _ in row_ids)
        path = self._spool_path(settings)

        async with aiosqlite.connect(path) as database:
            await database.execute(
                f"""
                UPDATE detection_spool
                SET status = 'failed',
                    attempts = attempts + 1,
                    last_error = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
                """,
                [error_message, *row_ids],
            )
            await database.commit()

    def _spool_path(self, settings: Settings) -> Path:
        return Path(settings.spool_sqlite_path).expanduser()
