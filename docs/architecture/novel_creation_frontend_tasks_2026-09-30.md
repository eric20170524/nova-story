# 小说构思与章节规划前端任务和核心代码

配套[总体方案](./novel_creation_workflow_plan_2026-09-30.md)和[后端任务](./novel_creation_backend_tasks_2026-09-30.md)。本文件是实施说明；新增组件、DTO 和方法尚未接入应用。示例中的服务端接口与适配函数需要按双方契约实现。

任务状态统一维护在 [0_TASKLIST.md](../0_TASKLIST.md) Track 4。本轮使用现有 StoryEditor、ProjectAgentPanel 和 ProjectAgentProvider，界面继续遵守 `docs/3_UI_RULES.md` 的 Tailwind、双语、Toast 与 data-testid 约定。

## 1 前端工作包

| 工作包 | 对应任务 | 改动位置 | 交付及验收 |
| --- | --- | --- | --- |
| F1 API 与项目状态 | FE-C2/C3/C4 共用 | types.ts、services/api.ts；新增 hooks/useStoryPlan.ts | DTO、错误码、按项目读取、候选恢复、未知请求查询；NC09/10/11 |
| F2 构思开书 | FE-C2 | StoryEditor 空状态、ProjectAgentPanel、ProjectAgentContext；新增 StoryBlueprintCandidate | 构思模式、整理设定、逐字段审核、采纳刷新；NC01/02 |
| F3 章节规划 | FE-C3 | StoryEditor 章节栏；新增 StoryPlanPanel、ChapterPlanCandidate | 已写章节与未来规划、选中范围、修订/扩展、差异与预算；NC03/07/08/13 |
| F4 创建与继续写作 | FE-C4 | StoryEditor、定稿结果卡、useStoryPlan | 开始首章、下一章、默认关闭的自动选项、幂等重试；NC04/05/06 |
| F5 编辑保护与验收 | FE-C2/C3/C4 | 现有数据刷新处理、locales.ts、浏览器用例 | 脏缓冲、切项目、过期候选、双语、完整旅程；NC10/11/14 |

前端负责根目录类型、API client、组件、文案和 UI 测试；后端负责 backend 下全部业务约束及响应夹具。新增 DTO 先对齐，再实现组件，避免双方分别定义不同候选形状。

## 2 页面行为

### 2.1 空项目与构思模式

空状态提供“和 Agent 构思”“填写初始设定”“规划前几章”。已有完整创意可直接整理设定，不要求聊够固定轮数。手工写作入口保留。

Agent 面板有“构思 / 创作指令”模式。构思不要求 activeChapter；发送时带 `surface: 'story'`、`conversation_mode: 'ideation'`。历史继续使用现有项目 sessionStorage，但消息增加模式标识，避免把导演、剧本指令混进构思。已采纳的创意要点来自服务端规划文档。

“整理开书设定”只生成候选。卡片展示标题、类型、风格、简介、未来主线、初始关系、角色、术语，以及将影响的正式字段。候选可编辑、逐项选择、采纳或拒绝。正式字段与未来计划的区别用普通文案表达，例如“故事发展方向”“已确认的初始关系”，不向作者展示表名、JSON 或事务术语。

### 2.2 规划列表

章节栏保留已创建章节，增加“后续规划”区域；两者共享顺序与稳定规划 ID。规划行显示序号、标题、目标字数以及是否已开始写作。点击未来规划进入概要编辑，不创建空 chapter，也不把概要加载到正文编辑器。

初始规划默认 3 章，批量选择 1–5 章。修订先选条目、再填写要求；扩展选择数量和发展方向。卡片同时显示原概要与候选概要，未经请求的条目不可编辑。已定稿实际章节默认不可用于 AI 规划修订；正在写的章节修改概要时提示需自行核对正文。

预算展示后端计算的“已写 / 预留 / 目标”，前端不维护另一套字数算法。未来规划不足以覆盖整本小说不算错误，允许逐批扩展。

### 2.3 创建新章

“开始第一章 / 创建下一章”消费已采纳规划，成功后使用响应中的实际 chapterId、标题、概要、目标字数打开编辑器。按钮加载期间禁用，网络重试保留请求键及原始载荷。

“定稿后自动创建下一章”默认关闭，配置持久化到规划文档。定稿与后续建章分别反馈：前者成功、后者失败时，显示可重试的继续写作入口。规划用完时显示补充规划入口，不悄悄再次调用模型。

## 3 DreamWaverAI 可复用的 UI 代码

### 3.1 独立的整理动作

来自 [SetupChat.tsx:78](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/components/SetupChat.tsx:78)：

```ts
const conversationContext = messages.map(m =>
  `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
).join('\n');
const novel = await generateNovelStructure({ conversationContext }, preferredModel);
onNovelGenerated(novel);
```

保留“连续聊天 → 用户触发整理 → 可编辑结果”的交互。NovaStory 前端把结构化 history 交给现有后端，不在浏览器调用模型；回调接收持久化 candidate DTO。历史拼接交给后端，减少两份格式逻辑。

### 3.2 稳定身份与等待保存完成

来自 [SetupOutline.tsx:35](/Users/lm/pyProj/Renren/app-registry/2025/Creation/DreamWaverAI/components/SetupOutline.tsx:35) 的关键片段：

```ts
const finalNovel: Novel = {
  ...novelWithContext,
  volumes: finalVolumes,
  id: previewNovel.id,
  lastModified: Date.now(),
  preferredModel: preferredModel,
  isLocal: true
};
await onNovelCreated(finalNovel);
```

保留“不要采纳时换 ID”和“等待真正保存完成再切换”的原则。NovaStory 项目已经存在，直接采纳到该 project；规划/章节 ID 由服务端分配，前端只生成 request_key。原实现的 localStorage 整本 Novel 草稿不作为正式数据源，原生 alert 换成现有 Toast。

## 4 拟冻结的接口类型

HTTP envelope 使用 snake_case，document_json 内规划对象保持后端 schema 的 camelCase。Agent 结果的 `data.candidate_id` 指向同一个服务端候选，面板收到后取回候选卡；禁止把整个模型回答当作正文 `content` 应用。

下面 `StoryPlanDocument` 对应后端文档第 3 节 schema 的前端镜像，`Chapter` 沿用 types.ts 并补齐三个新增字段。生产类型不从 backend 运行时模块跨目录导入。

```ts
type PlanCandidateState = 'generating' | 'pending' | 'applied'
  | 'rejected' | 'failed' | 'stale';

type PlanPatch = {
  id: string; // 服务端生成，绑定本版候选；不使用数组索引
  entity: 'plan' | 'project' | 'character' | 'glossary' | 'initial_relations';
  label: string;
  before: string | null;
  after: string | null;
};

type StoryPlanCandidate = {
  id: string;
  project_id: number;
  kind: 'blueprint' | 'chapters';
  state: PlanCandidateState;
  request_key: string;
  base_revision: number;
  candidate_revision: number;
  before: StoryPlanDocument | null;
  after: StoryPlanDocument | null;
  patches: PlanPatch[];
  error_code?: string;
};

type ApplyPlanRequest = {
  expected_revision: number;
  expected_candidate_revision: number;
  selected_patch_ids: string[];
};

type CreateNextChapterRequest = {
  plan_entry_id: string;
  expected_revision: number;
  expected_last_chapter_id: string | null;
  request_key: string;
};

type NextChapterResult = {
  chapter: Chapter;
  plan_revision: number;
  reused: boolean;
};
```

patch ID 及正式角色匹配由服务端生成并持久化；编辑候选后重新返回 patch 集合，客户端保留仍有效的选择，对新增/变化项重新展示。章纲初始化/扩展首期整批采纳，用一个批次 patch；修订可按目标条目选择。开书字段允许逐项采纳；空选择禁用采纳按钮。

在现有 ApiService 内增加以下方法，不新建第二套 fetch/鉴权封装：

```ts
getStoryPlan = (projectId: number) =>
  this.request<StoryPlanView>(`/projects/${projectId}/story-plan/`);

applyStoryPlanCandidate = (projectId: number, id: string, body: ApplyPlanRequest) =>
  this.request<ApplyPlanResult>(
    `/projects/${projectId}/story-plan/candidates/${encodeURIComponent(id)}/apply`,
    { method: 'POST', body },
  );

createNextChapter = (projectId: number, body: CreateNextChapterRequest) =>
  this.request<NextChapterResult>(`/projects/${projectId}/story-plan/next-chapter`, {
    method: 'POST', body,
  });
```

这是类内方法片段。`StoryPlanView` 包含 document、revision、实际章节绑定、预算及下一可创建条目；`ApplyPlanResult` 包含 plan_revision、candidate_id、affected_entities。后端提供夹具后再固定全部字段。其余 bootstrap、候选生成/查询/编辑/拒绝、手工规划保存同样封装于 ApiService。

现有 request 会将服务端错误压成普通 Error，且 mock 模式对 `/projects/*` 有宽泛兜底。F1 必须保留 `status/code/details`，保证 409 能区分来源变化、版本冲突和重复请求；规划接口在 mock 模式提供明确夹具或明确失败，不能返回普通 Project 冒充候选成功。错误能力在原 request 上兼容扩展，核查现有 catch 调用，不替换所有 API。

## 5 Agent 面板接线核心

当前 `ProjectAgentContext.sendPrompt` 只接字符串。保持旧调用兼容，增加结构化请求，让按钮直接提供模式和范围，避免用中文提示词反向猜测按钮意图：

```ts
type AgentPromptInput = string | {
  text: string;
  conversationMode?: 'ideation' | 'command';
  preferredOp?: 'PLAN_STORY' | 'PLAN_CHAPTERS';
  planning?: {
    mode: 'initial' | 'revise' | 'extend';
    targetPlanIds?: string[];
    batchSize?: number;
  };
};

function normalizeAgentPrompt(input: AgentPromptInput) {
  return typeof input === 'string'
    ? { text: input, conversationMode: 'command' as const }
    : input;
}

// 此函数体接入现有 sendPrompt，不修改普通发送按钮的历史规则。
function queueAgentPrompt(input: AgentPromptInput) {
  const prompt = normalizeAgentPrompt(input);
  setOpen(true);
  setPendingPrompt({ ...prompt, dispatchId: crypto.randomUUID() });
}
```

同步更新 Context value、pendingPrompt 消费 effect、面板 handleSend、api.chatWithAgent、后端 context schema。dispatchId 只负责 UI 消费去重；生成候选的 request_key 与 expected_revision 由 useStoryPlan 捕获并传入后端。不要只更新 sendPrompt 类型却丢弃 preferredOp/planning。

构思发送保留现有模式：先从旧 messages 取 history，再把本轮输入作为 message 传入；不要因 setMessages 后重新取历史，把当前用户消息重复加入。候选查询恢复不依赖聊天历史是否仍保存在 sessionStorage。

对话中的新动作与规划面板 HTTP 入口最终调用相同后端服务。现有 execute 确认卡不再要求用户先批准一次“生成候选”，再批准一次“采纳候选”。

## 6 请求、采纳与缓冲保护

### 6.1 冻结创建请求

以下纯函数适配浏览器 Storage，供 useStoryPlan 在点击事件中调用。同一条规划请求结果未知时，刷新/重试必须复用最初载荷，不能拿最新 revision 配旧键。

```ts
function getOrCreateNextRequest(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  projectId: number,
  input: Omit<CreateNextChapterRequest, 'request_key'>,
): CreateNextChapterRequest {
  const key = `novastory_next_chapter_${projectId}_${input.plan_entry_id}`;
  const saved = storage.getItem(key);
  if (saved) {
    const parsed = JSON.parse(saved) as CreateNextChapterRequest;
    if (parsed.plan_entry_id !== input.plan_entry_id ||
        typeof parsed.request_key !== 'string' ||
        !Number.isInteger(parsed.expected_revision) || parsed.expected_revision < 1 ||
        !(parsed.expected_last_chapter_id === null ||
          typeof parsed.expected_last_chapter_id === 'string')) {
      throw new Error('INVALID_SAVED_NEXT_REQUEST');
    }
    return parsed;
  }
  const request = { ...input, request_key: crypto.randomUUID() };
  storage.setItem(key, JSON.stringify(request));
  return request;
}
```

成功后清除对应存储项。网络未知保留并先查询回执；明确的版本/来源冲突允许刷新后重新发起新请求、新键，不能自动循环。Storage 不可用或损坏时给出可理解提示，并通过服务端 plan_entry_id 绑定和回执查询核对结果；不要静默换键重试未知写入。

Hook 的内存同步锁与 loading 一起阻止同一帧双击；服务端唯一约束是最终保证。调用成功到 UI 切换之间仍属于 loading，借鉴 DreamWaver await onNovelCreated 的做法。

### 6.2 采纳的是已经展示并保存的内容

采纳顺序：保存候选编辑 → 取得最新 candidate_revision 和 patches → 核对选择仍有效 → apply → 使用回执刷新。若保存会改变 patch 集合或范围，先重新显示差异供作者审核，再启用采纳；不能悄悄把未展示的新字段勾选进去。

采纳重放用 candidateId + candidate_revision + selected_patch_ids 的稳定身份；服务端保存选择载荷哈希，已采纳但选择不同返回冲突。生成请求键不能当作采纳载荷哈希。生成/保存/apply 都失败时保留本地候选编辑内容，显示重试或冲突选项。

### 6.3 项目隔离与编辑器保护

页面数据 hook 按 projectId 绑定；Provider 若不随项目重建，必须显式重置项目局部状态，或由上层使用 `key={projectId}`。请求捕获 projectId 与活动章节，返回时确认来源仍匹配；切换项目后取消读取或忽略旧结果。服务器已提交的写入仍可在原项目通过 GET 恢复，不能把忽略响应理解成撤销。

现有 `notifyDataChanged` 只带 project/chapter，可兼容增加 `affectedEntities`（plan/project/characters/glossary/chapters）并通知对应消费者。规划候选结果永不调用 `applyContent`；章节标题/概要更新只刷新关联元数据，正文 buffer 保持原样。

有未保存正文时，先提供“保存并继续 / 留在当前章”再主动跳章。自动建章可以成功，但用户仍在修改正文时只显示新章入口，不强制切走。每个章节的本地草稿与候选编辑状态都按 ID 保存，409 后不得用后端 reload 覆盖脏缓冲。

## 7 状态与验收

| 服务状态 | 前端反馈 | 后续动作 |
| --- | --- | --- |
| generating | 正在整理，展示请求状态 | 按请求键恢复；读轮询有上限和卸载清理 |
| pending | 可编辑的差异卡 | 保存、采纳、拒绝 |
| applied | 展示已采纳回执 | 刷新受影响数据、下一步入口 |
| stale / SOURCE_CHANGED | 来源已有修改，保留对比 | 查看旧候选、基于新来源重新生成 |
| failed | 明确生成失败，保留用户输入 | 用户发起新请求 |
| PREVIOUS_CHAPTER_NOT_FINALIZED | 上一章需要定稿或重新定稿 | 回到对应章节 |
| NO_PENDING_PLAN | 后续规划已用完 | 规划下一章或扩展数章 |
| 网络结果未知 | 正在核对处理结果 | 查询回执，原键原载荷重试 |

推荐 data-testid：story-ideation-start、agent-mode-ideation、story-blueprint-generate、story-plan-generate、story-plan-revise、story-plan-extend、story-plan-candidate-apply、story-next-chapter、story-auto-next。规划行与候选卡加 data-plan-id / data-candidate-id，测试定位不依赖标题。

浏览器验收覆盖总体方案 NC01–NC14 中的可见行为，至少完成：空书连续聊两轮 → 整理并编辑设定 → 采纳 → 3 条规划 → 第一章 → 定稿 → 下一章 → 修订第三条 → 扩展 2 条。再覆盖刷新恢复、切项目时慢响应、脏正文、模型失败、两标签页冲突、无下一条规划。接口 mock 验证交互和失败态；另做一次真实模型旅程，分开报告。

可直接用于前端实施的任务描述：

> 按本文件 F1–F5 实现小说故事页面的构思、规划与建章交互。复用现有 Agent 面板和项目 Context，使用后端提供的 story-plan DTO；未来规划保持独立，采纳只应用候选，自动建章默认关闭。落实项目隔离、稳定请求键、409 保留候选和正文缓冲。所有新文案同步中英文，新增控件含 data-testid。不要在前端调用模型、生成正式章序或保存第二份权威规划；完成后按浏览器证据更新 0_TASKLIST 对应条目。
