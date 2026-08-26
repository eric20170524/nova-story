---
name: novel-to-comic
description: 在 NovaStory 小说项目已经导入后，从项目校验、正文创作/定稿、人物与世界观收敛、正式分镜、场景生图一直执行到严格生成整本漫画 PDF。支持页面操作与 REST API 两条路径，并允许从任意中间状态恢复。
version: 1.1
---

# NovaStory：已导入小说 → 整本漫画 Skill

## 1. 使用场景

当 NovaStory 中已经存在一个小说 Project，用户希望继续完成以下任一目标时使用本 Skill：

- 检查导入后的小说是否具备继续创作条件；
- 续写、改写、完善或定稿章节；
- 收敛 Story Bible、角色和术语；
- 为已定稿章节生成正式叙事分镜；
- 生成角色视觉资产和 Scene 图片；
- 生成单章漫画用于审阅；
- 在全项目就绪后生成一个完整的 Project-level 漫画 PDF；
- 从任意中间状态继续，而不是从头重做。

本 Skill **不负责导入小说**。项目导入由现有 Import Preview / Commit 流程负责。

---

# 2. 最终完成定义

NovaStory 当前同时提供章节级与项目级漫画接口：

```http
POST /api/comics/{chapter_id}/generate
GET  /api/comics/project/{project_id}/status
POST /api/comics/project/{project_id}/generate
```

最终完成定义是：

```text
Project
  → 所有 Chapter 正文定稿
  → 已定稿内容的人物/术语状态同步
  → 主要角色视觉定义稳定
  → 所有 Chapter 有正式 narrative Timeline
  → 所有正式 Scene 都有可用 asset_url
  → Project comic readiness == true
  → 生成一个完整 Project-level PDF
  → generated_count == total_scenes
```

### 章节 PDF 的定位

单章接口：

```http
POST /api/comics/{chapter_id}/generate
```

适合中途审阅、返工和逐章交付，但**不是整本完成的硬前置**。

Project-level 生成会直接从当前数据库中的 Chapter → Scene → asset_url 重新渲染整本漫画，按：

```text
Chapter.index ASC → Scene.index ASC
```

组装，不依赖先前生成过的 chapter PDF。

---

# 3. Agent OS 能力边界

Agent OS 当前可编排：

- `DRAFT_CONTENT`
- `CINEMATIC_REWRITE`
- `ADD_CONFLICT`
- `REVERSE_PLOT`
- `RUN_CONSISTENCY_CHECK`
- `APPLY_CHAPTER_IMPACT`
- `GENERATE_TIMELINE`
- `ANALYZE_CHAPTER`
- `ANALYZE_CHAPTER_CHARACTERS`
- Project / Chapter / Character 元数据操作

Agent OS Action Schema 当前没有：

- `GENERATE_ASSET`
- `GENERATE_COMIC`
- `GENERATE_PROJECT_COMIC`

因此：

```text
小说创作 / 定稿 / Timeline
  → 优先 Agent OS 或 REST API

Scene 生图 / 单章漫画 / 整本漫画
  → Director 页面或直接 REST API
```

不要让 Agent 声称执行了不存在的 Agent action。

---

# 4. 工作模式

## A. 页面模式（默认推荐）

```text
/project/{PROJECT_ID}/story       小说编辑
/project/{PROJECT_ID}/characters  角色管理
/project/{PROJECT_ID}/director    分镜 / 生图 / 单章漫画 / 整本漫画
/project/{PROJECT_ID}/settings    Story Bible / 项目设置
/settings                         LLM / ComfyUI 设置
```

适合人工审稿、角色视觉选择和分镜/图片确认。

## B. API 模式

基础地址：

```text
http://127.0.0.1:3000/api
```

Swagger：

```text
http://127.0.0.1:3000/docs/
```

API 自动化必须遵循：

```text
READ CURRENT STATE
  → CHECK PRECONDITION
  → ACTION
  → VERIFY
  → REPAIR IF NEEDED
  → NEXT
```

不要把工作流实现成无条件重跑所有生成接口的线性脚本。

---

# 5. 核心原则

1. **已有合格成果就跳过。** 不重复生成已经满意的正文、Timeline 或图片。
2. **正文先于视觉。** Chapter 未定稿时不进入正式批量视觉生产。
3. **AI 写操作先 Preview。** Draft / Skill 优先 `apply=false`，确认后才写入。
4. **Timeline 是视觉源数据。** 已有 Timeline 时，不无条件重新生成，因为 `/timeline/generate` 会替换正式分镜。
5. **人物一致性优先。** 主要角色批量生图前应有稳定 description / visual tags，推荐 portrait / turnaround。
6. **漫画字幕来自 `Scene.dialogue`。** 需要字幕时先验收 dialogue。
7. **Scene 图片是漫画硬前置。** 整本漫画严格要求所有正式 Scene 都有 `asset_url`。
8. **整本导出必须先 readiness。** 不直接盲调 Project generate。
9. **不接受漏页“成功”。** 最终必须 `generated_count == total_scenes`。
10. **附加资料显式启用。** 只有 `context_enabled = 1` 的资料参与 WritingService。
11. **不静默覆盖 settings。** 更新 Story Bible 时保留未知 settings key。
12. **失败从最近阶段恢复。** 不因一张图失败而重做整本小说。

---

# 6. 状态机

每个 Chapter：

```text
C0 CHAPTER_READY
  ↓
C1 CHAPTER_FINALIZED
  ↓
C2 WORLD_SYNCED
  ↓
C3 TIMELINE_READY
  ↓
C4 IMAGES_READY
```

Project 全局：

```text
P0 PROJECT_READY
  ↓
P1 CHARACTER_VISUAL_READY
  ↓
P2 ALL_CHAPTERS_IMAGES_READY
  ↓
P3 PROJECT_COMIC_READY
```

可选中间产物：

```text
C4 IMAGES_READY
  → OPTIONAL CHAPTER_COMIC_PDF
```

真正完成条件：

```text
Project == P3 PROJECT_COMIC_READY
```

---

# 7. Phase 0 — Project / 环境 Preflight

## 7.1 Project 与 Chapter

```http
GET /api/projects/{PROJECT_ID}
GET /api/chapters/?project_id={PROJECT_ID}
```

确认：

- Project 存在；
- 至少一个 Chapter；
- Chapter.index 顺序合理；
- title 可识别；
- 不存在误导入的空章节。

不要仅因 `status == draft` 就判定正文没完成；导入项目可能内容已完整但状态仍是 draft。

## 7.2 LLM

页面：

```text
Settings → LLM → 验证连接
```

API 自动化：

```http
GET /api/settings/
```

取返回中的公开 `llm` 配置，再：

```http
POST /api/settings/verify-llm
Content-Type: application/json

{
  "llm": { ...GET /settings/ 返回的 llm 公共配置... }
}
```

服务端会复用已经保存的密钥；不要要求浏览器读取明文 API Key。

LLM 不可用时可以人工编辑已有正文，但不要进入 AI Draft / Skill / 自动 Timeline。

## 7.3 图像环境

```http
GET /api/settings/vram-status
GET /api/settings/tier-b-status
GET /api/workflows/
```

说明：

- Tier B 不是漫画硬前置；
- Pony XL 是默认成片路径；
- SD1.5 更适合草稿；
- 无 ComfyUI / 无可用 Workflow 时可完成小说与 Timeline，但无法完成 Scene 生图和最终漫画。

---

# 8. Phase 1 — Story Bible / 附加资料

页面：

```text
Project → Settings
```

检查已有：

- genre
- style
- story_tags
- POV
- tone
- main_plot
- character_relations
- glossary
- default_style
- default_model_type

缺失字段允许为空，不为了“字段齐全”自动脑补。

附加资料：

```http
GET /api/projects/{PROJECT_ID}/documents
```

只有确认与当前创作相关时才开启：

```http
PATCH /api/projects/{PROJECT_ID}/documents/{DOCUMENT_ID}

{
  "context_enabled": true
}
```

---

# 9. Phase 2 — 逐章创作

按 `Chapter.index ASC` 循环。

## 9.1 判断是否需要继续写

如果 Chapter 已经：

- 正文完整；
- summary 与正文一致；
- 用户没有要求扩写；

则不要自动续写，直接进入一致性/定稿检查。

## 9.2 页面

```text
Project → Story
```

可：

- 编辑 title / summary / Markdown 正文；
- AI Draft；
- Agent OS；
- 写作 Skill；
- 保存。

## 9.3 API Draft

先 Preview：

```http
POST /api/agent/draft

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "instructions": "按当前章纲继续完成本章，保持 POV、tone 和人物连续性",
  "target_word_count": 800,
  "apply": false
}
```

确认接受后：

- 可 `PATCH /api/chapters/{CHAPTER_ID}` 写入最终正文；或
- 对真正的“续写追加”再次调用 `apply=true`。

注意：`/agent/draft apply=true` 是追加语义，不是整章替换语义。

## 9.4 写作 Skill

只在有明确问题时调用，不要机械地每章全部跑。

```http
POST /api/agent/skill
```

支持：

```text
CINEMATIC_REWRITE
ADD_CONFLICT
REVERSE_PLOT
```

先 `apply=false`；满意后才 `apply=true`。

`/agent/skill apply=true` 会替换 Chapter content，必须先预览。

---

# 10. Phase 3 — 一致性与定稿

## 10.1 一致性

```http
POST /api/agent/consistency

{
  "project_id": PROJECT_ID
}
```

处理：

- critical / 明确逻辑冲突 → 修对应 Chapter；
- warning → 判断是否影响连续性；
- 风格偏好不能自动当逻辑错误改正文。

推荐在：

- 每完成若干章；
- 全书视觉化前；

至少各执行一次。

## 10.2 Chapter 定稿

确认正文与 summary 已接受后：

```http
PATCH /api/chapters/{CHAPTER_ID}

{
  "status": "completed"
}
```

`completed` 只是流程标志，不代替质量验收。

---

# 11. Phase 4 — 同步角色 / 术语 / 世界状态

Chapter 定稿后：

```http
POST /api/agent/impact

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "apply": true
}
```

更新可能包括：

- characters；
- personality / motivation；
- visual tags；
- glossary。

正文未定稿时不要 `apply=true`。

若本章确实没有世界状态变化，可人工确认后跳过写入。

---

# 12. Phase 5 — 角色视觉准备

页面优先：

```text
Project → Characters
```

主要角色最低应有：

- name；
- description；
- 能从正文明确得到时的 visual_tags。

推荐再准备：

1. portrait；
2. turnaround；
3. 必要时 face crop；
4. 只有确有需求时才登记/训练 LoRA。

Character Manager 页面优先于裸 REST，因为页面已经封装：

- Project style / model / NSFW policy；
- prompt 构建；
- portrait / turnaround；
- 参考图；
- VRAM handoff；
- SSE 状态。

辅助 API：

```http
GET  /api/characters/?project_id={PROJECT_ID}
POST /api/characters/{CHARACTER_ID}/build-prompt
POST /api/characters/{CHARACTER_ID}/crop-face
POST /api/characters/{CHARACTER_ID}/upload-asset
GET  /api/characters/{CHARACTER_ID}/versions
```

角色视觉不是漫画接口的数据库硬前置，但对跨 Scene 一致性非常重要。

---

# 13. Phase 6 — 正式 Timeline

只对已定稿 Chapter 执行。

## 页面

```text
Project → Director → 选择 Chapter → Generate Timeline
```

Story 页面跳到 Director 不会自动生成 Timeline。

## API

先读：

```http
GET /api/timeline/{CHAPTER_ID}
```

已有 `timeline.length > 0` 时默认保留，先检查是否仍匹配最终正文。

确认需要重做才：

```http
POST /api/timeline/generate

{
  "chapter_id": "CHAPTER_ID",
  "mode": "narrative"
}
```

Chapter-level 正式模式使用 `narrative`。

不要使用已经弃用的 Chapter-level：

```text
cinematic_grid
nine_shot_coverage
```

## Timeline 验收

每个 Scene 至少确认：

- index；
- visual_prompt；
- dialogue；
- shot_type；
- camera_angle；
- camera_movement；
- negative_prompt（如有）。

修改：

```http
PUT /api/timeline/scene/{SCENE_ID}
```

---

# 14. Phase 7 — 可选 Coverage

Coverage 是单 Scene 的 9 个镜头候选，不替代正式 Timeline。

适合：

- 关键戏构图不满意；
- 需要更多镜头语言；
- Scene 难以直接生图；
- 需要把关键 Scene 扩展为多个正式镜头。

```http
POST /api/scenes/{SCENE_ID}/coverage
GET  /api/scenes/{SCENE_ID}/coverage
POST /api/scenes/coverage/{SHOT_ID}/apply
POST /api/scenes/coverage/{SHOT_ID}/promote
```

promote body：

```json
{
  "position": "before | after | replace"
}
```

Coverage 后重新读取正式 Timeline；后续只对正式 `scene` 表中的 Scene 生图。

---

# 15. Phase 8 — Scene 生图

## 页面模式（推荐）

```text
Project → Director → 分镜出图控制
```

漫画目标推荐：

- Asset mode：Single image；
- 确认 Project render config；
- 检查 style / model preset / SFW-NSFW policy；
- `Generate all shots` 顺序批量生成。

单 Scene 不满意时只重做该 Scene 或创建 Scene Version。

## API

先：

```http
GET /api/workflows/
```

再逐 Scene：

```http
POST /api/assets/generate
```

使用当前项目实际 workflow；不要无条件复制示例生成参数。

监控：

```http
GET /api/assets/status/{TASK_ID}
GET /api/assets/stream/{TASK_ID}
```

单 Scene 进入图片完成态至少要求：

```text
asset_url exists
```

页面正常生成时通常同时会有：

```text
asset_status == completed
```

---

# 16. Phase 9 — 图片验收 / 修复循环

对每个正式 Scene：

```text
IF asset_url exists AND image accepted
    → next scene
ELSE
    → repair
```

修复顺序：

1. visual_prompt；
2. 人物 description / visual_tags；
3. shot_type / camera；
4. Project style / model；
5. 必要时 Scene Version；
6. 只重试失败 Scene。

版本 API：

```http
GET  /api/timeline/scene/{SCENE_ID}/versions
POST /api/timeline/scene/{SCENE_ID}/versions
POST /api/timeline/scene/{SCENE_ID}/versions/{VERSION}/activate
```

不要为修一张图覆盖已经满意的旧版本。

---

# 17. Phase 10 — 可选单章漫画审阅

当某章所有正式 Scene 图片都已接受，可生成单章 PDF：

页面：

```text
Project → Director → Export & production → 生成本章漫画
```

API：

```http
POST /api/comics/{CHAPTER_ID}/generate
```

当前章节接口保留兼容语义：可能跳过无 `asset_url` 或渲染失败的 Scene，因此完整审阅仍必须检查：

```text
generated_count == total_scenes
pages.length == total_scenes
pdf_url exists
```

不满足则回 Phase 8/9 修复。

单章 PDF 是审阅产物；Project-level 最终 PDF 不依赖它。

---

# 18. Phase 11 — Project Comic Readiness

这是整本漫画生成前的**硬门禁**。

页面点击“生成整本漫画 PDF”时会先自动检查。

API 自动化必须先：

```http
GET /api/comics/project/{PROJECT_ID}/status
```

核心响应：

```json
{
  "project_id": 12,
  "ready": false,
  "total_chapters": 10,
  "ready_chapters": 9,
  "total_scenes": 86,
  "ready_scenes": 84,
  "chapters": [
    {
      "chapter_id": "...",
      "index": 10,
      "title": "第十章",
      "total_scenes": 8,
      "ready_scenes": 6,
      "missing_scene_ids": [81, 82],
      "ready": false,
      "blocker": "missing_assets"
    }
  ]
}
```

`blocker`：

- `no_scenes`：该章没有正式 Timeline；
- `missing_assets`：存在正式 Scene 无 `asset_url`；
- `null`：该章就绪。

只有：

```text
ready == true
AND ready_chapters == total_chapters
AND ready_scenes == total_scenes
```

才进入整本生成。

注意：Project-level endpoint 当前严格覆盖**项目内所有 Chapter**。如果项目中保留了不准备出版的草稿 Chapter，它也会阻塞整本 readiness；应先明确项目结构，而不是让接口静默跳过。

---

# 19. Phase 12 — 生成整本漫画 PDF

## 页面

```text
Project → Director
  → Export & production
  → 生成整本漫画 PDF
```

行为：

1. 先读取 Project readiness；
2. 不就绪时只提示缺 Timeline / 缺图数量，不生成；
3. 就绪后严格组装；
4. 成功后直接打开 Project PDF。

## API

```http
POST /api/comics/project/{PROJECT_ID}/generate
```

如果 readiness 不满足：

```text
HTTP 409
```

并返回结构化 `details`，不得当作可忽略 warning。

成功响应核心：

```json
{
  "status": "completed",
  "project_id": 12,
  "total_chapters": 10,
  "total_scenes": 86,
  "generated_count": 86,
  "chapters": [
    {
      "chapter_id": "...",
      "index": 1,
      "title": "第一章",
      "total_scenes": 9,
      "page_count": 9
    }
  ],
  "pages": [
    {
      "chapter_id": "...",
      "scene_id": 1,
      "url": "/static/comics/comic_scene_1.jpg"
    }
  ],
  "pdf_url": "/static/comics/project_12_comic.pdf"
}
```

### 严格最终验收

必须同时满足：

```text
status == completed
generated_count == total_scenes
sum(chapters.page_count) == total_scenes
pages.length == total_scenes
pdf_url exists
```

页面顺序必须保持：

```text
Chapter.index ASC → Scene.index ASC
```

如果任一 Scene 在渲染过程中失败，整本生成失败，不把部分页面包装成“完整 PDF”。

---

# 20. 全 Project 编排伪代码

```pseudo
project = GET /projects/{PROJECT_ID}
chapters = GET /chapters/?project_id={PROJECT_ID}
sort chapters by index

preflight(project)
validate_story_bible_and_context()

for chapter in chapters:
    if chapter content is not accepted:
        draft_or_edit_with_preview()

    run_consistency_when_needed()
    finalize_chapter()
    sync_chapter_impact_or_explicitly_confirm_no_delta()

prepare_main_character_visuals()

for chapter in chapters:
    timeline = GET /timeline/{chapter.id}
    if timeline missing:
        generate narrative timeline
    else:
        validate existing timeline against final chapter

    refine key scenes with coverage only when needed

    for scene in formal timeline:
        if scene image is missing or rejected:
            generate / repair only that scene

    optional generate chapter comic for review

readiness = GET /comics/project/{PROJECT_ID}/status

if readiness.ready != true:
    repair readiness blockers
    repeat status check

book = POST /comics/project/{PROJECT_ID}/generate

assert book.status == completed
assert book.generated_count == book.total_scenes
assert book.pages.length == book.total_scenes
assert book.pdf_url exists
```

---

# 21. 页面优先 vs API 优先

| 阶段 | 默认路径 | 原因 |
|---|---|---|
| Story Bible | 页面 | 防止意外覆盖 settings |
| 附加资料 | 页面 | 用户明确控制 AI Context |
| 正文人工审稿 | 页面 | 编辑体验最好 |
| AI Draft / Skill | API / Agent OS | 可 Preview、可编排 |
| 一致性 | API / Agent OS | 结构化 issues |
| Chapter Impact | API / Agent OS | apply 边界清楚 |
| Character visual | 页面优先 | 已封装 prompt/ref/VRAM |
| Timeline | 页面或 API | 两者语义明确 |
| Coverage | 页面/API | 按关键 Scene 使用 |
| Scene 生图 | Director 页面优先 | 已封装 style/ref/SSE/VRAM |
| 单章漫画 | 页面或 API | 用于中途审阅 |
| Project readiness | API / 页面按钮自动检查 | 明确最终 blocker |
| 整本漫画 | Director 页面或 API | 严格 Project-level endpoint |

---

# 22. 禁止的快捷方式

不要：

- 导入完成后直接跳过正文验收到 Timeline；
- 每章无条件调用 AI 续写；
- 每章无条件执行所有写作 Skill；
- Chapter 未定稿时 `APPLY_CHAPTER_IMPACT apply=true`；
- 已有合格 Timeline 时无条件重新生成；
- 使用弃用的 Chapter-level `nine_shot_coverage`；
- Scene 缺图时把单章部分页面当完整漫画；
- 不做 readiness 就直接反复调用整本 generate；
- 收到整本 409 后忽略 blocker；
- 为了人物一致性强制所有 Scene 使用单人物 IP-Adapter；
- 把 Agent OS 当成支持生图或漫画 action；
- 在未读取 Project settings 的情况下 PUT 全新 settings 覆盖已有配置；
- 把旧 chapter PDF 当成 Project-level source of truth。

---

# 23. 失败恢复

## LLM 失败

- 保留现有 Chapter；
- 不写正文；
- 修复 LLM 配置后从当前章继续。

## Timeline 失败

- 已有 Timeline 不先删除；
- 检查 Chapter content；
- 再决定是否 generate。

## Scene 生图失败

- 读取 `/api/assets/status/{task_id}`；
- 必要时 `/api/assets/cancel`；
- 修改该 Scene 或新建版本；
- 只重试失败 Scene。

## 单章 Comic 失败

- `No scenes found` → 回 Timeline；
- `No scenes have generated images` → 回 Scene 生图；
- `generated_count < total_scenes` → 修缺图/渲染失败 Scene。

## Project readiness 不通过

读取：

```http
GET /api/comics/project/{PROJECT_ID}/status
```

逐章根据 blocker 修：

```text
no_scenes      → Phase 6
missing_assets → Phase 8/9
```

不要重做已经 ready 的 Chapter。

## Project generate 失败

- HTTP 409 → readiness 在检查后发生变化，重新 status 并修 blocker；
- HTTP 500 / 指定 scene_id → 修该 Scene 的图片源，再重试整本；
- PDF 可生成但内容过期 → 检查正式 Scene / active version 是否已切到正确版本，再重建。

---

# 24. 最终报告模板

```markdown
## NovaStory 整本漫画创作完成报告

Project: <title> (#<project_id>)

### 小说
- Chapters: N
- 已定稿: N/N
- 一致性检查: 通过 / 剩余 X 项
- 角色/术语同步: 完成 / 明确无需变化

### 角色视觉
- 主要角色: N
- 稳定视觉定义: N/N
- portrait/turnaround: 按需完成

### 分镜
- narrative Timeline: N/N chapters
- Scene 总数: N

### 生图
- Scene asset_url: N/N
- 待重试: 0

### 可选单章漫画
- 已生成 Chapter PDF: N/N 或按需生成

### 整本漫画
- readiness: ready
- total_chapters: N
- total_scenes: N
- generated_count: N
- generated_count == total_scenes: yes
- Project PDF: /static/comics/project_<id>_comic.pdf
```

---

# 25. 最终 Definition of Done

只有同时满足以下条件，才能宣布“小说 → 整本漫画”完成：

- [ ] Project / Chapter 数据可读取；
- [ ] 所有正式 Chapter 正文已接受并定稿；
- [ ] 没有未处理的关键一致性问题；
- [ ] 已定稿内容的角色/术语变化已同步或明确确认无需同步；
- [ ] 主要角色具有稳定视觉定义；
- [ ] 每个 Chapter 都有正式 narrative Timeline；
- [ ] 每个正式 Scene 均有已接受的 `asset_url`；
- [ ] 需要字幕的 Scene 有正确 dialogue；
- [ ] `GET /comics/project/{PROJECT_ID}/status` 返回 `ready == true`；
- [ ] `ready_chapters == total_chapters`；
- [ ] `ready_scenes == total_scenes`；
- [ ] Project Comic API 成功；
- [ ] `generated_count == total_scenes`；
- [ ] `pages.length == total_scenes`；
- [ ] Project `pdf_url` 可访问；
- [ ] 最终报告记录整本 PDF。

任一条件不满足，不要把工作流标记为 completed；从对应 Phase 恢复执行。
