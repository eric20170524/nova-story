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

## 五章完整生成与验收

资产管理将角色、场景、道具分开管理。角色支持定妆照和三视图；场景和道具支持从章节正文提取、生成素材、独立编辑和镜头引用。资产外观变化会使旧引用过期，必须重新绑定并生成关键帧后才能用于视频。项目导出、复制和 JSON 回导保留资产及引用关系。

先启动已配置文本模型和 ComfyUI 的服务，并启用视频：

```bash
NOVASTORY_ENABLE_VIDEO=true npm run dev
```

执行示例项目的完整链路：

```bash
npm run production:full -- --project 90713823
```

顺序为依赖预检 → 构思与五章规划 → 五章正文与定稿 → 分场剧本 → 角色/场景/道具素材 → 分镜 → 关键帧 → 镜头视频 → 五章合成与总片 → 验收报告。所有生成调用经过系统 API，预检失败会退出，已有正文不会被覆盖。默认示例是五章修仙冒险；其他创作要求可用 `--brief-file /绝对路径/创作要求.txt`。

输出保存在 `local/production/90713823/`：`state.json` 保留步骤与任务 ID，`report.html` 显示执行记录，`acceptance.json` 记录验收矩阵，`videos/full-story.mp4` 为总片。重复执行同一命令继续未完成步骤；`--retry-failed` 明确重新提交已终止的图像/视频任务。未知或仍运行的任务不会自动重复提交。

关键帧记录使用的素材版本，素材引用变更后会重新生成关键帧。视频任务按关键帧、镜头版本和主角参考图区分，当前素材未变时复用任务；变化后生成新候选。所有候选视频均须完成视觉检查并在导演中采纳，脚本才会合成；旧视频的生成清单必须与当前关键帧和角色引用相符才能复用。

可使用 `--stage preflight|text|scripts|assets|storyboards|images|videos|assemble|verify` 单独执行阶段，或使用 `--base-url http://127.0.0.1:3001` 选择本地预览服务。章节正文全部定稿后再生成剧本，以免后续章节带来的世界观与角色变化让剧本来源过期。

脚本按类型和稳定名称检查镜头所需的全部场景和道具，漏掉任一关键素材会停止。匹配不到时在导演镜头中手动绑定全部素材，再续跑；重复提取会向模型提供已有名称和外观。角色视频优先使用焦点主角的参考图，缺少参考图时停止；验收从实际视频生成清单核对引用身份。被标记为 `review_required` 的视频必须经过人工检查和采纳。自动验收检查完整性、字数、来源与文件，叙事质量、角色/道具视觉一致性和音画同步仍需观看实生成结果。当前 H3 提示与参考接口支持一个焦点角色，配角在多人镜头中的一致性需实测。场景参考图是否执行构图控制取决于已安装的 ControlNet，当前道具外观通过提示词和关键帧传递。

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
