from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import re
from typing import Any

import asyncpg
from pydantic import BaseModel, Field

from .config import PROJECT_ROOT, Settings
from .ui_events import UiEventLog


ANALYSIS_SQL_PATH = PROJECT_ROOT / "db" / "analysis_queries.sql"


class AnalysisRunRequest(BaseModel):
    query_ids: list[int] = Field(default_factory=list)
    row_limit: int = Field(default=80, ge=1, le=500)


def load_analysis_query_sections() -> list[dict[str, Any]]:
    if not ANALYSIS_SQL_PATH.exists():
        return []

    sections: list[dict[str, Any]] = []
    current_title = ""
    current_lines: list[str] = []
    echo_pattern = re.compile(r"^\\echo\s+'(.+)'\s*$")

    for line in ANALYSIS_SQL_PATH.read_text(encoding="utf-8").splitlines():
        match = echo_pattern.match(line.strip())
        if match:
            if current_title or current_lines:
                sections.append(_section(len(sections) + 1, current_title, current_lines))
            current_title = match.group(1)
            current_lines = []
        else:
            current_lines.append(line)

    if current_title or current_lines:
        sections.append(_section(len(sections) + 1, current_title, current_lines))

    return sections


async def run_analysis_query_sections(
    settings: Settings,
    event_log: UiEventLog,
    request: AnalysisRunRequest | None = None,
) -> dict[str, Any]:
    request = request or AnalysisRunRequest()
    sections = load_analysis_query_sections()
    selected_ids = set(request.query_ids)
    selected_sections = [
        section for section in sections if not selected_ids or int(section["id"]) in selected_ids
    ]

    await event_log.append(
        source="analysis",
        level="info",
        event="analysis_queries_start",
        message=f"开始执行 {len(selected_sections)} 个时序分析查询",
        details={"query_count": len(selected_sections), "database_configured": bool(settings.database_url)},
    )

    if not settings.database_url:
        result = {
            "status": "error",
            "message": "数据库未配置",
            "queries": sections,
            "results": [],
        }
        await event_log.append(
            source="analysis",
            level="error",
            event="analysis_queries_error",
            message="数据库未配置，无法执行时序分析查询",
            details={},
        )
        return result

    try:
        connection = await asyncpg.connect(
            settings.database_url,
            timeout=settings.database_connect_timeout,
        )
    except Exception as exc:
        await event_log.append(
            source="analysis",
            level="error",
            event="analysis_queries_error",
            message="数据库连接失败",
            details={"error": str(exc)},
        )
        return {
            "status": "error",
            "message": "数据库连接失败",
            "error": str(exc),
            "queries": sections,
            "results": [],
        }

    results: list[dict[str, Any]] = []
    try:
        for section in selected_sections:
            result = await _run_section(connection, section, request.row_limit)
            results.append(result)
            await event_log.append(
                source="analysis",
                level=_event_level_for_result(str(result["status"])),
                event="analysis_query_result",
                message=f"{section['title']} · {result['status']}",
                details={
                    "query_id": section["id"],
                    "row_count": result.get("row_count", 0),
                    "error": result.get("error"),
                },
            )
    finally:
        await connection.close()

    if all(result["status"] == "ok" for result in results):
        status = "ok"
        message = "时序分析查询完成"
    elif any(result["status"] == "error" for result in results):
        status = "error"
        message = "部分时序分析查询失败"
    else:
        status = "warn"
        message = "时序分析查询完成，部分维护语句未执行"
    await event_log.append(
        source="analysis",
        level=status,
        event="analysis_queries_done",
        message=message,
        details={"query_count": len(results)},
    )
    return {
        "status": status,
        "message": message,
        "queries": sections,
        "results": results,
    }


async def _run_section(
    connection: asyncpg.Connection,
    section: dict[str, Any],
    row_limit: int,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    columns: list[str] = []
    warnings: list[str] = []
    statements = _split_statements(str(section["sql"]))

    try:
        for statement in statements:
            if _returns_rows(statement):
                prepared = await connection.prepare(statement)
                columns = [attribute.name for attribute in prepared.get_attributes()]
                fetched = await prepared.fetch()
                rows = [_plain_row(row) for row in fetched[:row_limit]]
            else:
                try:
                    await connection.execute(statement)
                except Exception as exc:
                    if _can_continue_after_statement_error(statement, exc):
                        warnings.append("连续聚合刷新权限不足，已直接读取现有聚合结果")
                        continue
                    raise
    except Exception as exc:
        return {
            **section,
            "status": "error",
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": False,
            "error": str(exc),
            "warnings": warnings,
        }

    return {
        **section,
        "status": "warn" if warnings else "ok",
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": len(rows) >= row_limit,
        "warnings": warnings,
    }


def _section(index: int, title: str, lines: list[str]) -> dict[str, Any]:
    return {
        "id": index,
        "title": title or f"查询 {index}",
        "sql": "\n".join(lines).strip(),
    }


def _split_statements(sql: str) -> list[str]:
    return [part.strip() for part in sql.split(";") if part.strip()]


def _returns_rows(statement: str) -> bool:
    head = statement.lstrip().split(None, 1)[0].casefold()
    return head in {"select", "with", "show", "explain"}


def _can_continue_after_statement_error(statement: str, exc: Exception) -> bool:
    normalized_statement = statement.casefold()
    normalized_error = str(exc).casefold()
    return (
        "refresh_continuous_aggregate" in normalized_statement
        and "must be owner of view" in normalized_error
    )


def _event_level_for_result(status: str) -> str:
    if status == "error":
        return "error"
    if status == "warn":
        return "warn"
    return "ok"


def _plain_row(row: asyncpg.Record) -> dict[str, Any]:
    return {key: _plain_value(value) for key, value in dict(row).items()}


def _plain_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value
