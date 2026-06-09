# Web Console

React + Vite + TypeScript 监控台，负责展示视频流检测链路、配置编辑、采集任务和时序分析。

## 页面

- `总览`：展示 API、环境检测、视频源、推理端、数据库、缓存队列、远端 API 和 Grafana 状态
- `配置`：编辑拉流、推流、推理、数据库、接口鉴权、远端管理和 Grafana 参数；支持保存热重载、当前表单预检和前端 API 直连切换
- `任务`：启动或停止采集，查看运行中锁定配置，手动触发缓存队列批量写库
- `分析`：展示类别分布、检测时间桶、统计元数据和最近写入记录

## 开发启动

```bash
npm run dev -- --host 127.0.0.1
```

Vite 会把 `/api` 代理到 `http://127.0.0.1:8000`。先启动后端，再打开：

```text
http://127.0.0.1:5173
```

配置页里的“前端 API 连接”可以把浏览器请求切到远端 FastAPI。API token 存在当前浏览器，普通状态下用密码框遮挡，点小眼睛可查看。后端启用 `API_AUTH_TOKEN` 后，主页仍会打开；接口返回 401 时，顶部会显示 token 快捷输入条。浏览器直连远端 API 时，远端 `.env` 的 `CORS_ALLOWED_ORIGINS` 要包含当前前端 Origin。

## 单端口部署

```bash
npm run build
```

构建产物写入 `apps/web/dist`。FastAPI 启动后会用同一个端口托管该目录，浏览器访问后端根路径即可打开监控台，`/api/*` 继续走接口。

## 构建检查

```bash
npm run build
```

## 检查

```bash
npm run lint
```
