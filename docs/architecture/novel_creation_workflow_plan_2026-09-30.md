# 小说故事构思开书与章节规划方案

核查日期：2026-09-30。范围为 NovaStory 小说故事页面的构思开书、自动创建新章、修改与扩展章节规划。本轮交付代码核查、设计和前后端任务说明；文中的新增接口与代码骨架尚未接入应用。

建议在现有 Agent OS 内补齐“构思对话 → 开书设定候选 → 章节规划候选 → 采纳 → 按规划创建下一章”流程。未来规划与实际章节分开保存，继续保持上一章定稿后才创建下一实际章节的规则。LLM 负责提议；ID、章节顺序、采纳范围、幂等和写入由服务端决定。

实施包：

- [后端任务与核心代码](./novel_creation_backend_tasks_2026-09-30.md)
- [前端任务与核心代码](./novel_creation_frontend_tasks_2026-09-30.md)
- [唯一任务状态入口](../0_TASKLIST.md)，对应 Track 4 的 BE-C2/C3/C4/C6、FE-C2/C3/C4。本文和任务说明不另维护完成状态。

## 1 当前代码的核查结论

核查基于本轮实际工作区，HEAD 为 `40b4a41`。旧文档的未完成标记没有用于推断代码状态；本次交付只修改设计和任务文档。

| 用户要的能力 | NovaStory 当前代码 | 缺少的闭环 |
| --- | --- | --- |
| 与 Agent OS 交流构思开书 | 项目聊天面板、开书提示词、项目设定与角色术语 CRUD 已有 | 专门构思模式、连续对话上下文、结构化设定候选及采纳 |
| 自动创建新章 | StoryEditor 和 `POST /chapters/` 可手动创建空章；前后端检查最后一章 completed | 根据已采纳规划创建有标题和章纲的下一章；服务端分配顺序；重试去重 |
| 修改章节规划 | 手工 summary 编辑、`UPDATE_CHAPTER_SUMMARY` 写库已有 | 将自然语言修改指令转换为新章纲，正确选中目标，展示差异 |
| 扩展章节规划 | `structure_extend` 提示词已有 | 生成服务、类型校验、规划存储、候选采纳、UI 入口 |

关键证据：

1. [prompt_registry.ts:137](/Users/lm/pyProj/nova-story/backend/src/services/ai/prompt_registry.ts:137) 已有 `brainstorm_chat`、`structure_novel_gen`、`structure_volume_gen`、`structure_extend`。检索业务代码，四个键只有声明和模板，尚无调用服务。模板在仓库不代表功能已接通。
2. [agent_service.ts:113](/Users/lm/pyProj/nova-story/backend/src/services/ai/agent_service.ts:113) 的普通问答生成只传当前消息；项目外聊天同样没有传历史。路由得到的近四轮、每轮 120 字只用于决定意图，不能承担构思记忆。
3. [ProjectAgentPanel.tsx:142](/Users/lm/pyProj/nova-story/components/agent/ProjectAgentPanel.tsx:142) 已在 sessionStorage 保存最近聊天，发送最近十轮；可复用面板和缓存，需修正服务端使用方式与模式隔离。
4. [StoryEditor.tsx:236](/Users/lm/pyProj/nova-story/pages/StoryEditor.tsx:236) 创建空章；[chapters.ts:37](/Users/lm/pyProj/nova-story/backend/src/routes/chapters.ts:37) 有逐章定稿限制。直接套用 DreamWaver 的“先创建十个 pending 章节”与此规则冲突。
5. [agent_os.ts:308](/Users/lm/pyProj/nova-story/backend/src/schemas/agent_os.ts:308) 把 `UPDATE_CHAPTER_SUMMARY` 的 `focus` 原样设为 `newSummary`；[agent_executor.ts:401](/Users/lm/pyProj/nova-story/backend/src/services/ai/agent_executor.ts:401) 随后直接写入。自然语言“增加一段追逐”不能作为最终章纲。
6. [script_service.ts:930](/Users/lm/pyProj/nova-story/backend/src/services/script_service.ts:930) 已有候选、revision、来源快照和事务应用的实现模式，可借鉴其设计；小说使用自己的记录与校验，不复用剧本文档内容。
7. 本轮此前完成的定稿同步已更新角色、术语、主线时间线与关系。新规划必须保留 `chapter_impact_entries`，把计划中的未来事件与定稿事实分别注入模型。

### 本次验证证据

| 检查 | 结果与边界 |
| --- | --- |
| 前端、后端 typecheck | 当前工作区均通过 |
| 定向基线测试 | `agent_executor.test.ts`、`agent_os.test.ts`、`chapters.test.ts`、`chapter_impact.test.ts`，25 项通过 |
| 路由探针 | “交流构思一本悬疑小说”“自动创建下一章”“扩展后续五章规划”均没有快捷意图；现有 intent 枚举没有对应新能力 |
| 摘要探针 | 强制 `UPDATE_CHAPTER_SUMMARY` 后，`newSummary` 等于修改指令原句，确认语义缺口 |
| 文档与核心示例 | 14 段 TypeScript 语法检查、29 个本地链接和 SQL 草案通过；内存 SQLite 验证精确修订/越界拒绝、首章创建、请求重放/载荷冲突、已有绑定、定稿门槛及预登记自动请求消费。示例中的业务适配层仍待实现 |
| 模型与 UI | 本轮未用真实模型评估三项新增功能，也未把设计稿当成已实现的浏览器验收 |

## 2 DreamWaverAI 值得复用的部分

| 参考代码 | 可复用的机制 | NovaStory 适配点 |
| --- | --- | --- |
| [chatService.ts:10](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/chatService.ts:10) | 历史对话整理，`brainstorm_chat` 引导四项创意要素 | 在 Fastify 服务端调用现有 Provider，传入整理后的真实对话 |
| [SetupChat.tsx:78](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/components/SetupChat.tsx:78) | 聊天与“整理为开书设定”分开 | 复用 ProjectAgentPanel，结果落为候选卡 |
| [structureService.ts:10](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/structureService.ts:10) | 对话 → 标题、类型、风格、主线、关系、角色、术语 | 替换 Nebula 调用与手工 JSON 解析，使用现有 `LLMService.generateStructuredWithRetry` + Zod |
| [SetupOutline.tsx:35](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/components/SetupOutline.tsx:35) | 编辑设定、篇幅参数、等待生成与保存完成 | 拆成设定采纳、章纲采纳、首章创建；服务端稳定 ID 与唯一约束 |
| [structureService.ts:52](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/structureService.ts:52) | 从设定生成标题和概要；初始化目标字数 | 扁平规划条目，暂不实体化全部章节 |
| [structureService.ts:110](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/structureService.ts:110) | 按预估篇幅计算阶段；扩展后保留悬念或收束 | 基于真实正文断点及现有未来规划；95% 阈值只作参考，结局策略以作者选择为准 |
| [WritingPhase.tsx:208](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/components/WritingPhase.tsx:208) | 扩展结果追加到现有结构 | 候选差异、版本检查和一次事务追加规划 |
| [agent/scripts/structure.ts:29](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/agent/scripts/structure.ts:29) | 按稳定 ID 更新指定条目，找不到就报错 | 保留这一思路；服务端验证目标属于当前项目和请求范围 |

参考项目有三点必须调整：

- `extendNovelStructure` 实际只把最后一章标题传入 `lastChapterContext`，并没有传正文结尾。NovaStory 应加入最后有效定稿摘要、正文结尾、角色状态和未回收伏笔；同时把尚未写的规划标为未来计划。
- `Date.now()` 拼接章节 ID 和保留同一 Novel ID，只能降低部分前端重复问题。服务端还需要请求键、唯一约束和事务。
- 参考的默认总章数 100、分卷结构、硬编码模型名与客户端 Nebula 调用不适合直接移植。沿用 NovaStory 的扁平章节、项目配置和 Provider。

后端任务文档包含原始代码摘录及改写后的生成、范围校验和建章骨架；前端任务文档包含原始 UI 摘录及与现有 Agent 面板的接线方式。

## 3 推荐的产品流程

### 3.1 构思开书

沿用 Dashboard 创建 project 并进入 `/project/:id/story`。空项目显示“和 Agent 构思”“填写初始设定”“规划前几章”。同一 Agent 面板增加“构思 / 创作指令”模式。

构思阶段每轮聚焦一至两个问题，逐步明确类型、核心冲突、主角、世界规则。作者已有完整创意时允许直接整理设定；不强制聊满若干轮。聊天本身不写入正式人物或主线。

“整理开书设定”生成可编辑候选，包含标题、类型、文风、故事梗概、未来剧情方向、初始人物关系、角色和术语。候选首次生成后已持久化，刷新仍能继续审核。采纳时明确展示哪些项目字段和角色术语会变化。

初始固定设定进入现有项目设定与角色术语；未来剧情方向、角色成长和关系发展保存在规划文档中。已有故事重新构思时默认更新规划，正式资料的改动需在候选中明确列出。

### 3.2 首批规划和自动新章

采纳开书设定后，默认生成 3 章规划，可选择 1–5 章。每条规划包含标题、核心事件、冲突与结尾悬念组成的概要、目标字数。全部是可提前编辑的未来规划。

“开始第一章”或“创建下一章”直接使用已采纳规划：服务端生成章节 ID 和 index，写入标题、summary、目标字数，正文为空、状态 draft，并返回 chapterId。界面进入该章。已采纳的标题章纲不再重新请求模型。

没有下一条规划时，返回明确的 `NO_PENDING_PLAN`，界面提供“规划下一章”或“扩展 3 章”；生成候选采纳后继续创建。此处生成的是章纲；正文由现有“按章纲起草”入口负责。

提供默认关闭的“本章定稿后自动创建下一章”选项。开启后，定稿提交成功才尝试从已采纳规划创建一章；同一章、同一正文版本最多触发一次。后续建章失败单独展示，已成功的定稿不回滚。规划耗尽时停在“需要补充规划”，由作者决定扩展内容。

### 3.3 修改与扩展规划

- **修改**：选中一条或一组规划，输入要求，生成 before/after 差异。默认保留目标条目的 ID 与顺序，仅改标题、概要、目标字数。默认保护已定稿的实际章节；修改正在写的章纲不改正文，同时标记正文与规划可能不一致。
- **扩展**：选择追加数量、篇幅预算和剧情方向。只追加到现有规划末尾；上下文同时包含实际故事断点与已采纳的未来规划尾部，防止反复生成同一段情节。
- **重排/删除**：沿用现有手工入口并同步规划关联，旧候选变为过期。首期 AI 规划动作只做初始化、指定条目改写、尾部追加。

## 4 数据与状态设计

### 4.1 选择两张规划表

| 方案 | 对当前工程的影响 | 判断 |
| --- | --- | --- |
| 直接提前创建 chapter | 已有列表可复用，但会把未来章变成实际末章，与上一章定稿门槛冲突；还需重做实际状态判断 | 不选 |
| 全部放进 project.settings | 迁移较少，但大型设定 JSON 与候选、版本及请求回执混在一起，现有多入口设置更新容易互相覆盖 | 仅适合小型创意备注 |
| 独立规划文档 + 候选/回执表 | 增加两张表和同步边界，可借鉴已有剧本候选模式，保持实际章语义 | 本轮推荐 |

建议增加 `story_plan` 和 `story_plan_change`，参考当前 `chapter_script` / `script_change` 的生命周期。有限篇幅、扁平结构适合把规划作为一个有版本的 JSON 文档；暂不需要分卷表或逐条复杂关系表。

| 存储 | 责任 |
| --- | --- |
| `story_plan` | 每项目一份已采纳规划；`revision`、`document_json`、时间戳 |
| `story_plan_change` | 生成中的请求、待采纳候选、手工规划保存、建章请求回执；请求键及哈希、来源快照、base/candidate revision、before/after/result、状态 |
| `chapter.plan_entry_id` | 实际章节与规划条目的唯一关联；`UNIQUE(project_id, plan_entry_id)` |
| `chapter.target_word_count` | 建章时继承规划，供当前写作服务读取 |
| `chapter.finalized_content_hash` | 定稿成功时绑定正文，创建下一章时验证定稿仍有效 |

规划条目 ID 由服务端生成，模型只生成内容。`chapterId`、当前写作状态由 GET 时关联实际 chapter 后投影，不在规划 JSON 内维护第二份生命周期。

当前未实现通用 `creative_change` 表，不能把旧文档里这个名称当成可调用基础设施。如果未来通用候选服务落地，可以抽公共事务/回执代码；本轮先完成小说规划自身的最小闭环。

### 4.2 事实与计划的归属

| 内容 | 权威存储与使用规则 |
| --- | --- |
| 正文 | `chapter.content` |
| 已实体化章节的章纲 | `chapter.summary`；编辑服务同时更新关联规划并增加 plan revision |
| 尚未实体化章节的章纲 | `story_plan.document_json.chapters` |
| 定稿时间线、状态、关系 | 现有 `settings.main_plot`、`character_relations`、`chapter_impact_entries` |
| 未来结局、情节走向、人物成长 | `story_plan.document_json.blueprint`，Prompt 标明是计划 |
| 正文浓缩 | 现有 `condensed_content`；新规划服务仅将有可靠来源关联的版本当成事实，否则使用当前正文结尾 |

开书采纳的字段映射：title/summary → project 标题与简介；genre/style → settings；角色身份/性格、初始关系及术语 → 对应正式库的获选初始设定。未来 mainPlot、growthPath、关系演变 → blueprint。当前主线时间线不作为未来规划的覆盖目标。项目设置可从规划区查看未来方向，避免让两份可编辑全文相互覆盖。

### 4.3 现有功能的必要接缝

1. `UPDATE_CHAPTER_SUMMARY` 保留“写入明确的新摘要”语义；“帮我修改章纲”走 `PLAN_CHAPTERS(mode=revise)`，保留完整 instructions。
2. 手工 PATCH summary/title、Agent 修改章纲、重命名/移动/删除已关联章节，统一经过服务同步规划关联与 revision。不能出现 UI 改了章纲但下一轮规划仍读旧 JSON。
3. `layered_context` 当前只从实际 chapter 找下一章。规划分离后，写当前章时必须从相邻计划条目取得下一章概要，继续执行禁止剧情抢跑的负约束。
4. 创建下一章检查 `completed` 和正文哈希匹配。当前 PATCH 正文不会自动清除 completed，单看字符串会放过修改后的旧定稿；正文写入口应回到 draft 并清空定稿哈希。历史 completed 缺少哈希时提示重新定稿校准。
5. 手动新建也调用同一建章领域服务，顺序由服务端分配，防止两个标签页都用 `max(index)+1`。手工空白路径可在事务内建立空规划占位；按规划自动建章则必须使用概要完整的已采纳条目。
6. 导出/回导、项目复制和删除同轮覆盖新增规划表与关联 ID。备份范围至少包含已采纳规划及未来条目；待采纳候选可以明确排除，恢复时不伪装仍然可采纳。

## 5 Agent 与 HTTP 契约

维持小 Schema 路由。构思用 `context.conversation_mode='ideation'`；结构化动作只新增三类：

| 动作 | 参数与效果 |
| --- | --- |
| `PLAN_STORY` | `instructions`；生成开书候选，返回 `data.candidate_id` |
| `PLAN_CHAPTERS` | `mode: initial/revise/extend`、`targetPlanIds` 或 `batchSize`、`instructions`；生成章纲候选 |
| `CREATE_NEXT_CHAPTER` | `planEntryId`、预期规划版本、预期实际末章、请求键；从已采纳规划创建实际章节 |

`PLAN_*` 可以由明确的生成请求直接产生候选，不需要先确认一遍“是否生成”；正式采纳在候选卡执行一次。`CREATE_NEXT_CHAPTER` 从已采纳规划发起的显式按钮可以直接创建；聊天里沿用现有执行卡。候选生成不应放进“真正只读查询”名单，应明确归类为 `candidate_only`，防止以后出现隐式正式写入。

现有路由的 `focus` 会截断，不能作为规划指令唯一来源；规划服务取原始 message，目标/数量来自经过校验的 typed args。首次、修订、扩展共用一个生成服务。小说页面匹配“改写第3章规划”优先于通用正文改写与反转关键词；剧本页面仍走现有独立剧本动作。

拟新增接口，均在 `/api/projects/:projectId/story-plan` 下：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /` | 已采纳规划、revision、规划条目与实际章关联 |
| `POST /bootstrap` | 首次启用；从已有章节建立稳定关联，不调用 LLM、不改正文 |
| `POST /candidates` | kind=blueprint/chapters；请求含 mode、范围、instructions、expected_revision、request_key |
| `GET /candidates` | 恢复未结束候选；支持按 request_key 查询未知结果 |
| `PATCH /candidates/:id` | 编辑候选；校验 expected_candidate_revision 后递增 |
| `POST /candidates/:id/apply` | 校验 plan revision、candidate revision、source hash；应用已展示内容 |
| `POST /candidates/:id/reject` | 拒绝候选 |
| `PATCH /` | 手工改已采纳规划；相同版本与审计机制 |
| `POST /next-chapter` | 创建一个实际章节，返回 chapter、plan_revision 和回执 |

构思聊天继续走现有 `/api/assistant/chat`。候选生成和采纳共用领域服务，HTTP 入口与 AgentExecutor 不能各写一套逻辑。

HTTP envelope 使用 snake_case，规划文档内部保持 schema 的 camelCase；Agent 动作参数在入口集中转换。采纳请求用 candidate ID、expected_revision、expected_candidate_revision、selected_patch_ids 固定身份，服务端保存独立 apply_payload_hash；生成 request_key/request_hash 只标识生成请求。完整字段见前后端任务文档。

## 6 可靠性与篇幅策略

**生成与应用分开。** 生成先登记带 request_key 的请求，再在事务外调用模型。模型结果经过结构、数量、目标集合与预算校验后成为 pending 候选。采纳只消费保存的候选，不能再次调模型生成另一版。

**幂等与冲突分开处理。** 同键同请求先返回已有回执；同键不同请求返回 409。新请求才检查 expected_revision。两个标签页同时创建同一规划章节，最终只能有一个 chapter；失败的一方可读取既有绑定。候选过期保留可查看，不能盲目覆盖。

**短事务和独占连接。** SQLite 同时只允许一个写事务；BEGIN 不能在已有事务内再次嵌套。模型调用在锁外完成，应用和建章用 `BEGIN IMMEDIATE`，连接只供该事务使用。不能仅给一个服务加互斥锁、同时让其他写请求继续共用同一连接。[SQLite 事务文档](https://www.sqlite.org/lang_transaction.html)

**上下文只覆盖有用内容。** 已采纳创意要点、当前设定、最近定稿摘要/正文结尾、相关角色关系与伏笔、全部未来条目的短索引，以及要改条目的完整概要。超预算分批，不静默截掉选中的某一章。默认 3 章、单批最多 5 章是首期建议限额，超过时明确要求分批。

**保留有限篇幅约束。** 沿用 Track 4 的 5–10 万字目标和 10 万字正文上限。规划估算使用已完成章实际字数 + 当前草稿的 max(已写字数, 目标字数) + 未写规划的目标字数，避免正文与对应计划重复计数。规划预算检查是前置约束；正式正文的最终上限校验仍由 BE-C1 负责，当前不能宣称全项目写入上限已实现。

**避免机械完结。** 借鉴 DreamWaver 的篇幅进度计算，结局策略由作者设定为继续发展或推进收束。没有预估总章数时根据目标总字数估算；不使用默认 100 章触发任意收尾。

**前端请求绑定来源。** project、plan revision、选中规划 ID 和 candidate revision 在发起时固定。切项目/卸载后忽略旧响应；创建下一章的请求键在重试中保留。写操作放在用户事件处理或一次性的定稿完成服务流程中，避免 React Effect 重挂载触发重复建章。[React Effect 文档](https://react.dev/learn/synchronizing-with-effects)

## 7 实施顺序与责任划分

| 顺序 | 后端 | 前端 | 合并条件 |
| --- | --- | --- | --- |
| 0 契约 | 固定模型、候选、错误码和来源哈希 | 固定模式、卡片、规划行模型与 API 类型 | 三份文档的字段名一致 |
| 1 构思 | 构思历史、PLAN_STORY、候选保存/采纳 | 空状态、构思模式、开书设定卡 | 一句话到可编辑并可恢复的设定候选 |
| 2 规划 | PLAN_CHAPTERS 初始/修订/扩展；范围与预算校验 | 规划列表、选中范围、差异、手工编辑 | 未定稿首章时仍能规划后续章节 |
| 3 建章 | 单入口建章、绑定、去重、有效定稿门槛 | 开始首章、创建下一章、自动选项与结果反馈 | 重复点击和断网重试仍仅创建一章 |
| 4 接缝 | summary/上下文、旧项目、复制/备份兼容 | 脏缓冲、切项目、过期候选、英文中文 | 完整旅程与故障验收通过 |

后端负责所有正式写入与语义约束；前端负责展示候选、收集选择、使用稳定请求键和保护编辑缓冲。完成接口/按钮不能替代整个用户旅程验收。

## 8 验收矩阵

以下是拟实施功能的验收要求，尚未标记通过。

| 编号 | 场景 | 必须满足 |
| --- | --- | --- |
| NC01 | 零章节构思 | 无 activeChapter 也能连续交流；用户最新消息只出现一次；普通聊天不创建人物/章节 |
| NC02 | 整理设定 | 模型失败明确失败；有效候选可编辑、刷新恢复；采纳后设置与角色术语可读 |
| NC03 | 首批规划 | 一次生成所选 1–5 条规划；未写首章也能保存多章规划；尚未批量生成实际 chapter |
| NC04 | 开始写作 | 一次创建第一实际章，标题/概要/字数来自已采纳规划，正文为空 |
| NC05 | 下一章 | 前章定稿且哈希有效才能创建；顺序服务端分配；已创建返回同一章 |
| NC06 | 自动选项 | 默认关闭；开启后每次有效定稿最多创建一章；规划耗尽或建章失败有独立状态 |
| NC07 | 修订范围 | 仅修改选中规划 ID；模型漏项/多项/重复 ID 均拒绝；其他规划、正文和定稿事实不变 |
| NC08 | 扩展承接 | 用实际断点和规划尾部；已有未写规划不重复生成；append 位置不可由模型指定 |
| NC09 | 并发/重试 | 双击、超时重试、两个标签页不会重复建章/重复采纳；同键不同载荷 409 |
| NC10 | 过期与失败 | 正文、设定、候选或规划变化后旧候选不能盲目应用；故障不部分提交 |
| NC11 | 编辑保护 | 切项目旧响应不污染新项目；规划结果不走 applyContent 覆盖正文；脏草稿可保留 |
| NC12 | 上下文/兼容 | 下一未实体化规划仍提供负约束；旧项目、手工章纲、复制及备份关系完整 |
| NC13 | 篇幅 | 预算不重复计数；中期不被强行完结；超过规划批量/总量明确拒绝 |
| NC14 | 真实旅程 | 创意→设定→3条规划→首章写作/定稿→自动下一章→修订第3条→扩展2条→刷新/备份恢复 |

单测验证纯函数，SQLite 集成测试验证约束/事务，浏览器验证模式与切换保护，真实模型仅验收代表性创意和 3–5 章规划质量。分别记录证据，不把测试桩结果写成真实模型质量结论。
