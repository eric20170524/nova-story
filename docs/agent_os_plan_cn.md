# DreamWaver 小说创作核心 → NovaStory Agent OS 实现计划

| 项 | 说明 |
| --- | --- |
| 状态 | ✅ 首版已落地（细节以代码为准；后续可迭代流式/Prompt Admin） |
| 来源 | DreamWaver AI（`Renren/app-registry/.../DreamWaverAI`）能力对齐 |
| 相关 | [local_language_model_deployment_cn.md](./local_language_model_deployment_cn.md)、[architecture_cn.md](./architecture_cn.md)、[backend_implemented_features.md](./backend_implemented_features.md) |

本文档是可版本管理的实现规格；会话内 Plan Mode 草稿仅作过程记录。

---

## 1. 背景分析

### 1.1 DreamWaver AI 核心能力

| 模块 | 能力 | 关键实现 |
| --- | --- | --- |
| **Agent Core** | 自然语言 → 多 Action 协议；Zod 校验 + `agent_repair` 自愈；多轮指代 | `agent/schema.ts`, `agentService.ts` |
| **沉浸写作** | 负向约束（下一章预告防抢跑）；分层记忆 L1–L4；续写后 condensed + nextPlot | `writingService.ts`, `contextService.ts` |
| **结构管理** | 重命名/改摘要/删章/移章（原带卷） | `agent/scripts/structure.ts` |
| **Skill 卡** | 电影化改写 / 加冲突 / 反转 | `skillService.ts` |
| **世界观** | 定稿影响分析（角色+术语表）；全书一致性体检 | `writingService.analyzeChapterImpact/checkConsistency` |
| **UX** | Action Card 确认执行；Undo/Redo；Admin Prompt 面板 | `ContextSidebar`, `useUndo`, `AdminPanel` |

### 1.2 NovaStory 现状与缺口

| 区域 | 现状 | 缺口 |
| --- | --- | --- |
| **剧本编辑器** `StoryEditor` | 章节 CRUD、简易 AI 续写、角色抽取、分析、分镜 | 无负向约束、无分层记忆、无技能卡、无 Undo、右侧无 Agent |
| **Agent** `agent_service.ts` | 单 `action` 工具（analyze/timeline/char）；无 Zod 自愈；导演页 tab 内嵌 | 非「写作 OS」协议；不覆盖结构/正文/技能 |
| **LLM** | 已支持 Ollama 本地（`novastory-qwen3:8b`） | 写作 prompt 过简；Agent 未按本地 8K 优化 |
| **数据** | 扁平 `chapter`（有 `summary`/`status` 列）；`character`；`project.settings` JSON | 无术语表；无 condensed；无 story bible 字段 |
| **挂载点** | Agent 仅在 `DirectorRightPanel` | 非项目全局 |

### 1.3 已确认决策

1. **Agent 形态**：项目级浮动面板（`ProjectLayout` 挂载）
2. **范围**：**尽量对齐 DreamWaver 全量**（适配无卷模型）
3. **卷结构**：**不引入 volume 表**；扁平章节 + summary
4. **危险操作**：前端 Action Card 确认后再执行

---

## 2. 目标架构

```text
ProjectLayout
  ├── Outlet (story / characters / director / settings)
  └── ProjectAgentShell (浮动抽屉，全局)
        ├── 对话 + History（按 projectId 持久到 sessionStorage 或后端可选）
        ├── Action Card 预览 → 用户确认执行
        └── 上下文：route + active chapter/scene（localStorage / context）

Backend
  /api/assistant/chat          → Agent OS 决策（多 actions + 自愈）
  /api/assistant/execute       → 确认后执行单条/批量 action（服务端写库）
  /api/agent/draft             → 增强：分层记忆 + 负向约束
  /api/agent/consistency       → 全书逻辑体检
  /api/agent/impact            → 定稿世界观演化
  /api/agent/skills/*          → 可选直调技能（也可只经 Agent）
  /api/projects/:id/glossary   → 术语表 CRUD
  /api/projects/:id/story-bible → genre/style/main_plot（settings 内）

LLM
  一律走现有 LLMService.getProvider()（默认 ollama 本地）
  结构化输出：generateStructuredWithRetry + Zod
  本地 8K：Agent 上下文裁剪（结构树 + 短摘要，正文不全量塞）
```

### 2.1 无卷适配

| DreamWaver Op | NovaStory 映射 |
| --- | --- |
| `MOVE_CHAPTER` + volume | `MOVE_CHAPTER` → 仅 `positionIndex`（现有 `PUT /chapters/:id/move`） |
| `RENAME_VOLUME` / `UPDATE_VOLUME_SUMMARY` | **不做**；扩展为 `UPDATE_PROJECT_META`（改 title/description/main_plot） |
| Volume 树上下文 | 扁平：`Ch[id] index title (status)` 列表 |

---

## 3. 数据模型

> 说明：仓库已有 migration `006_generation_task`。落地时使用 **`007_agent_os_writing`**（或当前最新版本号 +1），勿与 006 冲突。

### 3.1 chapter 增补列

- `condensed_content TEXT` — L2 浓缩（生成后写回）
- 已有：`summary`, `status`（draft/completed 等）— 前端类型补齐

### 3.2 glossary 新表

```sql
CREATE TABLE glossary (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  term VARCHAR(200) NOT NULL,
  definition TEXT,
  category VARCHAR(100),
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX ix_glossary_project ON glossary(project_id);
```

### 3.3 project.settings 扩展（不拆表）

在现有 `ProjectSettings` 增加 story bible：

```ts
genre?: string;
style?: string;
main_plot?: string;
character_relations?: string;
agent_prompts_override?: Partial<Record<PromptKey, string>>; // Admin 可选
```

### 3.4 前端 Chapter 类型

补齐 `summary?`, `status?`, `condensed_content?`。

---

## 4. Agent 协议（后端权威）

文件：`backend/src/schemas/agent_os.ts`（新建）+ 演进 `schemas/agent.ts` 响应为多 actions。

```ts
// Creative
DRAFT_CONTENT | ANSWER_QUESTION | QUERY_DATABASE
// Structure
UPDATE_CHAPTER_SUMMARY | RENAME_CHAPTER | DELETE_CHAPTER | MOVE_CHAPTER
// Project meta
UPDATE_PROJECT_META  // title/description/genre/style/main_plot
// Skills
CINEMATIC_REWRITE | ADD_CONFLICT | REVERSE_PLOT
// World
RUN_CONSISTENCY_CHECK | APPLY_CHAPTER_IMPACT
// Nova 特有（保留导演能力）
GENERATE_TIMELINE | ANALYZE_CHAPTER | GET_CHARACTER | UPDATE_CHARACTER
```

响应示例：

```json
{
  "thought": "...",
  "response": "给用户看的自然语言说明",
  "actions": [
    { "op": "RENAME_CHAPTER", "chapterId": "...", "newTitle": "..." }
  ],
  "needs_confirmation": true
}
```

- **决策与执行分离**：`POST /assistant/chat` 只规划；`POST /assistant/execute` 在用户确认后写库。
- **自愈**：Zod `safeParse` 失败 → `agent_repair` prompt 最多 2 次（对齐 DreamWaver）。
- **本地 LLM**：system prompt 强调「只输出 JSON、禁止 markdown 围栏」；temperature 用已有 structured 低温度路径。

### 4.1 执行层 `AgentExecutor`

每个 op 对应 DB/LLM 调用；DELETE 执行前服务端再校验 chapter 属于 project。  
DRAFT/Skill 返回 `proposed_content`（可写回章节或仅预览，由 execute 参数 `apply: true|false` 控制——默认 confirm 后 apply）。

---

## 5. 写作核心服务

### 5.1 `layered_context.ts`

移植 `buildLayeredContext`（扁平章节）：

- L1：前 1–2 章全文尾部（本地 8K 下收紧：每章最多 ~800 字）
- L2：前 3–8 章 `condensed_content || summary`
- L3：更早章节 title+summary 列表
- L4：project description + main_plot + 角色名录 + glossary 摘要
- Anchor：上一章最后 ~400 字

### 5.2 `writing_service.ts`（后端）

- `generateChapterDraft`：注入 layered context + next-chapter negative constraint
- `generateMetadata`：condensed + nextPlot hook（JSON）
- `analyzeChapterImpact`：更新 character + glossary
- `checkConsistency`：全书 outlines → issues[]

### 5.3 `prompt_registry.ts`（后端）

从 DreamWaver 精简移植关键模板（中文写作 + JSON Agent）：

- `agent_core`, `agent_repair`
- `writing_chapter_gen`, `constraint_next_chapter`, `writing_metadata_gen`
- `analysis_impact`, `consistency_check`
- `skill_cinematic`, `skill_conflict`, `skill_reversal`

支持 `project.settings.agent_prompts_override` 覆盖（Admin 一期可用简易 JSON 编辑，放项目设置页折叠区即可，不必做隐藏彩蛋）。

### 5.4 增强 `creativeRoutes`

- `POST /agent/draft`：接受 `project_id`, `chapter_id`, `instructions`, `target_word_count`；内部走 writing_service
- `POST /agent/consistency`、`POST /agent/impact`
- 保留现有 storyboard-grid / analyze 兼容

---

## 6. 前端

### 6.1 项目全局 Agent Shell

- 新建 `components/agent/ProjectAgentPanel.tsx` + `AgentActionCard.tsx`
- 在 `ProjectLayout` 挂 FAB（右下角）打开抽屉；全路由可用
- 上下文：`projectId` + `localStorage director_project_${id}_chapter` + `useLocation` 当前页类型
- 升级现有 `AgentAssistant.tsx` 或替换为新组件；**Director 内嵌 tab 改为同一组件**，避免两套逻辑

### 6.2 Action Card 流程

1. 用户发消息 → chat 返回 thought + actions
2. UI 展示预览（删章红色警告）
3. 点「执行」→ `execute` API → onSuccess：刷新章节列表/角色/编辑器内容
4. 通过 `CustomEvent` 或轻量 React Context（`ProjectAgentContext`）通知 StoryEditor 等刷新

### 6.3 StoryEditor 小说核心 UX

- 展示/编辑 `summary`（章纲）
- AI 续写改走增强 draft（带 project/chapter id）
- 工具栏：一致性检查、定稿分析、技能快捷（电影化/冲突/反转）— 也可只靠 Agent 对话触发
- **Undo/Redo**：`hooks/useUndo.ts` 移植，作用于当前章 `content`（前端内存栈；切换章节清空或按章 key 分栈）
- 右侧 tab 增加 **Agent** 快捷（打开全局面板）或内嵌同一面板

### 6.4 术语表 + Story Bible

- `ProjectSettings` 页：genre / style / main_plot 表单
- 术语表：简易列表 CRUD（可挂角色管理旁或项目设置）

### 6.5 API 客户端

`services/api.ts`：assistant chat/execute、glossary、consistency、impact、增强 draft。

### 6.6 i18n

`locales.ts` 补 Agent OS / 写作相关文案（中英）。

---

## 7. 实现阶段

### Phase 1 — 协议与后端执行器（地基）

1. migration（`007_agent_os_writing` 等）+ glossary + chapter.condensed_content
2. `agent_os` Zod schema + prompt_registry + layered_context + writing_service
3. 重写 `AgentService`：决策（多 actions + 自愈）+ `AgentExecutor`
4. 路由：`/assistant/chat` 响应升级；新增 `/assistant/execute`；creative 增强
5. 单测：schema parse、executor 结构 ops（mock db）、draft context 组装（不强制真 LLM）

### Phase 2 — 项目全局 Agent UI

1. `ProjectAgentContext` + 浮动面板 + Action Card
2. Director 切换到共用组件
3. 确认执行后刷新链路

### Phase 3 — StoryEditor 写作体验

1. summary 编辑、增强续写、Undo/Redo
2. 一致性检查 / 定稿影响 UI
3. Skill 快捷按钮（可选，Agent 已覆盖）

### Phase 4 — Story Bible + Glossary + Prompt 覆盖

1. 项目设置字段 + glossary API/UI
2. 简易 prompt 覆盖编辑（项目设置高级区）

### Phase 5 — 验证与文档

1. `backend npm test` + typecheck；前端 `npm run check`
2. 更新 `docs/backend_implemented_features.md`、`docs/API.md`；实现完成后可将本文档状态改为「已落地」并链到实现说明

---

## 8. 本地 LLM 约束（实现时必须遵守）

- 默认走 `LLM_PROVIDER=ollama` / `novastory-qwen3:8b`，不新增云依赖
- Agent 决策 prompt 控制在结构树 + 摘要级，避免整书正文
- 结构化任务用低 temperature + JSON schema（现有 OpenAIProvider isOllama 路径）
- 长写作可流式：一期可非流式；若时延差再加 SSE（可选后续）
- 与 ComfyUI 显存互斥策略不变（见 [local_language_model_deployment_cn.md](./local_language_model_deployment_cn.md)）

---

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 本地 8B JSON 格式不稳 | 自愈 retry + 宽松 parse + 失败时 ANSWER_QUESTION 降级 |
| 8K 上下文爆掉 | 分层记忆硬裁剪；glossary/角色限条数 |
| 执行与 UI 不同步 | execute 返回变更摘要；前端统一 reload chapters |
| 全量范围过大 | 阶段可合并交付，但 PR 内按 Phase 文件边界清晰 |
| 误删章 | Action Card + 红确认；服务端 project 归属校验 |

---

## 10. 明确不做（本期）

- Volume 表与卷级 UI
- 云端 Nebula 支付/存储模拟层
- 知识图谱可视化
- 真·服务端全文 Undo 历史库（仅前端 content 栈）
- 语音输入

---

## 11. 关键文件清单

### 新建

- `backend/src/db` migration `007_agent_os_writing`（版本号以代码为准）
- `backend/src/schemas/agent_os.ts`
- `backend/src/services/ai/prompt_registry.ts`
- `backend/src/services/ai/layered_context.ts`
- `backend/src/services/ai/writing_service.ts`
- `backend/src/services/ai/agent_executor.ts`
- `backend/src/routes/glossary.ts`（或并入 projects）
- `components/agent/ProjectAgentPanel.tsx`
- `components/agent/AgentActionCard.tsx`
- `hooks/useUndo.ts`
- `contexts/ProjectAgentContext.tsx`（或 components 内）

### 大改

- `backend/src/services/ai/agent_service.ts`
- `backend/src/schemas/agent.ts`
- `backend/src/routes/assistant.ts`
- `backend/src/routes/creative.ts`
- `backend/src/services/prompts.ts`（或委托 registry）
- `components/AgentAssistant.tsx`（重构或薄包装）
- `pages/ProjectLayout.tsx`
- `pages/StoryEditor.tsx`
- `pages/ProjectSettings.tsx`
- `services/api.ts`
- `types.ts`, `locales.ts`
- `components/Director/DirectorRightPanel.tsx`

---

## 12. 验收标准

1. 本地 Ollama 下，在任意项目页打开全局 Agent，能对话并规划多步 actions
2. Action Card：重命名/移动/删除章节需确认后生效；删除有二次警示
3. StoryEditor 续写：注入下一章 summary 负向约束 + 前文分层记忆；可写回 condensed
4. 一致性检查返回 severity 列表；定稿影响可更新角色/术语表
5. Skill 通过对话或按钮可改写当前章内容，Undo 可撤销
6. 现有分镜/生图/导演路径不回归；契约测试路由列表更新

---

## 13. 实施顺序

先 Phase 1 后端（可测）→ Phase 2 UI Agent → Phase 3 编辑器 → Phase 4 bible/glossary → Phase 5 验证与文档同步。
