# NovaStory

NovaStory 是一个面向小说、短剧与分镜创作的本地优先 AI 工作台。当前主实现采用统一的 TypeScript 技术栈：

- 前端：React 19、Vite、TypeScript
- 后端：Node.js、Fastify、TypeScript
- 数据库：SQLite，启动时自动执行幂等迁移
- 长任务进度：进程内任务状态；配置 Redis 时增加 Pub/Sub
- AI：Gemini、OpenAI、Grok/OpenAI 兼容接口、Ollama
- 图像：Gemini/Imagen、OpenAI Images、xAI 兼容接口、ComfyUI

## 本地启动

要求 Node.js 20 或更高版本。Windows 用户可以直接运行：

```powershell
.\start_all.ps1
```

也可以分开启动：

```powershell
cd backend
npm install
npm run dev
```

```powershell
npm install
npm run dev
```

默认地址：

- Web 应用：`http://localhost:3000/novastory/`
- Swagger 接口文档：`http://127.0.0.1:8087/docs`

首次启动会在 `backend/sql_app.db` 中创建完整数据结构，并写入内置 ComfyUI 工作流。

## 质量检查

```powershell
cd backend
npm run check
npm run build
```

```powershell
cd ..
npm run check
```

## Docker

```bash
docker compose up --build
```

访问 `http://localhost:3000/novastory/`。SQLite、系统设置与生成素材保存在 `backend_data` 数据卷中。容器内不自动启动宿主机 ComfyUI；如需连接宿主机实例，请在设置页使用 `http://host.docker.internal:8188`。

更详细的接口、架构和迁移状态见：

- [API 文档](API.md)
- [技术架构](architecture_cn.md)
- [Node.js 迁移基准](nodejs_migration_plan.md)
