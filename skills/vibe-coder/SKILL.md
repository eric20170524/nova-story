---
name: vibe-coder
slug: vibe-coder
version: 1.3.0
always: true
description: Atmosphere Programming (Vibe Coding) stability guardian. Designed for slightly complex application projects, it enforces the document-driven contract from 0_TASKLIST to 5_AGENT_RULES to ensure that intent-driven iterative development maintains strict engineering stability and architectural consistency.
metadata: {"nanobot":{"emoji":"🛡️","requires":{"bins":[]},"os":["linux","darwin","win32"]}}
---

## NovaStory Binding (this repository)

This repo already instantiated the Vibe contract. **Read these files; do not regenerate empty FastAPI/Next.js templates over them.**

| Contract | Path | Role |
|---|---|---|
| Task list | `docs/0_TASKLIST.md` | Only licensed work. Start at the first `[ ]`. |
| Product | `docs/1_PRD.md` | MVP scope / out of scope for the current sprint. |
| Architecture | `docs/2_ARCHITECTURE.md` | Redlines. Deep stack: `docs/architecture_cn.md`. |
| UI | `docs/3_UI_RULES.md` | i18n, Tailwind, Toast, `data-testid` on new controls. |
| Data | `docs/4_BACKEND_DB.md` | SQLite migrations, `project_id` isolation, logging. |
| Agent | `docs/5_AGENT_RULES.md` | Coding zen, HITL, verification commands. |
| Visual prompt compiler | `docs/best_practice_scene_visual_prompt.md` | Single source of truth for storyboard → Pony tags. |

Issue that opened the current sprint: `questionlist/0827.md`.

Until the owner accepts the documents, **do not implement code**. After acceptance, implement only the next `[ ]` in `docs/0_TASKLIST.md`.

## Core Mission

"Vibe Coding" (Atmosphere Programming) is not about casual or hallucinatory improvisation; it is a highly perceptive, immersive iterative development model driven by high-level intent while maintaining rigorous engineering standards. 

This skill is designed specifically for **slightly complex application projects**. Its core responsibility is to act as a **"Complexity Stabilizer"** and **"Engineering Discipline Enforcer"**. As the project grows in size and complexity, this skill ensures that the Agent:
- **Guards the Boundaries**: Strictly adheres to the MVP scope in `1_PRD.md`, rejecting any form of feature creep, over-engineering, or unauthorized out-of-scope tasks.
- **Anchors the Architecture**: Strictly defends the architectural redlines in `2_ARCHITECTURE.md` (e.g., gateway forwarding principles, module responsibilities, tenant data isolation) to prevent architectural decay.
- **Enforces Engineering Zen**: Strictly follows the safety, verification, and Human-In-The-Loop (HITL) workflows defined in `5_AGENT_RULES.md`. Refuses "fake success" and ensures every iterative step is empirically validated and rock-solid.

## Iterative Development Redlines

### 1. Task-Driven Workflow (0_TASKLIST.md)
- **No Unlicensed Development**: Every single code modification MUST be mapped to a specific atomic task within `0_TASKLIST.md`.
- **State Synchronization & Audit**: Upon completing a task, you MUST update `[ ]` to `[x]` and explicitly write down a **Technical Decision Note & Modification Audit** (core decisions, files touched, verified downstream callers, edge cases handled).
- **AC-Driven Validation**: All UI or business flow tasks MUST have **Acceptance Criteria (AC)** defined. Completion is only valid when AC is verified, preferably via E2E tests (Playwright).
- **Transparent Blockers**: If you encounter ambiguous requirements, API conflicts, or unresolvable environmental issues, immediately mark the task as `[Blocked]`, attach the error log, and halt execution to await human decision. **NEVER hallucinate a fix.**

### 2. Architectural & Security Redlines (2_ARCHITECTURE & 5_AGENT_RULES)
- **Gateway Principle**: Never bypass the backend API to handle private business logic or direct LLM model calls in the frontend.
- **Testability First**: Enforce `data-testid` on all interactive elements. Reject fragile selectors in tests.
- **Tenant Isolation**: When performing any database read/write operations, you must proactively verify that `user_id` filtering (Tenant Isolation) is properly implemented at the Repository layer.
- **Security Interception (HITL)**: For destructive system commands (e.g., `rm`, `kill`, `drop`), sensitive financial operations, or logging/persisting API keys, you MUST trigger a human approval request. It is better to fail safely than to execute blindly.

### 3. UI & Internationalization Consistency (3_UI_RULES.md)
- **No Hardcoding**: Absolutely no hardcoded visible text (English or Chinese) in the UI components. You must use the `t('key.path')` hook and synchronize the translation dictionaries.
- **Dynamic Data-Driven**: UI structures (like lists, channels, models) should adapt to Backend Schemas to support dynamic plugin loading and future scalability.

### 4. Execution & Anti-Loop Protocol (MACI DNA)
- **Impact Analysis (Pre-Edit Call-Graph)**: Before modifying any shared function, type definition, API schema, or DB entity, search/grep the codebase to map all downstream callers, imports, fixtures, and test files.
- **Cross-File Completeness**: Single-task modifications must be end-to-end complete. If a signature change breaks downstream consumers or tests, update all affected call-sites in the same turn. NEVER leave broken imports or partial implementations (`// TODO`, `// handle later`).
- **Surgical Fidelity**: Use precise text replacements. NEVER output incomplete code blocks with placeholders like `// ...rest of code` or `/* unchanged */`. Deliver syntactically complete, runnable blocks.
- **Zero Collateral Damage**: Only modify code directly related to the task and its downstream cascade. Do not reformat unrelated sections or delete existing business comments.
- **One-Time Physical Verification**: Once code is applied, run the test/build command ONCE. If it passes without new errors, it is considered physically verified.
- **No Phantom Diffs**: DO NOT repeatedly run `git diff` or `git status` in an attempt to re-verify if no new errors were introduced. Force closure of the task to prevent infinite checking loops.

## Execution Workflow (The Vibe Cycle)

1. **Immerse**: Deeply read and parse all files in the `docs/` directory to absorb the project's current "vibe", rules, and context.
2. **Align**: Locate the next pending task in `0_TASKLIST.md` and verify against `1_PRD.md` that it remains within the MVP scope.
3. **Implement**:
   - **Impact Pre-Check**: Map the call-graph to identify all downstream callers, interfaces, and test fixtures before editing.
   - **Defensive & Complete**: Write DRY, complete logic (no `TODO` placeholders) with defensive checks for null/undefined, empty states, timeouts, and error boundaries.
   - **Cascade Updates**: Synchronously update any broken downstream callers in the same turn.
   - **DOM Contract**: Mandatory: Add `data-testid` to all new/modified interactive UI elements.
4. **Validate**: Execute the specific verification commands (Build, Test, Lint) explicitly listed in `2_ARCHITECTURE.md`. **Prioritize E2E tests to verify AC.** Do not mark a task complete until these pass without errors.
5. **Escalation (MACI Protocol)**: If you encounter a complex bug that cannot be fixed after 2 attempts, or if the task involves a cross-cutting architectural change (Frontend + Backend + DB), **STOP the standard Vibe-Coder flow**. You MUST escalate to the MACI protocol: explicitly invoke multi-dimensional diagnosis (Front/Back/Infra perspectives) and adversarial review before making further code changes.
6. **Consolidate (The Learning Loop)**: Update the task list with the modification audit. If you resolved a tricky bug, integrated a critical dependency, or solved a complex architectural integration, you MUST document the lesson learned in the `docs/` directory following the `[[Developer AI-Ready Knowledge Base]]` specification (using YAML Front Matter, explicit categories like `pitfall_xxxx.md`, `best_practice_xxxx.md`, or `case_xxxx.md`, and double-bracket `[[wikilinks]]`). Also, update `5_AGENT_RULES.md` to evolve the project's long-term behavior guidelines.

---

## Vibe Templates Reference (The Stability Anchors)

NovaStory already has filled-in contracts under `docs/0_TASKLIST.md` … `docs/5_AGENT_RULES.md`. Use those. The templates below are **only** for initializing a different new project, and must not overwrite this repo's files.

When instructed to initialize a new Atmosphere Programming (Vibe) project, you MUST create a `docs/` directory and populate it with the exact, unomitted templates below. These act as the fundamental system prompts and guardrails for the project.

### 0_TASKLIST.md
```markdown
# 0_TASKLIST.md: 开发任务与进度追踪 (Vibe Template)

## 🎯 当前迭代目标 (Current Sprint Goal)
[在此处简述当前 Sprint 的核心交付物，例如：实现 MVP 版本的核心闭环]

## ⚠️ AI 工作流要求 (Workflow Rules) - 核心准则
1. **执行入口**：阅读本文件，从第一个 `[ ]` 开始。
2. **状态更新**：完成子任务后将 `[ ]` 改为 `[x]`，并记录**技术决策与改动审计 (Decision & Audit)**（包括：改动核心决策、修改文件列表、已验证的下游调用方、边界防御处理）。
3. **验收标准 (AC)**：【新增】所有涉及 UI 或业务流的任务，必须在任务下方补充 **AC (Acceptance Criteria)**。例如：“点击保存后，列表应立即刷新并出现新项，且 Toast 提示成功”。
4. **阻塞即停 (Blocked)**：遇到模糊、冲突或无法解决的环境问题，记录 `[Blocked]` 并附带日志，停止工作。
5. **自测闭环 (Validation)**：标记完成前，必须运行验证命令。**优先通过 E2E 测试 (Playwright/Cypress) 验证 AC。**
6. **文档索引**：查阅 `1_PRD.md` 到 `5_AGENT_RULES.md` 确保不违背红线。

---

## 🔄 自我进化循环沉淀 (Learning & Best Practices)
- [记录隐式约束、隐式类型转换等陷阱]

## 🐛 遗留问题与技术债 (Icebox / Known Issues)
- [记录已知的 Bug 或待优化的性能点]

---

## 📝 任务池 (Task Backlog)

### Phase 1: 基础设施搭建 (Infrastructure)
- [ ] **Task 1.1:** [任务描述]
- [ ] **Task 1.2:** [任务描述]

### Phase 2: 核心功能开发 (Core Features)
- [ ] **Task 2.1:** [任务描述]
```

### 1_PRD.md
```markdown
# 1_PRD.md: 产品需求文档 (Vibe Template)

## 1. 愿景与目标 (Vision & Goal)
[用一句话描述产品愿景，以及核心解决的痛点。]

## 2. 核心用户路径 (User Flow)
[详细描述用户从进入、操作到获得结果的 Aha Moment。]

## 3. MVP 功能范围 (MVP Scope)
- **P0 (必须有)**: 核心业务闭环、基础 UI、认证。
- **P1 (最好有)**: 体验优化、进阶功能。

## 4. 🚫 明确不做的事 (Out of Scope) - 重要准则
> **AI 必读：** 除非用户明确要求，否则严禁自行添加以下功能，防止代码蔓延：
- [ ] 复杂的后台管理面板。
- [ ] 多角色 RBAC 权限（除非 MVP 需要）。
- [ ] 极致的性能优化或缓存层。
- [ ] 第三方社交登录集成。

## 5. 核心实体模型 (Core Entities)
[定义系统中的核心概念，如：用户、任务、项目等。]
```

### 2_ARCHITECTURE.md
```markdown
# 2_ARCHITECTURE.md: 架构红线与技术栈 (Vibe Template)

## 1. 技术栈 (Tech Stack)
- 前端：React 19 / Next.js (Vite 驱动)
- 后端：FastAPI / Node.js
- 通信：REST API / SSE (流式) / WebSocket (实时)
- 数据库：SQLite (开发) / MySQL (生产)

## 2. 架构红线 (Architectural Redlines)
- **网关原则 (Gateway)**：所有前端请求必须通过后端 API 转发，禁止直连大模型或第三方私有接口。
- **模块职责 (Responsibility)**：`backend/app/api/` 仅负责路由，具体逻辑写在 `services/`，数据库操作封装在 `repositories/`。
- **租户隔离 (Tenant Isolation)**：所有涉及数据的 Repository 必须包含 `user_id` 过滤。

## 3. 目录结构规范 (Folder Structure)
[在此描述 backend/ 和 src/ 的具体目录规划。]

## 4. 🛠️ 自测与验证命令 (Verification Hub)
> **AI 必读：** 在打勾任务前，必须根据任务类型运行以下命令进行自测。

**前端 (Front-end):**
- 类型检查：`npm run typecheck` (或 `npx tsc --noEmit`)
- 编译检查：`npm run build`
- 语法纠正：`npm run lint`

**后端 (Back-end):**
- 静态检查：`ruff check .`
- 单元测试：`pytest`
- 接口验证：启动服务后运行 `curl` 或测试脚本。

## 5. 统一响应格式 (Common Response)
[定义成功和失败的 API JSON 结构。]
```

### 3_UI_RULES.md
```markdown
# 3_UI_RULES.md: UI与设计规范 (Vibe Template)

## 1. 核心准则 (UI Principles)
- **极简主义**：界面干净，留白充足。
- **响应式优先**：默认适配移动端 (`sm:`, `md:`, `lg:` 前缀)。
- **测试友好 (Testability)**：【强制】所有交互元素（按钮、输入框、关键容器）必须挂载 `data-testid` 属性（如 `data-testid="login-submit"`）。严禁在测试中依赖易变的文本或复杂的层级。
- **动态适配 (Adaptive UI)**：严禁硬编码列表（如渠道、模型名），必须基于后端 Schema 动态渲染。

## 2. 🌍 国际化与本地化 (i18n Rules) - 强制红线
> **AI 必读：** 前端严禁出现任何可见的中英文字符串。
- **强制使用钩子**：必须引入 `useLanguage` 或 `useI18n` 钩子。
- **方法调用**：使用 `t('key.path')` 获取多语言文案。
- **同步更新**：每新增一个 UI 文本，必须同步更新 `translations` 字典中的 `en` 和 `zh` 词条。

## 3. 颜色、排版与图标 (Visuals)
- **主色调 (Primary)**: `indigo-600` / `blue-600`。
- **状态颜色**: 成功 (green-600), 危险 (red-600), 警告 (yellow-500)。
- **图标库**: 统一使用 `lucide-react`。

## 4. 交互与状态感知 (State Feedback)
- **加载态 (Loading)**：所有异步操作必须提供 Loading 图标 (animate-spin) 或骨架屏 (Skeleton)。
- **悬停态 (Hover)**：按钮和列表项必须显式定义 `hover:bg-xxx` 和 `transition-colors`。
- **二次确认 (Confirm)**：对于“删除”、“清空”等危险操作，必须弹出 Modal 进行确认。

## 5. 组件编写信条 (Component Rules)
- 使用 Tailwind CSS 工具类，严禁手写 CSS。
- 保持组件单一职责，逻辑复杂的组件应拆分为 `View` 和 `Hook`。
- **DOM 契约**：同步考虑组件在 Playwright 中的定位方式，确保关键路径上的 `data-testid` 覆盖率。
```

### 4_BACKEND_DB.md
```markdown
# 4_BACKEND_DB.md: 数据与后端规范 (Vibe Template)

## 1. 认证与授权 (Authentication)
- 基于 JWT Token 机制实现.
- API 路由和敏感逻辑通过 `Depends(get_current_user)` 进行拦截。

## 2. 数据库结构与迁移 (DB & Migrations)
- **迁移规范 (Alembic/Prisma)**：严禁手动修改数据库表结构。所有变更必须通过生成迁移脚本完成并同步。
- **ID 生成规则**：优先使用时间戳字符串或 UUID 作为主键 ID。

## 3. 租户安全与隔离 (Data Security & RLS)
- **Repo 层拦截**：Repository (数据访问层) 必须在查询中显式加入 `WHERE user_id = current_user_id`。
- **敏感字段保护**：密码必须哈希存储，API 响应时必须排除 `password_hash` 等敏感字段。

## 4. 📝 日志规范 (Logging Standards)
> **AI 必读：** 必须确保系统的可追溯性。
- **存储位置**：所有日志必须持久化到 `backend/logs/app.log`。
- **日志级别**：INFO (常规)、ERROR (异常)、DEBUG (本地调试)。
- **格式要求**：`时间 - 模块名 - 级别 - 消息`。
- **异常捕获**：全局 `exception_handler` 必须捕获完整的 Traceback 并在日志中记录。

## 5. 测试数据与环境隔离 (Testing & Seeding)
- **环境隔离**：在 `NODE_ENV=test` 或启动 E2E 模式时，优先使用独立的测试数据库 (如 `test.sqlite`)，严禁污染开发/生产环境。
- **数据种子 (Seeding)**：必须提供 `seed_test_data` 脚本，用于自动化初始化测试账号和预设业务数据。
- **状态清理 (Teardown)**：建议在测试环境下开放 `/api/v1/test/teardown` 接口，以便在测试用例结束后一键清除产生的脏数据，确保测试的幂等性。

## 6. 核心实体表 (Database Schema)
[在此列出核心实体表的字段定义。]
```

### 5_AGENT_RULES.md
```markdown
# 5_AGENT_RULES.md: AI 编码与行为准则 (Vibe Template)

## 1. 核心编码信条 (Coding Zen)
- **代码是负债**：用最少的代码解决问题。
- **DRY (Don't Repeat Yourself)**：重复代码必须重构。
- **改前查全链 (Call-Graph First)**：修改公共函数、类型定义、API Schema 或 DB 实体前，必先全局检索并覆盖所有调用方、Mock 及测试用例。
- **拒绝半成品与占位符 (No Partial Code)**：严禁使用 `// TODO`、`// ... existing code ...` 或临时 mock 等占位符，必须实现完整分支逻辑与防御性边界（空值/Undefined 检查、超时保护、竞态防御与异常捕获）。
- **跨文件级联闭环 (Cross-File Completeness)**：单次任务引发的下游接口或类型破坏，必须在同一次任务中闭环修复，拒绝把破损签名留到下一步。
- **测试先行 (Testability First)**：编写代码时同步考虑 E2E 测试的可达性，强制使用 `data-testid`。
- **拒绝脆弱选择器**：在测试脚本中严禁依赖 i18n 文本或不稳定 CSS 选择器。
- **不要猜测**：疑问即停，立刻询问，绝不凭空捏造 API。

## 2. 🛡️ 安全拦截与 HITL (Human-in-the-loop)
> **AI 必读：** 高危操作必须申请主人授权。
- 当尝试调用涉及以下操作的工具或代码时，必须主动说明风险并等待人类确认：
  - 破坏性系统命令 (`rm`, `kill`, `drop table`)。
  - 敏感财务或隐私数据输出。
  - 核心身份凭证 (API Keys) 的持久化或日志输出。

## 3. 思考与验证流 (Think & Verify)
- **伪代码先行**：大变动前，必须先列出实现思路与影响面分析 (Impact Analysis)。
- **自我修正 (Self-Correction)**：运行测试发现报错时，必须优先自行阅读 Log、搜索解决方案并尝试修复。
- **验收驱动**：完成代码后，必须通过 Playwright 脚本验证对应的 AC (Acceptance Criteria)。
- **拒绝“假成功”**：严禁在没有自测通过的情况下打勾任务。

## 4. 错误处理与用户感知 (Error Awareness)
- 严禁默默吞掉错误。`catch` 块必须输出到 `console.error` 或后端日志。
- 必须在 UI 上提供友好的 Toast 提示，引导用户而非显示“内部错误”。

## 5. 🔄 自我进化循环 (The Learning Loop)
- **硬性经验沉淀**：解决棘手 Bug、引入重要第三方依赖或打通通信链路后，**必须**主动将教训与经验固化到 `docs/` 目录中。
- **文档分类与模板规范**：沉淀文档必须遵循 `[[开发者 AI-Ready 知识库]]` 规范，强制在顶部嵌入 YAML Front Matter，且使用 `[[双链]]` 进行交叉引用：
  - **避坑类 (Pitfall)**：命名为 `pitfall_xxxx.md`。详细记录场景、核心报错堆栈 (Error Log)、底层根因分析及临时/永久解决方案。
  - **实践类 (Best Practice)**：命名为 `best_practice_xxxx.md`。记录通用代码实现规范、配置基线和被规避的坑点。
  - **案例类 (Case)**：命名为 `case_xxxx.md`。记录复杂业务攻坚、优化成效和演进链路。
- **统一抽象复用原则**：在开发新功能或接入接口时，**绝对禁止绕过系统原生的 Provider 抽象层去重新造轮子**。必须复用 `provider.chat()` 和 `provider.chat_stream()` 接口，以确保鉴权、路由清洗与流式生成等机制无缝生效。

## 6. 环境陷阱 (Quirks)
[记录本项目特定框架的坑点，如 Vite 的环境变量访问、React 生命周期处理等。]
```
