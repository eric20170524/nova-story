---
name: novel-to-comic
description: 在 NovaStory 小说项目已经导入后，从项目校验、正文创作/定稿、人物与世界观收敛、正式分镜、场景生图一直执行到逐章生成漫画页和 PDF。支持页面操作与 REST API 两条路径，并允许从任意中间状态恢复。
version: 1.0
---

# NovaStory：已导入小说 → 漫画 Skill

## 1. 使用场景

当 NovaStory 中已经存在一个小说 Project，并且用户希望继续完成以下任一目标时使用本 Skill：

- 检查导入后的小说是否具备继续创作条件；
- 续写、改写、完善或定稿章节；
- 收敛 Story Bible、角色和术语；
- 为已定稿章节生成正式叙事分镜；
- 生成角色视觉资产和场景图片；
- 逐章生成漫画页与 PDF；
- 从上述任意中间状态继续，而不是从头重做。

本 Skill **不负责导入小说**。项目导入由现有 Import Preview / Commit 流程负责。

---

# 2. 当前系统真实边界

## 2.1 当前完成定义

NovaStory 当前漫画接口是**章节级**：

```http
POST /api/comics/{chapter_id}/generate
```

因此本 Skill 的默认完成定义是：

```text
Project 中所有目标章节
  → 正文定稿
  → 角色/术语状态同步
  → 正式 Timeline
  → 所有正式 Scene 生图完成
  → 每章生成 Comic pages + chapter PDF
```

当所有目标章节均完成上述流程，视为“小说 → 漫画”工作流完成。

### 当前缺口

NovaStory 当前没有：

```text
Project → 一次性合并所有章节 → 单个全书漫画 PDF
```

如果用户要求“整本一个 PDF”，先完成每章 PDF，再把“项目级漫画合并”报告为独立缺失能力；不要声称当前系统已经支持。

---

## 2.2 Agent OS 能力边界

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

但 Agent OS Action Schema 当前**没有**：

- `GENERATE_ASSET`
- `GENERATE_COMIC`

因此：

```text
小说创作 / 定稿 / Timeline
  → 可以优先 Agent OS 或 REST API

场景生图 / 漫画输出
  → 使用 Director 页面或直接 REST API
```

不要让 Agent 假装已经执行了不存在的生图/漫画 Agent action。

---

# 3. 工作模式

Skill 必须支持两种模式，并允许混用。

## A. 页面模式（默认推荐）

适合人工审稿和视觉确认。

页面：

```text
/project/{PROJECT_ID}/story       小说编辑
/project/{PROJECT_ID}/characters  角色管理
/project/{PROJECT_ID}/director    导演 / 分镜 / 生图 / 漫画
/project/{PROJECT_ID}/settings    项目设置 / Story Bible
/settings                         系统 LLM / ComfyUI 设置
```

## B. API 模式

默认基础地址：

```text
http://127.0.0.1:3000/api
```

Swagger：

```text
http://127.0.0.1:3000/docs/
```

API 自动化时，始终先读当前状态，再决定是否执行写操作。

---

# 4. 核心执行原则

1. **先检查，再生成。** 不因为 Skill 被调用就重新生成已经合格的正文、Timeline 或图片。
2. **逐章状态推进。** 不要求整本小说一次全部重做。
3. **正文优先于视觉。** Chapter 未定稿时不要进入正式分镜和批量生图。
4. **Preview / dry-run 优先。** AI 改写优先 `apply=false`；接受后再写入。
5. **Timeline 是正式视觉边界。** Timeline 已存在时，API 自动化不得无条件重新生成，因为生成接口会替换当前正式分镜。
6. **场景图必须完整。** 漫画接口会跳过没有 `asset_url` 的 Scene；完整漫画验收不能只看 HTTP 200。
7. **人物一致性优先。** 主要角色在批量场景生图前应至少具有明确 description / visual tags；推荐具有 portrait 或 turnaround 资产。
8. **漫画字幕来源是 Scene.dialogue。** 需要对白/旁白的漫画，在生成 PDF 前先检查 Scene dialogue。
9. **附加资料默认不是强制上下文。** 只有用户显式开启 `context_enabled` 的资料才参与写作。
10. **不静默覆盖。** 项目 settings、Chapter content、Scene Timeline、版本资产均应先读取现状。

---

# 5. 状态机

将每个目标章节视为以下状态：

```text
S0 PROJECT_READY
  ↓
S1 CHAPTER_READY
  ↓
S2 CHAPTER_FINALIZED
  ↓
S3 WORLD_SYNCED
  ↓
S4 CHARACTER_VISUAL_READY
  ↓
S5 TIMELINE_READY
  ↓
S6 IMAGES_READY
  ↓
S7 COMIC_READY
```

Project 完成条件：

```text
所有目标 Chapter == S7
```

执行 Skill 时先识别当前状态，从最近的未完成状态继续。

---

# 6. Phase 0 — 环境与 Project Preflight

## 6.1 检查 Project 和 Chapters

API：

```http
GET /api/projects/{PROJECT_ID}
GET /api/chapters/?project_id={PROJECT_ID}
```

必须确认：

- Project 存在；
- 至少一个目标 Chapter；
- Chapter 顺序正确；
- Chapter title 可识别；
- 导入内容没有明显为空的目标章节。

不要因为 `status == draft` 就认定正文没写完；导入项目可能正文已经完整，只是状态尚未更新。

---

## 6.2 检查 LLM

页面：

```text
Settings → LLM 配置 → 验证连接
```

API：

```http
POST /api/settings/verify-llm
```

如果服务端已经保存密钥，可以使用当前配置进行验证。

LLM 不可用时：

- 可以继续人工编辑已有正文；
- 不进入 AI Draft / Skill / 自动 Timeline；
- 报告阻塞原因。

---

## 6.3 检查图像生成环境

页面：

```text
Settings → ComfyUI / 本地生成配置
```

API：

```http
GET /api/settings/vram-status
GET /api/settings/tier-b-status
GET /api/workflows/
```

说明：

- Tier B（IP-Adapter / ControlNet）不是生成漫画的硬前置；
- Pony XL 是当前默认成片路径；
- SD1.5 更适合草稿；
- 没有可用工作流/ComfyUI 时，可以完成小说和 Timeline，但不能完成 Scene 生图与漫画。

---

# 7. Phase 1 — Story Bible 与附加资料校验

## 页面

进入：

```text
Project → Settings
```

检查：

- genre
- style
- story_tags
- POV
- tone
- main_plot
- character_relations
- glossary
- 默认视觉风格
- default_model_type

不要为了“字段齐全”凭空编造信息。

如果导入文档没有提供某项，允许为空。

---

## 附加资料

页面可使用“附加资料”抽屉：

- outline
- worldbuilding
- character_notes
- reference
- other

只有显式开启 AI Context 的资料进入 WritingService。

API：

```http
GET /api/projects/{PROJECT_ID}/documents
PATCH /api/projects/{PROJECT_ID}/documents/{DOCUMENT_ID}
Content-Type: application/json

{
  "context_enabled": true
}
```

启用资料之前确认它与当前项目相关。

---

# 8. Phase 2 — 逐章正文创作与定稿

对 Chapter 按 `index ASC` 循环。

## 8.1 先判断是否真的需要写

读取：

```http
GET /api/chapters/?project_id={PROJECT_ID}
```

如果 Chapter 已经：

- 正文完整；
- summary 与正文一致；
- 没有用户要求继续扩写；

则不要自动续写，直接进入质量检查。

---

## 8.2 页面创作

进入：

```text
Project → Story
```

选择目标章节。

可用操作：

- 编辑 Chapter title；
- 编辑 Chapter summary；
- 编辑 Markdown 正文；
- AI Draft / 续写；
- Agent OS；
- 写作技能；
- 保存。

页面 AI Draft 会结合：

- 当前正文；
- Chapter summary；
- 前文章节记忆；
- Story Bible；
- 显式启用的附加资料。

---

## 8.3 API 续写

先生成预览：

```http
POST /api/agent/draft
Content-Type: application/json

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "instructions": "按当前章纲继续完成本章，保持 POV、tone 和人物连续性",
  "target_word_count": 800,
  "apply": false
}
```

`apply=false` 时先检查返回 `content`。

确认接受后有两种方式：

### 方式 A：明确保存最终正文

```http
PATCH /api/chapters/{CHAPTER_ID}

{
  "content": "FINAL_CONTENT",
  "summary": "FINAL_SUMMARY"
}
```

### 方式 B：直接 append

```http
POST /api/agent/draft

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "instructions": "继续完成本章",
  "apply": true
}
```

注意：`/agent/draft apply=true` 是**续写/追加**语义，不用于整章替换。

---

## 8.4 写作技能

当正文存在明确问题时才用技能，不要机械地每章全部跑一次。

### 电影化重写

```http
POST /api/agent/skill

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "skill": "CINEMATIC_REWRITE",
  "technique": "sensory",
  "instructions": "增强动作可视性、环境反馈和节奏",
  "apply": false
}
```

`technique`：

- `montage`
- `close_up`
- `sensory`

### 增加冲突

```json
{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "skill": "ADD_CONFLICT",
  "conflictType": "extreme_pressure",
  "intensity": "high",
  "apply": false
}
```

### 剧情反转

```json
{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "skill": "REVERSE_PLOT",
  "reversalType": "motive_switch",
  "apply": false
}
```

技能输出满意后再 `apply=true`。

注意：`/agent/skill apply=true` 会用技能输出更新 Chapter content，因此必须先预览。

---

## 8.5 Agent OS 路径

页面：

```text
顶部 Agent OS
```

推荐自然语言任务：

```text
检查当前章是否已经达到可定稿状态；先指出问题，不要写入。
```

```text
把当前章增强成更适合后续视觉分镜的小说正文，先给预览，不要直接入库。
```

```text
检查当前章人物和设定变化；只有我确认定稿后才写入角色库和术语表。
```

Agent OS 的 mutating actions 有确认机制。不要绕过确认去执行 DELETE / rewrite 等高影响操作。

---

# 9. Phase 3 — 一致性检查与章节定稿

## 9.1 全书一致性检查

API：

```http
POST /api/agent/consistency

{
  "project_id": PROJECT_ID
}
```

返回：

```text
issues[]
  severity
  location
  description
```

页面也可以通过 Story / Agent OS 发起一致性检查。

处理原则：

- critical / 明确逻辑冲突：进入对应 Chapter 修复；
- warning：判断是否影响剧情连续性；
- 纯风格偏好不能自动当逻辑错误修改正文。

推荐：

- 每完成若干章跑一次；
- 全书视觉化前必须再跑一次。

---

## 9.2 定稿 Chapter

确认：

- 正文存在；
- summary 与正文一致；
- 核心人物行为没有明显冲突；
- 后续章节约束未被破坏。

然后：

```http
PATCH /api/chapters/{CHAPTER_ID}

{
  "status": "completed"
}
```

`completed` 是流程标记，不代替内容质量检查。

---

# 10. Phase 4 — 同步角色、术语和世界状态

章节定稿后执行：

```http
POST /api/agent/impact

{
  "project_id": PROJECT_ID,
  "chapter_id": "CHAPTER_ID",
  "apply": true
}
```

它会分析并更新：

- new / updated characters；
- personality / motivation；
- visual tags；
- glossary。

如果只是预检：

```json
{
  "apply": false
}
```

### 规则

- **正文未定稿时不要 apply=true**；
- 角色/术语变化应来源于已接受的 Chapter 内容；
- 每个已定稿 Chapter 至少执行一次 impact 或人工确认“本章没有需要同步的世界变化”。

---

# 11. Phase 5 — 角色视觉准备

在大规模 Scene 生图之前，进入：

```text
Project → Characters
```

## 最低条件

主要角色至少应有：

- name；
- description；
- visual_tags（如果正文/Impact 能提供）。

## 推荐条件

主要角色建议至少生成：

1. portrait；
2. turnaround；
3. 必要时 face crop；
4. 只有真实需要时再登记/训练 LoRA。

页面 Character Manager 当前比直接 REST 更适合完成角色资产生成，因为它会：

- 读取 Project 默认 style / model / NSFW policy；
- 构建 character prompt；
- 处理 portrait / turnaround；
- 处理参考图；
- 处理 VRAM handoff 和 SSE 任务状态。

### API 辅助

```http
GET /api/characters/?project_id={PROJECT_ID}
POST /api/characters/{CHARACTER_ID}/build-prompt
POST /api/characters/{CHARACTER_ID}/crop-face
POST /api/characters/{CHARACTER_ID}/upload-asset
GET /api/characters/{CHARACTER_ID}/versions
```

角色视觉不是漫画接口的硬性数据库前置，但缺乏稳定角色定义会明显降低跨 Scene 人物一致性。

---

# 12. Phase 6 — 逐章生成正式 Timeline

只有定稿 Chapter 才进入此阶段。

## 页面

```text
Project → Director
```

选择 Chapter → Generate Timeline / 自动分镜。

Story 页面进入 Director 时不会自动生成 Timeline；真正生成发生在 Director 页面。

---

## API

先检查是否已有 Timeline：

```http
GET /api/timeline/{CHAPTER_ID}
```

如果 `timeline.length > 0`：

- 默认保留；
- 先检查已有 Scene 是否已经符合当前定稿正文；
- 只有确认需要重做时才调用 generate。

生成：

```http
POST /api/timeline/generate

{
  "chapter_id": "CHAPTER_ID",
  "mode": "narrative"
}
```

当前 Chapter-level 正式模式是 `narrative`。

不要使用：

- `cinematic_grid`
- `nine_shot_coverage`

作为 Chapter-level Timeline mode；它们已经被弃用。

---

## Timeline 验收

每个 Scene 至少检查：

- `index`
- `visual_prompt`
- `dialogue`（如果漫画要显示对白/旁白）
- `shot_type`
- `camera_angle`
- `camera_movement`
- `negative_prompt`（如有）

修改 Scene：

```http
PUT /api/timeline/scene/{SCENE_ID}
```

例如：

```json
{
  "visual_prompt": "...",
  "dialogue": "...",
  "shot_type": "Medium Shot",
  "camera_angle": "Eye-level",
  "camera_movement": "Static"
}
```

---

# 13. Phase 7 — 可选 Coverage 优化

Coverage 是单 Scene 的 9 镜头候选，不是 Chapter Timeline 的替代品。

只在以下情况使用：

- 关键戏构图不满意；
- 需要更多镜头语言候选；
- 当前 Scene 难以直接生图；
- 想把一个关键 Scene 扩展成多个正式镜头。

生成：

```http
POST /api/scenes/{SCENE_ID}/coverage
```

得到 9 个 candidate shots。

应用到源 Scene：

```http
POST /api/scenes/coverage/{SHOT_ID}/apply
```

提升成正式 Scene：

```http
POST /api/scenes/coverage/{SHOT_ID}/promote

{
  "position": "after"
}
```

`position`：

- `before`
- `after`
- `replace`

Coverage 完成后重新读取正式 Timeline，后续只对正式 `scene` 表中的 Scene 生图。

---

# 14. Phase 8 — Scene 生图

## 页面模式（推荐）

进入：

```text
Project → Director → 分镜出图控制
```

推荐：

- Asset mode：`Single image`（漫画目标）；
- 确认 Project render config；
- 检查风格、model preset、SFW/NSFW policy；
- 使用 `Generate all shots` 顺序批量生图。

批量生成是顺序执行，适合有限 VRAM 环境。

如果只是修某一 Scene，使用单镜头生成或新建 Scene Version，不要整章全部重跑。

---

## API 模式

先取得 Workflow：

```http
GET /api/workflows/
```

对每个正式 Scene：

```http
POST /api/assets/generate

{
  "scene_id": SCENE_ID,
  "mode": "standard",
  "workflow": {
    "prompt": "FINAL_SCENE_PROMPT",
    "model_type": "pony",
    "style_preset": "PROJECT_STYLE",
    "gen_type": "scene",
    "shot_type": "SCENE_SHOT_TYPE",
    "reference_tier": "A",
    "project_settings": {
      "nsfw_mode": "off"
    }
  },
  "generation_params": {
    "steps": 28,
    "cfg": 6.5,
    "sampler_name": "euler_ancestral",
    "scheduler": "normal"
  }
}
```

实际 workflow / generation_params 以项目当前工作流和设置为准；不要无条件硬编码示例参数。

响应：

```json
{
  "task_id": "...",
  "status": "processing"
}
```

监控：

```http
GET /api/assets/status/{TASK_ID}
```

或：

```http
GET /api/assets/stream/{TASK_ID}
```

SSE 完成条件：

```text
status == completed
AND image_url != null
```

---

# 15. Scene 图片验收与修复循环

对每个 Scene：

```text
IF asset_status == completed AND asset_url exists
    → 进入下一 Scene
ELSE
    → 修复
```

修复顺序：

1. 检查 `visual_prompt`；
2. 检查人物描述/visual tags；
3. 检查 shot type 是否与构图需求冲突；
4. 检查 Project style / model；
5. 需要 A/B 时创建 Scene Version；
6. 重新生成。

Scene Version API：

```http
GET  /api/timeline/scene/{SCENE_ID}/versions
POST /api/timeline/scene/{SCENE_ID}/versions
POST /api/timeline/scene/{SCENE_ID}/versions/{VERSION}/activate
```

不要为了修一张图覆盖已经满意的旧版本。

---

# 16. Phase 9 — 漫画生成

## 16.1 硬前置

生成漫画前必须检查正式 Timeline：

```http
GET /api/timeline/{CHAPTER_ID}
```

完整漫画要求：

```text
每个正式 Scene 都有 asset_url
```

因为漫画接口只处理有 `asset_url` 的 Scene。

另外检查：

```text
Scene.dialogue
```

漫画页字幕直接取自 `scene.dialogue`。

如果需要字幕但 dialogue 为空，先更新 Scene。

---

## 16.2 页面

```text
Project → Director
  → Export & production
  → Generate Comic
```

生成完成后：

```text
View Comic
  → 翻页检查
  → Download PDF
```

---

## 16.3 API

```http
POST /api/comics/{CHAPTER_ID}/generate
```

成功响应核心字段：

```json
{
  "status": "completed",
  "chapter_id": "...",
  "total_scenes": 12,
  "generated_count": 12,
  "pages": [
    {
      "scene_id": 1,
      "url": "/static/comics/comic_scene_1.jpg"
    }
  ],
  "pdf_url": "/static/comics/chapter_xxx_comic.pdf"
}
```

### 完整验收条件

不要只检查 `status == completed`。

必须检查：

```text
generated_count == total_scenes
AND pages.length == total_scenes
AND pdf_url exists
```

如果：

```text
generated_count < total_scenes
```

说明至少一个 Scene 没有可用图片或漫画页渲染失败。

回到 Phase 8 修复缺失 Scene，再重新生成该章漫画。

---

# 17. Phase 10 — 全 Project 循环

对 Chapters：

```pseudo
chapters = GET /chapters/?project_id=PROJECT_ID
sort chapters by index

for chapter in chapters:
    if chapter is outside user target scope:
        continue

    ensure chapter finalized
    ensure impact/world sync done
    ensure main characters visually ready
    ensure timeline exists and matches final content
    ensure all formal scenes have image assets
    generate chapter comic
    verify generated_count == total_scenes
    record pdf_url
```

最终输出 manifest：

```text
Project: {title}

Chapter 1
- chapter_id
- scenes
- generated_pages
- pdf_url

Chapter 2
- ...
```

当前系统没有 Project-level PDF merge；manifest 中保留每章 `pdf_url`。

---

# 18. 页面优先 vs API 优先选择规则

| 阶段 | 默认路径 | 原因 |
|---|---|---|
| Story Bible | 页面 | 防止覆盖未知 settings key |
| 附加资料 | 页面 | 用户明确控制 AI Context |
| 正文人工修改 | 页面 | 最适合审稿 |
| AI Draft / Skill | API 或 Agent OS | 可 dry-run / 可编排 |
| 一致性检查 | API / Agent OS | 结构化 issues |
| Chapter Impact | API / Agent OS | 明确 apply 边界 |
| Character visual | 页面优先 | 当前 UI 已封装 prompt/ref/VRAM 流程 |
| Timeline | 页面或 API | 两者语义清晰 |
| Coverage | 页面/API | 按关键 Scene 使用 |
| Scene 生图 | Director 页面优先 | 已封装 Project style、人物参考、SSE、VRAM |
| 漫画 | 页面或 API | Chapter-level endpoint 明确 |

---

# 19. 不允许的快捷方式

不要：

- 导入完成后直接跳过正文验收到 Timeline；
- 每章无条件调用 AI 续写；
- 每章无条件执行所有写作 Skill；
- Chapter 未定稿时 `APPLY_CHAPTER_IMPACT`；
- Timeline 已存在时无条件重新生成；
- 使用已弃用 Chapter-level `nine_shot_coverage`；
- Scene 缺图时仍把漫画接口返回的部分页面当“完整漫画”；
- 为了人物一致性强制所有 Scene 使用单人物 IP-Adapter；
- 把 Agent OS 当成支持 `GENERATE_ASSET` / `GENERATE_COMIC`；
- 在未读取当前 Project settings 的情况下 PUT 一个全新的 settings JSON 覆盖已有配置。

---

# 20. 失败恢复

## LLM 失败

- 保留现有 Chapter；
- 不修改正文；
- 修复 `/api/settings/verify-llm` 后从当前章继续。

## Timeline 失败

- 现有 Timeline 若仍存在，不先删除；
- 检查 Chapter content；
- 再执行 generate。

## 生图失败

- 读取 `/api/assets/status/{task_id}`；
- 必要时 `/api/assets/cancel`；
- 修改该 Scene 或新建版本；
- 只重试失败 Scene。

## Comic 生成失败

- `No scenes found` → 回 Phase 6；
- `No scenes have generated images` → 回 Phase 8；
- `generated_count < total_scenes` → 找出无图 Scene，再补图；
- PDF 有页但字幕错误 → 修 `scene.dialogue` 后重新生成漫画。

---

# 21. Skill 最终报告模板

完成后报告：

```markdown
## NovaStory 创作完成报告

Project: <title> (#<project_id>)

### 小说
- 目标章节：N
- 已定稿：N
- 一致性检查：通过 / 尚有 X 项
- 角色同步：完成 / 部分完成

### 角色视觉
- 主要角色：N
- portrait/turnaround 就绪：N/N

### 分镜
- 已生成 Timeline：N/N chapters
- Scene 总数：N

### 生图
- Scene 图片完成：N/N
- 失败/待重试：0

### 漫画
- Chapter PDF：N/N
- 每章 generated_count == total_scenes：是/否
- PDF URLs:
  - Chapter 1: ...
  - Chapter 2: ...

### 当前系统缺口
- Project-level 全书 PDF merge：未实现（如用户需要）
```

---

# 22. 最终 Definition of Done

只有同时满足以下条件，才能宣布“该目标范围已完成漫画创作”：

- [ ] Project / Chapter 数据可读取；
- [ ] 目标 Chapter 正文已接受并定稿；
- [ ] 全书/目标范围不存在未处理的关键一致性问题；
- [ ] 已定稿 Chapter 的角色/术语变化已同步或人工确认无需同步；
- [ ] 主要角色具备稳定视觉定义；
- [ ] 每个目标 Chapter 有正式 narrative Timeline；
- [ ] 每个正式 Scene 均有成功 `asset_url`；
- [ ] 需要字幕的 Scene 已有正确 dialogue；
- [ ] 每个目标 Chapter 的 Comic API 成功；
- [ ] 每章 `generated_count == total_scenes`；
- [ ] 每章 `pdf_url` 可访问；
- [ ] 最终报告记录所有 Chapter PDF。

如果任何一项不满足，不要把工作流标记为 completed；从对应 Phase 继续修复。
