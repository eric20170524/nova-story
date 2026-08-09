# NovaStory 技术架构

文档索引：[README.md](./README.md)。

## 总体结构

```text
React/Vite
    │ REST + SSE
    ▼
Fastify/TypeScript
    ├── Project / Chapter / Character (+ visual versions)
    ├── Timeline / Scene versions / Coverage / Comics
    ├── Creative Agent / Assistant
    ├── LLM Provider Layer
    └── Media Provider Layer
           ├── Gemini / Imagen
           ├── OpenAI / xAI
           └── ComfyUI（Pony XL / SD1.5；档位 A/B 参考）
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
5. 生图任务选择云提供方或 ComfyUI：
   - 本地默认 **Pony XL** 成片 / **SD1.5** 草稿；
   - 策略层统一 NSFW、风格 booster、LoRA 栈与参考门禁；
   - 结果写入静态目录并更新 Scene（可写入场景版本资产）。
6. 漫画服务读取已生成素材，栅格化字幕并输出页面和 PDF。

## 本地生图分层

```text
请求 model_type / style_preset / refs
        │
        ▼
image_generation_policy   → LoRA 栈 + 提示增强 + NSFW
reference_generation_policy → 是否 img2img / IP-Adapter / ControlNet
generation_service        → 解析工作流、注入节点、调 ComfyUI
        │
        ├── pony_xl_12gb.json
        └── sd15_draft_12gb.json
```

详见 [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md) 与 [local_image_generation_deployment_cn.md](./local_image_generation_deployment_cn.md)。

## 边界与长期原则

- 当前仓库 **Node/Fastify** 为唯一持续演进实现（历史 Python 仅作背景）。
- 路由存在性由契约测试锁定。
- 数据结构只能通过版本迁移演进，不能在路由中临时建表。
- Redis 必须保持可选；未配置时状态查询和 SSE 使用进程内/数据库降级。
- LLM 与生图提供方分层，避免用文本模型配置误选图片提供方。
- 外部 AI、ComfyUI 和字体依赖需要在目标环境执行冒烟测试。
- 退役能力（如 FLUX.1-dev GGUF 内置工作流）应在文档与 seed 清理中同步下线。
