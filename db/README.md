# Database

本目录保存数据库 schema、TimescaleDB 对象和分析 SQL。

- `schema.sql`：关系表、TimescaleDB 超表、索引、连续聚合和基础样例数据
- `analysis_queries.sql`：关系查询和时序分析查询

PostgreSQL/TimescaleDB 由实际部署环境提供。Docker 不是主方案。

需要 SSH 管理数据库时执行：

```bash
scripts/configure_remote_database.sh
scripts/apply_remote_schema.sh
```

数据库可以直连时，不需要 SSH：

```bash
DATABASE_URL=postgresql://cv_user:CHANGE_ME@DB_HOST:5432/cv_stream scripts/apply_remote_schema.sh
```

运行时数据库连接只看 `DATABASE_URL`。本地数据库、远端数据库或同机数据库都使用 PostgreSQL 连接串：

```text
postgresql://cv_user:CHANGE_ME@DB_HOST:5432/cv_stream
```

仓库保留端口转发脚本用于诊断无法直连的数据库：

```bash
scripts/ssh_db_tunnel.sh
```

这条脚本只在 SSH 允许端口转发时可用。SSH 配库脚本只负责远端初始化和授权。正常数据写入走 PostgreSQL 协议，不走 SSH 命令。

隧道场景才把 `.env` 中的 `DATABASE_URL` 指向：

```text
postgresql://cv_user:CHANGE_ME@127.0.0.1:15432/cv_stream
```

`configure_remote_database.sh` 会把实际连接串写入本地 ignored 文件：

```text
runtime/remote_database.env
```
