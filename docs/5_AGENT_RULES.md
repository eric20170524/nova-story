# 5_AGENT_RULES.md: AI 编码与行为准则

## 1. 核心编码信条

- **代码是负债：** 用最少改动打通契约编译，不顺手重构 Director / Agent OS。
- **单一事实源：** Prompt 词表、隐喻映射、镜头配额只住在 `docs/best_practice_scene_visual_prompt.md` + 一个实现模块。禁止 `prompts.ts` 与 sanitizer 各维护一份互相漂移的黑名单。
- **改前查全链：** 动 `compileComfyWorkflow`、`buildPromptEnhancement`、`TimelineShotSchema`、`scene` 写入前，grep 路由、测试、导入导出。
- **拒绝半成品：** 不要 `// TODO`、不要留下中文 visual_prompt fallback。做不到就 `[Blocked]`。
- **跨文件闭环：** schema 一变，llm.ts / timeline 路由 / 测试 / import 同轮改完。
- **测试先行：** 编译器、消毒、uniqueness、负向编译必须有 `.test.ts`。不依赖 ComfyUI 证明 P0/P1。
- **不要猜测 API：** 接口以 `docs/API.md` 和现有 route 为准。

## 2. 🛡️ HITL

以下必须停下来问主人，不得自行执行：

- 对用户库 `sql_app.db` 批量改第 2–10 章正式 Scene（Phase 3）
- `DELETE` / 覆盖已有合格 Timeline
- `rm`、`drop table`、杀 ComfyUI/Ollama 进程
- 把 API Key 写入文件或日志
- 扩大范围到视频、FLUX、改章节正文

文档 Phase 0 完成后，**必须等主人确认再写代码。**

## 3. 思考与验证

- 大变动先对照 `docs/2_ARCHITECTURE.md` 的目标管道，确认没有退回「更长的导演散文」。
- 测试红了先读失败断言和 log，禁止连跑三次同一失败命令当进度。
- 编译器任务：`cd backend && npm test` 相关文件通过才打勾。
- 拒绝假成功：库里还能搜到新写入的 `environmental storytelling` 前缀，任务就不算完。

## 4. 错误处理

- 后端：抛给 Fastify 的 `detail`；logger.error 带 scene_id / chapter_id。
- 前端若改到：`useToast()`，文案走 `locales.ts`。
- LLM 覆盖不足（缺 scene_id）：失败，不部分写入。

## 5. 🔄 学习循环

解决本 Sprint 的坑后，更新：

- 词表 / 规则 → `docs/best_practice_scene_visual_prompt.md`
- 任务勾选与 Decision & Audit → `docs/0_TASKLIST.md`
- 新的长期行为 → 本文件「环境陷阱」

禁止把新规则只写在聊天回复里。

## 6. 环境陷阱（NovaStory）

- **Pony CLIP ~77 token：** 共享 prefix 会淹没当镜道具。质量词放末尾。
- **负向 `portrait`：** 本 checkpoint 会全局压制动物。用 `front-facing studio portrait, looking at viewer` 等具体反面契约。
- **`POST /timeline/generate` 替换整章 Scene。** 重编译 Prompt 用 `POST /timeline/prompts/regenerate` + scene version，不要为修词重生成 Timeline。
- **fallback 中文进 visual_prompt：** Pony 不能吃章节原文；P1 必须删这条路径。
- **`buildPromptEnhancement` 对 narrative scene 叠 environment-dominant：** Insert 会被拉成风景。按 `shot_intent` 分支。
- **测试不要碰开发库。** `DATABASE_URL=:memory:`。
- **i18n：** 新 UI 字符串必须 `locales.ts` 的 en+zh 一起加。
