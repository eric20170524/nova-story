# NovaStory Backend API

基础地址：`http://localhost:3000/api`

可交互文档：`http://localhost:3000/api/docs`

OpenAPI JSON：`http://localhost:3000/api/openapi.json`

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

## 接口清单

| 分组 | 方法与路径 | 作用 |
|---|---|---|
| Projects | `GET /projects/` | 项目列表 |
| | `POST /projects/` | 创建项目 |
| | `GET /projects/{id}` | 项目详情 |
| | `PUT /projects/{id}` | 更新项目 |
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
| | `POST /characters/{id}/build-prompt` | 构建角色生图提示词 |
| | `POST /characters/{id}/crop-face` | 从角色素材裁剪头像 |
| | `POST /characters/{id}/train-lora` | 登记角色 LoRA 资产 |
| | `POST /characters/upload-image` | 上传角色图片 |
| | `POST /characters/{id}/upload-asset` | 上传并绑定角色资产 |
| Timeline | `GET /timeline/{chapter_id}` | 获取正式分镜 |
| | `POST /timeline/generate` | 自动拆解章节并原子替换分镜 |
| | `PUT /timeline/scene/{scene_id}` | 更新分镜 |
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
| Settings | `GET /settings/` | 读取系统设置 |
| | `POST /settings/` | 保存系统设置 |
| | `POST /settings/verify-llm` | 验证 LLM 连接和推理 |

## 常用请求

自动分镜：

```json
POST /api/timeline/generate
{
  "chapter_id": "chapter-uuid",
  "mode": "narrative"
}
```

生成单场景候选镜头：

```http
POST /api/scenes/42/coverage
```

提升候选镜头：

```json
POST /api/scenes/coverage/99/promote
{
  "position": "after"
}
```

生图：

```json
POST /api/assets/generate
{
  "scene_id": 42,
  "mode": "standard",
  "workflow": {
    "prompt": "cinematic close-up of the protagonist"
  },
  "generation_params": {
    "steps": 28,
    "cfg": 6.5
  }
}
```
