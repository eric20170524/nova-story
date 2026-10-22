# NovaStory Backend API

基础地址：`http://127.0.0.1:3000/api`（默认仅回环监听）

| 资源 | URL |
| --- | --- |
| 交互文档（Swagger UI） | `http://127.0.0.1:3000/docs/` |
| OpenAPI JSON | `http://127.0.0.1:3000/openapi.json` |

校验失败统一返回 HTTP 422：

```json
{
  "detail": [
    {
      "type": "invalid_type",
      "loc": ["field"],
      "msg": "Invalid input"
    }
  ]
}
```

文档索引见 [README.md](./README.md)。

## 连续性与单场分轮制作（CT00–CT22）

以下路径相对于 `/api`，不替代既有整章采纳或 coverage 三入口。读取不产生建议；模型建议启动返回 202，确认必须经过独立人工核对。

| 方法与路径 | 作用 |
| --- | --- |
| GET `/scripts/:scriptId/continuity?target_scene_id=…` | 原文、实物、入场/变化/出场、时刻、时间计划、旧图与核对记录 |
| POST `/scripts/:scriptId/continuity/preview`、`confirm` | 只读影响预览、人工确认状态；完整核对可带 `time_plan` |
| POST `/scripts/:scriptId/continuity/undo-preview`、`undo` | 预览/撤销为新修订，旧图和无关成品保留 |
| POST `/scripts/:scriptId/continuity/refresh-shot` | 人工确认实际读取时刻/属性，创建恢复版本 |
| POST `/scripts/:scriptId/continuity/time-preview`、`time-confirm` | 人工故事日/回忆边界的只读预览和确认 |
| POST `/scripts/:scriptId/continuity/suggestions` | 创建或复用本场模型建议任务，`automatic_accepted=0` |
| GET `/scripts/:scriptId/continuity/suggestion-tasks`、`suggestion-tasks/:taskId` | 任务、断点、原输出、预算与待核对项 |
| POST `/scripts/:scriptId/continuity/suggestion-tasks/:taskId/cancel` | 持久化取消，仍保留诊断与断点 |
| GET `/scripts/:scriptId/production` | 本场制作轮次、候选、文字覆盖与正式镜头 |
| POST `/scripts/:scriptId/production/candidates` | 保存本场骨架/定样/补齐候选与覆盖缺口 |
| POST `/scripts/:scriptId/storyboard-candidates/:changeId/preview-scene`、`apply-scene` | 独立局部预览/采纳事务，不改其他场次 |
| GET `/scripts/:scriptId/production/frames/:sceneId` | 当前图、冻结状态/参考、相邻镜与图片核对 |
| POST `/scripts/:scriptId/production/frames/:sceneId/references` | 冻结同一实物及人物的具体历史参考版本 |
| POST `/scripts/:scriptId/production/frames/:sceneId/review` | 接受/拒绝本版图片，六项检查，不回写剧情 |
| POST `/scripts/:scriptId/production/frames/:sceneId/redraw` | 显式新版本重绘；须有当前状态与参考指纹 |
| POST `/scripts/:scriptId/production/queue-preview`、`queue` | 列出有效缺图/跳过理由并按本场排队；重复点击不重复任务 |

状态/时间核对使用 `review_action: "human_review"`、`expected_script_revision`、`expected_continuity_revision`、`request_key`、`reason`；确认预览另带 `expected_impact_hash`。`time_plan` 为 `schema_version:1, policy_version:"continuity-time-1", initial_day_id, boundaries`，每边界包含 `script_scene_id`、`kind`、精确完整 `evidence`。`new_day` 另需新 `day_id` 及每属性 `inherit/unknown` 规则；`flashback` 另需 `day_id, branch_id, anchor{script_scene_id,phase}, rules`；`return_reality` 只关闭匹配分支；`unknown` 不断言继承。客户端 actor/authority 不会被信任。

身体持物手别为唯一 v2 属性，值 `physical_left/physical_right/both/unheld`，读取同时包含已确认 holder；其他十一项属性仍 v1。模型建议不可自动确认；复杂多人持有、消耗量和轴线未支持。

连续性错误返回 `{code,detail}`：冲突/来源过期/未确认读取通常 409，无效请求 422，越出所属剧本可为 404。保留草稿、旧图、旧版本，并由返回问题引导人工核对。接受图片要求当前版本、图片地址、冻结参考指纹及六项检查全部通过；拒绝当前展示的过期图可以记录，未绑定旧项目图须先完成参考核对。

## 接口清单

| 分组 | 方法与路径 | 作用 |
|---|---|---|
| Projects | `GET /projects/` | 项目列表 |
| | `POST /projects/` | 创建项目 |
| | `GET /projects/{id}` | 项目详情 |
| | `PUT /projects/{id}` | 更新项目；`settings.image_generation` 包含唯一项目模型、可选同模型工作流、画风、画布和 NSFW 策略 |
| | `DELETE /projects/{id}` | 事务级联删除项目 |
| | `POST /projects/import` | 从 TXT 导入项目、章节和角色声明 |
| | `POST /projects/{id}/duplicate` | 完整复制项目 |
| | `GET /projects/{id}/export` | 导出完整项目 JSON |
| Chapters | `GET /chapters/?project_id={id}` | 章节列表 |
| | `POST /chapters/` | 创建章节 |
| | `PATCH /chapters/{id}` | 更新章节 |
| | `DELETE /chapters/{id}` | 事务级联删除章节 |
| | `PUT /chapters/{id}/move` | 调整章节顺序 |
| Characters | `GET /characters/?project_id={id}` | 角色列表 |
| | `POST /characters/` | 创建角色 |
| | `GET /characters/{id}` | 角色详情 |
| | `PUT /characters/{id}` | 更新角色 |
| | `DELETE /characters/{id}` | 删除角色 |
| | `POST /characters/extract` | 从章节提取角色并分析角色演化 |
| | `POST /characters/{id}/build-prompt` | 构建角色生图提示词（`model_type`: `pony` \| `sd15`） |
| | `POST /characters/upload-image` | 上传角色图片 |
| | `POST /characters/{id}/upload-asset` | 上传并绑定角色资产 |
| | `GET /characters/{id}/versions` | 角色视觉版本列表 |
| | `POST /characters/{id}/versions` | 新建角色版本 |
| | `POST /characters/{id}/versions/{version}/activate` | 激活角色版本 |
| Timeline | `GET /timeline/{chapter_id}` | 获取时间线镜头。旧称“正式分镜”，指镜头列表，不是 Track 8 的已采纳正式分镜图 |
| | `POST /timeline/generate` | 自动拆解章节并原子替换分镜 |
| | `PUT /timeline/scene/{scene_id}` | 更新分镜 |
| | `GET /timeline/scene/{scene_id}/versions` | 场景内容/资产版本列表 |
| | `POST /timeline/scene/{scene_id}/versions` | 新建场景版本 |
| | `POST /timeline/scene/{scene_id}/versions/{version}/activate` | 激活场景版本 |
| Coverage | `POST /scenes/{scene_id}/coverage` | 为单场景生成 9 个候选镜头 |
| | `GET /scenes/{scene_id}/coverage` | 获取候选镜头版本 |
| | `POST /scenes/coverage/{shot_id}/apply` | 应用候选镜头到源场景 |
| | `POST /scenes/coverage/{shot_id}/promote` | 插入、替换或提升候选镜头 |
| Creative | `POST /agent/storyboard-grid` | 生成九宫格提示词 |
| | `POST /agent/draft` | AI 续写（可选 `project_id`/`chapter_id`/`context_text` 分层记忆；默认不写 condensed，除非 `apply`） |
| | `POST /agent/analyze` | 内容分析 |
| | `POST /agent/consistency` | 全书逻辑体检 `{ project_id }` → `{ issues[] }` |
| | `POST /agent/impact` | 定稿同步角色、术语、主线时间线与人物关系 `{ project_id, chapter_id, apply? }` |
| | `POST /agent/skill` | 写作技能（电影化/冲突/反转） |
| | `GET /agent/context/{chapter_id}` | 获取章节、结构、角色与术语表上下文 |
| Assistant | `POST /assistant/chat` | Agent OS 决策（多 actions + needs_confirmation） |
| | `POST /assistant/execute` | 确认后执行 action 列表（非事务原子；逐条 status） |
| Projects | `GET /projects/{id}/glossary` | 术语表列表 |
| | `POST /projects/{id}/glossary` | 新增术语 |
| | `PUT /projects/{id}/glossary/{glossaryId}` | 更新术语 |
| | `DELETE /projects/{id}/glossary/{glossaryId}` | 删除术语 |
| Assets | `POST /assets/generate` | 提交生图任务 |
| | `GET /assets/status/{task_id}` | 获取任务状态 |
| | `GET /assets/stream/{task_id}` | SSE 任务进度 |
| | `POST /assets/cancel` | 中断 ComfyUI 当前任务 |
| Workflows | `GET /workflows/files` | 内置工作流文件列表 |
| | `GET /workflows/` | 工作流列表 |
| | `POST /workflows/` | 创建工作流 |
| | `GET /workflows/{id}` | 工作流详情 |
| | `PUT /workflows/{id}` | 更新工作流 |
| | `DELETE /workflows/{id}` | 删除工作流 |
| Settings | `GET /settings/` | 读取系统设置（**不含**明文 API Key，仅 `llm.has_api_key`） |
| | `POST /settings/` | 保存系统设置（空 `api_key` 表示不修改已有密钥） |
| | `POST /settings/verify-llm` | 验证 LLM 连接和推理（可用服务端已存密钥） |
| | `GET /settings/tier-b-status` | Tier B（IP-Adapter / ControlNet）探测结果 |

## 常用请求

### 自动分镜

```json
POST /api/timeline/generate
{
  "chapter_id": "chapter-uuid",
  "mode": "narrative"
}
```

### 章节定稿同步

`POST /api/agent/impact` 与 `APPLY_CHAPTER_IMPACT` 使用同一流程。`apply` 默认 `true`：在同一事务中同步角色、术语、`project.settings.main_plot`（角色状态、事件、伏笔）与 `project.settings.character_relations`；`false` 返回预览，不写库。

结果保留 `newOrUpdatedCharacters`、`newOrUpdatedGlossary` 等字段，并包含：

| 字段 | 说明 |
| --- | --- |
| `chapterContinuity` | `characterStates`、`events`、`foreshadowing`、`characterRelations` 四组本章事实（字符串数组） |
| `mainPlotEntry` / `characterRelationsEntry` | 本章写入两项设定的文本 |
| `mainPlotChanged` / `characterRelationsChanged` | 本次合并是否改变对应设定（预览时表示拟变更） |
| `applied` | 是否已提交写入 |

章节自动记录保存在 `settings.chapter_impact_entries`，重新定稿替换本章原记录并保留作者设定。长章分段提取并合并，任何分段提取失败则不提交；分析期间正文变化需重试。旧版执行没有这些记录，需要重新定稿补齐。

### 生图

`workflow` 中常用字段（本地 ComfyUI）：

| 字段 | 说明 |
| --- | --- |
| `prompt` / `negative_prompt` | 正负向 |
| `model_type` | `pony`（默认成片）\| `sd15`（草稿）；legacy `flux` 回落 pony |
| `style_preset` | 画风预设 key（如 `sensual_gufeng`） |
| `gen_type` | `scene` \| `portrait` \| `turnaround` 等 |
| `shot_type` | 镜头类型（影响风格剥离与参考门禁） |
| `character_ref_url` | 可选人物参考；**双人/远景/动作镜不会启用 IP-Adapter** |
| `composition_ref_url` | 可选构图参考（ControlNet） |
| `reference_tier` | `"A"` 强制纯文本标签路径 |
| `nsfw_enabled` / `project_settings.nsfw_mode` | 覆盖 NSFW 策略 |
| `character_lora` | 角色 LoRA 文件名 |
| `new_version` | 是否新建场景内容版本 |
| `project_settings.output_spec` | 项目级分镜画布：`aspect_ratio` / `resolution` / `orientation_policy` |

```json
POST /api/assets/generate
{
  "scene_id": 42,
  "mode": "standard",
  "workflow": {
    "prompt": "2girls, martial arts clash, score_9, source_anime",
    "model_type": "pony",
    "style_preset": "sensual_gufeng",
    "gen_type": "scene",
    "shot_type": "Wide Shot",
    "reference_tier": "A",
    "project_settings": {
      "nsfw_mode": "off",
      "output_spec": {
        "aspect_ratio": "3:4",
        "resolution": "standard",
        "orientation_policy": "fixed"
      }
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

分镜画布的优先级为：本次请求 `workflow.output_spec` / `generation_params.output_spec`
→ 项目 `project_settings.output_spec` → 系统默认（固定 `3:4`、标准清晰度）。高级调用方也可在
`generation_params` 中同时传入符合 `3:4`、`4:3` 或 `1:1` 的 `width` 与 `height`；后端会对齐到 64 的倍数。`auto_by_shot`
仅在明确启用时根据 Wide / Establishing / Overhead 等镜头切换为横版。九宫格和角色三视图仍使用专用画布。

参考策略详见 [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md)。

### 任务状态与取消

- `GET /api/assets/status/{task_id}` — 读 `generation_task`（SQLite）+ 内存缓存；重启后仍可查询；完成后含 `width` / `height` / `aspect_ratio`
- `POST /api/assets/cancel` — 可选 body：`{ "task_id": "..." }` 或 `{ "prompt_id": "..." }`
  - 有 `comfy_prompt_id` 时：`POST ComfyUI/queue` 删除队列项，并 `POST /interrupt` 中断当前执行

### 场景版本

```http
GET  /api/timeline/scene/42/versions
POST /api/timeline/scene/42/versions
POST /api/timeline/scene/42/versions/2/activate
```

### Tier B 状态

```http
GET /api/settings/tier-b-status
```

返回字段含 `characterAdapter`、`compositionControl`、`full_dual_ref`、`missing` 等。

### Coverage

```http
POST /api/scenes/42/coverage
```

```json
POST /api/scenes/coverage/99/promote
{
  "position": "after"
}
```
