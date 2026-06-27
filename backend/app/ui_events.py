from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from .config import PROJECT_ROOT


LOG_PATH = PROJECT_ROOT / "runtime" / "ui_events.jsonl"
SENSITIVE_KEY_PARTS = ("token", "password", "secret", "private", "database_url")
URL_KEY_PARTS = ("url", "source", "endpoint")


class UiEventLog:
    def __init__(self, path: Path = LOG_PATH, max_events: int = 800) -> None:
        self._path = path
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        async with self._lock:
            if self._initialized:
                return
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if self._path.exists():
                for line in self._path.read_text(encoding="utf-8").splitlines()[-self._events.maxlen:]:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict):
                        self._events.append(event)
            self._initialized = True

    async def append(
        self,
        *,
        source: str,
        level: str,
        event: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        entry = {
            "id": uuid4().hex[:12],
            "time": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "level": _normalize_level(level),
            "event": event,
            "message": message,
            "details": sanitize_payload(details or {}),
        }

        async with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._events.append(entry)
            with self._path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

        return entry

    async def list_events(
        self,
        *,
        source: str = "",
        level: str = "",
        q: str = "",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        await self.initialize()
        normalized_source = source.strip().casefold()
        normalized_level = level.strip().casefold()
        query = q.strip().casefold()
        capped_limit = max(1, min(limit, 500))

        async with self._lock:
            events = list(self._events)

        filtered: list[dict[str, Any]] = []
        for event in events:
            if normalized_source and str(event.get("source", "")).casefold() != normalized_source:
                continue
            if normalized_level and str(event.get("level", "")).casefold() != normalized_level:
                continue
            if query:
                haystack = json.dumps(event, ensure_ascii=False, default=str).casefold()
                if query not in haystack:
                    continue
            filtered.append(event)

        return filtered[-capped_limit:]


def sanitize_payload(value: Any, key: str = "") -> Any:
    normalized_key = key.casefold()

    if any(part in normalized_key for part in SENSITIVE_KEY_PARTS):
        return "已配置" if value else "未配置"

    if isinstance(value, dict):
        return {str(item_key): sanitize_payload(item_value, str(item_key)) for item_key, item_value in value.items()}

    if isinstance(value, list):
        return [sanitize_payload(item, key) for item in value]

    if isinstance(value, tuple):
        return [sanitize_payload(item, key) for item in value]

    if isinstance(value, str) and any(part in normalized_key for part in URL_KEY_PARTS):
        return mask_url(value)

    return value


def mask_url(value: str) -> str:
    if not value:
        return value

    try:
        parts = urlsplit(value)
    except ValueError:
        return value

    if not parts.scheme or not parts.netloc or not parts.password:
        return value

    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    if parts.username:
        host = f"{parts.username}:***@{host}"
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def _normalize_level(value: str) -> str:
    normalized = value.strip().casefold()
    return normalized if normalized in {"info", "ok", "warn", "error"} else "info"
