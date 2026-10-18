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

## 文本模型与推理模式

系统保证文本推理经由真实大模型，**杜绝任何绕过 LLM 调用内置模型能力（如 `codex` / `NOVASTORY_BUILTIN_AI=codex`）**。系统提供**本地 LLM** 与**远端预设**两种并列的可选工作方式，支持通过参数或环境变量显式控制：

| 工作模式 | 参数 / 环境变量 | 默认配置 | 显存与推理行为 |
| --- | --- | --- | --- |
| **本地 LLM**（默认） | `--llm-mode local`<br>`NOVASTORY_LLM_MODE=local` | Ollama / llama.cpp<br>`127.0.0.1:11434/v1`<br>`novastory-qwen3.5:9b` | 文本阶段独占申请本机 GPU 租约，按需自动启停 `llamacpp`；生图阶段自动释放显存给 ComfyUI |
| **远端预设** | `--llm-mode remote`<br>`NOVASTORY_LLM_MODE=remote` | OpenAI 兼容接口<br>`https://comfy.chuangyi.chat/gemma4/v1`<br>`gemma-4-31b` | 文本推理运行在远端算力机（如 GPU 3），不占用本机 GPU 租约，本机显存完全保留给生图与生视频 |

可在设置页面图形化测试连接与切换，也可在命令行脚本中直接传参。

## 完整视频制作链路与生成验收

制作全链路包含：依赖预检（A）→ 故事构思（B1）→ 章节规划与定稿正文（B2）→ 全篇连续性检查（B3）→ 分场剧本（C1）→ 章节分镜采纳（C2）→ 资产提取与生成（C3）→ 关键帧生成与正式定版（C4）→ 镜头视频生成与连续性时序绑定（C5）→ 章节拼接成片与总片验收（D）。详细规范见 [完整视频制作链路与内部接口.md](local/docs/完整视频制作链路与内部接口.md)。

### 1. 严格逐章依次生图与生视频
- **逐章前置门禁**：生图（`images`）和生视频（`videos`）阶段严格按章节从第 1 章开始依次进行。
- **前置依赖强校验**：只有在上一章节的所有关键帧完成质检（`review-images` 签字）且章节视频通过验收（`review-chapter` 签字）后，方可启动下一章节的资产生成与视频渲染，杜绝跨章乱序或跳章生成。

### 2. B3 直到 D 重新制作与历史版本自动归档
当剧本设定或分镜视觉策略调整、需要对项目从 **B3（连续性检查与处置）直到 D（总片合成）** 进行重新制作时，系统支持全自动归档与重制：

- **产物与状态归档**：传入 `--reproduce-from-b3` 参数，流水线将自动保留已确认的 Stage A/B1/B2 产物（`01-brainstorm.txt`、`02-story-plan.json`、`03-chapter-*.txt` 及对应 `state.steps`），并将原有的 B3～D 产物（`04-continuity-review.json`、`05-script-*`、`06-*`、`07-storyboards.json`、`08-rendered-storyboards.json`、`09-*`、`10-video-delivery.json`、`review-*`、`videos/` 及原 `state.json`）完整移入 `local/production/<projectId>/history/<timestamp>/` 目录留档。
- **数据库与媒体历史版本**：
  - **分镜重制与快照**：旧分镜在重新采纳时会自动备份到 `script_change.result_json.previous_timeline`（包含旧镜头的 `continuity_shot_dependency` 与 `scene_production_frame` 快照）。
  - **就绪视频归档**：已有 `narrative_final` 就绪视频会自动调用归档接口转为 `archived` 状态，不阻塞新分镜替换。
  - **关键帧历史留档**：镜头重做时自动派生新版本，旧图安全保留在 `scene_version` 历史记录中，并通过连续性重绑定（`bind-chapter-shots`）打通视频门禁。

### 3. 运行与重制命令

先启动已配置文本模型和 ComfyUI 的服务，并启用视频：

```bash
NOVASTORY_ENABLE_VIDEO=true npm run dev
```

常用流水线制作命令：

```bash
# 执行示例项目的完整链路（默认本地 LLM，限制 5 章，支持断点续跑）
npm run production:full -- --project 2 --retry-failed

# 选用远端预设（Gemma 4 31B）并行推理，跑满 14 章
npm run production:full -- --project 2 --chapter-limit 14 --llm-mode remote

# 对已有项目从 B3 直到 D 重新制作（原有 B3..D 产物与成片自动归档为历史版本）
npm run production:full -- --project 2 --chapter-limit 14 --reproduce-from-b3

# 可选独立阶段：preflight|text|review-continuity|scripts|assets|storyboards|images|review-images|audio|video-preflight|videos|assemble|verify
npm run production:full -- --project 2 --chapter-limit 14 --stage storyboards --rebuild-storyboards
```

输出保存在 `local/production/<projectId>/`：`state.json` 保留步骤与任务 ID，`report.html` 显示执行记录与验收矩阵，`videos/full-story.mp4` 为总片。重复执行同一命令继续未完成步骤；`--retry-failed` 明确重新提交已终止的图像/视频任务。

```bash
npm run check
npm run typecheck --workspace backend
npm run build --workspace backend
npm test
```

## API 文档

服务启动后：

- Swagger UI：`http://127.0.0.1:3000/docs/`
- OpenAPI JSON：`http://127.0.0.1:3000/openapi.json`

说明见 [docs/API.md](docs/API.md)。

## 许可

见 [LICENSE](LICENSE)。
