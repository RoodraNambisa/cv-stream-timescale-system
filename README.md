# cv-stream-timescale-system

手机视频流实时目标检测与时序分析系统。项目包含 React 监控台、Python 后端/边缘端、本地或远端推理、PostgreSQL/TimescaleDB 存储和 SQLite 缓存队列。

## 项目结构

- `apps/web`：React + Vite + TypeScript 视频流监控台
- `backend`：FastAPI 后端
- `db`：数据库 schema、TimescaleDB 和分析 SQL 脚本目录
- `deploy`：部署材料目录
- `scripts`：本地和远端启动脚本
- `runtime`：本地缓存和运行产物目录

## 依赖位置

不要全局安装依赖。

- 前端依赖安装在 `apps/web/node_modules`
- Python 依赖安装在仓库根目录 `.venv`
- 服务器推理直接使用已有 `configured Python environment` CUDA 环境

## 本地启动

安装后端依赖：

```bash
scripts/setup_local_backend.sh
```

启动 FastAPI：

```bash
scripts/run_backend.sh
```

启动 React 监控台：

```bash
scripts/run_web.sh
```

命令行采集入口：

```bash
. .venv/bin/activate
python phone_stream_cv.py --max-frames 300 --frame-interval 10
```

前端默认访问：

```text
http://127.0.0.1:5173
```

后端健康检查：

```text
http://127.0.0.1:8000/api/health
```

环境检测：

```text
http://127.0.0.1:8000/api/environment
```

该接口返回 Python、OpenCV、PyTorch/CUDA、数据库、TimescaleDB、视频源、推理端和 SQLite 缓存目录状态。缺少本地推理依赖时会显示提醒。

配置接口：

```text
GET  /api/config
POST /api/config
POST /api/config/reload
```

React 配置页通过 `POST /api/config` 写项目根目录 `.env`，然后热重载后端配置。密码、`DATABASE_URL` 这类敏感字段不回显；前端留空时后端保留原值。采集运行时，后端拒绝修改数据库 URL、视频源 URL、推流 URL、推理端点、模型路径和 spool 路径。

检测结果缓存接口：

```text
POST /api/detections
POST /api/detections/batch
GET  /api/spool/status
POST /api/spool/flush
```

检测结果先进入内存队列，再写入 SQLite spool。内存队列只负责当前进程内的快速缓冲；SQLite spool 是落盘队列，进程重启、数据库断开或网络抖动时仍能保留待写记录。数据库恢复后，flush 会按批量配置写入 `cv_detection_stream` 超表。

采集任务接口：

```text
GET  /api/capture/status
POST /api/capture/start
POST /api/capture/stop
```

启动任务后，系统锁定数据库 URL、视频源 URL、推流 URL、推理端点、模型路径和 spool 路径。置信度、帧间隔、FPS 限制和批量写入大小来自当前配置。

视频源和推流配置：

```text
GET  /api/video/config
POST /api/video/probe
```

视频输入支持 `http_mjpeg`、`rtsp`、`rtmp`、`camera`、`file`。Android IP Webcam 常用地址是：

```text
http://手机IP:8080/video
```

如果手机使用推流，配置 `STREAM_MODE=push`、`STREAM_PROTOCOL=rtmp` 或 `rtsp`，并填写 `STREAM_PUSH_URL`、账号和密码。后续可用 MediaMTX 接收 RTMP/RTSP 推流。

推理接口：

```text
GET  /api/inference/status
POST /api/inference/image
```

`INFERENCE_ENDPOINT` 留空时使用本地推理；填写远端 API base URL 时，图像推理请求会转发到远端。后端会自动拼接 `/api/inference/status` 和 `/api/inference/image`。当前服务器 base conda 已验证：

```text
torch 2.1.2+cu121
CUDA 12.1
GPU NVIDIA H20-3e
ultralytics 8.2.16
```

远端 API 需要在服务器上单独启动。它也是同一个 FastAPI 项目，只是运行位置在服务器，使用服务器 conda 里的 CUDA、PyTorch 和 Ultralytics。本地采集远端推理时，本地后端把帧发到 `INFERENCE_ENDPOINT` 指向的 API。这个地址按 HTTP 直连配置，SSH 不参与推理请求。

按更新后的要求，服务器端直接使用现有 conda 环境，不克隆、不额外占用空间。检查远端 CUDA 和 YOLO 环境：

```bash
scripts/check_remote_conda.sh
```

需要本地 CPU 推理时，把可选依赖安装进本地 `.venv`：

```bash
. .venv/bin/activate
python -m pip install -r backend/requirements-inference.txt
```

## 配置

复制模板：

```bash
cp .env.example .env
```

系统按配置组合采集、推理和存储：

- `CAPTURE_SOURCE_KIND`：`http_mjpeg`、`rtsp`、`rtmp`、`camera`、`file`
- `CAPTURE_SOURCE_URL`：视频源地址
- `STREAM_MODE`：`pull` 或 `push`
- `INFERENCE_ENDPOINT`：留空时本地推理，填写后走远端推理
- `DETECTION_CLASS_FILTER`：逗号分隔的类别白名单，留空表示不过滤
- `ANALYSIS_TIME_RANGE_MINUTES`：分析页图表和查询的默认时间窗口
- `DATABASE_URL`：本地或远端 PostgreSQL/TimescaleDB
- `SPOOL_SQLITE_PATH`：SQLite 缓存路径

前端配置页可以修改这些配置。保存后，后端写 `.env` 并热重载；运行中锁定项要先停止采集再改。`REMOTE_API_BASE_URL` 是本地或前端可访问的远端 API 直连入口，`INFERENCE_ENDPOINT` 才是采集运行时真正使用的推理地址。`REMOTE_API_HOST` 和 `REMOTE_API_PORT` 控制服务器上 FastAPI 的监听参数。`REMOTE_SSH_HOST`、`REMOTE_SSH_PORT`、`REMOTE_SSH_USER` 和 `REMOTE_SSH_KEY_PATH` 是可选远端管理参数，只用于检测服务器、同步项目、安装依赖、配库、启动或停止远端 API。

采集运行中仍可热重载 `CONFIDENCE_THRESHOLD`、`FRAME_INTERVAL`、`CAPTURE_FPS_LIMIT`、`DETECTION_CLASS_FILTER`、`ANALYSIS_TIME_RANGE_MINUTES`、`DATABASE_BATCH_SIZE` 和 `DATABASE_FLUSH_INTERVAL_MS`。系统会继续使用启动时的视频源、推理端点、模型、数据库 URL 和 spool 路径。

运行时写库只看 `DATABASE_URL`，后端通过 PostgreSQL 协议直接连接本地或远端数据库。SSH 配库只负责创建用户、启动服务、应用 schema、写服务器 `.env`，不参与正常检测数据写入。只有在平台允许端口转发且数据库无法直连时，才把 SSH 隧道当作临时诊断方案。


## 远端联调

同步本地代码到服务器持久目录：

```bash
scripts/sync_remote_project.sh
```

安装远端 API 依赖到服务器现有 conda：

```bash
scripts/setup_remote_backend.sh
```

检查远端 CUDA、YOLO、FastAPI 依赖、PostgreSQL、TimescaleDB 和 API 状态：

```bash
scripts/remote_smoke_check.sh
```

启动远端 PostgreSQL：

```bash
scripts/start_remote_postgres.sh
```

通过 SSH 配置远端数据库用户和远端 `.env`：

```bash
scripts/configure_remote_database.sh
```

如果你要指定数据库密码：

```bash
REMOTE_DB_PASSWORD='你的密码' scripts/configure_remote_database.sh
```

脚本会在本地生成 ignored 文件：

```text
runtime/remote_database.env
```

这里面会写入本地直连远端数据库的 `DATABASE_URL`，以及服务器内部运行用的 `SERVER_DATABASE_URL`，不要提交。

应用 schema 和分析 SQL：

```bash
scripts/apply_remote_schema.sh
```

启动远端 API：

```bash
scripts/remote_api.sh start
scripts/remote_api.sh status
scripts/remote_api.sh logs
scripts/remote_api.sh stop
```

可选诊断脚本：数据库端口转发：

```bash
scripts/ssh_db_tunnel.sh
```

运行时优先把可直连的 PostgreSQL/TimescaleDB 连接串写进 `DATABASE_URL`。这条脚本只在服务器禁止数据库直连且 SSH 允许端口转发时临时使用。

可选诊断脚本：远端 API 端口转发：

```bash
scripts/ssh_remote_api_tunnel.sh
```

本地采集远端推理时，优先把远端 FastAPI 的直连地址写进 `INFERENCE_ENDPOINT`。这条脚本只在远端 API 无法直连且 SSH 允许端口转发时临时使用。

React 配置页的“SSH 远端管理”按钮会请求本地 FastAPI：

```text
POST /api/remote/check
POST /api/remote/sync
POST /api/remote/setup
POST /api/remote/configure_database
POST /api/remote/api_start
POST /api/remote/api_status
POST /api/remote/api_stop
POST /api/remote/api_logs
```

这些接口只允许调用仓库内白名单脚本。连接服务器靠可选的 `REMOTE_SSH_*` 配置和 SSH 私钥；安装依赖会进入服务器持久目录，使用现有 conda 环境，不全局安装本地依赖。`configure_database` 是远端管理动作，负责初始化数据库用户和远端配置；检测结果写库仍然由后端按 `DATABASE_URL` 发起 PostgreSQL 连接。未配置 SSH 时，这些管理按钮会返回缺少 SSH 配置，不影响直连数据库和直连推理 API。

本地采集、远端推理、远端数据库直连时，本地 `.env` 可以这样组合：

```text
CAPTURE_SOURCE_KIND=http_mjpeg
CAPTURE_SOURCE_URL=http://手机IP:8080/video
INFERENCE_ENDPOINT=http://服务器:8000
DATABASE_URL=postgresql://cv_user:密码@数据库主机:5432/cv_stream
```

服务器完整运行时，编辑服务器上的：

```text
REMOTE_PROJECT_DIR/.env
```

把 `CAPTURE_SOURCE_URL` 改成服务器能访问的视频 URL，`INFERENCE_ENDPOINT` 留空，远端 API 会使用服务器 conda 里的 CUDA/Ultralytics。

## 运行组合

本地完整运行：

```text
本地拉流 -> 本地推理 -> 本地或远端数据库
```

本地采集远端推理：

```text
本地拉流 -> 远端 GPU API -> 本地或远端数据库
```

服务器完整运行：

```text
服务器拉视频 URL -> 服务器 GPU 推理 -> 服务器 TimescaleDB
```
