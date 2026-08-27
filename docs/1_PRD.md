# 1_PRD.md: 产品需求文档

## 1. 愿景与目标

NovaStory 是本地优先的 **小说 → 分镜 → 漫画** 工作台：用户能干预每一层（正文、角色、分镜、生图），而不是一次黑盒出片。

当前 Sprint 要解决的用户痛点：正文已经写清了道具和动作，导出的分镜图却抽象、重复、看不懂故事。

## 2. 核心用户路径

```text
导入或撰写章节
  → 定稿正文（本 Sprint 不改剧情）
  → 收敛角色 visual_tags
  → 生成 narrative Timeline
  → 每镜 visual_prompt 可审、可改、可版本化
  → ComfyUI（默认 Pony XL）出图
  → 验收图片 / 只重做失败镜
  → 单章或整本漫画 PDF
```

Aha：读者不看字幕也能从画面认出「按了导览图上的音符按钮」，而不是连续六张同一条走廊里的猫。

## 3. MVP 功能范围

### P0（本 Sprint 必须有）

- 分镜 Prompt 对读者可辨：每镜有独特的可见动作或关键道具。
- 角色物种/毛色锁定在角色圣经，不在 rewrite 提示词里发明 `kitten` / `1girl`。
- 非视觉词（声音、气味、心理、元叙事）不得进入 `visual_prompt`。
- 隐喻必须编译成可画物体（例如云朵看台 ≠ 真云真山）。
- 相邻镜不得复制粘贴同一段环境描述。
- 质量/风格词不得抢 CLIP 前段；项目世界观不得写死进每镜 prefix。

### P1（本 Sprint 最好有）

- Timeline 先出镜头契约，再由代码编译 Pony 词。
- `shot_spec` 持久化契约，支持按镜重编译而不整章打散正文。
- 负向词按镜头契约生成，而不是整章同一串身份锁。

### 已有、本 Sprint 不重做

- 小说导入 / 编辑 / Agent OS 写作
- 角色 portrait / turnaround
- ComfyUI 工作流、LoRA 策略、档位 A/B
- 漫画 PDF / readiness
- 整本 `novel-to-comic` 编排（见 `skills/novel-to-comic/SKILL.md`）

## 4. 🚫 明确不做的事

**AI 必读：** 除非主人明确要求，禁止自行添加：

- 修改第 2–10 章（或任何章）**正文剧情**来迁就模型。
- 把 `generateTimeline` 的导演说明写得更长，当作修复。
- 再加一层「整章 visual 散文 rewrite」，并把旧 Prompt 当 few-shot。
- 恢复已退役的 FLUX.1-dev GGUF 内置工作流。
- 视频、TTS、Force Alignment、时间线剪辑 DSL。
- 多租户 / RBAC / 云端后台管理。
- 为修图给所有 Scene 强制单人物 IP-Adapter。
- 覆盖已接受的第 1 章 Timeline / 图片。
- 无条件 `/timeline/generate` 替换整章已有合格分镜。
- 把 `dreamcore amusement park` 写死进每一镜 prefix。

## 5. 核心实体

| 实体 | 本 Sprint 含义 |
|---|---|
| Project | 故事容器；style / model / NSFW 在 settings。 |
| Chapter | 正文是视觉源。未定稿不批量生图。 |
| Character | `visual_tags` 是跨镜身份锁。 |
| Scene | 正式分镜。`visual_prompt` 给 Pony；`dialogue`/`narration` 给字幕；`audio_prompt` 给声音。 |
| shot_spec | 镜头契约 JSON（intent / location / action / props）。 |
| Scene Version | Prompt 重编译和图片 A/B 的安全层。 |
| Coverage | 单镜 9 候选，不替代正式 Timeline。 |
