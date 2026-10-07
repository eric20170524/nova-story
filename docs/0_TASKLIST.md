# 0_TASKLIST.md: 全局开发任务与进度追踪

> **统一说明**：本文档为 NovaStory 仓库唯一的任务与进度追踪事实源（合并原 0827 分镜契约编译器、0907 H3 生视频部署、0907-2 RedCraft 双 Profile 接入三份离散 TODO，并新增小说故事创作与独立短剧剧本 Track）。
> 所有开发、Agent 编码、迭代评审均以此文档状态为准。

---

## 🎯 迭代概览与全局规则

### 当前活动工作流 (Active Tracks)
1. **Track 1 (当前默认主干)**: 梦核分镜 Prompt 契约与编译器闭环（Phase 0–4，已完成 Phase 0–2 及 Phase 4 验收，存量章节数据就绪）。
2. **Track 2**: 红潮 Hybrid H3 A2A 本机部署与黄金样片（P0–P5 已闭环，P6–P7 待 RTX 3060 实机联调）。
3. **Track 3**: RedCraft 赤佬 3.0 / Krea 2 INT4/INT8 双 Profile 接入（已有模型族、单工作流和隔离策略；双 Profile 与 3060 实机验收未完成，详见下方核验记录）。
4. **Track 4**: 小说故事新书创建与 Agent OS 创作链路（5 万–10 万字目标、故事正文总量不超过 10 万字；A–E 按实际验收推进）。指定本 Track 时按下方依赖顺序执行，不改变 Track 1 的默认主干。
5. **Track 5**: 独立短剧结构化剧本模块（参考 Toonflow；改编提纲→分场剧本→导演交接）。剧本文档、编辑页和 AI 候选已落地；导演交接（S3）与备份往返（S4）尚未实施。复用 Track 4 的已保存故事与现有角色/导演基础，不把短剧写回小说正文。
6. **Track 6**: 本机中文 TTS 音色目录与角色绑音。连通 `local-chinese-tts`，查询、筛选、试听，并在资产管理的角色上保存音色。方案见 `docs/deployment/local_chinese_tts_voice_cn.md`。指定本 Track 时从第一个 `[ ]` 开始，不改分镜、不生成章节配音。
7. **Track 7**: 统一 16:9 分镜画布与 H3 原生 24fps 视频生产契约。生图默认 16:9 并移除 3:4/4:3；生视频默认 720p/24fps，保留 480p；统一 Shot Master 与多参考素材职责。方案见 `docs/video/分镜生图与生视频生产最佳实践_20261003.md`。

### ⚠️ AI 工作流要求

1. **执行入口**：读本文件，从指定 Track 的第一个 `[ ]` 开始。一次只做一块可验收任务。
2. **状态更新**：完成后 `[ ]` → `[x]`，并写 **Decision & Audit**（决策、改动文件、下游调用方、边界）。
3. **验收标准 (AC)**：每个任务下方的 AC 必须用测试或可复现检查锁住，不能只靠肉眼。
4. **阻塞即停**：需求冲突、接口歧义、环境无法验证 → `[Blocked]` + 日志，停止等待主人。
5. **自测闭环**：后端 `cd backend && npm test`；类型检查跑根 `npm run typecheck`。编译器单测不得依赖 ComfyUI / 真实 LLM。
6. **文档索引**：
   - Prompt 编译契约唯一事实源：`docs/best_practice_scene_visual_prompt.md`
   - 产品边界：`docs/1_PRD.md`
   - 架构红线：`docs/2_ARCHITECTURE.md`（系统分层与数据流见 `docs/architecture/architecture_cn.md`）
   - 本地部署与模型配置：`docs/deployment/`
   - 生视频详细方案：`docs/video/`
   - Track 4 对齐证据、数据方案及 AC01–26：`docs/architecture/creation_alignment_review_2026-09-28.md`
   - Track 4/5 分层边界及剧本 SC01–13：`docs/architecture/structured_screenplay_module_2026-09-28.md`
   - Track 6 本机 TTS 与角色音色：`docs/deployment/local_chinese_tts_voice_cn.md`
   - Track 7 统一媒体生产规范：`docs/video/分镜生图与生视频生产最佳实践_20261003.md`

### 🐛 全局遗留问题与技术债 (Icebox)

- 梦核 ch2–10 已有重编译 Prompt + 抽样生图，但端到端闭环修复后需主人确认是否点杀弱镜（117/126/141/197 等）；**不自动批量重生**。
- Director 页尚无 `data-testid`；若不动 UI 则不强制回填全站。
- `backend/sql_app.db-shm` / `*-wal` 为运行时文件，禁止入库。
- H3 生视频必须在 RTX 3060 12GB 实机环境完成黄金输入 smoke test，才能开启生产就绪开关。

---

## 📌 Track 1: 梦核分镜 Prompt 契约与编译器闭环 (主干)

### 🎯 目标 (Sprint Goal)
修复「失声的梦核游乐园」第 2–10 章分镜图抽象、模板化、风格漂移的**系统原因**：把「LLM 一次写出生图散文」改成「LLM 填镜头契约 + 代码编译 Pony 词」。正文剧情不改，第 1 章已接受的 Timeline / 图片默认保留。

### 🔄 自我进化循环沉淀
- [[best_practice_scene_visual_prompt]]：Pony 分镜必须「契约 → 编译」，质量词放末尾，角色锁只来自 visual_tags。
- Pony CLIP 前 ~77 token 权重大；共享前缀会把整章画成同一张环境图。
- 该 checkpoint 把负向里的 `portrait` 当成全局动物压制，禁止用它当「防大头照」。
- `identity_mode: auto` 未知时必须保持中性；全局非人锁不得含 wolf/fox/dog。
- Coverage 与 Timeline 一样必须走 compiler；旧库升级靠独立 migration 版本号。

### 📝 任务池

#### Phase 0: 文档契约（先于代码）
- [x] **Task 0.1:** 落地 Vibe 合同 `docs/0_TASKLIST.md` … `docs/5_AGENT_RULES.md`，并把 `skills/vibe-coder/SKILL.md` 绑定到本仓库路径。
  - **AC:** `docs/README.md` 能索引到这 6 份合同；Skill 不再诱导用 FastAPI 空模板覆盖。
  - **Decision & Audit:** 合同按 NovaStory 现行栈（Vite/React + Fastify + SQLite + Pony XL）填写。
- [x] **Task 0.2:** 写 `docs/best_practice_scene_visual_prompt.md`（镜头契约、CLIP 词序、消毒表、负向编译、黄金用例）。
  - **AC:** 0827 中的失败类型在文档里都有对应编译规则；词表只在这一份文件出现。

#### Phase 1: P0 止血（不改 schema、不重跑 LLM 写散文）
- [x] **Task 1.1:** 删除 `normalizeVisualPrompt` 的项目级前缀（`narrative comic panel` / `environmental storytelling` / `detailed dreamcore amusement park environment` / 入库的 `score_9`）。
  - **AC:** 新写入的 `scene.visual_prompt` 不得以 `score_9` 或上述抽象词开头；质量词只允许在 `generation_service` 组装末尾出现一次。
  - **Decision & Audit:** `normalizeVisualPrompt` 改为只清洗入库串，不拼接任何前缀或 shotType。单测全绿。
- [x] **Task 1.2:** rewrite / timeline 提示词去掉写死物种（如 `cream and white fluffy kitten`）。角色外貌只注入 `character.visual_tags` 锁定串。
  - **AC:** 无圣经依据时不得出现 `kitten` / `1girl`；「失声的梦核游乐园」主角编译为 `small beige-and-white furry creature` 一类圣经词。
  - **Decision & Audit:** 删除 rewrite 写死的 kitten，角色外貌统一走 `CHARACTER_VISUAL_LOCK_RULES` 与 `formatVisualLockTokens`。
- [x] **Task 1.3:** 实现确定性 visual sanitizer（非视觉词删除 + 隐喻落地）。词表只从 `best_practice_scene_visual_prompt.md` 编码进一处模块。
  - **AC:** 单测覆盖：`metallic ring echo` 删除；`cloud-like platform` 落地为可走平台 + 负向排除真云群山；`environmental storytelling` / 气味 / 声音 不得出现在 visual_prompt。
  - **Decision & Audit:** 新建模块 `visual_prompt_sanitizer.ts`，词表对齐 best_practice §6。
- [x] **Task 1.4:** 相邻镜 uniqueness gate。token Jaccard ≥ 0.65 或 `uniqueness_key` 相同则拒绝入库并重试该镜。
  - **AC:** 用第 2 章 108–113 那种六条相同走廊 Prompt 作为负例，gate 必须失败。
  - **Decision & Audit:** 纯函数模块 `visual_prompt_uniqueness.ts`，测试覆盖六条走廊负例。
- [x] **Task 1.5:** `shot_type` / `shot_intent` 枚举 + 章节配额。Wide/Establishing ≥ 35%，Close-up/Insert ≤ 20%，每章至少 1 个 Insert（有关键道具时）。
  - **AC:** 模拟「11 镜全是 Wide Environmental Action Shot」必须被拒绝或自动改契约。
  - **Decision & Audit:** `shot_intent_quota.ts` 映射 shot_type→intent；≥5 镜强制宽/近配额。
- [x] **Task 1.6:** 按契约编译 `negative_prompt`（identity_lock + shot_inverse + location_inverse + prop_inverse）。禁止整章复制同一串。
  - **AC:** Insert 必须含 landscape/aerial/plain background 一类；Wide 不得含会抽空背景的 `simple background`；mechanism/music box 必须排除 mecha/helmet/spaceship。
  - **Decision & Audit:** `negative_prompt_compiler.ts` 按 intent/location/prop 编译，接入写入链路。

#### Phase 2: P1 契约编译器（结构化 Timeline）
- [x] **Task 2.1:** 扩展 `TimelineShotSchema`：`shot_intent` / `location` / `primary_action` / `key_props` / `subject_scale` / `uniqueness_key`。最终 `visual_prompt` 由 compiler 生成，不信任 LLM 自由散文。
  - **AC:** Zod 拒收无 location+action 的 shot；`visual_prompt` 可空由 compiler 填充。契约写入已有 `scene.shot_spec` JSON。
- [x] **Task 2.2:** 抽 beat 的 LLM prompt 只填契约字段（中文可以），禁止要求「Detailed English scene description」。
  - **AC:** `Prompts.generateTimeline` 快照测试不再要求长散文 visual_prompt；policy 指向 compiler。
- [x] **Task 2.3:** 纯函数 `compilePonyPrompt(contract, characterLock, stylePreset)`：CLIP 词序、概念预算（1 主体 + 1 动作 + ≤3 道具）、质量词 suffix。
  - **AC:** 黄金用例测试（G1–G5）全部通过；无网络、无 ComfyUI。
- [x] **Task 2.4:** `LLMService.generateTimeline` 两段式：beats → compile。删除把中文原句塞进 `visual_prompt` 的 fallback。
  - **AC:** fallback 若触发，也必须走 compiler 或直接失败，不得输出中文 visual_prompt。
- [x] **Task 2.5:** `regenerateSceneVisualPromptsForChapter` 改为逐镜编译，上一镜 `uniqueness_key` 作为禁复用列表。禁止把旧 visual_prompt 当 few-shot 整章重写。
  - **AC:** 重跑不得再产生 108–113 那种 byte-identical 串；已有 asset 的 scene 必须走 scene_version。
- [x] **Task 2.6:** `buildPromptEnhancement` 按 `shot_intent` 分支。Insert 不得再叠 `environment-dominant cinematic composition`。项目风格（dreamcore 等）只走 suffix / style preset。
  - **AC:** 现有 `image_generation_policy.test.ts` 不回退；新增 insert vs wide 分支断言。

#### Phase 3: 存量章节（仅 P1 绿灯后）
- [~] **Task 3.1:** 为项目「失声的梦核游乐园」第 2–10 章按正文+角色卡重编译 Prompt，写入 **新 scene version**，不覆盖第 1 章，不自动批量生图。
  - **状态:** 数据已写入；可交付验收见 Phase 4 Task 4.7（fixture + 断言 CLI）。
  - **复现:** `cd backend && npx tsx scripts/verify_dreamcore_ac.ts --fixture`（干净环境）或 `--project-id 4`（本地库）。

#### Phase 4: E2E Closure（审查阻断项）
- [x] **Task 4.1:** 根目录 typecheck — uniqueness/quota `ok === false` 收窄。
- [x] **Task 4.2:** identity `auto→unknown`；`nonhuman` 全局锁去掉 wolf/fox/dog；支持 `mixed`。
- [x] **Task 4.3:** CLIP token 级合并：scene → framing → quality；真实 `pony_xl_12gb` 模板保留 `cinematic shot`，`score_9`/`source_anime` 各一次且在动作之后。
- [x] **Task 4.4:** 生图路径 SELECT/合并 `shot_spec.shot_intent`。
- [x] **Task 4.5:** `visible_subjects` 多角色锁；Timeline 示例去物种写死。
- [x] **Task 4.6:** Coverage：`011_coverage_shot_contract` 迁移；compiler 入库；fallback 继承源合同否则 fail closed；Apply/Promote 版本与负向/shot_spec；复制/导入/类型同步。
- [x] **Task 4.7:** `.gitignore` 白名单交付脚本；`assertDreamcoreAc` + fixture CLI；忽略 shm/wal；根 `npm test` 转发 backend；`run-tests` 默认 concurrency=1。

---

## 📌 Track 2: 红潮 Hybrid H3 A2A 本机部署与黄金样片

> 目标环境：`D:\ComfyUI`，RTX 3060 12GB，约 32GB RAM  
> 使用范围：GoddessDaily 陆雪琪 Body Master；NovaStory 生视频管线  
> 现行结论：**代码与工作流骨架已完成，尚未完成实机真实端到端生成。不得将静态关键帧的 FFmpeg 运镜降级产物标记为 H3/红潮生成成功。**  
> 详见：`docs/video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md` 与 `docs/video/生视频最佳实践与TODO 分析报告.md`
> **规范覆盖说明（2026-10-03）**：Track 2 保留 H3 bring-up / 实机验证历史；涉及产品默认画布、默认分辨率与参考素材策略时，以 Track 7 为准。Track 7 为产品层最新默认规范：生图 16:9，移除 3:4/4:3；H3 默认 720p / 24fps，480p 可选。

### 0. 当前核验快照
- [x] `ComfyUI-VideoHelperSuite` 已安装，版本 `1.7.9`。
- [x] `minimax_h3_audio_vae_fp32.safetensors` 已落盘 (SHA-256: `8e505d95dd...`)。
- [x] `minimax_h3_video_vae_fp16.safetensors` 已落盘 (SHA-256: `7c1f131492...`)。
- [x] `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` 已完成落盘 (SHA-256: `35a88d5104...`)。
- [x] `minimax_h3_ref2va_pruned_int8_convrot.safetensors` 已完成落盘 (SHA-256: `9255f52b66...`)。
- [x] `127.0.0.1:8188` ComfyUI 升级至官方版本 `0.34.5`（Git commit `7fd919f0`），GPU 模式运行。
- [x] `comfy-kitchen` 升级至 `0.2.31`，`eager` backend 提供完整 INT8 ConvRot 与 NVFP4 AWQ 算子。
- [x] 废弃伪适配层 `ComfyUI-MiniMax-H3`，替换为 ComfyUI 原生 `comfy_extras/nodes_minimax_h3.py`。
- [x] 澄清身份：红潮为基于 MiniMax H3 Ref2VA 的 A2A 工作流预设。
- [ ] 尚未在目标硬件完成真实端到端 H3/红潮生成。

### 1. P0：立即停止错误成功语义
- [x] NovaStory 在 H3 提交失败时必须 fail closed，移除静默 fallback 到 FFmpeg zoompan 的逻辑。
- [x] 将静态图运镜定义为独立 provider `keyframe_motion_fallback`，UI 与 QA 明确区分。
- [x] 为视频任务持久化 `provider`、`generation_mode`、`workflow_id`、`model_sha256`、`comfy_prompt_id` 与 fallback 标志。
- [x] 修正历史假成功记录；QA 引入动态指标核算（LoopAnalyzer v1.1.0），杜绝占位假分。

### 2. P1：完成并验证模型文件
- [x] Text Encoder、Diffusion Model、Video VAE、Audio VAE 全部下载完成并通过 SHA-256 校验。
- [x] 确认磁盘余量（D 盘 193GB+，C 盘 98GB+），清理断点临时文件。

### 3. P2：澄清模型身份与授权 (Gate G0)
- [x] 确认红潮为 Ref2VA A2A 工作流预设组合名称，明确基础模型与 preset 边界。
- [x] 记录许可证及限制；现阶段标注为“本机技术试验”，默认特性开关 `video_generation.enabled = false`。

### 4. P3：替换伪 H3 适配层
- [x] 升级官方 ComfyUI v0.34.5，原生支持 `nodes_minimax_h3.py`。
- [x] 完整支持 Ref2VA/FL2VA conditioning、时空缩放、首尾帧与角色/运动参考编码。
- [x] 验证 PyTorch 2.6.0+cu124 与 comfy-kitchen 0.2.31 算子兼容。

### 5. P4：建立真实 API workflow
- [x] 重建 `minimax_h3_hongchao_a2a_12gb.api.json` 与 sidecar manifest。
- [x] 包含 positive/negative prompt, first/last frame, 1–3 char refs, motion ref, 864x480/24fps/121f。
- [x] `/object_info` 验证所有 14 个节点通过，缺任意模型/节点时 preflight fail-closed。

### 6. P5：ComfyUI 服务与能力预检
- [x] GPU 模式验证 RTX 3060 12GB。
- [x] 模型加载峰值 VRAM/RAM 预检通过，启用 `--lowvram` 动态卸载。

### 7. P6：黄金输入真实 smoke test（实机待跑）
- [ ] 使用黄金输入：`canonical_keyframe_k.png`、`golden_motion_reference_5s_24fps.mp4`、人物参考。
- [ ] 第一条单任务跑 864×480、5 秒、24fps、固定 seed。
- [ ] 取得真实 `comfy_prompt_id`，ComfyUI history 返回真实视频 output。
- [ ] 验证角色/环境运动非简单平移缩放；人物身份、服装、镜头稳定；H.264/yuv420p 无音轨。

### 8. P7：LoopCloser 与生产稳定性
- [ ] LoopCloser 生成派生 final，保留 raw 原始证据。
- [ ] Appearance、Pose、Motion、Flicker 评分通过，无 OOM、无崩溃。
- [ ] 连续 5 次 480p/5s 稳定生成，建立 pass/manual_review/reject 门槛。

### 9. Definition of Done
- 红潮权重与 workflow 身份可追溯且通过 SHA-256 校验。
- GPU 模式预检全部通过，NovaStory 得到真实 ComfyUI video output。
- 真实黄金样片生成成功并证明非静态运镜，连续 5 次无 OOM/崩溃。

---

## 📌 Track 3: RedCraft 赤佬 3.0 / Krea 2 INT4/INT8 双 Profile 接入

> 目标：将现有实验性 RedCraft 工作流做成真正可部署的 INT4 / INT8 双 Profile，支持 RTX 3060 12GB 本地生图。  
> 详见：`docs/deployment/local_image_generation_deployment_cn.md` 与 `docs/deployment/comfyui_local_setup_guide_3060.md`

### 现状与架构原则
- 当前已有：`redcraft_krea2` 模型族识别、`redcraft_krea2_12gb.json` 工作流、独立 VAE img2img、项目设置页选项。
- 架构原则：**保持 `ComfyUIService` 通用性，不为 RedCraft 增加第二层 Provider**。通过 `RedCraftProfileResolver` 运行时注入 Loader 参数。

### 1. P0 — 完成真正可运行的生产链路
- [ ] **P0-1: 引入 RedCraft Model Profile**
  - 新增轻量配置：variant (`auto | int4 | int8`)、diffusion_model、text_encoder、vae、steps、cfg、sampler、scheduler。
  - RTX 3060 12GB 默认 `int4`，保留单一 `redcraft_krea2_12gb.json` 模板。
- [ ] **P0-2: 修正 workflow 模型依赖**
  - 修改 `backend/static/workflows/redcraft_krea2_12gb.json`，改占位文件名为 runtime profile 注入。
  - 默认 Text Encoder：`qwen3vl_4b_fp8_scaled.safetensors`；VAE：`qwen_image_vae.safetensors`。
- [ ] **P0-3: 增加 INT4 / INT8 配置项**
  - 修改 `backend/src/core/settings_manager.ts`，增加 `comfyui.redcraft_krea2` 配置段。
- [ ] **P0-4: 在 `compileComfyWorkflow()` 中应用 Profile**
  - 修改 `backend/src/services/generation_service.ts`，运行时按 Profile patch UNETLoader / CLIPLoader / VAELoader。
- [ ] **P0-5: 微调默认推理参数**
  - INT4 / INT8: `steps = 8~10, cfg = 1, sampler = euler, scheduler = simple`。
- [ ] **P0-6: 增加 ComfyUI RedCraft Preflight**
  - 检查 ComfyUI 可达、所需节点、ConvRot 原生支持、扩散模型、Qwen3VL 与 VAE 是否全部就绪。
- [ ] **P0-7: 缺模型必须 Fail Fast**
  - 缺少模型时返回 `REDCRAFT_MODEL_NOT_FOUND` 并提示路径，**严禁静默 fallback 回 Pony**。
- [ ] **P0-8: 增加 RTX 3060 分辨率门禁**
  - 12GB 推荐 768×1024 / 1024×1024，超大分辨率 1152×1536 提示 swapping / OOM 风险。
- [ ] **P0-9: INT4 为 3060 默认 Profile**
  - INT8 (13.5GB) + Qwen3VL (5.24GB) 超过 12GB，明确标注 INT8 为实验/高质量档位。

### 2. P1 — UI、测试与可观测性
- [ ] **P1-1: 系统设置加入 RedCraft Profile 配置** (`pages/Settings.tsx`)。
- [ ] **P1-2: ProjectSettings 增加 Auto / INT4 / INT8 档位切换** (`pages/ProjectSettings.tsx`)。
- [ ] **P1-3: VramHealthBadge 增加 RedCraft Ready 状态检测**。
- [x] **P1-4: 严禁自动挂载猜测的 Pony LoRA**（保持 RedCraft 与 Pony LoRA 隔离）。
- [x] **P1-5: 保持 Tier B 隔离**（第一阶段只支持 T2I 与 Tier A img2img，不混用 SDXL IP-Adapter）。
- [ ] **P1-6: 后续单独支持 Krea2 原生 Style Reference**。
- [ ] **P1-7: 补齐 `generation_service.test.ts` 的 RedCraft fixture 测试**。
- [ ] **P1-8: 增加 `REDCRAFT_COMFY_SMOKE=1` 真实生图 Smoke Test**。
- [ ] **P1-9: 记录完整 generation provenance 元数据**。

### 3. P2 — 部署体验与文档
- [x] **P2-1: 修订 `docs/deployment/local_image_generation_deployment_cn.md` 中的模型文件名与路径**。
  - **Decision & Audit（2026-10-07）**：
    - **决策**：部署文档改记本机事实。扩散权重是 `krea2_turbo_int8_convrot.safetensors`（13,492,686,496 字节，约 13.5 GB）的硬链接，工作流文件名仍为 `redcraft_krea2_int4.safetensors`。官方 Comfy-Org/Krea-2 没有约 6GB 的 INT4 扩散权重。文本编码器是 `qwen3vl_4b_fp8_scaled.safetensors` 的硬链接 `qwen_vl.safetensors`。3060 上标准潜空间 1280×704 依赖 `D:\ComfyUI\venv` 的 PyTorch 2.9.1+cu130 与 comfy-kitchen 0.2.37，使 CUDA `int8_linear` 生效。PyTorch 2.6.0+cu124 会关掉该后端，INT8 走 eager 反量化，该潜空间溢出。
    - **改动文件**：`docs/deployment/local_image_generation_deployment_cn.md`；本任务状态。
    - **下游调用方**：阅读部署文档的操作者。`redcraft_krea2_12gb.json` 的 UNETLoader / CLIPLoader 文件名未改，仍靠上述硬链接解析。
    - **边界**：P2-1 当时不改 3060 指南。该清单已由 P2-2 补上。P2-3、P2-4 仍不关闭，也不实现 INT4 / INT8 Profile。P0-9 仍把 INT4 写成 3060 默认档；官方并没有那份约 6GB INT4 扩散权重，该前提留在未完成任务里，本次不把它改写成已实现。
    - **验收**：`fsutil hardlink list` 确认两个扩散文件名、以及 `qwen_vl.safetensors` 与 `qwen3vl_4b_fp8_scaled.safetensors` 为硬链接。该虚拟环境报 torch 2.9.1+cu130、torchvision 0.24.1+cu130、torchaudio 2.9.1+cu130、comfy-kitchen 0.2.37。同日导入 comfy-kitchen 后，`cuda` 后端可用且实现了 `int8_linear`。本次没有重跑 2.6.0+cu124 的溢出。
- [x] **P2-2: 在 `docs/deployment/comfyui_local_setup_guide_3060.md` 增加 RedCraft 配置清单**。
  - **Decision & Audit（2026-10-07）**：
    - **决策**：3060 指南改为本机启动方式，并写入 RedCraft 配置清单。扩散、文本编码器、VAE 用工作流文件名与本机硬链接对照；运行时写明 PyTorch 2.9.1+cu130 与 comfy-kitchen 0.2.37。量化原因仍以 `local_image_generation_deployment_cn.md` 第 3.2 节为准，本指南不另写一套，也不记录耗时或峰值显存。
    - **改动文件**：`docs/deployment/comfyui_local_setup_guide_3060.md`；本任务状态。
    - **下游调用方**：按该指南启动 ComfyUI 或摆放 RedCraft 权重的操作者。`start_all.ps1` 的启动命令未改。
    - **边界**：不关闭 P2-3、P2-4，不加入下载脚本或仓库内权重，也不实现 INT4 / INT8 Profile。指南只给出官方仓库链接和本机已核对的文件名。
    - **验收**：本机 `D:\ComfyUI` 为 0.34.5，`install_path` 为 `D:\ComfyUI`，存在 `venv\Scripts\python.exe` 与 `main.py`，不存在 `run_nvidia_gpu.bat` 与 `python_embeded`。指南中的启动参数与 `start_all.ps1` 一致，清单中的文件名和字节数与 2026-10-07 的磁盘核对一致。
- [ ] **P2-3: 仅提供检测与下载指引，不内置第三方权重**。
- [ ] **P2-4: 记录 3060 Benchmark (INT4 vs INT8 耗时与峰值显存)**。

### 验收门槛 (DoD)
- RTX 3060 12GB + Project = RedCraft Krea2 + Profile = INT4 下 Preflight 报告 READY。
- 768×1024 / 1024×1024 正常生成真实 PNG 并持久化为 MediaAsset。
- 缺模型或节点时入队前明确报错，不发生静默退回。

### Decision & Audit（2026-09-28 代码核验）

- **决策**：Track 3 不能整体标为完成。现有 `redcraft_krea2` 模型族、项目模型选项和单份 INT4 工作流属于接入基础；尚无 `auto | int4 | int8` Profile 配置、运行时 Loader 注入和 RedCraft 专用 Preflight。`redcraft_krea2_12gb.json` 仍固定扩散模型与 `qwen_vl.safetensors`，因此 P0-1–4、P0-6–9 保持未完成。工作流已有 10 steps / cfg 1 / euler / simple，编译器也有 RedCraft 默认参数，但没有 INT8 Profile，P0-5 仍待双档验证。
- **已完成项及调用方**：`backend/src/services/image_generation_policy.ts` 按模型族选择 LoRA 并排除 Pony 文件，`image_generation_policy.test.ts` 覆盖隔离行为，支撑 P1-4；`backend/src/services/generation_service.ts` 在非 Pony 模型上禁用 Tier B 的角色适配与构图控制，并保留 RedCraft 的 Tier A img2img，支撑 P1-5。下游调用方仍走通用 `GenerationService → ComfyUIService`，未新增 RedCraft Provider。
- **未完成边界**：`pages/Settings.tsx` 只有 RedCraft LoRA 设置，`pages/ProjectSettings.tsx` 只有模型选择，没有 Profile 档位；未见 RedCraft Ready、专用 smoke、完整 provenance、Krea2 原生 Style Reference 或 3060 INT4/INT8 实测。2026-09-28 时部署文档仍使用示例模型名；该文档已于 2026-10-07 按 P2-1 修订。3060 指南已于同日按 P2-2 写入 RedCraft 配置清单与本机启动方式。P1-1–3、P1-6–9 与 P2-3–4 保持未完成；P2-3 需同时有检测和下载指引才能关闭。
- **验收矩阵**：根目录及后端 `typecheck` 通过；静态检查确认 P1-4 / P1-5 的代码路径；相关模型族、工作流选择与 LoRA 策略测试 34/34 通过。标准 `backend/npm test` 在当前沙箱因 `tsx` IPC 管道 `listen EPERM` 未能启动，相关测试改用 `node --import tsx --test` 运行。三个 DoD 场景均缺目标 RTX 3060 + ComfyUI 的可复现记录，不能据仓库静态状态判定通过。

---

## 📌 Track 4: 小说故事新书创建与 Agent OS 创作链路

> **来源与验收定义**：[新书创建与 Agent OS 对齐核查及建设方案](./architecture/creation_alignment_review_2026-09-28.md)。本 Track 是待开发任务，不把已有工具或旧规划的“已落地”标记当作完整链路已验收。
>
> **现行范围（2026-09-28 修订）**：本 Track 只负责小说故事；单部作品的目标正文约 50,000–100,000 字，正式正文硬上限 100,000 字。仍用 project + 扁平 chapter，不建卷表；现有角色中心、项目设置、Agent 面板和导演模式继续复用。独立短剧剧本归 Track 5，见 [分层方案](./architecture/structured_screenplay_module_2026-09-28.md)。下列历史任务/审计中的“章/集、两种形态、作品形态注入”不再授权把短剧结构写入 `chapter.content`；统一按故事章节解释，AC25 的旧双形态格式要求由 BE-C5 和 Track 5 的 SC01/12/13 替代。已写入的审计记录保留为当时实现说明，不能据此宣称新边界已实现。

### 核心流程建议（前后端共用契约）

1. **创建/导入**：Dashboard 设置故事总字数目标，沿用 `/api/projects` 创建项目；模型不可用也能建空项目。导入先预览实际正文总字数，再决定是否提交。空项目在 StoryEditor 显示创作起步区。
2. **构思**：Agent 对话或表单收集一句创意、主线、结局方向、角色及风格；`PLAN_STORY` 只生成可编辑的设定候选。用户逐项审核后才合并到现有 `project.settings`/角色/术语。
3. **规划**：`PLAN_CHAPTERS` 根据已采纳设定、剩余字数预算和既有章序，先给 3–5 个章/集纲候选；审核后一笔事务追加。后续扩纲走同一动作，不自动生成无限章/集或覆盖既有正文。
4. **写作/修订**：手写、续写和三类技能都绑定 `project_id + chapter_id + source_revision`。Agent 先返回正文候选与差异，用户选择采纳；采纳时不重新调用 LLM。只读分析不刷新脏编辑缓冲，请求期间切章不串写。
5. **定稿**：先展示本章/集浓缩、下一章/集钩子、人物和术语差异；用户审核后原子提交 `completed` 与有效记忆。失败保持草稿，不能把空结果或部分写入显示为完成。
6. **续写与复核**：下一章/集优先读取已定稿的有效浓缩和设定，钩子只作建议；旧章再改标记关联报告/摘要过期。一致性检查报告范围、覆盖章/集和失败状态。
7. **交付与恢复**：现有项目导出增加 TXT/Markdown 作品文本；JSON 备份与回导覆盖创作事实、术语和启用资料。恢复旧版本先校验当前版本；作品在 100,000 字上限内完成整条路径。

**跨层规则**：`summary` 是规划章纲，`condensed_content` 是已写正文的派生摘要；只在 `metadata_source_revision === chapter.revision` 时把后者作为有效事实。统一字数函数统计 NFC 正规化后正文中的 Unicode 字母/数字码点（汉字、英文字母、数字各计 1；标点/空白不计），标题、章纲、资料和 Agent 对话不占正文预算。超限候选或未保存手稿必须可恢复，服务端禁止超限采纳和定稿，不自动截断用户正文。

### 开发顺序与协作边界

| 阶段 | 前置 | 后端核心落点 | 前端核心落点 | 退出门槛 |
| --- | --- | --- | --- | --- |
| A · P0 正文保护 | 无 | `agent_executor`、`writing_service`、体检失败语义 | `StoryEditor`、`ProjectAgentPanel`、目标同步桥 | AC06–07、10–11、18 的止损场景通过 |
| B · P0/P1 候选采纳 | A | DB 迁移、统一章节写入、`/assistant/execute` 候选/采纳、有限恢复 | 候选差异卡、冲突与恢复入口 | AC08–09、12、16 通过；A 阶段保护不能回退 |
| C · P1 新书到首章 | B 的采纳协议；C 的纯计数可提前 | 故事字数规则、`PLAN_STORY`、`PLAN_CHAPTERS`、typed route | 新建弹窗、设定/章纲审核、篇幅提示 | AC01–05、17、24 及修订后的格式边界通过 |
| D · P1 定稿与交付 | B、C | 定稿事务、下一章/集记忆、导出回导 | 定稿差异、下一章、导出选择 | AC13–15、20–22 通过 |
| E · P2 上限规模验收 | A–D | 分批概要检查与 5/8/10 万字夹具 | 覆盖报告与复核入口 | AC18–19、22、24–26 完整通过 |

以下 `BE` / `FE` 是可分别领取的开发任务。每项的 **实现** 是建议落点，不预设未经核查的新路由已存在；**AC** 映射来源文档第 11 节。完成任务时按文件顶部规则将 `[ ]` 改为 `[x]` 并补 Decision & Audit。跨层任务的双方完成后才可关闭该阶段。

#### A. P0 正文保护：先消除现有数据覆盖路径

- [x] **BE-A1 · 禁止截断原文后整章覆盖，并统一技能输入。**
  - **实现：** 在 `backend/src/services/ai/writing_service.ts`、`agent_executor.ts` 和 `prompt_registry.ts` 为续写/电影化/冲突/反转使用共同上下文契约；所有技能注入用户 instructions、作品形态、已采纳设定和下一章/集边界。若原文超模型预算，明确返回“需分段或缩小选区”，不取前 3500/6000 字后把生成结果当整章替换；空输出、部分分段失败不得写库。
  - **AC：** 超预算章/集的尾部哨兵不会消失；三类技能 Prompt 都含用户指令和下一章边界；模型空响应或失败时 DB 正文逐字不变（来源 AC10–11、F03）。
  - **Decision & Audit:**
    - **决策**：
      1. 提示词契约全面对齐 DreamWaverAI：引入五大神级写作法则（Show Don't Tell、感官延伸、冰山理论、心理博弈、篇幅达标策略）及强负向约束（断章艺术与抢跑禁止）；三类技能（电影感重写、增加冲突、情节反转）及正文生成统一注入用户 instructions、作品形态（`contentForm`）、故事设定（`context`）与下一章边界（`nextChapterConstraint`）。
      2. 消除静默截断覆盖：输入正文超模型预算（技能 3500 字，全文重写 6000 字）时，明确报错“需分段或缩小选区”，禁止截断原文前部后当作整章替换。
      3. 失败/空响应与元数据异常强保护（P1修复）：模型返回空内容、纯思考标签或抛出异常时统一 fail-closed；在 `WritingService` 抽离纯内存计算 `generateCondensedForContent`，正文改写/续写采纳时在写库前先计算新浓缩，若元数据 LLM 抛错直接拦截，DB 原正文与浓缩摘要逐字不变，杜绝“正文已写库而后置浓缩失败导致脏数据”；全部就绪后单条 SQL 原子落库。
      4. 短剧与小说创作格式分流（P1修复）：彻底消除正文提示词硬编码禁止【场景】【动作指令】与短剧形态的冲突。按 `content_form === 'short_drama'` 动态分流注入短剧文学剧本格式规范（集纲、场景说明、人物对白与动作说明；机位运镜留由导演模式处理），短篇小说则保留小说叙述体并禁止剧本分镜标签。
    - **改动文件**：
      - `backend/src/services/ai/prompt_registry.ts`：扩充 `PromptKey`；创作与技能提示词对齐 DreamWaverAI，统一注入 `contentForm`、`instructions`、`nextChapterConstraint`，引入 `{{formatRules}}` 与 `{{writingModeNote}}` 占位消除剧本格式冲突。
      - `backend/src/services/ai/writing_service.ts`：补充 `rewriteContent: 6000` 预算；在 `generateChapterDraft` 与 `executeSkill` 增加硬预算门禁与短剧/小说格式规范分流；导出纯内存计算 `generateCondensedForContent`。
      - `backend/src/services/ai/agent_executor.ts`：`DRAFT_CONTENT` 支持短剧与小说差异化重写提示词；先在内存生成浓缩，再执行单一原子 SQL 更新正文与浓缩，元数据异常时正文 100% 保持不变。
      - `backend/src/routes/creative.ts`：草稿与技能路由捕获预算超限返回 400，拦截空输出返回 502；正文写库前先在内存算好浓缩，原子更新 DB，保证失败不产生半写入。
      - `backend/src/services/ai/writing_protection_skills.test.ts`：新建并扩充单元测试，覆盖尾部哨兵保留、重写超限拒绝、Prompt 参数校验、空/错不变性、正文成功元数据失败原子保护、短剧与小说格式分流测试（6 项测试全部通过）。
    - **下游调用方**：`AgentExecutor`、`/api/creative/draft`、`/api/creative/skill`。
    - **边界**：超出 3500/6000 字单次预算的安全拒绝并提示分段或缩小选区，自动分段连续改写留待后续扩展。
    - **验收验证**：根目录与后端 `npm run typecheck` 0 错误；`writing_protection_skills.test.ts` 6/6 通过；全库测试全部通过。
- [ ] **FE-A1 · 统一编辑器与 Agent 的目标快照，保护脏缓冲。**
  - **实现：** 改 `pages/StoryEditor.tsx`、`contexts/ProjectAgentContext.tsx`、`components/agent/ProjectAgentPanel.tsx`。全局面板和“智能创作”菜单共享保存/快照入口，显式记录 projectId、chapterId、sourceRevision、dirty 状态；只读结果不触发 `forceSync`，写结果只更新命中的章节。`applyContent` 必须带目标章 ID；切章或离页时保留未保存文本并显示恢复入口。
  - **AC：** 输入未保存正文后做角色分析，输入仍在；A 章请求期间切到 B，A 的返回只影响 A；保存失败不执行写入动作。用可复现浏览器场景和必要的组件/服务测试验收（AC06–07、F02）。
- [ ] **BE-A2 · 把 AI 检查失败与“零问题”分开。**
  - **实现：** `WritingService.checkConsistency` 与 `AgentExecutor` 返回 `complete | partial | failed`、issues、coverage 和错误原因；结构化 LLM 返回 null/无效 JSON/超时不能 `issues || []` 伪装为 success。角色分段分析同样区分真实空结果与部分失败；保持现有只读能力。
  - **AC：** 以 null、无效 JSON、单段失败和真实零问题四种桩输入验证状态；仅完整成功且 issues 为空显示“未发现问题”（AC18、F06）。
- [ ] **FE-A2 · 明确目标、失败和未覆盖信息。**
  - **实现：** 在 `AgentActionCard`、`AgentExecutionResultCard`、`ProjectAgentPanel` 显示目标章/集、操作范围和失败状态；体检失败不得使用“0 项问题”的成功样式。文案同时写入 `locales.ts` 的中英文键。
  - **AC：** 用户能在采纳前辨认目标章/集；后端 failed/partial、正文未改/未保存时 UI 文案与实际状态一致（AC07、18）。

#### B. P0/P1 候选、版本与恢复：写作入口收敛到一次采纳

- [ ] **BE-B1 · 增加最小创作版本与候选迁移。**
  - **实现：** 在 `backend/src/db/database.ts` 使用下一个未占用的独立 migration：`project.revision`；`chapter.revision/target_word_count/next_plot/metadata_source_revision`；一个限定用途的 `creative_change` 表，存项目/章节、动作、状态、基线版本或哈希、request_key、候选与变更前后快照、时间。迁移对已有 project/chapter 初始化并保留现有 settings、正文和场景；不加卷表或通用工作流表。
  - **AC：** 旧库升级与空库初始化结果一致；重复启动不重复迁移；现有项目 JSON/图片设置及章节状态未丢失，迁移单测用内存库（AC09、12、23）。
- [ ] **BE-B2 · 统一所有正文写入与派生记忆失效。**
  - **实现：** 抽 `chapter_mutation_service`（或等价单一服务）供 `backend/src/routes/chapters.ts`、`creative.ts` 的 apply 路径、`AgentExecutor` 调用。手写保存、续写采纳、技能替换都增加 revision；修改 completed 后回 draft，使旧 condensed/next_plot 失效，不再给后续章节当事实。`summary` 保持规划章纲语义；编辑器提交携带预期版本并在冲突时报 409。
  - **AC：** 每一种写入口都让旧浓缩失效并递增版本；不同标签页先后修改不会无声覆盖；无内容变动的保存不得制造多余版本（AC09、12、F04）。
- [ ] **BE-B3 · 建立“生成候选 → 只采纳该候选”的服务端协议。**
  - **实现：** 扩 `backend/src/schemas/agent_os.ts`、`routes/assistant.ts`、`services/ai/agent_executor.ts`。`POST /api/assistant/execute` 增加 `preview`（动作+目标+expected revisions）和 `apply`（change_id+request_key）模式；preview 只存候选，不改正式数据；apply 校验项目、章节、候选状态、project/chapter 基线后在短事务中提交，不再次调用 LLM。增加按项目读取 pending/单个候选的接口，供刷新后恢复。本任务只交付新协议，旧生成型写入收口由 BE-B5 在前端迁移后完成。
  - **AC：** 预览字节与落库正文相同；两标签页冲突返回 409 且候选保留；重复 request_key 只提交一次；跨项目 change_id 拒绝；采纳阶段 LLM 调用数为 0（AC05、08–09、F07）。
- [ ] **FE-B1 · 候选差异卡与采纳状态机。**
  - **实现：** 扩 `services/api.ts`、`ProjectAgentPanel` 与结果卡。按 change_id 显示原文/候选、操作目标、正文增删和过期告警；用户选择采纳/丢弃。刷新后按项目取回 pending；apply 返回的 affectedEntities 只刷新相应数据，409 允许重新生成或保留原稿，不自动覆盖编辑器。
  - **AC：** 不采纳不改正式正文；刷新后候选可见；采纳后显示的版本/字数与服务端一致；切章后返回候选留在原章（AC05、07–09）。
- [ ] **BE-B5 · 收口旧生成型直写入口。**
  - **实现：** FE-B1 接入新协议后，检查 `POST /api/assistant/execute` 的旧 `apply=true + actions`、`/api/agent/draft` 的 apply、`/api/agent/skill` 的 apply 及其他调用方；生成型写入改为走候选采纳，旧请求转成候选或返回可操作的迁移错误。现有只读查询、确定性结构操作和必要兼容路径保留，但不得绕过 BE-B2 的统一章节写入及版本校验。
  - **AC：** 从每个公开生成入口都不能在未审核候选时替换正式正文；原前端入口没有 4xx 回归；直接调用旧参数不会绕开 revision、状态失效和写入保护（AC08–09、12）。
- [ ] **BE-B4 · 受版本约束的最近变更恢复。**
  - **实现：** 在 `creative_change` 基础上增加有限恢复接口/服务；恢复生成新 revision，不改写旧 revision。正文快照必须包含其摘要有效性与状态；若之后发生手工修改、定稿或关联设定变化，拒绝盲目回滚并提供冲突信息。结构删除如未保存完整依赖快照，就保持现有删除确认并明确不支持自动恢复。
  - **AC：** 恢复一次正文替换可得原文；第二标签页随后修改时旧恢复返回 409；不会把旧浓缩冒充当前章/集记忆（AC16）。
- [ ] **FE-B2 · 撤销、恢复及冲突提示与服务端对齐。**
  - **实现：** `StoryEditor` 的 `useUndo` 继续负责本地未保存编辑；已采纳的 Agent 变更显示服务端“恢复此变更”入口，避免把清空本地历史误说成可撤销。展示 409 冲突和恢复后的新版本；相关文案进 `locales.ts`。
  - **AC：** 本地 Undo 与服务端恢复含义分明；已采纳修改可按 BE-B4 恢复；冲突时正文和候选都不丢（AC16）。

#### C. P1 新书到首章：小说故事与有限篇幅规划

2026-09-30 按当前代码补充三项创作流程设计：[总体方案](./architecture/novel_creation_workflow_plan_2026-09-30.md)、[后端任务与核心代码](./architecture/novel_creation_backend_tasks_2026-09-30.md)、[前端任务与核心代码](./architecture/novel_creation_frontend_tasks_2026-09-30.md)。规划子集已接入应用：`story_plan` / `story_plan_change`、构思与章节候选、按规划创建下一章，以及故事页规划面板。下列勾选保持未完成：BE-C1 的 10 万字硬上限、BE-C4 的“移到末尾 / 改文风”映射、NC14 全旅程和真实模型质量都还没有验收证据。C2/C3 采用“未来规划与实际章节分离”；替代旧方案直接批量创建实际章的做法，以兼容当前逐章定稿门槛。NC01–NC14 是本轮新增验收编号，任务完成状态仍只维护在本文件。

- **Decision & Audit（2026-09-30，规划子集，勾选未关）**
  - **决策**：未来章节存在规划文档里，实际章节仍逐章创建。生成和建章都先固定 `request_key` 与当时的版本；网络结果未知时重放原载荷。版本或顺序冲突经确认后才换新键，且只试一次。上一章未定稿不换键。
  - **证据**：前后端 `tsc --noEmit` 通过。记忆库定向测试 29 项通过，覆盖迁移 015、定稿门槛、同键回放、空采纳和规划快捷指令。2026-10-01 在临时项目「规划点击验收」上点过故事页：空勾选不能采纳，采纳后出现两条规划并创建第 1 章；取消脏章纲确认会留在当前章，确认后先保存再提示上一章尚未定稿。构思按钮会把助手切到构思模式。远端模型网关返回 502，所以没有点出真实模型生成的设定。该临时项目已删除。手机宽度下规划按钮会换行，正文和章纲仍可编辑。同日评审复现后补上：扩展候选不能改删既有规划，只合并本批新增；修订采纳会同步草稿章的标题、章纲和目标字数并保留正文；“第N章”在生成前解析成规划 ID；整理设定与章节规划提示词带上构思历史；模拟规划请求会拒绝而不是一直等待；确认创建下一章不再把服务器旧正文盖回未保存编辑。勾选仍不关闭。

- [ ] **BE-C1 · 统一小说故事计字和总量校验。**
  - **实现：** 扩 `backend/src/schemas/project.ts`、`routes/projects.ts`、`services/project_settings.ts`，创建请求接收 `target_total_words: 50000..100000`；服务端合并现有默认 image_generation。抽纯函数统计 NFC 正规化故事正文的 Unicode 字母/数字码点，在 B 阶段采纳/手动保存事务内重算全项目字数。超过软目标提示调整目标；超过硬上限拒绝正式写入，保留本地草稿和候选。剧本及分镜不重复计入；旧 content_form 原值兼容保留，不作为故事输出格式开关。
  - **AC：** 49,999/50,000/80,000/99,999/100,000/100,001 边界符合方案；并发两次追加无法突破 100,000；未知设置键及图片工作流配置保持不变；新增剧本不增加故事字数（AC01、24；修订后的分层约束）。
- [ ] **FE-C1 · 新小说项目与预算入口。**
  - **实现：** `pages/Dashboard.tsx` 新建弹窗增加 5/8/10 万字及范围内自定义、空白/辅助规划；`pages/ProjectSettings.tsx` 展示目标、实际、剩余及调整入口。短剧通过独立剧本导航进入，不在创建时切换小说正文格式。模型不可用时创建仍成功；超限候选显示需缩减的字数，不自动截断。新文案进 `locales.ts`。
  - **AC：** 三个字数预设建项目成功；软目标/硬上限提示区分；既有项目打开不被强制重写设定（AC01、24）。
- [ ] **BE-C2 · `PLAN_STORY` 生成可审核的创作设定。**
  - **实现：** 复用 Agent OS、Provider 与已有 brainstorm_chat/structure_novel_gen，增加 ideation 模式、受预算约束的真实对话历史及 PLAN_STORY。新增 story_plan/story_plan_change 保存规划、候选、来源快照及回执；不依赖尚未实现的通用 creative_change。未来主线/结局/人物成长与已定稿事实分开；获选初始设定和角色/术语逐字段合并，保留 image_generation、未知设置键、chapter_impact_entries 和已有人工内容。Zod 校验；采纳只应用保存的候选，不再次调用模型。
  - **AC：** 零章节可连续构思；预览不改正式资料；候选可编辑和恢复；获选字段采纳幂等；资料关闭时 Prompt 不含其内容；未来规划不覆盖定稿时间线/关系（AC02、05；NC01/02/09/10）。
- [ ] **FE-C2 · 空项目构思与设定审核。**
  - **实现：** StoryEditor 空状态接入现有 ProjectAgentPanel，支持构思/指令模式及结构化 sendPrompt；设定候选编辑、逐项选择与采纳。服务端候选独立于聊天缓存恢复；API 保留错误码，切项目慢响应不污染当前项目；ProjectSettings/角色中心继续编辑正式资料。
  - **AC：** 一句创意可生成设定；无模型仍可手工写作；候选编辑不改正式资料；刷新可恢复；来源冲突保留候选与正文；采纳后库内可读（AC01–02、05；NC01/02/10/11）。
- [ ] **BE-C3 · `PLAN_CHAPTERS` 初始化、修订与扩展。**
  - **实现：** 统一 initial/revise/extend 生成服务。首批默认 3、单批最多 5 条扁平规划；修订精确校验目标 ID 集合；扩展使用实际断点和未来规划尾部。候选采纳事务更新 story_plan，不批量创建 chapter；校验版本、来源与预算。同步已关联章节的标题/summary；未来规划接入下一章负约束；旧项目 bootstrap、复制、导出/回导及删除闭环。
  - **AC：** 首章未定稿也能保存多条未来规划；修订不改未选条目/正文/定稿事实；扩展不重复尾部；故障原子回滚；同键重试幂等；上下文和备份关联完整（AC03–05、24；NC03/07/08/09/10/12/13）。
- [ ] **FE-C3 · 章节规划审核与预算视图。**
  - **实现：** StoryEditor 章节栏区分实际章节和未来规划；提供生成、选中范围修订、末尾扩展、差异与目标字数编辑。复用候选展示机制，但使用 BE-C2/C3 的小说规划 DTO，不等待通用正文候选服务。显示后端预算，规划结果不走 applyContent；手工概要入口保留。
  - **AC：** 未来规划可独立编辑；采纳后可进入首章；扩展后旧正文逐字不变；刷新/拒绝不产生重复实际章；409 保留编辑内容（AC03–05；NC03/07/08/10/11/13）。
- [ ] **BE-C4 · 修正活跃 Agent 的确定性参数映射。**
  - **实现：** 在 `backend/src/services/ai/agent_route.ts` 与 `schemas/agent_os.ts` 为目标章/集、移动位置（开头/末尾/明确索引）和项目字段提供有限 typed args；无法解析时返回待补参数，不把“末尾”默认转 index=0，也不把“改文风”的原句写入 main_plot。问答仅注入预算内的项目设定、当前章/集及最近对话；继续保留小 Schema + 现有单意图路由，不扩成任意多步代理。
  - **AC：** “移到末尾”“把文风改为悬疑”、无明确目标章、问当前角色设定分别走正确参数/澄清/上下文，保持项目隔离（AC17、F05）。
  - **本轮创作子集：** 接入 PLAN_STORY、PLAN_CHAPTERS、CREATE_NEXT_CHAPTER；planning 模式和目标参数通过 typed args 传递，完整原始指令不被 focus 截断。自然语言修改章纲进入候选，不把指令原句写入 summary；规划关键词优先于通用正文改写，保持 story/script 隔离（NC01/07）。
- [ ] **BE-C5 · 收口小说故事 Prompt 的职责。**
  - **实现：** `WritingService`、三类技能 Prompt 和 `agent_executor` 统一生成小说叙述与对白，移除 `short_drama` 驱动同一正文输出剧本的分支；原故事及设置保留。短剧场次/动作/对白结构由 Track 5 的独立服务与 Schema 承担，剧本页面的改写不得路由到故事覆盖技能。
  - **AC：** 故事 Prompt 的角色与格式约束一致；旧 short_drama 设置不会改写存量正文或产生混合格式；剧本与故事服务隔离（替代旧 AC25，联动 SC01/12）。
- [ ] **BE-C6 · 按已采纳规划创建下一实际章。**
  - **实现：** 单一领域服务分配章节 ID/顺序，建立 chapter.plan_entry_id 唯一关联并继承标题/summary/target_word_count。检查末章 completed 与 finalized_content_hash；正文改动使定稿失效，旧定稿缺哈希需校准。幂等键先于新请求版本校验；手工空章共用一致性逻辑。默认关闭的自动模式在有效定稿后最多创建一章，持久化请求与回执，定稿成功和后续建章结果分别反馈。
  - **AC：** 首章与下一章均从计划创建；重复点击、断网重试、两连接并发不重复；旧定稿改正文后被阻止；规划耗尽明确停止；手工空白写作保留（NC04/05/06/09/12）。
- [ ] **FE-C4 · 开始首章、自动下一章与失败恢复。**
  - **实现：** 接入 next-chapter 返回的真实章节；冻结请求键和载荷，直到保存及页面切换结束才解除 loading。自动选项持久化且默认关闭；定稿与建章分开显示。规划耗尽提供扩纲入口，前章过期提供重新定稿入口；有脏正文时保留当前编辑器，不强制跳章。
  - **AC：** 计划→首章→定稿→下一章路径连贯；自动模式每次只创建一章；刷新/重试不重复；切项目无污染；完成 NC14 全旅程并记录真实模型与接口桩各自证据（NC04/05/06/09/11/14）。

#### D. P1 定稿、承接和交付

- [ ] **BE-D1 · 定稿候选与原子提交。**
  - **实现：** 把 `WritingService.analyzeChapterImpact` 与元数据生成接入 B 阶段候选服务；`APPLY_CHAPTER_IMPACT` 区分只读影响分析和定稿采纳。候选展示当前完整正文的 condensed/next_plot、人物与术语逐项差异；确认时校验 source revision，短事务写入获选差异、有效摘要、钩子与 `status=completed`。复用角色视觉字段/版本合并规则，失败不留下部分设定或假定稿。
  - **AC：** 重复定稿幂等；影响分析失败状态仍为 draft；角色视觉资产保留；定稿版摘要与正文 revision 对齐（AC13、15、F04）。
- [ ] **FE-D1 · 定稿审核卡与真实状态。**
  - **实现：** `StoryEditor` 增加“定稿并更新设定”入口；`ProjectAgentPanel` 或结果卡展示摘要、下一章/集建议、人物/术语变更，可逐项接受或拒绝。采纳前明确“尚未定稿”，采纳成功后才显示 completed；失败保留正文并可重试。
  - **AC：** 用户能选择只定稿正文、不采纳某条设定差异；失败/冲突时不显示成功；已定稿后修改正文立即回 draft（AC13、15）。
- [ ] **BE-D2 · 下一章/集上下文读取已确认事实。**
  - **实现：** 改 `services/ai/layered_context.ts`、`writing_service.ts`：仅使用与正文版本匹配的 condensed；未定稿内容标明草稿，不冒充事实；`next_plot` 作为可选择的承接建议，不覆盖已有 chapter.summary。修订前章后下游生成或检查识别摘要/报告过期；无下一章纲时不强行完结全作。
  - **AC：** 两章/集样例能承接已定稿信息；改前章后旧摘要不进入事实区；已有人写章纲不被钩子覆盖（AC14）。
- [ ] **FE-D2 · 下一章/集入口与上下文来源提示。**
  - **实现：** `StoryEditor` 在定稿成功后给出下一章/集、承接钩子及“规划后续”入口；展示上一章/集是草稿还是已定稿、摘要是否过期。跳章不强制拦截，但不能静默将未定稿正文当作确认事实。
  - **AC：** 定稿后继续下一章/集路径连贯；人工章纲保留；未定稿或摘要过期时 UI 有准确提示（AC14、22）。
- [ ] **BE-D3 · 创作事实的 JSON 往返与导入上限。**
  - **实现：** 扩 `backend/src/routes/projects.ts` 导出、`services/import/novastory_json_model.ts`、`novastory_json_import.ts` 和通用导入预览/提交：格式新版本保留 content_form/target、chapter 的 status/summary/condensed/next_plot/target_word_count、glossary、project_document 内容及 context_enabled；兼容旧 v1。重映射实体 ID 后修复关联并重建有效摘要版本；新导入正文 >100,000 字在预览提示并拒绝提交，旧超限项目可读且不损坏。
  - **AC：** 导出→回导后正式创作事实语义相等；旧格式仍可导入；超限新导入拒绝且库内无半成品（AC20、26、F08）。
- [ ] **BE-D4 · 作品文本导出。**
  - **实现：** 在现有项目导出体系增加小说 TXT、Markdown 下载；按 chapter.index 稳定排序，调用共用纯序列化函数，区分“全部章节”和“仅定稿章节”，输出章标题与故事正文，空章/草稿标识一致。剧本阅读版由 Track 5 序列化，不混入小说导出；不得写死虚构作者。
  - **AC：** 中文、换行、排序、空章和草稿筛选夹具内容精确匹配；不影响现有 JSON 和漫画 PDF 导出（AC21、23）。
- [ ] **FE-D3 · 导出选择与恢复后继续写。**
  - **实现：** `pages/Dashboard.tsx` 或项目已有导出入口提供 TXT/Markdown/JSON、全部/仅定稿选择；导入预览显示字数和超限原因。恢复后的作品按新形态/目标进入原编辑器，不重走新书构思。
  - **AC：** 同一两章/集作品可导出文本和 JSON，再回导并继续编辑；字数和故事设定保持一致（AC20–22、26）。

#### E. P2 10 万字范围内的检查与整链验收

- [ ] **BE-E1 · 按章/集分批做概要一致性检查。**
  - **实现：** 重构 `WritingService.checkConsistency`，在固定模型预算内覆盖作品全部章/集的规划摘要或有效浓缩；每批记录 chapterId/sourceRevision、已检查范围和失败。汇总报告标 `complete/partial/failed`，用户指定章/集可做正文深查；失败不返回假零问题。不引入向量库或长篇卷史。
  - **AC：** 50 章/集及 5/8/10 万字确定性夹具覆盖全部概要、末章哨兵可查；缺摘要、单批失败和模型无效结果分别报告覆盖缺口（AC18–19、26、F06）。
- [ ] **FE-E1 · 检查报告的覆盖、过期与复核。**
  - **实现：** `AgentExecutionResultCard` 显示“概要检查/选定章正文检查”、覆盖数量、未覆盖章/集、来源版本和失败原因；从问题卡可定位目标章/集。修订后标旧报告过期并提供重查，不显示笼统“全书无问题”。
  - **AC：** 完整无问题、部分失败、修订后过期三种报告可区分；点击问题定位正确章/集（AC18–19）。
- [ ] **BE/FE-E2 · 验收小说故事完整创作旅程。**
  - **实现：** 用确定性 LLM 桩与内存 SQLite 覆盖创建→设定候选→3 章规划→两章写作/定稿→修订/冲突/恢复→概要复核→文本与 JSON 导出→回导继续写；另做少量真实模型小说样例。浏览器验证脏缓冲及跨章结果；剧本改编旅程由 Track 5 单独验收。保留 `npm run typecheck`、后端 `npm test`、根 `npm run build` 基线。
  - **AC：** 来源文档 AC01–26 按本 Track 范围修订逐项有证据或明确未达标；旧 AC25 由 BE-C5 及 SC01/12/13 替代；49,999 到 100,001 字边界及并发上限通过，角色/导演/导入导出无回归。

### Track 4 范围门槛与完成记录

- 本 Track 只改小说故事创作链路。独立短剧剧本归 Track 5；漫画、图片和视频已有接口作为回归边界，不借此改写存量章节或重生素材。
- 故事正文的 100,000 字硬上限同时在前端提示和服务端提交时生效；模型 Prompt 的“约 10 万字”不能代替服务端计数。
- 完成每项时，在该任务下写 **Decision & Audit**：实际改动文件、API/数据迁移、调用方、回退方式、测试证据、已知限制；实施方案若与本清单不同，以代码证据更新本 Track 和来源方案，避免文档继续写“待实施”。
- **Definition of Done：** 前后端 A–E 对应任务完成，来源文档 AC01–26 按现行范围修订全部有证据；小说走完新建→规划→写作→定稿→下一章→导出/回导，且 100,000 字上限、脏缓冲、并发冲突与恢复场景通过。Track 5 独立验收。

---

## 📌 Track 5: 独立短剧结构化剧本模块

> **设计事实源**：[小说故事与短剧结构化剧本分层方案](./architecture/structured_screenplay_module_2026-09-28.md)。参考 Toonflow 的改编、结构化剧本与资产关联思路。S0–S4 已全部在代码中落地并完成整链验收。
>
> **首期范围**：一章一份剧本、多场戏；小说正文与剧本独立保存。复用角色中心、Provider、Agent 面板、Shot Contract 编译器和现有导演。一章拆多集、跨章合集、无限画布、3D 导演台及新媒体平台后置。已有正式 Timeline 仅预览比较，首期交接只向空 Timeline 采纳。

- [x] **S0 · 对齐故事、剧本、分镜边界。**
  - 与 Track 4 BE-C5 统一 Prompt 和页面术语；新增 ScriptDocument 契约，明确 scriptScene 为场戏、scene 为镜头。保留当前已调整的写库前浓缩与空结果保护，并执行相关回归；同一正文的短剧分流按新边界收口。
  - **AC：** SC01/12 的契约与路由用例锁定，旧项目不发生正文格式迁移。
  - **Decision & Audit（2026-09-29）**：
    - **修改文件**：`backend/src/schemas/script.ts`（新增契约/校验/哈希/序列化、增加角色/地点/道具强引用约束）、`backend/src/schemas/agent_os.ts`（增加 `SurfaceSchema` 并在所有动作 schema 明确保留 surface 字段）、`backend/src/schemas/agent.ts`、`backend/src/services/ai/prompt_registry.ts`、`backend/src/services/ai/writing_service.ts`、`backend/src/services/ai/agent_executor.ts`（闭合 surface 隔离与小说技能拦截、将 S2 阶段短剧剧本生成动作明确标记为 skipped）、`backend/src/services/ai/agent_route.ts`、`backend/src/services/ai/agent_service.ts`、`backend/src/routes/assistant.ts`、`components/agent/ProjectAgentPanel.tsx`（切页清空待确认动作、执行请求携带 surface 闭合保护）、`locales.ts`。
    - **测试文件**：`backend/src/schemas/script_boundary.test.ts`（2/2 通过）、`backend/src/services/ai/writing_protection_skills.test.ts`（6/6 通过）。
    - **决策**：统一小说故事与短剧剧本边界，小说写作服务严格产出小说正文并禁止剧本排版标签；Agent OS 增加 `surface: 'script'` 隔离与意图路由，在剧本上下文绝对拒绝小说改写技能（闭合切页遗留卡片及直接执行保护），增加跨项目章节所有权校验（SC01/SC12）；未实装的 S2 阶段 AI 改编动作明确返回 `status: 'skipped'` 与友好提示，杜绝伪成功。
    - **验证**：根 `npm run typecheck`、后端 `tsc`、根 `npm run build` 均 0 错误通过。旧项目正文不发生任何迁移。
- [x] **S1-BE · 剧本文档、候选/变更记录与版本保存。**
  - 按方案两张表实施迁移，增加本模块服务与路由；项目隔离、来源快照哈希、revision 比较、手工保存、幂等与确认。不得把尚未实施的 chapter revision 或 creative_change 当作现成依赖。
  - **AC：** SC01/02/04/05，内存 SQLite 验证事务与来源变化。
  - **Decision & Audit（2026-09-29）**：
    - **修改文件**：`backend/src/db/database.ts`（增加 `014_chapter_script` 迁移，新建 `chapter_script` 与 `script_change` 表及外键级联与索引）、`backend/src/schemas/script.ts`（严格校验 Location/Prop/Scene ID 唯一性与引用闭包，`confirmScript` 强校验角色所属项目与场景出场角色）、`backend/src/services/script_service.ts`（实现 `ScriptService`：初始化/获取剧本、带 revision 校验的手工短事务保存、完整性与来源新鲜度校验确认、最近文档版本恢复、候选变更按类型校验载荷、采纳前校验完整 ScriptDocument、编辑候选增加 `expected_candidate_revision` 冲突控制、确定性 Markdown 导出）、`backend/src/routes/scripts.ts`（实现 `/api/chapters/:id/script` 与 `/api/scripts/:id/*` 接口，透传候选版本控制）、`backend/src/server.ts`（注册 `scriptRoutes`）、`backend/src/db/database.test.ts`。
    - **测试文件**：`backend/src/services/script_service.test.ts`（8/8 全部通过，包含 SC02 强引用校验、SC04 候选版本冲突、P1-1 候选载荷非法拦截）、`backend/src/routes/scripts.test.ts`（8/8 全部通过）、`backend/src/db/database.test.ts`（3/3 全部通过）。
    - **决策**：严格实现方案规定的两张表结构；短事务内对比 expected_revision 防止两标签页冲突覆盖（409 Conflict）；候选编辑与采纳引入 `expected_candidate_revision` 并自增版本，彻底杜绝并发覆盖；候选载荷按 outline/scene/document 细分校验并在事务提交前执行全文档校验，防止写入无效提纲或单场破坏剧本合法性；确认时强制引用完整性检查（角色所属当前项目、对白角色属于场景出场、地点道具已声明引用）及来源快照内容/语义上下文哈希一致性检查；所有剧本操作严格禁止改写 `chapter.content/summary/condensed_content`（SC01/02/04/05）。
    - **验证**：内存 SQLite 与 Fastify inject 全生命周期验证通过；全库 332 个后端测试全部通过；前后端类型检查与 Vite 生产构建 0 错误。
- [x] **S1-FE · 独立剧本编辑页。**
  - 新增项目 script 路由，章节导航、提纲/分场编辑、原文对照、角色引用与 Markdown 阅读版/导出；新文案走 locales。无模型可手写，切章与脏缓冲可恢复。
  - **AC：** SC01/02/04；故事与剧本独立保存、刷新可读。
  - **Decision & Audit（2026-09-29）**：
    - **修改文件**：`App.tsx`（添加 `/project/:id/script` 路由）、`pages/ProjectLayout.tsx`（添加剧本导航标签链接）、`pages/ScriptEditor.tsx`（新建独立分场剧本编辑页：章节列表、状态标签、小说原文只读对照侧栏、提纲/分场/地点道具三标签、分场动作/对白/画外音/音效块编辑、角色中心出场角色绑定、脏数据保护与切章提示、Markdown 阅读导出弹窗与下载；修复异步竞态风险，引入 `selectedChapterRef`、`documentRef`、`scriptDataRef` 与 `latestLoadChapterIdRef`，保证异步保存与加载不会覆盖其他章节或冲掉并发输入）、`services/api.ts`（封装剧本增删改查、保存草稿、确认、恢复和导出接口）、`locales.ts`（补齐中英文 `script_editor` 及导航文案）。
    - **决策**：严格在独立界面提供无模型纯手写能力；小说正文采用只读侧栏对照展示，彻底阻断在剧本页误改小说正文的可能；剧本数据独立保存至 SQLite，刷新可读；切章及页面卸载前提供脏缓冲确认拦截；异步保存和加载加入引用检查与本地脏缓冲合并保护，杜绝异步回调串章覆盖（SC01/SC02/SC04）。
    - **验证**：根 `npm run typecheck`、后端 `tsc`、根 `npm run build`（Vite 生产构建）全部 0 错误通过；20/20 个剧本核心单元测试与 Fastify 接口测试全部通过。
- [x] **S2 · AI 改编与有限 Agent 入口。**
  - 提纲→逐场生成→完整验证；全文与单场候选支持编辑/采纳/丢弃；复用现有 Provider。Agent 按页面和稳定目标选择服务，采纳不重新调模型。
  - **AC：** SC03/05/06/07/12；超预算、缺场及单场失败均不部分采纳。
  - **Decision & Audit（2026-09-30）**：
    - **修改/新增文件**：`backend/src/services/ai/script_generation_service.ts`（新增改编提纲生成、逐场剧本生成流水线、单场局部改写、角色库精确与子串安全匹配、预算硬约束校验）、`backend/src/schemas/script.ts`（扩展 `CreateScriptCandidateBodySchema` 支持无 `after_json` 时透传 AI 指令与目标时长/分场）、`backend/src/routes/scripts.ts`（在 `POST /candidates` 中集成 `ScriptGenerationService` 与 `ScriptGenerationError` 状态码映射）、`backend/src/services/ai/agent_executor.ts`（实现 `GENERATE_SCRIPT_OUTLINE`、`GENERATE_SCRIPT`、`REWRITE_SCRIPT_SCENE` 意图，生成 pending 候选并阻断小说正文直接修改）、`components/agent/AgentActionCard.tsx` 与 `components/agent/AgentExecutionResultCard.tsx`（新增短剧 Agent 方案描述与待审核候选提示卡）、`pages/ScriptEditor.tsx`（增加 AI 生成提纲/整剧本/改写本场操作入口、待审核候选审核横幅、一键采纳与丢弃、监听 Agent 数据变更自刷新）、`services/api.ts`（封装候选创建、编辑、采纳、丢弃接口）、`locales.ts`（中英文双语补齐 AI 剧本生成与候选操作文本）。
    - **测试文件**：`backend/src/services/ai/script_generation_service.test.ts`（7/7 全部通过，覆盖 SC03 幂等与无需重新调模型、SC05 来源修改后拒绝采纳、SC06 空输出/非法 JSON/未知角色/中途单场失败整章回滚/字数超限拒收、SC07 单场改写保留稳定 ID 且完全不动其他场、SC12 Agent 执行不污染小说正文与拒绝跨项目目标）、`backend/src/schemas/script_boundary.test.ts`（2/2 通过）、`backend/src/routes/scripts.test.ts`（9/9 通过）、`backend/src/services/script_service.test.ts`（8/8 通过）。
    - **决策**：严格按照「提纲→逐场生成（每个已采纳节拍一场，上限 12 场）→全文完整性校验」构建生成管线；任何中间场次失败或遇到未在项目角色中心登记的对白角色，执行 Fail-Closed 立即中止整章并拒绝落库，绝不产生“半份剧本采纳”；局部单场改写严格维持 `targetScene.id` 稳定且完整保留其他场次 ID 与内容块；Agent OS 严格作为有限入口仅生成 `pending` 状态候选，不自动覆写 `chapter_script`，小说故事正文在任何剧本操作下均保持 100% 逐字不可变；全生命周期操作以 `request_key` 保证幂等。
    - **验证**：根 `npm run typecheck` 0 错误；后端 `tsc` 0 错误；后端全部 339 个单元测试 100% 通过（339 pass, 0 fail）；根 `npm run build`（Vite 生产构建）0 错误完成。
- [x] **S3 · 剧本到现有导演的安全交接。**
  - 从现有 Timeline 服务拆出候选阶段，共用镜头编译与门禁；增加来源追踪和对白/画外音 block 覆盖；空 Timeline 原子提交镜头与版本。更新 packShotSpec、Coverage、Scene Version 来源传递。
  - **AC：** SC08/09/10；超过 20 镜明确失败，已有资产保留。
  - **Decision & Audit（2026-09-30）**：
    - **修改/新增文件**：
      - `backend/src/schemas/shot_contract.ts`：扩展 `ShotSourceReferenceSchema` (`{ type: 'chapter' | 'script', script_id, script_revision, script_scene_id, block_ids }`)，在 `ShotContractFieldsSchema` 与 `packShotSpec` 序列化中完整固化 `source` 溯源字段。
      - `backend/src/schemas/script.ts`：增加分镜候选相关 Contract 与 Payload Schema（`StoryboardCandidateShotSchema`、`StoryboardCandidatePayloadSchema`、`CreateStoryboardCandidateBodySchema`、`ApplyStoryboardCandidateBodySchema`）。
      - `backend/src/routes/coverage.ts`：`compileCoverageCandidate` 支持接收 `sourceRef`，补拍生成时自动从 `sourceScene.shot_spec` 继承来源溯源。
      - `backend/src/services/timeline_generation_service.ts`：小说叙事生成分镜场景时在 `packShotSpec` 统一写入 `source: { type: 'chapter' }`。
      - `backend/src/services/ai/prompt_registry.ts`：注册 `script_storyboard_gen` 提示词模板。
      - `backend/src/services/script_service.ts`：`createPendingCandidate` 与 `updatePendingCandidate` 支持校验 `kind === 'storyboard'`；通用 `applyCandidate` 严格拒绝分镜候选并指引使用分镜采纳专线。
      - `backend/src/services/ai/storyboard_generation_service.ts`（新建）：实现分镜候选生成与空 Timeline 原子提交：严格校验剧本已确认与来源新鲜度；20 镜预算硬限制（超限则 Fail-Closed 抛出 400，绝不静默切片截断）；100% 分场覆盖率检查与 100% 对白/画外音 block 覆盖率检查（严禁缺失、重复分配、跨场或乱序）；从 block 原文确定性组装 `dialogue`/`narration` 及 `audio_prompt`（严格保持原文及块内相对顺序）；复用镜头编译流水线（Pony Prompt 编译、Sanitizer、Negative Prompt、Uniqueness 检查与配额校验）；落地 `script_change` 候选记录；采纳时短事务检查空 Timeline（`scene` 记录数为 0）及进行中生成任务，批量插入 `scene`（初始 `active_version = 1`）与 `scene_version` 基线，更新候选状态为 `applied` 并记录 `result_json`；支持幂等重试（已采纳直接返回 `scene_ids`）。
      - `backend/src/routes/scripts.ts`：新增 `POST /api/scripts/:scriptId/storyboard-candidates` 与 `POST /api/scripts/:scriptId/storyboard-candidates/:changeId/apply` 路由及 `StoryboardGenerationError` 状态码映射。
      - `services/api.ts`：增加 `createStoryboardCandidate` 与 `applyStoryboardCandidate` 接口。
      - `pages/ScriptEditor.tsx`：增加分镜候选生成入口按钮、Timeline 场景计数检测、空 Timeline 保护提示与已有镜头防覆盖拦截、分镜候选卡片展示（镜头数量、分场归属、正反打提示与详细参数预览）、采纳成功提示与自动刷新。
      - `locales.ts`：补充导演分镜候选、空 Timeline 保护警告及采纳相关的中英文双语对照。
    - **测试文件**：
      - `backend/src/services/ai/storyboard_generation_service.test.ts`（新建，5/5 全部通过，全覆盖 SC08、SC09、SC10 场景）：
        - SC08 门禁：100% 覆盖全部分场、100% 覆盖对白/画外音 block、文本与相对顺序保真、超过 20 镜硬预算拒收（绝不切片截断）、遗漏 block 或重复分配或乱序或跨场均 400 失败。
        - SC09 原子采纳：空 Timeline 下原子插入所有 scene、生成初始 active_version=1 的 scene_version 基线、记录 script_change applied 状态及 result_json、重复采纳幂等返回已有 scene_ids。
        - SC10 保护已有资产：当 Timeline 存在已有场景时，拒绝写入并返回 409 Conflict，现有 scene 与版本资产 100% 完整保留。
      - `backend/src/routes/scripts.test.ts`（扩展，12/12 全部通过，覆盖分镜候选创建与采纳路由验证）。
    - **决策**：严格在剧本确认后开放分镜候选生成；严格执行 20 镜上限硬门禁，绝不使用静默切片伪装成功；对白与画外音 block 文本确定性拼装，不重新调用大模型改写，严防台词走样；仅允许向空 Timeline 采纳，已有场景时提供预览与 409 拒绝，严防误冲掉既有导演制作进度。
    - **验证**：全量后端测试套件 `npm --prefix backend test` 355/355 全部通过（0 失败）；根目录 `npm run typecheck` 0 错误；根目录 `npm run build`（Vite 生产构建）0 错误完成。
- [x] **S4 · 备份、恢复与整链验收。**
  - 剧本最近变更恢复、复制/删除事务、JSON 新格式往返与 ID 重映射；小说直出及导演回归。浏览器完成一份故事到剧本、分镜再到导出回导的旅程，真实模型改编质量单独记录。
  - **AC：** SC01–13 全部有证据；静态检查、相关测试与 UI build 按仓库规则通过。文档、模型桩、真实模型样例和视频实机结果分别记录，不互相代替。
  - **Decision & Audit（2026-09-30）**：
    - **修改/新增文件**：
      - `backend/src/schemas/script.ts`：新增 `remapScriptDocumentCharacters(doc, charMap)` 纯函数递归重映射分场出场角色 ID 与动作/对白/画外音角色引用；新增 `remapShotSpecScriptId(shotSpec, scriptIdMap)` 重映射分镜溯源 `shot_spec.source.script_id`。
      - `backend/src/routes/chapters.ts`：在章节删除事务（`DELETE /api/chapters/:id`）增加 `script_change`、`chapter_script`、`scene_version` 级联清理，杜绝孤儿记录（SC11 Part 1）。
      - `backend/src/routes/projects.ts`：
        - 项目导出（`GET /:id/export`）：升级备份格式为 `version: 2`；查询并导出 `screenplay.scripts`（包含完整的 `document`、`source_snapshot`、哈希与 `changes` 列表）；在 `summary` 中统计 `scripts` 数量；
        - 项目复制（`POST /:id/duplicate`）：事务中深度克隆 `chapter_script` 与 `script_change`，重映射角色 ID 与剧本 ID；重构来源快照哈希；重映射 `scene` 与 `coverage_shot` 中的 `shot_spec.source.script_id`；返回包含 `scripts` 的统计计数（SC11 Part 2）；
        - 项目删除（`DELETE /:id`）：级联删除项目下所有章节关联的 `script_change` 与 `chapter_script`。
      - `backend/src/services/import/novastory_json_model.ts`：定义 `NovaStoryJsonImportScriptChange` 与 `NovaStoryJsonImportScript` 契约，支持解析 `screenplay.scripts` 与旧版 `jsonContent.scripts`，校验章节归属；`NovaStoryJsonImportCharacter` 记录 `sourceId` 以便重映射。
      - `backend/src/services/import/novastory_json_import.ts`：在 `restoreNovaStoryJsonProject` 事务中建立 `characterIdMap` 与 `scriptIdMap`，完整还原 `chapter_script` 与 `script_change`，分配独立 UUID 避免主键冲突；重映射场景与补拍分镜中的 `shot_spec.source.script_id`；为导入的 scenes 自动建立 `scene_version` 基线；保持对遗留 V1 JSON 备份的向前兼容（SC11 Part 3）。
      - `backend/src/services/import/import_preview.ts`：在导入预览统计 `counts` 中扩充 `scripts` 数量展示。
      - `backend/src/routes/timeline.ts`：`GET /api/timeline/:chapter_id` 返回章节剧本元数据 `{ script: { id, revision, status } }`，支持前端比对剧本最新 revision。
      - 前端：
        - `types.ts`：扩展 `Scene` 接口增加可选 `shot_spec` 字段。
        - `services/project_import.ts`：在 `ProjectImportPreview['counts']` 增加 `scripts?: number`。
        - `pages/Dashboard.tsx`：导入预览统计网格扩展至 4 列，展示 Scripts 统计指标。
        - `components/Director/DirectorTimeline.tsx`：支持 `chapterScript` 属性；为分镜卡片渲染来源标识（`剧本 r{revision}` 或 `小说直出`）；检测到 `chapterScript.revision > source.script_revision` 时高亮显示 `来源过期` 警告徽标（SC11 Part 4）。
        - `pages/DirectorMode.tsx`：加载时间线时同步保存 `chapterScript` 元数据并传入 `<DirectorTimeline />`。
    - **测试文件**：
      - `backend/src/routes/scripts_s4_lifecycle.test.ts`（新建，6/6 全部通过）：
        - SC11 Part 1：章节删除与项目删除级联清理剧本和变更记录，绝无孤儿记录。
        - SC11 Part 2：项目复制完整克隆剧本与变更，严格重映射角色 ID 与 `shot_spec.source.script_id`。
        - SC11 Part 3：项目导出（version: 2）并回导导入，完整还原剧本、快照与变更历史，重映射语义关联。
        - 向后兼容：V1 版无 scripts 的遗留 JSON 备份无缝导入。
        - SC11 Part 4：时间线返回剧本元数据，剧本版本递增时准确识别出已过期的分镜来源。
      - `backend/src/services/text_import.test.ts`：更新导出 `summary` 断言匹配 `scripts: 0`。
    - **决策**：严格在导出与回导中维持剧本语义相等与 ID 重映射闭包；项目复制与级联删除纳入短事务处理；导演时间线显式感知剧本版本演进并在分镜卡片展示来源标识与过期告警，保证创作者明确追踪镜头来源新鲜度。
    - **验证**：全量后端测试套件 `npm --prefix backend test` 364/364 全部通过（0 失败）；根目录 `npm run typecheck` 0 错误；后端 `npm --prefix backend run build` 0 错误；根目录 `npm run build`（Vite 生产构建）0 错误完成。

**Decision & Audit（Track 5 最终全闭环，2026-09-30）**：
- **验收矩阵（SC01–SC13）全量核验达成**：
  - **SC01**：故事与剧本独立保存，故事 `chapter.content/summary/condensed_content` 在剧本生命周期各阶段逐字不变（验证：`script_boundary.test.ts`、`scripts.test.ts`、`scripts_s4_lifecycle.test.ts`）。
  - **SC02**：无模型手写剧本，提纲/分场/角色引用严格校验，确定性 Markdown 导出（验证：`script_service.test.ts`、`scripts.test.ts`、`ScriptEditor.tsx`）。
  - **SC03**：提纲→逐场候选→编辑→采纳，采纳阶段 LLM 调用数为 0，`request_key` 幂等（验证：`script_generation_service.test.ts`）。
  - **SC04**：切章脏缓冲提示，expected_revision 与 expected_candidate_revision 乐观锁，并发修改返回 409（验证：`script_service.test.ts`、`ScriptEditor.tsx`）。
  - **SC05**：小说来源变更导致哈希失配时拒绝采纳旧候选与确认（验证：`script_service.test.ts`、`script_generation_service.test.ts`）。
  - **SC06**：Fail-Closed 保护：空输出、未知角色、单场失败、超时或字数超限拒收，整章回滚不半份采纳（验证：`script_generation_service.test.ts`）。
  - **SC07**：局部单场改写保持 `targetScene.id` 稳定且完全不改动其他场次（验证：`script_generation_service.test.ts`）。
  - **SC08**：分镜候选生成门禁：100% 覆盖全部分场及对白/画外音 block，文本与相对顺序保真，超 20 镜上限硬拒收（绝不静默截断）（验证：`storyboard_generation_service.test.ts`）。
  - **SC09**：向空 Timeline 原子采纳镜头及版本基线，重复采纳幂等（验证：`storyboard_generation_service.test.ts`）。
  - **SC10**：Timeline 存在已有镜头时拒绝采纳并返回 409 Conflict，现有镜头与资产完整保留（验证：`storyboard_generation_service.test.ts`）。
  - **SC11**：剧本更新后导演分镜识别来源过期；章节与项目删除级联清理；复制与 JSON 备份 V2 往返重映射 ID（验证：`scripts_s4_lifecycle.test.ts`）。
  - **SC12**：Agent 在剧本页面执行改写走短剧服务，拒绝跨项目目标，不污染小说正文（验证：`script_generation_service.test.ts`、`script_boundary.test.ts`）。
  - **SC13**：故事→剧本→分镜交接→导演→导出回导整链闭环，小说直出与既有能力无回归。
- **全栈门禁**：
  - 后端自动化测试套件：364 项测试全部通过（`npm --prefix backend test`）。
  - 静态类型检查：前端及后端全部 0 错误（`npm run typecheck` + `npm --prefix backend run build`）。
  - 生产打包构建：Vite + esbuild 生产打包 0 错误（`npm run build`）。

**评审修复与补充验收（2026-09-30）**：

| 范围 | 修复后的验收条件 | 验证 |
| --- | --- | --- |
| 测试数据库隔离 | 标准测试入口及新增数据库测试直接运行均使用内存数据库；临时磁盘库的项目哨兵不被删除 | `run-tests.ts`、`test_setup.ts`，独立子进程复验通过 |
| 小说正文与摘要 | 摘要返回 null/空文本时 Agent 草稿、三项改写技能及 HTTP 接口均不写正文；续写摘要依据合并后的整章生成 | `script_review_regressions.test.ts` |
| SC04 候选并发编辑 | 相同候选修订号的两个并发编辑只允许一个成功，另一个返回 409 | `script_review_regressions.test.ts` |
| SC07 单场改写 | 改写后重新验证必留事件的实际文本覆盖并更新事件编号，遗漏时拒绝生成候选 | `script_review_regressions.test.ts` |
| SC08/SC09 分镜应用 | 事务内重查剧本状态、修订、来源及候选版本；重新校验覆盖、音轨、来源、唯一性与镜头配额；部分写入失败完整回滚且可重试 | `script_review_regressions.test.ts`、`storyboard_generation_service.test.ts` |
| SC05/SC11 复制与导入 | 单场候选角色、分镜来源、采纳结果镜头编号完整重映射；保留历史来源正文及哈希，过期来源不会被洗成最新 | `script_review_regressions.test.ts` |
| 配置与显示 | Gemma 清理 Ollama 占位密钥；Vite 不注入后端密钥；角色模糊匹配优先最长名称且拒绝等长歧义；一节拍一场；提示显示场次序号 | `llm_presets.test.ts`、`script_review_regressions.test.ts`及类型/构建检查 |

验证结果：全量后端测试 **374/374** 通过；前端及后端 `typecheck`、生产构建及 `git diff --check` 均通过。该轮使用模拟模型验证故障和状态边界，未调用真实远端模型服务。

---

## 📌 Track 6: 本机中文 TTS 音色与角色绑音

> **方案（唯一契约）**：[local_chinese_tts_voice_cn.md](./deployment/local_chinese_tts_voice_cn.md)。实现时以该文的接口、字段和保存规则为准；本文只排任务顺序。
>
> **目标**：NovaStory 通过 Fastify 连接本机 `local-chinese-tts`（默认 `http://127.0.0.1:8765`）。作者能查询并试听音色，在资产管理的角色上保存音色编号。浏览器不直连 8765。
>
> **2026-10-02 实测**：`GET /api/health` 成功，`voices: 30`，`default_voice: QF1`；`GET /api/voices` 返回 32 条（light 4、quality 13、online 13、clone 2）。健康检查的计数不含克隆。克隆条目含本机绝对路径 `ref_audio`，代理响应必须去掉。
>
> **顺序**：T6.1 → T6.7。一次只做一块。默认测试不连接真实 TTS。T6.6 做浏览器验收。

- [x] **T6.0 · 写下最佳实践方案。**
  - **AC：** `docs/deployment/local_chinese_tts_voice_cn.md` 写明代理边界、公开音色结构、`voice_id` / `voice_label`、保存规则、试听上限，以及导出/复制/提取的不变量。`docs/README.md` 能索引到该文。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：音色是角色上的外部编号，写入新列 `character.voice_id` 与服务端生成的 `character.voice_label`。`visual_tags` 与 `character_version` 继续只描述形象。目录以 `GET /api/voices` 为活数据，不入库。试听走 `POST /v1/audio/speech` 的字节流，不保存 TTS `cache/` 里的 URL，也不调用 TTS 的 `POST /api/settings`。
    - **改动文件**：`docs/deployment/local_chinese_tts_voice_cn.md`（新）、`docs/0_TASKLIST.md`、`docs/README.md`。
    - **下游**：T6.1 起按该文实现。章节配音、视频混音、克隆上传、项目级旁白、Agent 自动挑音色留在方案第 13 节，不进入本 Track 的 `[ ]`。
    - **边界**：本任务只交付文档。未改角色表、路由或界面。

- [x] **T6.1 · TTS 根地址与回环守卫。**
  - **实现：** `backend/src/core/settings_manager.ts` 增加 `tts.base_url` 与 `tts.enabled`。`TTS_BASE_URL` 覆盖已保存地址，示例写入 `backend/.env.example`。纯函数拒绝带用户名、密码、非空路径的 URL；主机不是 `127.0.0.1` / `localhost` / `::1` 时，除非 `TTS_ALLOW_REMOTE=1`，否则返回 `TTS_URL_REJECTED` 且不发起网络请求。
  - **AC：** 单测覆盖默认地址、环境变量覆盖、非法 URL 不发请求、`TTS_ALLOW_REMOTE=1` 才允许非回环。`cd backend && npm test` 与根 `npm run typecheck` 通过。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：`SettingsManager` 接入 `tts` 配置项（默认 `http://127.0.0.1:8765`，`enabled: true`），支持 `TTS_BASE_URL` 环境变量覆盖与 `.env` 持久化同步。纯函数 `validateTtsBaseUrl` 严格校验协议、用户名密码、路径、查询参数/哈希，以及回环地址（`127.0.0.1`、`localhost`、`::1`、`[::1]`）；非回环地址仅在 `TTS_ALLOW_REMOTE=1` 时放行，其余情况拒绝并返回 `TTS_URL_REJECTED`，不发起任何网络请求。
    - **改动文件**：`backend/src/core/settings_manager.ts`、`backend/src/services/tts_service.ts`（新）、`backend/src/services/tts_service.test.ts`（新）、`backend/.env.example`、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.2 状态探测与音色目录代理、T6.4 试听代理服务。
    - **边界**：本任务仅建立根地址管理与回环安全守卫，尚未注册新路由，未修改数据库角色列。


- [x] **T6.2 · 状态与音色目录代理。**
  - **实现：** 新增音色目录归一与 `GET /api/tts/status`、`GET /api/tts/voices`，在 `backend/src/server.ts` 注册。状态在上游失败时仍返回 HTTP 200 且 `ok: false`。`voice_count` 等于目录长度。公开结构只含 `id, name, gender, style, locale, description, tier, offline, provider`，按 light → quality → clone → online 排序。
  - **AC：** 用含 `ref_audio: /Users/...` 的夹具断言响应文本没有绝对路径，也没有 `instruct`、`model`、引擎字段 `voice`。上游不可达时 voices 为 503 `TTS_UNAVAILABLE`。`server.test.ts` 的路由基线加上本任务注册的 2 条路由。默认测试不访问 8765。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：创建 `TtsService.getStatus` 与 `TtsService.getVoices`，新增 `backend/src/routes/tts.ts` 并在 Fastify 注册 `/api/tts`。目录归一化彻底剥离上游绝对路径 `ref_audio`、`ref_text`、`instruct`、`model`、引擎字段 `voice` 与硬件占用等内部字段，仅透出标准 9 个公开字段，严格按 `light → quality → clone → online` 并在档内按 `id` 稳定排序。状态接口始终返回 HTTP 200，上游异常时置 `ok: false` 并将 `voice_count` 归零，成功时计数以活目录长度（如 32 条）为准。音色代理在上游不可达或被禁用时返回 503 `TTS_UNAVAILABLE`。
    - **改动文件**：`backend/src/services/tts_service.ts`、`backend/src/routes/tts.ts`（新）、`backend/src/server.ts`、`backend/src/server.test.ts`、`backend/src/services/tts_service.test.ts`、`backend/src/services/fixtures/tts_voices_sample.json`（新）、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.3 角色保存校验音色存在性及生成 `voice_label`、T6.6 角色编辑弹窗音色选择器、T6.7 设置页连通状态展示。
    - **边界**：本任务未修改数据库角色表（留待 T6.3），未接入试听音频流（留待 T6.4）。


- [x] **T6.3 · 角色音色列与保存规则。**
  - **实现：** `database.ts` 迁移 `018_character_voice`（`ensureColumns`：`voice_id`、`voice_label`）。扩展 `CharacterCreateSchema` / `CharacterUpdateSchema` 与 `PUT/POST`。省略字段保持原值；`null` 或空串清空且不访问 TTS；相同编号不访问 TTS；新编号必须存在于当场目录，由服务端写入 label；未知编号 400、上游不可达 503，并且本次不写任何列。客户端传入的 `voice_label` 丢弃。
  - **AC：** 局部 `PUT { avatar_url }` 不改变 `voice_id`。失败用例里角色行与 `visual_tags` 保持调用前的值。`character_version` 仍只有 description 与 visual_tags。生图提示词组装结果不含 `voice_label`。未传 `voice_id` 的新角色两列为 NULL。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：应用数据库迁移 `018_character_voice` 为 `character` 表添加 `voice_id` 与 `voice_label` 列。Zod 增加 `VoiceIdSchema`，匹配 `^[A-Za-z][A-Za-z0-9_]{0,79}$`，空串与 null 归一化为 null。保存规则严格落实 Fail-Closed：局部更新（如 `{ avatar_url }`）或省略 `voice_id` 保持原值不碰 TTS；清除（`null` 或 `""`）在 TTS 离线时依然可保存；相同编号直接复用原值；新编号当场拉目录检验，未知报 400 `VOICE_NOT_FOUND`，TTS 不可达报 503 `TTS_UNAVAILABLE`，校验失败在执行 `UPDATE` 前拦截，整行数据及 `visual_tags` 原样保留。客户端传入的 `voice_label` 丢弃，由服务端按 `${id} · ${name} · ${style}` 格式生成并存库。`character_version` 保持仅快照形象（`description` 与 `visual_tags`），提示词编译完全不包含音色字段。
    - **改动文件**：`backend/src/db/database.ts`、`backend/src/db/database.test.ts`、`backend/src/schemas/character.ts`、`backend/src/routes/characters.ts`、`backend/src/routes/character_voice.test.ts`（新）、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.5 导出/回导/复制/提取持久化保证、T6.6 角色编辑弹窗绑音与清除交互。
    - **边界**：本任务未改动短句试听接口（留待 T6.4），未改动项目复制与 JSON 备份逻辑（留待 T6.5）。


- [x] **T6.4 · 短句试听代理。**
  - **实现：** `POST /api/tts/preview`。省略文本时使用「这是这个角色的声音。」；空白或超过 80 字返回 400，不截断。上游请求固定 `model=local-chinese-tts`、`speed=1`、`response_format=mp3`，`voice` 用公开 id。成功返回 `audio/mpeg`。超时 120 秒返回 504 `TTS_TIMEOUT`。响应体超过 8MiB 按上游失败。
  - **AC：** 成功响应用于播放的内容类型是 audio/mpeg；未知音色 400；不新增 `media_asset` 行，不写 `scene.audio_prompt`。路由基线再加 1。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：实现 `TtsService.preview` 与 `POST /api/tts/preview` 试听代理。文本缺省默认使用「这是这个角色的声音。」，空白或超出 80 字符严格返回 400 `INVALID_PREVIEW_TEXT` 且不截断；校验 `voice_id` 必须存在于活目录，未知报 400 `VOICE_NOT_FOUND`；固定上游 `model="local-chinese-tts"`、`speed=1`、`response_format="mp3"` 发起请求，设置 120 秒超时守卫返回 504 `TTS_TIMEOUT`；设置 8MiB 响应上限（超限或上游故障返回 503 `TTS_UNAVAILABLE`）；成功返回 `Content-Type: audio/mpeg` 二进制 MP3 字节流。全程不写库，断言不向 `media_asset` 插入记录。OpenAPI 基线路由操作数由 53 增加至 54。
    - **改动文件**：`backend/src/services/tts_service.ts`、`backend/src/routes/tts.ts`、`backend/src/server.test.ts`、`backend/src/services/tts_service.test.ts`、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.6 角色编辑弹窗中的试听按钮（`character-voice-preview`）。
    - **边界**：试听只读内存处理，不写任何持久化记录；本任务未改动导出/回导/复制逻辑（留待 T6.5）。

- [x] **T6.5 · 导出、回导、复制与提取保持音色。**
  - **实现：** 导出 version 仍为 2，角色对象带可选 `voice_id`、`voice_label`。`novastory_json_model.ts`、`novastory_json_import.ts` 与 `projects.ts` 的角色复制插入这两列。编号不因角色 id 重映射而改变。`POST /api/characters/extract` 更新已有角色时不写这两列。文本草稿导入与规划/写作插入的新角色保持 NULL。
  - **AC：** 复制后的角色音色编号与源项目相同。无音色字段的旧 JSON 导入为 NULL。对已绑音色的角色执行正文提取后，`voice_id` 与 label 不变。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：在 `backend/src/routes/projects.ts` 的项目副本复制逻辑中，插入 `character` 显式带上 `voice_id` 与 `voice_label`，外部编号不参与角色 ID 重映射；在 `novastory_json_model.ts` 规范化中为 `NovaStoryJsonImportCharacter` 补充可选的 `voiceId` 与 `voiceLabel`，并在 `novastory_json_import.ts` 中写入两列，旧版备份 JSON 缺省时自然回落为 NULL；`POST /api/characters/extract` 的更新操作严格只更新形象与文本字段，保证已绑音色绝不被正文提取冲刷覆盖；新建角色时两列保持 NULL。
    - **改动文件**：`backend/src/routes/projects.ts`、`backend/src/services/import/novastory_json_model.ts`、`backend/src/services/import/novastory_json_import.ts`、`backend/src/routes/character_voice.test.ts`、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.6 前端角色编辑与资产管理展示。
    - **边界**：本任务仅处理持久化流转（复制、导入、导出、提取），未修改前端界面组件（留待 T6.6）。

- [x] **T6.6 · 资产管理角色可选、可听、可保存音色。**
  - **实现：** `CharacterEditModal` 增加状态、分档选择、试听、清除；`CharacterCard` 显示 label 或「未设定音色」。`types.ts`、`services/api.ts`、`locales.ts` 的中英词典一起补。`data-testid`：`character-voice-status`、`character-voice-select`、`character-voice-preview`、`character-voice-clear`。保存请求携带 `voice_id`。目录中已消失的编号仍显示 label，并说明本机目录中已没有这个音色。
  - **AC：** 浏览器打开资产管理 → 角色，以及 `/characters`。选中一个音色（服务可用时选克隆档并试听），保存后卡片显示 label，刷新后仍在。清除后再保存，卡片为未设定。TTS 不可达时，已保存 label 仍在，改选新音色失败且原编号不变，清除仍能保存。桌面与约 390px 宽都能滚动到选择器和按钮。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：
      1. 在 `types.ts` 扩展 `Character` 接口补充可选的 `voice_id` 与 `voice_label`，并新增 `TtsVoiceTier`、`PublicTtsVoice`、`TtsStatusResult` 接口声明。
      2. 在 `services/api.ts` 扩展 `getTtsStatus`、`getTtsVoices` 与 `previewTts`（返回 audio blob 二进制流，统一封装 `ApiError` 错误传递）。
      3. 在 `locales.ts` 补齐中英双语的音色词典（包含状态、分档标签、在线/高质/克隆提示、试听中、清除、目录缺失警告等）。
      4. 在 `components/character/CharacterCard.tsx` 增加 `data-testid="character-card-voice"` 徽标，有 `voice_label` 时展示 `${char.voice_label}`，缺省展示「未设定音色」。
      5. 在 `components/character/CharacterEditModal.tsx` 构建角色音色完整功能区：`character-voice-status` 展示连通性与活目录总数（32 个）；`character-voice-select` 遵循 `light → quality → clone → online` 四档原生 `<optgroup>` 分组展示，并在目录已消失的已保存音色上标注「本机目录中已没有这个音色」；`character-voice-preview` 代理音频播放，播完/出错/弹窗关闭时自动注销释放 Blob URL 避免内存泄露；`character-voice-clear` 支持一键清空表单音色编号与展示名。
      6. 在 `App.tsx` 补充 `/characters` 顶层路由重定向至首个项目的 `/project/:id/characters`，使资产管理页与 `/characters` 均无缝到达。
      7. 浏览器自动化全流程核验通过：克隆音色试听合成（HTTP 200，21KB mp3）、绑音保存并持久化生效（刷新后保留）、清空保存恢复「未设定音色」、TTS 模拟不可达时保持原 label 且支持清空保存、390px 窄屏与桌面端均流畅滚动无裁切。新增 `CharacterVoiceUI.test.tsx` 单元测试。
    - **改动文件**：`types.ts`、`services/api.ts`、`locales.ts`、`components/character/CharacterCard.tsx`、`components/character/CharacterEditModal.tsx`、`pages/CharacterManager.tsx`、`App.tsx`、`constants.ts`、`package.json`、`components/character/CharacterVoiceUI.test.tsx`（新）、`docs/0_TASKLIST.md`。
    - **下游调用方**：T6.7 设置页展示 TTS 连通状态。
    - **边界**：本任务未在设置页接入 TTS 详情（留待 T6.7），未涉及分镜对白实际语音合成（留待后续单独立项）。


- [x] **T6.7 · 设置页显示 TTS 连通状态。**
  - **实现：** `pages/Settings.tsx` 显示是否可达、音色数量、TTS 自身默认音色和当前根地址。不在设置页选择角色音色，不调用 TTS `POST /api/settings`。
  - **AC：** 8765 可用时状态为已连通且数量与 `GET /api/tts/voices` 一致（实测目录为 32，而不是 health 的 30）。根地址不可达时页面显示未连通，角色页已保存的音色不被清空。
  - **Decision & Audit（2026-10-02）**：
    - **决策**：
      1. 创建模块化组件 `components/settings/TtsStatusCard.tsx` 并在 `pages/Settings.tsx` 的常规设置页（`activeTab === 'general'`）底部接入。
      2. 卡片仅呈现只读连通探测信息：连通徽标（`tts-status-badge`：已连通/未连通）、服务根地址（`tts-base-url`：默认 `http://127.0.0.1:8765`）、可用音色数量（`tts-voice-count`：连通时以活目录总数 32 为准，不可达时为 0）、TTS 自身默认音色（`tts-default-voice`：`QF1`）、本地神经网络模型就绪状态（`tts-models-status`：Light Edge 与 Quality/Clone CosyVoice），并提供一键刷新连通状态按钮（`tts-refresh-btn`）。
      3. 严格遵守安全与业务边界：设置页不提供任何角色音色选择器下拉框，绝不调用上游 TTS 的 `POST /api/settings` 改写全局默认朗读音色。底部附有明确的使用说明 banner。
      4. 浏览器实测验收通过：访问 `http://localhost:3000/settings` 状态即时展示「已连通」且音色数量精确为 32 个；点击刷新动态重新探测；模拟不可达时动态降级展示「未连通」且音色数为 0；返回角色资产页验证角色已保存音色未被清空或重置，持久化完好。
      5. 单元测试与端到端测试全绿：新增 `TtsStatusCard` 连通与断连双状态断言；`npm run test:agent-ui`（29 项通过）、`cd backend && npm test`（441 项全部通过）、`npm run typecheck` 与 `npm run build` 均 0 错误。
    - **改动文件**：`components/settings/TtsStatusCard.tsx`（新）、`pages/Settings.tsx`、`locales.ts`、`components/character/CharacterVoiceUI.test.tsx`、`docs/0_TASKLIST.md`。
    - **下游调用方**：Track 6 全部任务至此闭环；后续章节对白配音、视频混音等留在后续单独立项。
    - **边界**：本任务仅在设置页展示只读探测状态，未修改音色保存与试听代理逻辑。

### Definition of Done

- 作者能在资产管理的角色上查询、试听并保存音色；刷新、导出再导入、复制项目后编号还在。
- 代理响应不含克隆参考音的本机绝对路径。
- TTS 关闭时，清除音色和角色的其他字段仍能保存；把角色改绑到一个未验证的新编号会失败并保持原行。
- 默认后端测试不依赖 8765。浏览器验收覆盖资产页与 `/characters`，以及桌面和窄屏。


---

## 📌 Track 7: 统一 16:9 分镜画布与 H3 原生 24fps 视频生产契约

> 方案事实源：`docs/video/分镜生图与生视频生产最佳实践_20261003.md`  
> 本 Track 覆盖产品层媒体默认值；Track 2 继续保留 H3 模型部署、显存和黄金样片验证历史。  
> **硬规则：MiniMax H3 必须保持原生 24fps，不提供 30/60fps 主链或 UI 选项。**

### 🎯 目标

统一 NovaStory 的视觉生产链为：

```text
镜头契约 → 16:9 Shot Master → H3 @ 24fps → 720p 成片
                                      └→ 480p 预览
```

消除“漫画默认 3:4 / 视频另做 16:9”的双构图事实源；让场景、角色、道具先在 16:9 Shot Master 中收敛，再进入视频参考绑定。

### P0 — 文档与合同冻结

- [x] **T7-P0-01：建立统一媒体生产最佳实践。**
  - 文档：`docs/video/分镜生图与生视频生产最佳实践_20261003.md`
  - 决策：生图默认 16:9；移除 3:4 / 4:3；H3 默认 1280×720 / 24fps / 5.0s，保留 480p / 24fps。
  - 决策：H3 模型侧保持 124 帧长度规则，交付固定 120 帧 / 5.0s。
  - 决策：Shot Master 是视频最高优先级视觉真值；identity / guide / motion / last-frame 各司其职。
  - **AC：** 文档不得出现“默认 30fps”；必须明确 H3 model/delivery/timeline/QA 均为 24fps。

### P1 — 生图画布合同统一

- [x] **T7-P1-01：移除 3:4 / 4:3 新请求枚举。**
  - 修改：`types.ts`、`backend/src/schemas/assets.ts`、`backend/src/services/image_output_spec.ts`。
  - 新枚举只保留 `16:9 | 9:16 | 1:1 | auto`。
  - **AC：** 新 API 请求中的 3:4 / 4:3 被拒绝；TS 不再把它们暴露为合法新值。

- [x] **T7-P1-02：生图默认值统一为 16:9。**
  - 修改 `DEFAULT_IMAGE_OUTPUT_SPEC`、`pages/ProjectSettings.tsx`、`pages/DirectorMode.tsx`、`components/Director/DirectorRightPanel.tsx`。
  - 新项目、新 Director 会话和无配置 fallback 都必须是 16:9。
  - **AC：** 新项目打开设置页即显示 16:9；Director 生产配置卡不再 fallback 显示 3:4。

- [x] **T7-P1-03：重写 auto / auto_by_shot，禁止旧比例通过自动策略回流。**
  - 普通 scene/storyboard/video_keyframe → 16:9。
  - portrait 仍默认 16:9；只有显式用户选择才用 9:16。
  - cinematic grid/contact sheet → 1:1。
  - turnaround 不再用 4:3 作为对外资产契约；内部 panel/compositor 尺寸与最终资产比例解耦。
  - **AC：** 全量 `resolveImageOutputTarget` 测试中不存在 resolved 3:4 / 4:3。

- [x] **T7-P1-04：旧项目 3:4 / 4:3 数据兼容迁移。**
  - 读取旧值时归一为 16:9；项目再次保存后写回 16:9。
  - 不修改历史已生成图片文件，只影响后续生成合同。
  - **AC：** 旧项目可正常打开；无 Zod/TS 崩溃；保存后 settings 不再含 3:4 / 4:3。

- [x] **T7-P1-05：补齐画布回归测试。**
  - 更新 `backend/src/services/image_output_spec.test.ts` 及前端相关测试。
  - **AC：** 覆盖默认 16:9、显式 9:16、显式 1:1、auto、旧值迁移、turnaround、exact dimensions。

### P2 — H3 默认 720p / 24fps，保留 480p

- [x] **T7-P2-01：Director 默认视频 preset 改为 `standard_720p_5s`。**
  - 修改 `pages/DirectorMode.tsx` 与 `components/Director/DirectorRightPanel.tsx` 默认值。
  - **AC：** 首次进入 Director 视频模式默认选中“720P 标准画质”。

- [x] **T7-P2-02：保留 `preview_480p_5s` 作为显式可选预览档。**
  - 480p 用于 RTX 3060 smoke test、提示词/动作快速试错和批量预览。
  - **AC：** 用户可在 720p / 480p 间切换；切换不得改变 fps、时长或参考图语义。

- [x] **T7-P2-03：把 24fps 固化为 H3 全链硬约束。**
  - 保持/加强：`video_spec_compiler.ts`、`loop_closer.ts`、`video_postprocess_service.ts`、所有 H3 workflow manifest。
  - UI 仅显示 24fps，不提供 30/60fps 选择器。
  - **AC：** H3 model fps = delivery fps = timeline fps = QA fps = 24；测试不得出现默认 30fps。

- [x] **T7-P2-04：锁定 124 model frames → 120 delivery frames。**
  - 5.0s × 24fps = 120 交付帧；H3 内部仍请求符合 `17k+5` 的 124 帧。
  - **AC：** 720p final probe = 1280×720 / 24fps / 120f / 5.0s；480p final = 24fps / 120f / 5.0s。

- [x] **T7-P2-05：消除 Grok 6 秒请求与 5 秒产品合同的不一致。**
  - browser job 现在请求 5 秒并记录 source/delivery 时长；返回超出 5±0.25 秒时阻塞。
  - 方案：统一请求为 5 秒，或将 provider-specific 时长显式进入 spec/QA；禁止静默丢最后 1 秒。
  - **AC：** 请求时长与最终交付时长差异必须可解释、可测试、可观测。

- [x] **T7-P2-06：章节合成增加 24fps readiness 门禁。**
  - **AC：** H3 章节导出不得直接混入非 24fps final；遇到异常资产必须阻塞或显式标准化后再进入剪辑层。

### P3 — Shot Master 与参考素材职责收敛

- [x] **T7-P3-01：把 16:9 Shot Master 设为视频生成前置事实源。**
  - Location / Prop / Character Version 改动后旧 Shot Master 必须失效。
  - **AC：** preflight 能阻止使用未反映当前绑定资产的旧关键帧。

- [x] **T7-P3-02：身份参考保持“同一角色 1–3 张”，默认推荐 1–2 张。**
  - 保留 `VideoReferenceIdentityService` mixed-identity fail-closed。
  - **AC：** 不同 `character_id` 不能伪装成多图身份参考；相同角色多视角可通过。

- [x] **T7-P3-03：按镜头类型选择官方工作流。**
  - 普通单角色叙事：Official Ref2VA。
  - 复杂关键姿态：Official Multi-Frame。
  - 强首尾边界/loop：Official FL2VA。
  - 红潮 Hybrid：保留 experimental / benchmark，不作为新产品默认。
  - **AC：** UI/编排层能解释为什么选择某 workflow；不靠隐藏 fallback。

- [x] **T7-P3-04：Multi-Frame guide frame 按 24fps 时间轴展示。**
  - frame 24≈1s、36≈1.5s、48≈2s、72≈3s、96≈4s。
  - **AC：** UI 不只暴露 frame_idx 裸整数；同时展示对应秒数。

### P4 — 多角色与多关键帧增强（P1–P3 稳定后）

- [x] **T7-P4-01：设计真正的 multi-subject reference contract。**
  - 目标结构：`subject_references[{ character_id, asset_ids[] }]`。
  - 在实现前继续禁止 mixed character refs。
  - **AC：** 两个角色的身份图不会再被解释成“同一人物的三视图”。

- [x] **T7-P4-02：Multi-Frame 从单 guide 扩展为 `guide_frames[]`。**
  - 目标：多个 `{ asset_id, frame_idx }` 关键姿态。
  - **AC：** 编译器验证 frame_idx 不重复、范围合法、按 24fps 映射；工作流不支持时 fail closed。

评审修复：Multi-Frame 尾帧锚点落在交付帧 119；Comfy 生图 latent 独立按 64 对齐，最终图片仍归一为精确 16:9；视频 preflight 检查完整可见角色版本；批量 Guide 帧位非法时阻塞；同角色参考图连续上传可追加。

### P5 — E2E 验收

代码级验收：前后端 typecheck、构建及仓库测试通过；FFmpeg 实测 124 输入帧标准化为 720p/480p 的 24fps、120 帧、5 秒候选。当前 ComfyUI/H3 离线且视频功能门禁关闭，以下真实端到端验收仍需在启用服务后执行，并保留未完成状态。

- [ ] **T7-P5-01：生图合同 E2E。**
  - 新项目 → 16:9 分镜 → 16:9 video keyframe。
  - **AC：** 新链路没有 3:4 / 4:3 新写入。

- [ ] **T7-P5-02：720p 默认视频 E2E。**
  - 16:9 Shot Master → H3 → final。
  - **AC：** 1280×720 / 24fps / 120f / 5.0s，刷新恢复、QA、promote 均正常。

- [ ] **T7-P5-03：480p 预览 E2E。**
  - **AC：** 480p 仍保持 24fps / 120f / 5.0s，并可无语义变化地升级为 720p 重生。

### Definition of Done

Track 7 完成必须同时满足：

1. 新项目生图默认 16:9，3:4 / 4:3 不再作为新值暴露。
2. 历史 3:4 / 4:3 项目可兼容打开并迁移，不破坏旧图片。
3. Director 生视频默认 720p，480p 可选。
4. MiniMax H3 全链固定原生 24fps，无默认 30/60fps 插帧主链。
5. 5 秒合同精确为 120 个交付帧，H3 内部按 124 帧模型规则执行。
6. Shot Master 是场景/角色/道具/构图的唯一视频视觉真值。
7. 不同角色身份参考继续 fail closed，直到 multi-subject contract 正式落地。
8. 普通 Ref2VA / 复杂 Multi-Frame / 边界 FL2VA 的职责清晰，Hybrid 不再承担产品默认。
