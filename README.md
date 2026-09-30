# NovaStory

本地优先的 AI 短剧 / 分镜创作工具：React + Fastify + SQLite，本地 ComfyUI（**Pony XL 成片 + SD1.5 草稿**）。

## 快速启动

**前提：** Node.js 18+、（可选）本机 ComfyUI、Ollama 或云端 LLM API Key。

```powershell
# 安装依赖（仓库根）
npm install

# 配置后端密钥与路径（勿提交）。只使用 backend/.env，仓库根目录的 .env 不会被读取。
# 从 backend/.env.example 复制：
#   LLM_PROVIDER=gemini
#   LLM_API_KEY=...
#   LLM_MODEL=gemini-2.5-flash
#   # 默认仅监听回环；不要轻易改成 0.0.0.0
#   # HOST=127.0.0.1
#   # PORT=3000

# 开发（全栈：Vite + API，默认 http://127.0.0.1:3000）
npm run dev
```

或使用脚本：

```powershell
.\start_all.ps1
```

macOS 可在 Finder 中双击 `start_all.command` 启动、双击 `stop_all.command` 停止；也可在终端运行 `./start_all.command` 和 `./stop_all.command`。启动脚本会在缺少依赖时运行 `npm install`，并在当前进程中默认使用远端 ComfyUI。请先在 `backend/.env` 或应用设置中配置远端地址和凭据；脚本不会启动或停止本机 ComfyUI、Ollama。启动日志位于 `local/launcher/novastory.log`。

打开浏览器访问：**http://127.0.0.1:3000**（不要依赖局域网 IP，除非你明确开启了外网绑定）。

## 安全默认

| 项 | 默认行为 |
| --- | --- |
| 监听地址 | `127.0.0.1`（`HOST` / `NOVASTORY_HOST` 可覆盖） |
| CORS | 仅 localhost:3000；`NOVASTORY_ALLOW_LAN=1` 才放宽 |
| 设置 API | **永不**回传明文 `api_key`，只返回 `has_api_key` |
| 密钥存储 | `backend/.env` 的 `LLM_API_KEY`，不进 `system_settings.json` |

局域网暴露前请自行增加认证；当前产品定位是**单机单用户**。

## 架构一览

```text
浏览器 (React/Vite)
    │ REST + SSE（同源）
    ▼
Fastify (backend/src/server.ts)
    ├── SQLite 业务库 + generation_task 任务表
    ├── LLM 提供方 / ComfyUI 生图
    └── Redis（可选，仅进度广播）
```

详细文档见 **[docs/README.md](docs/README.md)**。

## 本地生图

- 成片：`pony_xl_12gb.json`（Pony / SDXL）
- 草稿：`sd15_draft_12gb.json`（SD 1.5）
- 参考策略（IP-Adapter 门禁）：[docs/deployment/local_image_reference_policy_cn.md](docs/deployment/local_image_reference_policy_cn.md)
- 项目统一模型出图需要启用 ComfyUI；安装：`docs/deployment/comfyui_local_setup_guide_3060.md`

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 全栈开发服务器 |
| `npm run check` | 前端类型检查 + 构建 |
| `cd backend && npm test` | 后端单测 |
| `cd backend && npm run typecheck` | 后端类型检查 |

## API 文档

服务启动后：

- Swagger UI：`http://127.0.0.1:3000/docs/`
- OpenAPI JSON：`http://127.0.0.1:3000/openapi.json`

说明见 [docs/API.md](docs/API.md)。

## 许可

见 [LICENSE](LICENSE)。
