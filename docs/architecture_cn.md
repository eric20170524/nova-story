# NovaStory 技术架构

## 总体结构

```text
React/Vite
    │ REST + SSE
    ▼
Fastify/TypeScript
    ├── Project / Chapter / Character
    ├── Timeline / Coverage / Comics
    ├── Creative Agent / Assistant
    ├── LLM Provider Layer
    └── Media Provider Layer
           ├── Gemini / Imagen
           ├── OpenAI / xAI
           └── ComfyUI
    │
    ├── SQLite
    └── Redis（可选进度广播）
```

前后端统一 TypeScript，Zod 同时承担输入校验和 AI 结构化输出校验。Fastify 负责 REST、SSE、静态素材和 OpenAPI；SQLite 是本地优先的唯一事实源，Redis 不参与业务持久化。

## 核心数据流

1. 用户导入或编辑章节。
2. LLM 将章节拆解为正式 `Scene` 时间线。
3. 对单个 Scene 可生成独立的 9 镜头 `CoverageGroup/CoverageShot`。
4. 候选镜头可以覆盖源场景，也可以按前、后或替换方式提升到正式时间线。
5. 生图任务选择云提供方或 ComfyUI，结果写入静态目录并更新 Scene。
6. 漫画服务读取已生成素材，栅格化字幕并输出页面和 PDF。

## 边界与长期原则

- `main` 仅作为历史 Python 功能基准，不再进行双写。
- `nodejs` 是唯一持续演进实现。
- 路由存在性由 48 操作契约测试锁定。
- 数据结构只能通过版本迁移演进，不能在路由中临时建表。
- Redis 必须保持可选；未配置时状态查询和 SSE 使用进程内/数据库降级。
- LLM 与生图提供方分层，避免用文本模型配置误选图片提供方。
- 外部 AI、ComfyUI 和字体依赖需要在目标环境执行冒烟测试。
