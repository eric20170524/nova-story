# 2_ARCHITECTURE.md: 架构红线与技术栈

详细分层见现行文档 [`architecture_cn.md`](./architecture_cn.md)。本文只锁红线和本 Sprint 的目标管道，不重复那份总览。

## 1. 技术栈（现行，禁止按历史 MVP 回退）

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vite + React 19 + Tailwind 4 | 路由 `react-router-dom`；图标 `lucide-react` |
| 后端 | Fastify + TypeScript | 唯一持续演进实现。历史 Python/FastAPI 只作背景 |
| 校验 | Zod | HTTP 输入 + LLM 结构化输出 |
| 数据 | SQLite | 唯一业务事实源；幂等版本迁移在 `backend/src/db/database.ts` |
| 进度 | Redis 可选 | 未配置则进程内 / DB 降级 |
| 文本 LLM | Provider 层 | Gemini / OpenAI / Grok / Ollama；前端禁止直连 |
| 生图 | ComfyUI | 成片 **Pony XL**（`pony_xl_12gb`）；草稿 **SD1.5**。FLUX.1-dev GGUF 已退役 |

## 2. 架构红线

- **网关原则：** 浏览器只打本机 Fastify（`services/api.ts`）。禁止前端直连 Ollama、ComfyUI、Gemini、OpenAI。
- **模块职责：** `backend/src/routes/` 只做校验与编排；领域逻辑在 `services/`；表结构只通过 `database.ts` 迁移演进，路由里禁止临时建表。
- **隔离单位：** 本地单用户。业务数据按 `project_id`（章节/角色）或 `chapter_id`（场景）隔离。不要按 SaaS 多租户去加 JWT/RLS，除非主人单独立项。
- **Timeline 是视觉源数据：** `POST /timeline/generate` 会替换正式分镜。已有合格 Timeline 默认保留。
- **图片失败只修那一镜：** 用 scene version；禁止为修一张图重做整本小说。
- **Redis 必须可缺省。**
- **退役能力不同步回潮：** 不把 FLUX 内置工作流、Python FastAPI 栈当现行方案。

## 3. 本 Sprint 目标管道（红线）

错误形态（现行痛点，必须拆掉）：

```text
章节正文
  → LLM 一次输出整章 visual_prompt 散文
  → 整章 rewrite（旧 prompt 当 few-shot）
  → 每镜硬加同一段 dreamcore prefix
  → generation_service 再叠环境构图词
  → Pony XL
```

目标形态：

```text
章节正文 + Character.visual_tags
  → LLM 只填 Shot Contract（location / action / props / shot_intent）
  → compilePonyPrompt() 纯函数
  → sanitizer + uniqueness gate + negative compiler
  → 写入 scene.visual_prompt / negative_prompt / shot_spec
  → generation_service 只追加风格/质量 suffix
  → Pony XL
```

硬约束：

1. **LLM 不写最终 Pony 词。** `visual_prompt` 由 compiler 产出。
2. **契约进 `scene.shot_spec` JSON。** 无查询需求不新增列。
3. **角色锁只来自 visual_tags。** rewrite 系统提示不得写死 kitten/1girl。
4. **质量词（`score_9`, `source_anime`）只在生图组装末尾出现，不入库。**
5. **项目风格（dreamcore / 古风）走 style preset / enhancement suffix，不写进每镜 prefix。**
6. **词表单一来源：** `docs/best_practice_scene_visual_prompt.md`。代码模块实现它，不在 prompts.ts 再抄一份互相漂移的列表。

关键代码锚点（改前先 grep 下游）：

| 职责 | 文件 |
|---|---|
| 整章分镜生成 | `backend/src/services/timeline_generation_service.ts` |
| LLM + fallback | `backend/src/services/llm.ts` |
| 导演提示词 | `backend/src/services/prompts.ts` |
| 镜头 schema | `backend/src/schemas/llm.ts` |
| 整章 prompt 重写 | `backend/src/services/scene_visual_prompt_service.ts` |
| 生图增强 | `backend/src/services/image_generation_policy.ts` |
| 工作流组装 | `backend/src/services/generation_service.ts` |
| 路由 | `backend/src/routes/timeline.ts` |

## 4. 目录结构（与本 Sprint 相关）

```text
backend/src/services/     领域逻辑（编译器应落在这里，而不是 routes）
backend/src/schemas/      Zod
backend/src/routes/       HTTP
backend/src/db/           迁移
components/ Director/     分镜 UI
pages/DirectorMode.tsx
locales.ts                前后端可见文案的唯一词典
skills/novel-to-comic/    小说→整本漫画编排（本 Sprint 不改流程阶段）
```

## 5. 🛠️ 自测与验证命令

打勾前按任务类型跑，本 Sprint **优先纯函数单测**，不把 ComfyUI 当编译器正确性的证明。

**后端：**

```text
cd backend && npm test
cd backend && npm run typecheck
```

编译器 / sanitizer / uniqueness / negative 必须有不启动服务的 `.test.ts`。

**前端（仅当本任务改了 UI）：**

```text
npm run typecheck
```

根目录 `npm run check` = 前端 typecheck + 前端 build。不要为纯后端 Prompt 任务强制跑全量 Vite build，除非改了前端。

**禁止当作本 Sprint 验收的：**

- 人工看一张生成图就宣称 Prompt 管道修好（图是下游；先锁 Prompt 合约）。
- 无测试地改 `prompts.ts` 长文。

## 6. 统一响应

Fastify 错误体沿用现有 `{ detail: string }`。新接口保持 Zod parse；结构化失败写清 missing/unexpected scene_id，不要吞成 200。
