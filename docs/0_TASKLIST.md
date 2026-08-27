# 0_TASKLIST.md: 开发任务与进度追踪

## 🎯 当前迭代目标 (Current Sprint Goal)

修复「失声的梦核游乐园」第 2–10 章分镜图抽象、模板化、风格漂移的**系统原因**：把「LLM 一次写出生图散文」改成「LLM 填镜头契约 + 代码编译 Pony 词」。

正文剧情不改。第 1 章已接受的 Timeline / 图片默认保留。

问题原点：`questionlist/0827.md`  
编译规范（唯一事实源）：`docs/best_practice_scene_visual_prompt.md`  
产品边界：`docs/1_PRD.md`  
架构红线：`docs/2_ARCHITECTURE.md`

> ⚠️ **审查结论（2026-08-27）**：Phase 1–3 的纯函数编译器有价值，但生图组装 / identity / Coverage / 角色锁 / 可交付验收曾未闭环。**禁止把 Phase 1–3 标为全部完成或合并主分支**，直到 Phase 4 E2E Closure 验收通过。已生成的梦核图片 ≠ Sprint 完成证明。

## ⚠️ AI 工作流要求

1. **执行入口**：读本文件，从第一个 `[ ]` 开始。一次只做一块可验收任务。
2. **状态更新**：完成后 `[ ]` → `[x]`，并写 **Decision & Audit**（决策、改动文件、下游调用方、边界）。
3. **验收标准 (AC)**：每个任务下方的 AC 必须用测试或可复现检查锁住，不能只靠肉眼。
4. **阻塞即停**：需求冲突、接口歧义、环境无法验证 → `[Blocked]` + 日志，停止等待主人。
5. **自测闭环**：后端 `cd backend && npm test`；类型检查必须跑**仓库根** `npm run typecheck`（不只 backend）。本 Sprint 的编译器测试不得依赖 ComfyUI / 真实 LLM。
6. **文档索引**：改 Prompt 规则只改 `docs/best_practice_scene_visual_prompt.md`，不要在代码注释里另建一份词表。

---

## 🔄 自我进化循环沉淀

- [[best_practice_scene_visual_prompt]]：Pony 分镜必须「契约 → 编译」，质量词放末尾，角色锁只来自 visual_tags。
- Pony CLIP 前 ~77 token 权重大；共享前缀会把整章画成同一张环境图。
- 该 checkpoint 把负向里的 `portrait` 当成全局动物压制，禁止用它当「防大头照」。
- `identity_mode: auto` 未知时必须保持中性；全局非人锁不得含 wolf/fox/dog。
- Coverage 与 Timeline 一样必须走 compiler；旧库升级靠独立 migration 版本号。

## 🐛 遗留问题与技术债 (Icebox)

- 梦核 ch2–10 已有重编译 Prompt + 抽样生图，但端到端闭环修复后需主人确认是否点杀弱镜（117/126/141/197 等）；**不自动批量重生**。
- Director 页尚无 `data-testid`；本 Sprint 若不动 UI 则不强制回填全站。
- `backend/sql_app.db-shm` / `*-wal` 为运行时文件，禁止入库。

---

## 📝 任务池

### Phase 0: 文档契约（先于代码）

- [x] **Task 0.1:** 落地 Vibe 合同 `docs/0_TASKLIST.md` … `docs/5_AGENT_RULES.md`，并把 `skills/vibe-coder/SKILL.md` 绑定到本仓库路径。
  - **AC:** `docs/README.md` 能索引到这 6 份合同；Skill 不再诱导用 FastAPI 空模板覆盖。
  - **Decision & Audit:** 合同按 NovaStory 现行栈（Vite/React + Fastify + SQLite + Pony XL）填写，不复制 Skill 内的 FastAPI/JWT 示例。

- [x] **Task 0.2:** 写 `docs/best_practice_scene_visual_prompt.md`（镜头契约、CLIP 词序、消毒表、负向编译、黄金用例）。
  - **AC:** 0827 中的失败类型在文档里都有对应编译规则；词表只在这一份文件出现。

> ⛔ Phase 0 完成后停止。未经主人确认不得进入 Phase 1 改代码。

### Phase 1: P0 止血（不改 schema、不重跑 LLM 写散文）

- [x] **Task 1.1:** 删除 `normalizeVisualPrompt` 的项目级前缀（`narrative comic panel` / `environmental storytelling` / `detailed dreamcore amusement park environment` / 入库的 `score_9`）。
  - **AC:** 新写入的 `scene.visual_prompt` 不得以 `score_9` 或上述抽象词开头；质量词只允许在 `generation_service` 组装末尾出现一次。
  - **涉及:** `backend/src/services/scene_visual_prompt_service.ts` 及测试。
  - **Decision & Audit:**
    - **决策:** `normalizeVisualPrompt` 改为只清洗入库串：去掉质量/抽象禁词 token，**不再**拼接任何项目前缀或 `shotType`。质量词仍由 Pony workflow 模板在 `compileComfyWorkflow`（`preserveTemplateConditioning`）侧注入；`source_anime` 可由 `buildPromptEnhancement` suffix 补一次。
    - **改动文件:** `backend/src/services/scene_visual_prompt_service.ts`（导出 `normalizeVisualPrompt`）；新增 `backend/src/services/scene_visual_prompt_service.test.ts`。
    - **下游:** `regenerateSceneVisualPromptsForChapter` → `POST /timeline/prompts/regenerate`；生图路径未改。
    - **边界:** 不重写存量库内已带前缀的旧 prompt（留给 Phase 3 / scene version）；完整非视觉 sanitizer 留给 Task 1.3。
    - **验证:** `cd backend && npm test -- src/services/scene_visual_prompt_service.test.ts`（含 generation 回归）全绿。

- [x] **Task 1.2:** rewrite / timeline 提示词去掉写死物种（如 `cream and white fluffy kitten`）。角色外貌只注入 `character.visual_tags` 锁定串。
  - **AC:** 无圣经依据时不得出现 `kitten` / `1girl`；「失声的梦核游乐园」主角编译为 `small beige-and-white furry creature` 一类圣经词。
  - **Decision & Audit:**
    - **决策:** 删除 rewrite 里写死的 `cream and white fluffy kitten`；timeline / grid / coverage 统一走 `CHARACTER_VISUAL_LOCK_RULES`；角色档案只输出 `Visual Lock`（`formatVisualLockTokens`），不再塞 Description 当外貌。`flattenVisualTagMap` 支持 `base_model.tags` 为 string / string[]。
    - **改动文件:** `prompts.ts`, `scene_visual_prompt_service.ts`, `timeline_generation_service.ts`, `reference_generation_policy.ts`, `image_generation_policy.ts`（SFW policy 禁发明物种）, 相关 `.test.ts`。
    - **下游:** `POST /timeline/generate`、`POST /timeline/prompts/regenerate`、coverage；生图路径仍用 `buildCharacterAppearanceSnippet`。
    - **边界:** NSFW policy 仍可提 `1girl`（成人向人设）；无 lock 时 SFW 禁止默认物种。存量库里已写死的 kitten prompt 不在本任务改写。
    - **验证:** `scene_visual_prompt_service.test.ts` + `reference_generation_policy.test.ts` 全绿。

- [x] **Task 1.3:** 实现确定性 visual sanitizer（非视觉词删除 + 隐喻落地）。词表只从 `best_practice_scene_visual_prompt.md` 编码进一处模块。
  - **AC:** 单测覆盖：`metallic ring echo` 删除；`cloud-like platform` 落地为可走平台 + 负向排除真云群山；`environmental storytelling` / 气味 / 声音 不得出现在 visual_prompt。
  - **Decision & Audit:**
    - **决策:** 新建唯一模块 `visual_prompt_sanitizer.ts`，词表对齐 best_practice §6；`normalizeVisualPromptWithExtras` 走 sanitizer，隐喻负向合并进 rewrite 的 `negative_prompt`。可见 `music-note` / music box 不被声音规则误删。
    - **改动文件:** `visual_prompt_sanitizer.ts` + test；`scene_visual_prompt_service.ts` 接入。
    - **下游:** `regenerateSceneVisualPromptsForChapter`；Timeline 初生成的 prose 仍靠后续 uniqueness / Phase 2 compiler 收口。
    - **边界:** `metallic ring echo` 按 AC **删除**（非落地成涟漪）；`cloud-like platform` 落地。词表禁止再抄到 `prompts.ts`。
    - **验证:** `visual_prompt_sanitizer.test.ts` 全绿；typecheck 通过。

- [x] **Task 1.4:** 相邻镜 uniqueness gate。token Jaccard ≥ 0.65 或 `uniqueness_key` 相同则拒绝入库并重试该镜。
  - **AC:** 用第 2 章 108–113 那种六条相同走廊 Prompt 作为负例，gate 必须失败。
  - **Decision & Audit:**
    - **决策:** 纯函数模块 `visual_prompt_uniqueness.ts`（Jaccard + 显式 uniqueness_key）。rewrite 失败先整章重试一次再拒绝入库；timeline 入库前 gate，失败则不 DELETE 旧 scene。
    - **改动文件:** `visual_prompt_uniqueness.ts` + test；`scene_visual_prompt_service.ts`；`timeline_generation_service.ts`。
    - **下游:** `POST /timeline/generate`、`POST /timeline/prompts/regenerate`。
    - **边界:** 无显式 key 时只靠 Jaccard；派生 key 仅用于日志。阈值 gate 在 1.5。
    - **验证:** 六条相同走廊负例测试红→绿（gate 失败断言）。

- [x] **Task 1.5:** `shot_type` / `shot_intent` 枚举 + 章节配额。Wide/Establishing ≥ 35%，Close-up/Insert ≤ 20%，每章至少 1 个 Insert（有关键道具时）。
  - **AC:** 模拟「11 镜全是 Wide Environmental Action Shot」必须被拒绝或自动改契约。
  - **Decision & Audit:**
    - **决策:** `shot_intent_quota.ts` 映射 shot_type→intent；≥5 镜强制宽/近配额 + 同质 ≤65%；有关键道具缺 Insert 拒绝。<5 镜只拦「全部同 type」。rewrite/timeline 入库前强制。
    - **改动文件:** `shot_intent_quota.ts` + test；接入 `timeline_generation_service.ts` / `scene_visual_prompt_service.ts`。
    - **验证:** 11× Wide Environmental 负例失败；agent_executor 短分镜回归绿。

- [x] **Task 1.6:** 按契约编译 `negative_prompt`（identity_lock + shot_inverse + location_inverse + prop_inverse）。禁止整章复制同一串。
  - **AC:** Insert 必须含 landscape/aerial/plain background 一类；Wide 不得含会抽空背景的 `simple background`；mechanism/music box 必须排除 mecha/helmet/spaceship。
  - **Decision & Audit:**
    - **决策:** `negative_prompt_compiler.ts` 按 intent/location/prop 编译；Wide/establish **不加** `simple background`。timeline + rewrite 用 compiler 结果，不再整章复用 LLM 同一负向串。
    - **改动文件:** `negative_prompt_compiler.ts` + test；接入 timeline/rewrite 写入路径。
    - **边界:** 完整 shot_spec 契约字段仍属 Phase 2；本任务用 shot_type + visual_prompt 启发式。
    - **验证:** compiler 单测覆盖 Insert/Wide/music-box AC。

### Phase 2: P1 契约编译器（结构化 Timeline）

- [x] **Task 2.1:** 扩展 `TimelineShotSchema`：`shot_intent` / `location` / `primary_action` / `key_props` / `subject_scale` / `uniqueness_key`。最终 `visual_prompt` 由 compiler 生成，不信任 LLM 自由散文。
  - **AC:** Zod 拒收无 location+action 的 shot；`visual_prompt` 可空由 compiler 填充。
  - **存储:** 契约写入已有 `scene.shot_spec` JSON，无查询需求不新建列。
  - **Decision & Audit:**
    - **决策:** `TimelineShotSchema` 强制 `location`+`primary_action`；`visual_prompt` 可空。新增 `schemas/shot_contract.ts`（packShotSpec / 临时 compileVisualPromptFromContract）。timeline 入库写 `shot_spec`；空 visual 用契约填充后再 sanitizer。
    - **改动文件:** `schemas/llm.ts`, `schemas/shot_contract.ts`, `llm.timeline.test.ts`, `timeline_generation_service.ts`, `prompts.ts`（示例字段）, `llm.ts` fallback 合同字段, `agent_executor.test.ts`, `shot_intent_quota.ts`（intent 枚举上移 schema）。
    - **边界:** 完整 CLIP 词序 compilePonyPrompt 在 2.3；中文 fallback 删除在 2.4。
    - **验证:** Zod 拒收/可空 visual AC 单测绿；typecheck + 相关回归绿。

- [x] **Task 2.2:** 抽 beat 的 LLM prompt 只填契约字段（中文可以），禁止要求「Detailed English scene description」。
  - **AC:** `Prompts.generateTimeline` 快照测试不再要求长散文 visual_prompt；policy 指向 compiler。
  - **Decision & Audit:** `buildTimelineVisualPromptPolicy` + `Prompts.generateTimeline` 改为 Shot Contract；强制 `visual_prompt: ""`；policy 指向 `compilePonyPrompt`。

- [x] **Task 2.3:** 纯函数 `compilePonyPrompt(contract, characterLock, stylePreset)`：CLIP 词序、概念预算（1 主体 + 1 动作 + ≤3 道具）、质量词 suffix。
  - **AC:** 黄金用例测试（见 best_practice §黄金用例）全部通过；无网络、无 ComfyUI。
  - **Decision & Audit:** 新建 `pony_prompt_compiler.ts`；G1–G5 + 无 score_9 入库单测；timeline 入库始终走 compiler（忽略 LLM 散文）。

- [x] **Task 2.4:** `LLMService.generateTimeline` 两段式：beats → compile。删除把中文原句塞进 `visual_prompt` 的 fallback。
  - **AC:** fallback 若触发，也必须走 compiler 或直接失败，不得输出中文 visual_prompt。
  - **Decision & Audit:** narrative LLM 失败时 **抛错拒绝**中文 visual_prompt fallback；九宫格 fallback 仍只出英契约 + 空 visual（由 compiler 填充）。

- [x] **Task 2.5:** `regenerateSceneVisualPromptsForChapter` 改为逐镜编译，上一镜 `uniqueness_key` 作为禁复用列表。禁止把旧 visual_prompt 当 few-shot 整章重写。
  - **AC:** 重跑不得再产生 108–113 那种 byte-identical 串；已有 asset 的 scene 必须走 scene_version，不静默覆盖。
  - **Decision & Audit:** rewrite 改为契约 schema（无 `current_visual_prompt`）；有 `shot_spec` 则纯编译；有 `asset_url` 先 `createSceneVersion` 再写 prompt。

- [x] **Task 2.6:** `buildPromptEnhancement` 按 `shot_intent` 分支。Insert 不得再叠 `environment-dominant cinematic composition`。项目风格（dreamcore 等）只走 suffix / style preset。
  - **AC:** 现有 `image_generation_policy.test.ts` 不回退；新增 insert vs wide 分支断言。
  - **Decision & Audit:** 新增 `shotIntent` 参数；insert 优先于 environment 推断；`resolveGenerationPlan` 传入 `shot_intent` / `shot_spec.shot_intent`。

### Phase 3: 存量章节（仅 P1 绿灯后）

- [~] **Task 3.1:** 为项目「失声的梦核游乐园」第 2–10 章按正文+角色卡重编译 Prompt，写入 **新 scene version**，不覆盖第 1 章，不自动批量生图。
  - **状态:** 数据已写入；可交付验收见 Phase 4 Task 4.7（fixture + 断言 CLI）。**不得**仅凭肉眼/打印脚本标完成。
  - **AC:** 第 2 章出现「导览图 / 音符按钮」Insert；第 3 章不再含未落地的 `cloud-like`；第 8 章八音盒为 Insert 且负向含 aerial/satellite；第 10 章 payoff 含 groove/core，负向含 mecha/helmet。
  - **复现:** `cd backend && npx tsx scripts/verify_dreamcore_ac.ts --fixture`（干净环境）或 `--project-id 4`（本地库）。

### Phase 4: E2E Closure（审查阻断项 — 合并前必须绿）

- [x] **Task 4.1:** 根目录 typecheck — uniqueness/quota `ok === false` 收窄。
- [x] **Task 4.2:** identity `auto→unknown`；`nonhuman` 全局锁去掉 wolf/fox/dog；支持 `mixed`。
- [x] **Task 4.3:** CLIP token 级合并：scene → framing → quality；真实 `pony_xl_12gb` 模板保留 `cinematic shot`，`score_9`/`source_anime` 各一次且在动作之后。
- [x] **Task 4.4:** 生图路径 SELECT/合并 `shot_spec.shot_intent`。
- [x] **Task 4.5:** `visible_subjects` 多角色锁；Timeline 示例去物种写死。
- [x] **Task 4.6:** Coverage：`011_coverage_shot_contract` 迁移；compiler 入库；fallback 继承源合同否则 fail closed；Apply/Promote 版本与负向/shot_spec；复制/导入/类型同步。
- [x] **Task 4.7:** `.gitignore` 白名单交付脚本；`assertDreamcoreAc` + fixture CLI；忽略 shm/wal；根 `npm test` 转发 backend；`run-tests` 默认 concurrency=1。

> Phase 4 代码闭环后：**仍不自动合并**；是否点杀弱镜重生图由主人确认。
