# 数据库部署说明

当前 Node.js 后端以 SQLite 为正式持久化实现，不再使用历史 FastAPI 分支中的 SQLAlchemy/MySQL 配置。旧版 `mysql+pymysql://...` 地址不能直接传给 Node 后端。

生产或团队内网部署建议先使用仓库提供的 Docker Compose：

```bash
docker compose up --build
```

Compose 将 SQLite 数据库、系统设置和静态素材保存在 `backend_data` 卷中，并启用 Redis 作为进度广播增强。备份时应同时备份该数据卷。

如未来需要多实例写入或高并发事务，应单独规划 PostgreSQL/MySQL 数据访问层迁移；在完成 SQL 方言、迁移器、事务语义和集成测试之前，不应只替换 `DATABASE_URL`。
