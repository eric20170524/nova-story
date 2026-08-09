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

## 接口清单

| 分组 | 方法与路径 | 作用 |
|---|---|---|
| Projects | `GET /projects/` | 项目列表 |
| | `POST /projects/` | 创建项目 |
| | `GET /projects/{id}` | 项目详情 |
| | `PUT /projects/{id}` | 更新项目（含 `settings`：默认风格 / `default_model_type` / `nsfw_mode` 等） |
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
| | `POST /characters/{id}/crop-face` | 从角色素材裁剪头像 |
| | `POST /characters/{id}/train-lora` | 登记角色 LoRA 资产 |
| | `POST /characters/upload-image` | 上传角色图片 |
| | `POST /characters/{id}/upload-asset` | 上传并绑定角色资产 |
| | `GET /characters/{id}/versions` | 角色视觉版本列表 |
| | `POST /characters/{id}/versions` | 新建角色版本 |
| | `POST /characters/{id}/versions/{version}/activate` | 激活角色版本 |
| Timeline | `GET /timeline/{chapter_id}` | 获取正式分镜 |
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
| | `POST /agent/draft` | AI 续写 |
| | `POST /agent/analyze` | 内容分析 |
| | `GET /agent/context/{chapter_id}` | 获取章节、结构和角色上下文 |
| Assistant | `POST /assistant/chat` | 导演助手对话与工具调用 |
| Assets | `POST /assets/generate` | 提交生图任务 |
| | `GET /assets/status/{task_id}` | 获取任务状态 |
| | `GET /assets/stream/{task_id}` | SSE 任务进度 |
| | `POST /assets/cancel` | 中断 ComfyUI 当前任务 |
| Comics | `POST /comics/{chapter_id}/generate` | 生成带字幕漫画页和 PDF |
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
    "project_settings": { "nsfw_mode": "off" }
  },
  "generation_params": {
    "steps": 28,
    "cfg": 6.5,
    "sampler_name": "euler_ancestral",
    "scheduler": "normal"
  }
}
```

参考策略详见 [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。

### 任务状态与取消

- `GET /api/assets/status/{task_id}` — 读 `generation_task`（SQLite）+ 内存缓存；重启后仍可查询  
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
