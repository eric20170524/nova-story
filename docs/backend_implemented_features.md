# Node.js 后端已实现能力

后端入口为 `backend/src/server.ts`，生产构建输出到 `backend/dist`。

## 领域能力

- 项目、章节、角色、场景、工作流完整 CRUD
- TXT 项目导入、完整 JSON 导出和项目复制
- 章节自动分镜与场景编辑
- 单场景 9 镜头 coverage 的生成、应用与提升
- AI 续写、内容分析、上下文读取和导演助手工具调用
- 角色抽取、跨章节外观演化、素材上传与头像裁剪
- 图片任务、状态查询、SSE、Redis 可选 Pub/Sub 和 ComfyUI 中断
- 漫画字幕栅格化与 PDF 输出

## AI 与媒体

- 文本：Gemini、OpenAI、Grok、Ollama 和 OpenAI 兼容服务
- 结构化输出：Zod JSON Schema、校验、重试和模式化降级
- 云生图：Gemini/Imagen、OpenAI Images、xAI 兼容端点
- 本地生图：ComfyUI 自动探活/启动、内置 Pony/FLUX 工作流、参考图、参数注入、LoRA 实际连线
- **档位 A/B 参考策略**（`reference_generation_policy.ts` + `tier_b_adapters.ts`）：
  - A：标签 + 角色 LoRA + 文本构图；单图 img2img 仅限立绘/三视图/特写
  - B（Pony/SDXL）：`character_ref` → IP-Adapter；`composition_ref` → ControlNet；缺节点/模型静默回退 A
  - 探测：`GET /api/settings/tier-b-status`；安装脚本 `scripts/setup_tier_b_comfyui.ps1`
  - FLUX GGUF 暂仅 A
- FLUX：东亚特征提示增强及本地风格 LoRA 自动发现
- **NSFW 开关驱动的默认生图策略**（`image_generation_policy.ts`）：
  - **开启 NSFW**：自动叠加载 风格/细节 LoRA + 成人向 LoRA（Pony：Detail + Incase 类；FLUX：写实/东亚 + aidma 解锁），去重、缺文件按文件名模式自动发现；提示词注入 unlock/rating 与触发词；分镜 LLM 按成人向英文标签策略生成
  - **关闭 NSFW**：仅风格/细节 LoRA（绝不自动挂 Incase 等成人 LoRA）；强制 SFW 负向词；分镜 LLM 要求全年龄向描述
  - 风格预设（`style_preset`）自动追加国风/仙侠等 booster；FLUX 默认 CFG 3.5

## 数据与可靠性

- SQLite 幂等版本迁移
- 完整领域表和索引
- 内置工作流自动初始化
- 时间线替换、coverage 提升、项目/章节删除使用事务
- 旧数据库缺失级联约束时执行显式子记录清理
- 配置目录、数据目录和静态目录可通过 `NOVASTORY_*_DIR` 独立挂载

## 验证

`npm run check` 覆盖类型检查与测试；`npm run build` 验证生产编译。完整 Fastify 应用测试会对照 main 的 48 个 API 操作检查 OpenAPI 路由契约。
