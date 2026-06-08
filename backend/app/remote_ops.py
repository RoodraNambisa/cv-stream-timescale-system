from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .config import PROJECT_ROOT, Settings


class RemoteActionRequest(BaseModel):
    remote_db_password: str | None = None


REMOTE_ACTIONS: dict[str, tuple[list[str], int]] = {
    "check": (["scripts/remote_smoke_check.sh"], 180),
    "sync": (["scripts/sync_remote_project.sh"], 240),
    "setup": (["scripts/setup_remote_backend.sh"], 900),
    "configure_database": (["scripts/configure_remote_database.sh"], 240),
    "api_start": (["scripts/remote_api.sh", "start"], 180),
    "api_status": (["scripts/remote_api.sh", "status"], 120),
    "api_stop": (["scripts/remote_api.sh", "stop"], 120),
    "api_logs": (["scripts/remote_api.sh", "logs"], 120),
}

SSH_MANAGEMENT_MESSAGE = (
    "SSH 管理未配置。运行时数据库连接使用 DATABASE_URL，"
    "远端推理使用 INFERENCE_ENDPOINT；SSH 只用于远端检测、同步、安装、配库和启动 API。"
)


async def run_remote_action(
    action: str,
    settings: Settings,
    request: RemoteActionRequest | None = None,
) -> dict[str, Any]:
    if action not in REMOTE_ACTIONS:
        return {
            "status": "error",
            "action": action,
            "message": "不支持的远端操作",
            "allowed_actions": sorted(REMOTE_ACTIONS),
        }

    ssh_error = _validate_ssh_management(action, settings)
    if ssh_error:
        return ssh_error

    command, timeout = REMOTE_ACTIONS[action]
    env = _remote_env(settings, request)

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=PROJECT_ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return {
            "status": "error",
            "action": action,
            "returncode": None,
            "message": f"远端操作超时，超过 {timeout} 秒",
            "stdout": "",
            "stderr": "",
        }

    stdout = _clip_output(stdout_bytes.decode("utf-8", errors="replace"))
    stderr = _clip_output(stderr_bytes.decode("utf-8", errors="replace"))
    ok = process.returncode == 0

    return {
        "status": "ok" if ok else "error",
        "action": action,
        "returncode": process.returncode,
        "message": "远端操作完成" if ok else "远端操作失败",
        "stdout": stdout,
        "stderr": stderr,
    }


def _remote_env(settings: Settings, request: RemoteActionRequest | None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "REMOTE_HOST": settings.remote_ssh_host,
            "REMOTE_PORT": str(settings.remote_ssh_port),
            "REMOTE_LOGIN": settings.remote_ssh_user,
            "REMOTE_KEY": str(Path(settings.remote_ssh_key_path).expanduser()),
            "REMOTE_API_HOST": settings.remote_api_host,
            "REMOTE_API_PORT": str(settings.remote_api_port),
        }
    )

    if request and request.remote_db_password:
        env["REMOTE_DB_PASSWORD"] = request.remote_db_password

    return env


def _validate_ssh_management(action: str, settings: Settings) -> dict[str, Any] | None:
    missing: list[str] = []
    if not settings.remote_ssh_host.strip():
        missing.append("REMOTE_SSH_HOST")
    if not settings.remote_ssh_user.strip():
        missing.append("REMOTE_SSH_USER")
    if not settings.remote_ssh_key_path.strip():
        missing.append("REMOTE_SSH_KEY_PATH")

    if missing:
        return {
            "status": "error",
            "action": action,
            "message": SSH_MANAGEMENT_MESSAGE,
            "missing_fields": missing,
            "stdout": "",
            "stderr": "",
        }

    key_path = Path(settings.remote_ssh_key_path).expanduser()
    if not key_path.exists():
        return {
            "status": "error",
            "action": action,
            "message": f"SSH 私钥不存在：{key_path}",
            "stdout": "",
            "stderr": "",
        }

    return None


def _clip_output(value: str, limit: int = 6000) -> str:
    if len(value) <= limit:
        return value

    return value[-limit:]
