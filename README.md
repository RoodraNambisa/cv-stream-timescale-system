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

安装前端依赖：

```bash
scripts/setup_web.sh
```

执行本地 smoke check：

```bash
scripts/local_smoke_check.sh
```

该脚本会在 `runtime/` 生成一个短测试视频，用 `file` 输入跑采集流程，并验证类别过滤、SQLite spool 入队和无数据库分析路径。

执行 API 级本地 smoke check：

```bash
scripts/local_api_smoke_check.sh
```

该脚本临时接管 `.env` 并在结束时恢复，直接请求 FastAPI 接口，覆盖配置热重载、运行锁定、spool 入队、无数据库 flush、分析接口、本地推理接口和采集状态。

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
flush 写检测流之前会按检测记录里的 `device_id` 和 `task_id` 自动 upsert `device` 与 `cv_task`，避免新设备或新任务因为外键缺失而写入失败。
检测流写入成功后，flush 会把本批次检测按分钟、任务和类别汇总到 `cv_result_meta`，记录平均置信度和检测数量。

采集任务接口：

```text
GET  /api/capture/status
POST /api/capture/start
POST /api/capture/stop
```

启动任务后，系统锁定数据库 URL、视频源 URL、推流 URL、推理端点、模型路径和 spool 路径。置信度、帧间隔、FPS 限制、类别过滤和批量写入大小来自当前配置。状态接口会返回最近检测快照，前端首屏用它显示实时类别和置信度。

分析接口：

```text
GET /api/analysis/summary
```

该接口按 `ANALYSIS_TIME_RANGE_MINUTES` 和 `DETECTION_CLASS_FILTER` 查询 TimescaleDB，返回类别分布、10 秒时间桶和最近写入记录。数据库未配置时返回 `skipped`，前端仍显示当前窗口和过滤条件。
接口还会返回 `cv_result_meta` 的分钟级统计元数据，前端分析页用它展示任务、类别、平均置信度和检测数量。

视频源和推流配置：

```text
GET  /api/video/config
POST /api/video/probe
```

视频输入支持 `http_mjpeg`、`rtsp`、`rtmp`、`camera`、`file`。Android IP Webcam 常用地址是：

```text
http://手机IP:8080/video
```

`CAPTURE_USERNAME` 和 `CAPTURE_PASSWORD` 会用于 HTTP/RTSP/RTMP 拉流。URL 已经带账号密码时，后端保留 URL 里的凭据；URL 没有凭据时，后端把单独配置的账号密码拼入读取地址。

如果手机使用推流，配置 `STREAM_MODE=push`、`STREAM_PROTOCOL=rtmp` 或 `rtsp`，并填写 `STREAM_PUSH_URL`、账号和密码。MediaMTX 或 nginx-rtmp 可以接收 RTMP/RTSP 推流。`STREAM_PUSH_URL` 是手机发布视频的入口；`CAPTURE_SOURCE_URL` 是后端读取视频的播放地址。接收服务把发布和播放做成同一个地址时，两项可以填同一个 URL。

可选流媒体接收器配置：

```text
STREAM_RECEIVER_KIND=mediamtx     # none | mediamtx | nginx_rtmp | custom
STREAM_RECEIVER_STATUS_URL=http://SERVER_HOST:9997/v3/config/global/get
```

后端不安装 MediaMTX 或 nginx-rtmp，只检测你填写的状态 URL 是否可达。MediaMTX 常用 API 端口是 `9997`；nginx-rtmp 常见做法是开启 stat 页面，再把 stat URL 填进 `STREAM_RECEIVER_STATUS_URL`。只要接收器提供 RTSP/RTMP/HTTP 播放地址，后端就能通过 `CAPTURE_SOURCE_URL` 拉流。

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
- `STREAM_RECEIVER_KIND`：`none`、`mediamtx`、`nginx_rtmp` 或 `custom`
- `STREAM_RECEIVER_STATUS_URL`：MediaMTX API、nginx-rtmp stat 或自定义接收器状态 URL
- `INFERENCE_ENDPOINT`：留空时本地推理，填写后走远端推理
- `DETECTION_CLASS_FILTER`：逗号分隔的类别白名单，留空表示不过滤
- `ANALYSIS_TIME_RANGE_MINUTES`：分析页图表和查询的默认时间窗口
- `DATABASE_URL`：本地或远端 PostgreSQL/TimescaleDB
- `SPOOL_SQLITE_PATH`：SQLite 缓存路径
- `GRAFANA_BASE_URL`：可选 Grafana 地址，环境检测会访问 `/api/health`
- `GRAFANA_DASHBOARD_URL`：可选 Grafana 面板地址，前端配置页会保留该链接

前端配置页可以修改这些配置。保存后，后端写 `.env` 并热重载；运行中锁定项要先停止采集再改。`REMOTE_API_BASE_URL` 是本地或前端可访问的远端 API 直连入口，环境检测会访问它的 `/api/health`。`INFERENCE_ENDPOINT` 才是采集运行时真正使用的推理地址。`REMOTE_API_HOST` 和 `REMOTE_API_PORT` 控制服务器上 FastAPI 的监听参数。`REMOTE_SSH_HOST`、`REMOTE_SSH_PORT`、`REMOTE_SSH_USER` 和 `REMOTE_SSH_KEY_PATH` 是可选远端管理参数，只用于检测服务器、同步项目、安装依赖、配库、启动或停止远端 API。

Grafana 是可选观测入口。React 分析页已经能展示类别分布、时间桶和统计元数据；如果你部署了 Grafana，可以让它直接读取同一个 PostgreSQL/TimescaleDB，再把 `GRAFANA_BASE_URL` 和 `GRAFANA_DASHBOARD_URL` 写入配置，环境检测会显示 Grafana 是否可达。

配置片段模板：

```text
deploy/env/local-all.env.example
deploy/env/edge-to-remote.env.example
deploy/env/server-all.env.example
```

这些文件只提供可复制的键值组合，不引入固定运行模式。按实际链路把需要的键复制进 `.env`，再通过配置页或 `POST /api/config/reload` 让后端重载。数据库、远端推理 API、MediaMTX/nginx-rtmp 和 Grafana 都按各自 URL 直连；SSH 仍然只是可选管理通道。

可选组件模板：

```text
deploy/mediamtx.yml
deploy/nginx-rtmp.conf
deploy/grafana/provisioning/datasources/timescaledb.yml
deploy/grafana/provisioning/dashboards/cv-stream.yml
deploy/grafana/dashboards/cv-stream.json
```

MediaMTX 模板开启 RTSP `8554`、RTMP `1935` 和 API `9997`。推流发布到 `rtmp://SERVER_HOST:1935/camera` 或对应路径，后端读取 `rtsp://SERVER_HOST:8554/camera`、`rtmp://SERVER_HOST:1935/camera`，再把 `STREAM_RECEIVER_STATUS_URL` 指向 MediaMTX API。

nginx-rtmp 模板开启 RTMP `1935` 和 stat `8088/stat`。后端不读取 stat 页面，只用它做接收器健康检测；视频读取仍走 `CAPTURE_SOURCE_URL`。

Grafana provisioning 模板使用环境变量读取 PostgreSQL/TimescaleDB 连接信息：

```text
GRAFANA_PG_HOST
GRAFANA_PG_PORT
GRAFANA_PG_DATABASE
GRAFANA_PG_USER
GRAFANA_PG_PASSWORD
```

dashboard JSON 包含检测时间桶、类别 Top、分钟置信度和最近检测表。Grafana 面板和 React 分析页读同一批表，不改变后端写库流程。

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
