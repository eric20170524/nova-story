# 小说构思与章节规划后端任务和核心代码

配套[总体方案](./novel_creation_workflow_plan_2026-09-30.md)。这是后端实施说明与参考代码，新增表、API、动作及服务尚未实现。代码片段表达拟冻结的契约和关键算法；需要按任务补齐 Fastify 接线、项目归属校验、Repository、来源快照与测试后才能上线。

任务状态仅在 [0_TASKLIST.md](../0_TASKLIST.md) Track 4 维护。本轮负责构思开书、规划初始/修订/扩展、从规划创建下一实际章。

## 1 后端工作包

| 工作包 | 对应任务 | 改动位置 | 交付及验收 |
| --- | --- | --- | --- |
| B1 规划数据与候选基础 | BE-C2/C3 | 新增 `schemas/story_plan.ts`、`services/story_plan_service.ts`、`routes/story_plan.ts`；database.ts/server.ts | 规划、候选、幂等回执、来源快照；GET/编辑/采纳/拒绝；NC02/09/10 |
| B2 构思与开书 | BE-C2 | 新增 `services/ai/story_planning_service.ts`；agent.ts、agent_service.ts、prompt_registry.ts | ideation 历史 + PLAN_STORY；固定事实与未来规划字段分离；NC01/02 |
| B3 三种章纲操作 | BE-C3 | 同一 planning service/schema；LLMService 复用 | initial/revise/extend 的输出校验与局部合并；NC03/07/08/13 |
| B4 Agent 确定性接线 | BE-C4 本轮子集 | agent_os.ts、agent_route.ts、agent_service.ts、agent_executor.ts | 三个新动作、typed args、保留完整指令、候选专用结果；NC01/07 |
| B5 单入口创建下一章 | BE-C6 | story_plan_service.ts、chapters.ts、writing_service.ts | 服务端分配顺序、唯一关联、有效定稿检查、自动模式回执；NC04/05/06/09 |
| B6 兼容与上下文 | BE-C3/C6 | layered_context.ts、writing_service.ts、projects.ts、JSON import/export | 下一规划负约束、summary 同步、旧项目启用、复制/删除/备份；NC10/12 |

数据库/schema/service/API 属于后端；前端只消费已约定 DTO。共享文件 `types.ts`、`services/api.ts`、`locales.ts` 由前端负责，后端先提交 JSON 夹具。迁移编号需在实施时读取最新 migration 尾号，不固定使用本文核查时的下一编号。

## 2 DreamWaverAI 原始复用点

### 2.1 构思上下文

来自 [chatService.ts:10](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/chatService.ts:10)：

```ts
const historyStr = history.map(m =>
  `${m.role === 'user' ? '用户' : 'DreamWeaver'}: ${m.content}`
).join('\n');

const template = await getPrompt('brainstorm_chat');
const prompt = formatPrompt(template, {
  history: historyStr,
  message: newMessage
});
```

复用历史角色映射和模板填充。NovaStory 的 getPrompt 为同步函数，并支持项目 overrides；生成放到服务端现有 Provider。最新用户消息不同时放进 history 和 message。已确认创意要点单独置顶，最近对话按模型预算选择，不能把路由用的 120 字摘要当成完整创意。

### 2.2 对话整理为开书设定

来自 [structureService.ts:10](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/structureService.ts:10)：

```ts
const template = await getPrompt('structure_novel_gen');
const prompt = formatPrompt(template, {
  conversationContext: params.conversationContext
});
```

原函数后续用流式文本累计、parseJSON，再把 title/genre/style/summary/mainPlot/characterRelations/characters/glossary 填进 Novel。这里可复用字段映射，生成结果改为 Zod 校验的 blueprint candidate。模型不返回 projectId、章节 ID、正式状态或 SQL。

### 2.3 篇幅与节奏

来自 [structureService.ts:110](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/services/ai/structureService.ts:110)：

```ts
const currentTotal = novel.volumes.reduce((acc, v) => acc + v.chapters.length, 0);
const totalPlanned = novel.totalEstimatedChapters ||
  (currentTotal + newVolCount * newChCount + 50);
const endOfNewBatch = currentTotal + (newVolCount * newChCount);
const progressPercent = Math.round((endOfNewBatch / totalPlanned) * 100);
const isEnd = progressPercent > 95;
```

借用“进度影响节奏”的计算思路。NovaStory 由目标总字数、已写字数及未来章目标估算进度；收束由明确的 endingPolicy 控制。不能直接带入分卷参数、100 章默认值或“超过 95% 自动完结”。

## 3 数据契约

### 3.1 规划内容与动作

以下为拟放入 `backend/src/schemas/story_plan.ts` 的核心内容。持久化 schema 允许旧章空概要；模型输出使用更严格 schema。角色成长和未来关系属于 blueprint，初始身份和关系另列为固定设定。

```ts
import { z } from 'zod';

export const ChapterPlanFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(3000),
  targetWordCount: z.number().int().min(200).max(10000),
});

export const GeneratedChapterFieldsSchema = ChapterPlanFieldsSchema.extend({
  summary: z.string().trim().min(1).max(3000),
}).strict();

export const PlannedChapterSchema = ChapterPlanFieldsSchema.extend({
  id: z.string().min(1), // 服务端稳定 ID；旧项目 bootstrap 也由服务端分配
}).strict();

export const StoryBlueprintSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre: z.string().max(200),
  style: z.string().max(500),
  summary: z.string().trim().min(1).max(3000),
  mainPlot: z.string().max(6000), // 未来主线，不覆盖定稿时间线
  initialRelations: z.string().max(3000),
  plannedRelations: z.string().max(3000),
  characters: z.array(z.object({
    name: z.string().trim().min(1),
    role: z.enum(['main', 'supporting', 'minor']),
    description: z.string().max(1500),
    personality: z.string().max(1000),
    growthPath: z.string().max(1500), // 仅保存在规划文档
  })).max(20),
  glossary: z.array(z.object({
    term: z.string().trim().min(1),
    definition: z.string().max(1500),
    category: z.string().max(100),
  })).max(30),
}).strict();

export const StoryPlanDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  blueprint: StoryBlueprintSchema.nullable(),
  targetTotalWords: z.number().int().min(50000).max(100000),
  endingPolicy: z.enum(['develop', 'conclude']),
  autoCreateNextChapter: z.boolean().default(false),
  chapters: z.array(PlannedChapterSchema),
}).strict();

export const PlanningActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('PLAN_STORY'), instructions: z.string().min(1) }),
  z.object({
    op: z.literal('PLAN_CHAPTERS'),
    mode: z.enum(['initial', 'revise', 'extend']),
    instructions: z.string().min(1),
    targetPlanIds: z.array(z.string().min(1)).max(5).optional(),
    batchSize: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    op: z.literal('CREATE_NEXT_CHAPTER'),
    planEntryId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    expectedLastChapterId: z.string().nullable(),
    requestKey: z.string().uuid(),
  }),
]);
```

动作进入服务前补充跨字段校验：revise 必须有非空且去重的 targetPlanIds，初始/扩展必须有 batchSize；范围只能属于当前 project 的已采纳规划。用户说“第三章”时先在服务端章序中解析为稳定 ID；无法唯一定位时返回待选择目标，不自动使用当前章。

### 3.2 最小迁移草案

```sql
CREATE TABLE story_plan (
  project_id INTEGER PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE story_plan_change (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES story_plan(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('generating', 'pending', 'applied', 'rejected', 'failed', 'stale')),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_payload_json TEXT,
  base_revision INTEGER NOT NULL,
  candidate_revision INTEGER NOT NULL DEFAULT 1,
  source_snapshot_json TEXT,
  before_json TEXT,
  after_json TEXT,
  patches_json TEXT,
  apply_payload_hash TEXT,
  result_json TEXT,
  error_code TEXT,
  applied_revision INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, request_key)
);

ALTER TABLE chapter ADD COLUMN plan_entry_id TEXT;
ALTER TABLE chapter ADD COLUMN target_word_count INTEGER;
ALTER TABLE chapter ADD COLUMN finalized_content_hash TEXT;
CREATE UNIQUE INDEX ix_chapter_plan_entry
  ON chapter(project_id, plan_entry_id) WHERE plan_entry_id IS NOT NULL;
```

复用 runMigrations 的版本检查与事务；旧库列兼容走 ensureColumns。JSON 内的规划 ID 没有 SQL 外键，服务端必须禁止删除仍被 chapter 引用的规划项。项目复制同时重映射计划条目 ID 和 chapter.plan_entry_id；GET 返回关联 chapterId，而不是把关联再写一份到规划 JSON。

### 3.3 来源快照

候选保存 `planRevision`、有序 targetPlanIds、相关正文原文哈希与摘要/状态、项目创作设定哈希、参与的角色/术语哈希、启用资料的 ID/校验值。哈希使用稳定键排序的序列化，数组保留顺序。

生成完成、编辑候选、采纳候选均校验合法状态。采纳事务内重读来源；来源变化返回 `SOURCE_CHANGED`，保留候选。单独 plan revision 不能检测 chapter PATCH 或项目设定更新。

## 4 生成服务核心代码

### 4.1 连续构思

此骨架复用现有 getPrompt/formatPrompt/Provider。`selectHistoryWithinBudget` 是 B2 必须实现的预算函数：保留完整消息边界，并为最后用户输入及置顶的创作要点预留空间；4500 是可配置预算示例，不是字符数即 token 数。完整服务另返回被省略轮次供 UI 说明。规划候选可持久化；原始对话继续复用现有项目缓存。

```ts
async function brainstormStory(input: {
  message: string;
  history: Array<{ role: 'user' | 'agent'; content: string }>;
  acceptedBrief: string;
  overrides: Partial<Record<PromptKey, string>>;
}): Promise<string> {
  const history = selectHistoryWithinBudget(input.history, 4500)
    .map(m => `${m.role === 'user' ? '用户' : 'NovaStory'}: ${m.content}`)
    .join('\n');
  const prompt = formatPrompt(getPrompt('brainstorm_chat', input.overrides), {
    history: `已确认构思想法：\n${input.acceptedBrief}\n\n${history}`,
    message: input.message,
  });
  const result = await LLMService.getProvider().generateText(prompt);
  const reply = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!reply) throw new PlanningError('MODEL_EMPTY', 502);
  return reply;
}
```

在 AgentService 普通章节动作前识别构思模式，但明确的 PLAN_STORY/PLAN_CHAPTERS 按结构化动作处理。构思模式不要求 chapter_id；普通项目问答的扩展改造不作为这次任务前置条件。

### 4.2 生成与精确范围校验

下例依赖上一节 schema；`ctx` 由服务端从项目资料、规划和实际章节构建，不信任模型提供的状态。

```ts
type PlannedChapter = z.infer<typeof PlannedChapterSchema>;

function mergeGeneratedChapters(
  current: PlannedChapter[],
  mode: 'initial' | 'revise' | 'extend',
  targetIds: string[],
  generated: Array<z.infer<typeof GeneratedChapterFieldsSchema> & { id?: string }>,
  makeId: () => string,
): PlannedChapter[] {
  if (mode === 'initial' && current.length) {
    throw new PlanningError('PLAN_ALREADY_EXISTS', 409);
  }
  if (mode !== 'revise') {
    return [...current, ...generated.map(({ id: ignored, ...fields }) => ({
      ...fields, id: makeId(),
    }))];
  }
  const targets = new Set(targetIds);
  const existing = new Set(current.map(ch => ch.id));
  const resultIds = generated.map(ch => ch.id);
  if (!targets.size || targets.size !== targetIds.length ||
      targetIds.some(id => !existing.has(id)) ||
      generated.length !== targets.size ||
      new Set(resultIds).size !== targets.size ||
      resultIds.some(id => !id || !targets.has(id))) {
    throw new PlanningError('TARGET_SET_MISMATCH', 422);
  }
  const byId = new Map(generated.map(ch => [ch.id!, ch]));
  return current.map(ch => {
    const replacement = byId.get(ch.id);
    return replacement ? { ...ch, ...replacement, id: ch.id } : ch;
  });
}

async function generateChapterPlanCandidate(
  request: PlanGenerationRequest,
  ctx: PlanningContext,
): Promise<PlannedChapter[]> {
  const count = request.mode === 'revise'
    ? request.targetPlanIds.length : request.batchSize;
  const rowSchema = request.mode === 'revise'
    ? GeneratedChapterFieldsSchema.extend({ id: z.string().min(1) }).strict()
    : GeneratedChapterFieldsSchema;
  const responseSchema = z.object({ chapters: z.array(rowSchema).length(count) }).strict();

  const promptKey = request.mode === 'initial' ? 'structure_volume_gen'
    : request.mode === 'extend' ? 'structure_extend' : 'structure_revise';
  const prompt = formatPrompt(getPrompt(promptKey, ctx.overrides), {
    title: ctx.title,
    genre: ctx.genre,
    summary: ctx.summary,
    mainPlot: ctx.plannedMainPlot,
    contentForm: '小说故事',
    lastChapterContext: ctx.finalizedStoryTail,
    existingFuturePlans: ctx.futurePlanIndex,
    targetPlans: JSON.stringify(ctx.selectedPlans),
    chapterCount: count,
    pacingInstruction: ctx.pacingInstruction,
    instructions: request.instructions,
  });
  const raw = await LLMService.generateStructuredWithRetry(
    prompt + '\n只返回 {"chapters":[...]}；条目数量必须与请求一致。',
    responseSchema,
    undefined,
    { temperature: 0.5, maxRetries: 2, maxTokens: 3200 },
  );
  if (!raw) throw new PlanningError('MODEL_INVALID_OUTPUT', 502);
  const parsed = responseSchema.parse(raw);
  const next = mergeGeneratedChapters(ctx.document.chapters, request.mode,
    request.targetPlanIds, parsed.chapters, randomUUID);
  assertWritableTargets(ctx, request);
  assertPlanningBudget(ctx, next);
  return next; // 调用方保存候选 after_json，此处不写正式 chapter
}
```

`PlanGenerationRequest` 是服务端完成跨字段校验后的归一化类型：`targetPlanIds` 默认 []，`batchSize` 有确定值；`PlanningContext` 与预算/目标校验由 B3 实现。默认模板需要真实使用新增占位符，不能只给 formatPrompt 传一个未在模板出现的字段。三个模板统一返回对象包裹数组；旧项目自定义模板仍须追加结构契约和作用范围。

修订专用 Prompt 的最小要求：列出允许变更的 ID 和原规划；逐条返回同一组 ID；遵循修改要求，保留承接关系；没有获得许可的已定稿事实不得改变。模型选择的新角色/伏笔只属于未来计划。

### 4.3 候选保存与采纳顺序

生成：校验项目 → 按 request_key 查已有请求并比较 request_hash → 短事务预占 generating 行 → 事务外调用模型 → 重新检查 plan/source → 保存 pending 或 failed/stale。未知 HTTP 结果通过 request_key 查询，不先换键重跑模型。服务重启遗留 generating 行标记中断，作者明确重试后使用新键。

采纳核心顺序：

```ts
return planningRepository.withImmediateTransaction(async tx => {
  const change = await tx.loadChange(projectId, changeId);
  const applyHash = hashCanonicalApplyRequest(changeId, request);
  if (change.state === 'applied') {
    if (change.apply_payload_hash !== applyHash) {
      throw new PlanningError('APPLY_SELECTION_CHANGED', 409);
    }
    return JSON.parse(change.result_json);
  }
  const plan = await tx.loadPlan(projectId);
  assertPending(change);
  assertRevision(plan.revision, request.expected_revision);
  assertRevision(change.base_revision, plan.revision);
  assertRevision(change.candidate_revision, request.expected_candidate_revision);
  await assertSourceUnchanged(tx, projectId, change.source_snapshot_json);
  const after = StoryPlanDocumentSchema.parse(JSON.parse(change.after_json));
  await assertAllowedDiff(tx, plan, after, change);
  const result = await tx.applySelectedPlanningChanges(plan, after, request);
  await tx.markApplied(change, result, applyHash); // 回执、plan 和关联 summary 同事务
  return result;
});
```

此段是 Repository 的调用骨架；上述方法由 B1 实现，不能将伪接口当成现有函数。生成的 request_hash 与采纳的 apply_payload_hash 各有用途，不比较不同阶段的载荷。采纳哈希包含 candidate ID、两个 expected revision 和排序去重后的 selected_patch_ids；不包含当前数据库 revision，保证已成功请求在版本推进后仍能重放。

候选生成时保存服务端分配 ID 的 patches_json；角色/术语匹配、字段路径与白名单都由服务端生成。`applySelectedPlanningChanges` 只允许候选已声明的 patch，空选择不表示全部采纳。开书 blueprint 作为完整规划 patch，正式项目字段/角色/术语可逐项选择；未选的正式字段保持原样。首次规划和扩展按整批采纳，修订可按目标条目选择；不要因逐项选择制造缺少必填字段的 blueprint。单个候选只采纳一次，剩余未选项不会被下次重试补写。revision 在更新语句 WHERE 中再做 CAS，并检查 changes=1。

角色库当前没有独立 personality 列：沿用现有角色 description 中的性格段合并规则，并保留 visual_tags、角色版本及图片资源。不能把 blueprint.personality 当成 CharacterCreate 已支持的字段直接传入。

## 5 创建下一章核心事务

下面是围绕已采纳计划的参考实现，`PlanningTx` 必须为该事务独占的 SQLite 连接，withImmediateTransaction 负责 BEGIN/COMMIT/ROLLBACK。项目存在及目标归属检查在进入服务前完成；所有 SQL 仍按 project_id 过滤。沿用本地单用户部署，不新增 JWT 或租户系统。

```ts
import { createHash, randomUUID } from 'node:crypto';

type SqlRow = Record<string, any>;
type PlanningTx = {
  get(sql: string, ...params: unknown[]): Promise<SqlRow | undefined>;
  all(sql: string, ...params: unknown[]): Promise<SqlRow[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
};
type CreateNextRequest = {
  project_id: number;
  plan_entry_id: string;
  expected_revision: number;
  expected_last_chapter_id: string | null;
  request_key: string;
};
const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

async function createNextChapter(
  withTx: <T>(work: (tx: PlanningTx) => Promise<T>) => Promise<T>,
  request: CreateNextRequest,
) {
  // 固定字段顺序；重试发送相同参数，不能拿新 revision 复用旧请求键。
  const requestHash = hashText(JSON.stringify([
    'next_chapter', request.project_id, request.plan_entry_id,
    request.expected_revision, request.expected_last_chapter_id,
  ]));
  return withTx(async tx => {
    const receipt = await tx.get(
      'SELECT * FROM story_plan_change WHERE project_id = ? AND request_key = ?',
      request.project_id, request.request_key,
    );
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new PlanningError('REQUEST_KEY_REUSED', 409);
      if (receipt.state === 'applied') return JSON.parse(receipt.result_json);
      // 自动模式在定稿事务中预登记 pending 请求；这里执行同一份载荷。
      if (receipt.kind !== 'next_chapter' || receipt.state !== 'pending') {
        throw new PlanningError('REQUEST_NOT_FINISHED', 409);
      }
    }
    const plan = await tx.get('SELECT * FROM story_plan WHERE project_id = ?', request.project_id);
    if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404);
    const document = StoryPlanDocumentSchema.parse(JSON.parse(plan.document_json));
    const bound = await tx.get(
      'SELECT * FROM chapter WHERE project_id = ? AND plan_entry_id = ?',
      request.project_id, request.plan_entry_id,
    );
    let chapter = bound;
    let nextRevision = plan.revision;
    if (!bound) {
      if (plan.revision !== request.expected_revision) throw new PlanningError('PLAN_CONFLICT', 409);
      const actual = await tx.all(
        'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index", id', request.project_id,
      );
      const last = actual.at(-1);
      if ((last?.id ?? null) !== request.expected_last_chapter_id) {
        throw new PlanningError('CHAPTER_TAIL_CHANGED', 409);
      }
      if (last && (last.status !== 'completed' ||
          last.finalized_content_hash !== hashText(String(last.content || '')))) {
        throw new PlanningError('PREVIOUS_CHAPTER_NOT_FINALIZED', 409);
      }
      const linked = new Set(actual.map(ch => ch.plan_entry_id).filter(Boolean));
      const next = document.chapters.find(entry => !linked.has(entry.id));
      if (!next) throw new PlanningError('NO_PENDING_PLAN', 409);
      if (next.id !== request.plan_entry_id) throw new PlanningError('PLAN_ORDER_CHANGED', 409);
      if (!next.summary.trim()) throw new PlanningError('PLAN_INCOMPLETE', 422);
      const chapterId = randomUUID();
      const index = actual.length ? Math.max(...actual.map(ch => Number(ch.index))) + 1 : 1;
      await tx.run(`INSERT INTO chapter
        (id, project_id, "index", title, summary, target_word_count, plan_entry_id, content, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', 'draft')`,
        chapterId, request.project_id, index, next.title, next.summary,
        next.targetWordCount, next.id);
      const update = await tx.run(
        'UPDATE story_plan SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND revision = ?',
        request.project_id, plan.revision,
      );
      if (update.changes !== 1) throw new PlanningError('PLAN_CONFLICT', 409);
      nextRevision += 1;
      chapter = await tx.get('SELECT * FROM chapter WHERE id = ? AND project_id = ?', chapterId, request.project_id);
    }
    if (!chapter) throw new PlanningError('CHAPTER_NOT_FOUND', 500);
    const result = { chapter, plan_revision: nextRevision, reused: Boolean(bound) };
    if (receipt) {
      await tx.run(`UPDATE story_plan_change SET state = 'applied', result_json = ?,
        applied_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?`,
        JSON.stringify(result), nextRevision, receipt.id, request.project_id);
    } else {
      await tx.run(`INSERT INTO story_plan_change
        (id, project_id, kind, state, request_key, request_hash, request_payload_json,
         base_revision, result_json, applied_revision)
        VALUES (?, ?, 'next_chapter', 'applied', ?, ?, ?, ?, ?, ?)`,
        randomUUID(), request.project_id, request.request_key, requestHash, JSON.stringify(request),
        request.expected_revision, JSON.stringify(result), nextRevision);
    }
    return result;
  });
}
```

`PlanningError(code,status)` 是 B1 的领域错误类。骨架展示事务核心；落地还需返回字段白名单、错误码映射、预算复核、旧项目 bootstrap 完整性检查和事务连接管理。绑定已存在时返回现有章节，不重新覆盖其标题、章纲或正文。

**自动模式接线：** 定稿提交事务中登记 kind=next_chapter、state=pending 的后续请求，保存完整 request_payload_json；事务成功后调用同一函数。自动 request_key 根据项目 + 前章 ID + 定稿正文哈希生成确定性 UUID，唯一约束防止重复定稿触发第二次；仅在有下一条已采纳规划时登记。定稿前验证规划配置，登记失败与定稿一起回滚，后续执行失败则独立记录。重试先查此前请求回执，使用其原始参数，不能用新的 revision 重新构造同键载荷。首期请求由现有 HTTP 流程完成；中途断开后通过回执恢复，接口不承诺后台无限自动生成。返回主操作定稿成功、后续建章独立状态。

**手工空章兼容：** 同一领域服务提供手工入口，事务内建立空概要的规划占位并创建实际章；与按规划建章共用末章定稿校验、ID/顺序分配和唯一关联。只有明确的手工空章允许空概要。上面的 createNextChapter 是已采纳规划入口，不能直接用它替换旧手工按钮而使空白写作失效。

## 6 必须闭环的接缝

1. `AgentRouteIntentSchema`、`routeToActions`、操作分类、AgentActionSchema、执行器、响应卡数据同步新增。保留现有单意图模型；使用原始 instructions，路由 focus 仅辅助定位。
2. `brainstorm_chat` 的名字改为 NovaStory；保留 DreamWaver 的四要素、少量追问、自然收束。`structure_novel_gen` 转成上面的 initialRelations/plannedRelations 输出；新增 `structure_revise`。
3. `structure_volume_gen` 虽然名称是 volume，当前 NovaStory 模板已是扁平章纲；首期可保留 key 兼容项目 overrides，补 count、instructions、pacing、futurePlans 占位符。
4. 正文生成读取 chapter.target_word_count，并从 story_plan 的下一条规划得到 nextChapterConstraint，实际过去事实仍只从已写正文/定稿元数据取得。
5. 所有正文写入口使旧定稿哈希失效；analyzeChapterImpact 成功提交时写当前正文哈希。旧库已定稿记录不伪造哈希。
6. 已关联 summary/title 的手动更新和 Agent 更新走同一个领域服务。对被改动来源的 pending 候选标记 stale；AI 不能借 revise 更新角色库或正文。
7. bootstrap 只建立规划映射；旧章没有 summary 时保留空值并标为待补全，不把正文自动截断成章纲。
8. 新规划实体进入导出/回导、项目复制与删除。导入后候选和自动建章设置的状态必须明确；复制不能让新项目引用原项目章节。

## 7 后端验收与交接

优先写 SQLite 集成测试：preview 不写正式资料、修改范围精确、初始化/扩展数量一致、双请求同键重放、同键不同载荷、双连接并发建章、revision/source 冲突、事务中途失败、旧定稿内容变更、两项目 ID 隔离、复制/回导关联。

核心验收场景使用模拟模型输出验证数据约束；另外用真实模型分别生成一份开书设定、3 章首批规划、2 章扩展和指定章修订，检查人物动机、承接与篇幅方向，记录模型配置和来源。

交给前端的固定响应样例至少包含：blueprint pending、chapters pending、generating、failed、stale、已采纳回执、已存在新章回执、无后续规划、前章未有效定稿、同键不同载荷。生成失败不回空数组冒充成功。

可直接用于后端实施的任务描述：

> 按本文件 B1–B6 与总体方案 NC01–NC14 实现小说创作的三项能力。先固定 story_plan/candidate DTO 和错误码，复用当前 Provider、Prompt registry、Agent 路由及剧本候选的事务模式。未来规划与 chapter 分开；采纳只应用已保存候选；自动建章只从已采纳规划创建一个实际章节。保持现有定稿时间线与关系记录。前端组件和文案由前端任务负责；提供响应夹具及 SQLite 故障/并发测试。完成后按实际证据更新 0_TASKLIST 对应条目。
