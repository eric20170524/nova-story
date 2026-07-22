# NovaStory 生产环境部署指南 (MySQL)

本文档详细说明如何在生产环境中使用 MySQL 数据库部署 NovaStory 后端服务。

## 1. 前置准备

确保服务器已安装以下软件：
*   **Python 3.10+**
*   **MySQL 8.0+**
*   **Redis** (用于异步任务队列)
*   **Git**

## 2. 数据库配置

### 2.1 创建数据库
登录 MySQL 并创建数据库及用户：
```sql
CREATE DATABASE novastory CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'novastory_user'@'localhost' IDENTIFIED BY 'your_secure_password';
GRANT ALL PRIVILEGES ON novastory.* TO 'novastory_user'@'localhost';
FLUSH PRIVILEGES;
```

### 2.2 安装 MySQL 驱动
在项目后端目录下，安装 `mysqlclient` 或 `pymysql`。推荐使用 `mysqlclient` 以获得更好的性能。
```bash
# 激活虚拟环境后
pip install mysqlclient
# 或者
pip install pymysql
```

## 3. 后端配置

### 3.1 修改环境变量
编辑 `backend/.env` 文件（如不存在则复制 `.env.example`），修改 `DATABASE_URL`：

```ini
# 使用 mysqlclient
DATABASE_URL=mysql://novastory_user:your_secure_password@localhost/novastory

# 或者使用 pymysql
# DATABASE_URL=mysql+pymysql://novastory_user:your_secure_password@localhost/novastory
```

同时确保其他生产环境配置正确：
```ini
# Redis 配置
REDIS_URL=redis://localhost:6379/0

# Nebula 集成 (如果需要)
NEBULA_ENABLED=true
NEBULA_BASE_URL=https://www.chuangyi.chat/v2
# 系统 Token 可在部署后通过 API 配置，或在此预设
```

## 4. 数据库迁移

使用 Alembic 将数据库结构应用到 MySQL。

```bash
cd backend
# 确保已安装依赖
pip install -r requirements.txt

# 执行迁移
alembic upgrade head
```

**验证**: 登录 MySQL，检查 `novastory` 数据库中是否已创建 `project`, `chapter`, `character`, `scene`, `alembic_version` 等表。

## 5. 生产级运行

不要使用 `uvicorn main:app --reload`。在生产环境中，推荐使用 Gunicorn 管理 Uvicorn worker。

### 5.1 安装 Gunicorn
```bash
pip install gunicorn
```

### 5.2 启动服务
```bash
# 启动 4 个 worker，绑定到 8000 端口
gunicorn main:app --workers 4 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

建议使用 Systemd 或 Supervisor 来管理 Gunicorn 进程，实现开机自启和自动重启。

### 5.3 Systemd 配置示例
创建 `/etc/systemd/system/novastory.service`:

```ini
[Unit]
Description=NovaStory Backend Service
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/path/to/NovaStory/backend
Environment="PATH=/path/to/NovaStory/backend/.venv/bin"
ExecStart=/path/to/NovaStory/backend/.venv/bin/gunicorn main:app --workers 4 --worker-class uvicorn.workers.UvicornWorker --bind 127.0.0.1:8000

[Install]
WantedBy=multi-user.target
```

## 6. 注意事项

1.  **时区**: 确保服务器和 MySQL 时区一致（通常使用 UTC 或 Asia/Shanghai），避免时间戳错乱。
2.  **备份**: 定期备份 MySQL 数据库。
3.  **安全性**: 
    *   不要将 `.env` 文件提交到 Git。
    *   确保 MySQL 端口 (3306) 不对外网直接开放，或配置防火墙规则。
    *   如果启用 Nebula 集成，确保 API 通信走 HTTPS。
