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
5. **Track 5**: 独立短剧结构化剧本模块（改编提纲→分场剧本→导演交接）。S0–S4 历史验收见下文，实施仍以当前代码核验；新增 [S5 单场连续性与分轮制作](#track5-s5-continuity)，任务 CT00–CT22。复用 Track 4 的已保存故事与现有角色/导演基础，不把短剧写回小说正文。
6. **Track 6**: 本机中文 TTS 音色目录与角色绑音。连通 `local-chinese-tts`，查询、筛选、试听，并在资产管理的角色上保存音色。方案见 `docs/deployment/local_chinese_tts_voice_cn.md`。指定本 Track 时从第一个 `[ ]` 开始，不改分镜、不生成章节配音。
7. **Track 7**: 统一 16:9 分镜画布与 H3 原生 24fps 视频生产契约。生图默认 16:9 并移除 3:4/4:3；生视频默认 720p/24fps，保留 480p；统一 Shot Master 与多参考素材职责。方案见 `docs/video/分镜生图与生视频生产最佳实践_20261003.md`。
8. **Track 8**: [构图草稿保留与正式分镜生成](#track8-production-storyboards)。按“已部署能力接入 → 首批实机验收 → 新模型及连续性增强”推进，任务 FS00–FS17。草稿继续无连续性 pin；正式候选写入未激活版本，采纳才切换活动图和 Shot Master，并沿用 CT18 六项核对。Krea2 与 SDXL 保持隔离。

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
  - **复现:** `cd backend && npm test -- src/services/dreamcore_ac_verify.test.ts`。断言在 `assertDreamcoreAc`，不再依赖已删除的 fixture CLI。

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

<a id="track5-s5-continuity"></a>

### Track 5 S5 单场连续性与分轮制作任务清单

**方案**：[单场分镜连续性与分轮制作实施方案](./architecture/scene_continuity_workflow_2026-10-09.md)。本节是 CT00 至 CT22 唯一勾选状态；23 项已完成各自验收与审计。确定性流程、浏览器、真实 9B 评估及真实出图均已运行；9B 仍需人工确认，8 张成图均拒绝，任务关闭不代表模型或图片质量合格。CT21 本轮只扩展身体持物手别，未宣称全部消耗量/空间关系已支持。用户于 2026-10-10 授权持续推进直到所有任务完成；沿用“基线 → 静态检查 → 测试 → 验收矩阵”。

**范围**：单场独立生成使用已确认的故事状态；九机位共享来源镜头时刻；剧情/连续性、骨架、定样、补齐分轮完成。第一批实现确认账本与非破坏性失效；新剧本单场候选只预览，既有 coverage 生成/apply/promote 加门禁后单独验收，不串用整章采纳。真实模型只提供建议，自动确认默认关闭。

**依赖**：A（CT01–08）→ B 的模型工作；CT13 只依赖 CT08，可提前执行。C（CT15–19）依赖 CT08 + CT13，人工/规则路径不等待真实 9B；采用模型建议时另需 CT14。D（CT20–22）按实际案例排期。C01–C16、F01–F08、E01–E12 见方案；A/B 后缀区分确定性输入与模型建议，不代表通过。CT14 被端点阻塞时可转做依赖已满足的 CT13/C，不虚勾模型验收。

- [x] **CT00 · 完成连续性方案和分批任务拆解。**
  - **交付**：区分剧本场次、节拍、时间线镜头；确定入场/变化/出场状态、候选与正式版本、分轮制作和有限模型职责；列出依赖及验收矩阵。
  - **Decision & Audit（2026-10-09）**：静态核对当前 `storyboard-facts-3.1`、状态抽取/继承和九机位路径；新增详细方案，在本表管理状态并更新文档索引。下游为 CT01–CT22；没有改业务实现、执行模型验收或生成正式素材，历史测试数字不作为此次通过证据。
  - **评审修订（2026-10-09）**：采纳接口分界、按镜头保留旧图、during 独立状态、证据/规范值分离、独立实物 ID、单场写范围、真实评估口径及调用点预算八项决定；补入哈希预像、旧项目/UI、独立夹具和依赖修正。保留三点判断：九机位不是天然与整章采纳互斥；哈希问题是等价集合规范化，不宣称同输入随机变化；CT14 可验收建议能力但不授予自动确认。仅更新文档，CT01–CT22 均未关闭。

#### 批次 A 状态基础 先用已确认输入形成闭环

- [x] **CT01 · 固定当前基线与独立验收夹具。**
  - **依赖/落点**：CT00；测试、诊断记录及工作流入口。记录实际代码版本、未提交变更、策略和既有失败。
  - **交付/AC**：建立 F01 三场主链及 F02–F08 独立夹具，预先标注正反例和期望依赖；记录当前输出、失败、未支持/N/A。缺新接口只能记录缺口，不能算 C01–C13 通过；此记录不得替代 CT08。模拟/真实模型分开归档，未运行明确标注；保留单人继承、歧义待核对、施受交换拒绝及同关系被动句通过的旧回归。
  - **Decision & Audit（2026-10-10）**：基于 HEAD `6b4af00` 与实施前 31 项未提交变更建立离线诊断入口 `npm --prefix backend run continuity:baseline`；F01–F08 共 33 项预标注输入，独立实体/前态/证据/依赖、标签校验值及 F06 旧图示意数据已冻结。模拟三场输出 6 镜，正式时间线/剧本/候选写入 0；新接口与属性明确记未支持/N/A，不算 CT08。新增 7/7、相关旧回归 26/26、前端单元测试 53/53 通过；前后端类型检查、后端构建、diff 检查通过。全量基线 582/592，新增后 589/599，仍为相同 10 项既有失败；未调用真实模型、生成正式素材或运行浏览器。详细输入、调用边界和失败见 [CT01 基线记录](./archive/scene_continuity_baseline_2026-10-10.md) 及其机器记录。下游 CT02，CT02–CT22 未勾选。
- [x] **CT02 · 建立最小实体身份及故事位置契约。**
  - **依赖/落点**：CT01；共用 schema、实体映射、镜头来源类型。
  - **交付/AC**：独立 `continuity_entity` 身份，不沿用素材库名称唯一约束；同名物件可共用设计但不同 ID，角色关联现有角色 ID，组件/关系有项目归属。区分 script_scene_id/beat_id/source_shot_id；故事顺序来自剧本版本，不来自 scene.index，插机位不改故事序。C01-A/C04-A/C07-A/C08-A。
  - **Decision & Audit（2026-10-10）**：新增 `schemas/continuity.ts` 与 `continuity_identity.ts`，支持独立实物注册、角色 ID 映射、组件闭包/关系归属、剧本版本化顺序和 moment 引用；镜头来源 schema 与 `packShotSpec` 保留新引用，前端复用类型。冻结 F01–F08 标签未改；同名共享设计、合法/跨项目引用、乱序位置、coverage 同刻复制和编译往返等 12/12 通过；相关旧回归 57/57、前后端类型/构建、diff 检查通过。全量基线 589/599，验证后 605/615，仍为同样 10 项既有失败；其中 12 个新增测试属于本项，其他工作区更新净增 4 项。完成 C01/C04/C07/C08 的契约子集，完整矩阵仍待 CT08；持久化及端点门禁分别到 CT05/CT06，不宣称已有快照或正式生成能力。详见 [CT02 验收](./archive/scene_continuity_identity_2026-10-10.md)。下游 CT03–CT06；未运行真实模型、浏览器或生成素材，CT03–CT22 未勾选。
- [x] **CT03 · 定义属性变化与确认契约。**
  - **依赖/落点**：CT02；连续性 schema、校验器。
  - **交付/AC**：按方案冻结版本化属性注册表、值类型和作用域；逐件/组件分离，支持 assign/clear/completed transfer。quote/原文版本/UTF-16 范围与规范值分开；缺字段、unknown、confirmed null 不同。只有具名白名单规则或人工可确认，旧 fact.states 自动写入不成为新快照可信回退；未知属性、共同持有、未知跳时保留待核对。C01-A/C03-A/C10-A/C11-A（含合法确认正例）及 C16 回退。
  - **Decision & Audit（2026-10-10）**：新增 `continuity_state.ts` 与 `continuity_confirmation.ts`，冻结十一项属性、schema 1 / `continuity-state-1`；原文/设计证据分开，精确 UTF-16 范围与版本核验，人工批准对应建议指纹，湿度/已接收两条具名规则各带正反例。冻结确认对象及状态格，拒绝旧自动状态、伪造确认和不匹配 holder 转移；共同持有/未知跳时/未知属性保留待核对，设计不覆盖剧情，during 留给 CT04 overlay。新增 21/21、相关回归 87/87、前后端类型/构建及格式检查通过；F01–F08 标签未改。全量沙箱基线 605/615；获准沙箱外复核 provider 6/6 及全量 632/636，剩余四项均为原有失败，六项原连接失败确认为环境限制；无新增失败。完成矩阵的契约子集，完整闭环仍待 CT08，持久化与端点上下文继续由 CT05/CT06 实施。详见 [CT03 验收](./archive/scene_continuity_confirmation_2026-10-10.md)。下一项 CT04；未运行真实模型、浏览器或生成素材，CT04–CT22 未勾选。
- [x] **CT04 · 实现确定性状态回放与快照。**
  - **依赖/落点**：CT03；独立连续性服务，复用现有继承代码。
  - **交付/AC**：计算 entry/changes/exit 和 before/after，另存有确认依据的 during_overlay/moment，不从 after 倒推或改写 exit。按故事序回放，离画持续、原地点物件可查询、缺入口不回落默认。实现方案规定的 state_hash/source_hash 预像；重复执行、等价集合重排一致，事件改序/来源改版按契约变化，排除时间戳等元数据。C02-A/C05-A/C06-A/C07-A/C13-A。
  - **Decision & Audit（2026-10-10）**：新增 snapshot schema 与纯回放服务，明确人工入口、按故事序 entry/changes/exit、独立已确认 during overlay/已完成子事件、镜头属性读取与 dependency_hash；新增规范 state/source 预像，拒绝旧 JSON 回退和未知读取。冻结 F01/F03/F04/F06/F08 验持续/返回/多时刻/证据版本/读取依赖，F02 验集合重排，标签未改。新增 15/15、连续性相关 55/55、前后端类型检查、后端构建与格式通过；全量基线 632/636 → 647/651，相同四项既有失败，无新增失败。完成对应纯回放子集，持久化/写门禁与完整矩阵仍到 CT05–CT08。详见 [CT04 验收](./archive/scene_continuity_replay_2026-10-10.md)。未运行真实模型、浏览器或生成素材；继续 CT05，CT05–CT22 未勾选。
- [x] **CT05 · 持久化快照、非破坏性失效与生命周期。**
  - **依赖/落点**：CT04；数据库迁移、候选、缓存、导入导出/复制/清理。
  - **交付/AC**：版本进入现有 source_hash 与事务内采纳校验；确认/候选/时间线分修订。实现 markContinuityStale：保留镜头行、版本、coverage、参考和旧 asset_url，无关成品不变；禁止整章替换或仅存 result_json 充当保留旧图。首版回放所有可能受影响后续状态、比较实际镜头依赖，不在下一次 assign 截止。复制/导入完整重映射；旧项目可读、缺快照须核对，直写 HTTP/Agent 仍 410。C09-A/C13-A；迁移编号实施时确定。
  - **Decision & Audit（2026-10-10）**：迁移 023 与确认账本服务保存人工/规则批准、快照和每镜读取；短事务校验预期修订/幂等，完整后续回放后只标依赖镜头，保留旧图/版本/coverage/声音。缓存、候选保存及采纳加入来源指纹，旧镜头版本切回检查修订；复制/导入重映射实体/组件/关系/素材/快照/候选，签名收据验证批准，未签名导入保留待核对。新增 11 项、相关 115/115 和最终生命周期/版本回归通过；前后端类型、构建和格式通过；全量 647/651 → 658/662，仍为相同四项既有失败，无新增失败。详见 [CT05 验收](./archive/scene_continuity_persistence_2026-10-10.md)。未运行模型、浏览器或生成素材；继续 CT06–CT22。
- [x] **CT06 · 让主工作流与九机位消费同一状态。**
  - **依赖/落点**：CT05；`storyboard_fact_workflow`、分镜生成服务、`coverage` 生成/应用/加入时间线三入口。
  - **交付/AC**：单场显式 scope/target_scene_id，只读已确认前序或指定入口，只写目标场建议/候选/进度/快照；缺前态待核对，不在其他场提取、规划或落候选。coverage 生成/apply/promote 走既有三路由，不调用整章 applyStoryboardCandidate；复制来源 moment/快照，不新建变化。生成及写前版本检查，旧项目无快照明确引导；新单场正式采纳到 CT16 才开。C06-A/C07-A/C08-A。
  - **Decision & Audit（2026-10-10）**：单场请求明确范围/动作时刻/实际读取，只装配和保存本场，规划/翻译复用确认快照并关闭旧自动状态；coverage 三入口先查及事务重查同刻引用，复制固定动作，不重复事件，插机位不改故事序。迁移 024 保存版本完整契约；无关镜头重验证同步引用，旧图/历史保持；新单场候选仅预览，整章采纳拒绝。新增六项、相关 125/125 和最终媒体/迁移/版本回归通过；全量 658/662 → 664/668，剩余相同四项既有失败。前后端类型、构建、格式通过。详见 [CT06 验收](./archive/scene_continuity_consumption_2026-10-10.md)，明确区分状态消费范围测试与 CT08 全夹具。未运行真实模型、浏览器或生成素材；继续 CT07–CT22。
- [x] **CT07 · 提供最小状态核对与阻断范围。**
  - **依赖/落点**：CT05/CT06；事实核对面板、共用 API、候选审核。
  - **交付/AC**：在 /project/:id/director 提供场次选择及来源/entry/changes/exit/moment，跳转 /project/:id/script；修正并确认有证据的值，保留审计。实现方案 GET continuity、POST continuity/confirm、HTTP/错误码、zh/en 及 data-testid；显示过期旧图、阻断原因和最小恢复，不等 CT13。无关镜头可继续，确认不重写源文。C09-A/C11-A 正反例/C13-A。
  - **Decision & Audit（2026-10-10）**：只读核对、人工确认和指定镜头恢复接入导演页，迁移 025 保存正文指纹/恢复收据；原文与设计证据、during 位置、待核对建议、中英文及定位标识齐备。草稿切场/切章保留，冲突保留旧基准直至显式刷新；恢复新建无图版本，旧图/声音及无关成品保留。新增 API 4 项和页面交互 5 项通过，API/存储 14/14、前端 58/58；类型/后端构建/格式通过，全量 668/672，仍为同样四项既有失败。详见 [CT07 验收](./archive/scene_continuity_review_2026-10-10.md)。未运行真实模型或生成正式素材；完整矩阵及浏览器继续 CT08，CT08–CT22 未勾选。
- [x] **CT08 · 验收第一批完整确定性流程。**
  - **依赖/落点**：CT01–CT07；后端测试、最小浏览器旅程。
  - **交付/AC**：F01–F08 逐项覆盖 C01-A–C11-A、C13-A 与 C16 未支持回退；三场 3→1→2/1→2→3 语义一致且无他场写入。已有三场时间线验证 coverage 三动作、无重复事件；修改只标依赖过期，旧图可看。按方案在导演/剧本页以 1280×800、1920×1080 验核对、旧项目、冲突、过期、恢复。类型/相关测试与历史失败分列；三场演示不能替代全部夹具，不宣布模型通过。
  - **Decision & Audit（2026-10-10）**：F01–F08 33 项业务矩阵通过；已有时间线验证 coverage 三入口/三位置和旁场、声音、旧图保留。隔离项目在两个约定视口完成导演/剧本原文、确认、并发、切章草稿、过期和恢复；只重做实际读取黑伞完整度的镜头，蓝外套镜头一直有效。修复实体等价排列误判及另一页清除缓存后的冲突草稿丢失，针对性 48/48、页面 7/7；类型和构建通过，全量沙箱外 713/717，相同四项既有失败。11 张截图尺寸及数据库来源/媒体/修订审计通过。详见 [CT08 完整验收](./archive/scene_continuity_matrix_2026-10-10.md)。模型与正式成图均未运行；下游 CT09、CT13 和人工分轮制作。

#### 批次 B 分项提取变化与恢复 CT13 可在 CT08 后提前做

- [x] **CT09 · 将 9B 任务收敛为有来源的变化建议。**
  - **依赖/落点**：CT08；状态抽取、小任务输入装配、缓存/重试。
  - **交付/AC**：先冻结 E01–E12 标签和允许输出，再装配本场相关实体、前态、完整动作与必要前文，输出增量建议；无变化合法。逐点管理绑定 2200、来源 1800/批 900、状态 JSON 2000、节拍 1800/分组 1400 及输出/批量限制；统一一次语义修复预算，网络/拆批/实际推理另计且汇总，禁止嵌套重置。超限完整拆分或待核对；模型自审不放宽确认。C10-B/C11-B。
  - **阶段记录（2026-10-10，未关闭）**：36 案例/72 逻辑任务已冻结，新建议 API、迁移 026、持久化预约/取消/进程重启复用、输入/模型指纹、晚到结果保护和父预算通过。调用前保存预约，未知中断单列；模型建议进入待核对区，载入为显式草稿并保留既有变化。驱动/任务 13/13，含矩阵及迁移相关 57/57；前端 61/61，最后面板 8/8；类型/构建通过，全量 718/722，同样四项旧失败。旧分镜 request 与内部修复尚未统一父预算，所以仍未勾选。详见 [CT09 阶段记录](./archive/scene_continuity_suggestions_2026-10-10.md)。真实 9B 未运行，CT14 未关闭。
  - **Decision & Audit（2026-10-10，后续关闭）**：旧完整链路绑定/分类/状态/规划/翻译/审计纳入持久化父预算，一次语义修复及独立网络重试；调用前预约、进程未知中断单列，恢复不重置。内部拆批/审计修复同样消费额度；修复改写原文即待核对。父预算相关 53/53、驱动/持久化/类别/编译 58/58；全量 763/767，仍为四项旧失败，类型及生产构建通过。真实关键小集已启动，输出上限由截断证据调整为 768，标签未改；CT14 独立验收。下游 CT10–CT12/CT14，详见更新后的 [CT09 验收](./archive/scene_continuity_suggestions_2026-10-10.md)。
- [x] **CT10 · 完善逐件衣着及资产状态参考。**
  - **依赖/落点**：CT09；衣物映射、状态抽取、外观锁编译和参考版本。
  - **交付/AC**：完善衣物属性建议和外观编译；同款多件可区分，穿戴/湿度/破损/颜色独立，只改对应人和衣物；资产默认不能覆盖确认变化，参考图不改实物 ID。沿用 CT03 注册表，新增语义须升版本。C01-B/C02-B/C04-B，同时保留对应 A 回归。
  - **Decision & Audit（2026-10-11）**：逐件状态编译接入工作流、恢复和英文画面材料，修复实物 ID 丢失及默认衣着覆盖确认值；同款/穿戴者/颜色/湿度/损伤和素材版本独立回归通过。模型建议保留完整原文、ID 和待核对项，自动确认关闭。详见 [属性批次验收](./archive/scene_continuity_categories_2026-10-11.md)，真实能力按 CT14 分开记录。
- [x] **CT11 · 完善道具持有、位置、损伤与恢复。**
  - **依赖/落点**：CT09/CT10；道具关系与状态变更服务。
  - **交付/AC**：所有者、持有者、位置分开；“使用”保留动作事实，不自动当所有权。完成递交才建议转移，递出未接不转移；损伤跟物件，修复/更换有依据，同名伞不串状态。共同持有保留双方证据待核对，不丢一方；新增属性须升版本。C03-B/C04-B/C10-B 及对应 A 回归。
  - **Decision & Audit（2026-10-11）**：增量建议严格区分 holder/owner/location 及各属性允许操作；未接、同名歧义、共同持有和未知属性保留原始双方及证据待核对。逐件损伤、恢复、关系及离场回归通过；没有新增注册语义。下游为 CT14、局部制作及参考绑定，详见同一属性批次验收。
- [x] **CT12 · 加入最小场景物件变化。**
  - **依赖/落点**：CT11；背景物件登记、场所状态和事实装配。
  - **交付/AC**：完善门窗开闭、门板/玻璃完整度、门锁功能、灯开关的建议与编译；组件独立，关门不推断修锁；离场返回不重置，无人也能登记。未知属性仅建议，新注册语义升策略版本；不全量猜背景。C05-B/C10-B、E09/E10，并回归 C05-A/C06-A。
  - **Decision & Audit（2026-10-11）**：门/玻璃/锁/灯以独立实物及组件 ID 编译，空场景也能读取，关门不修锁，返回不重置。原 A 矩阵和 36 类别输入、编译相关合计 97/97；英文材料从确认值装配。未知属性继续人工回退，注册表保持现行版本；CT14 单独说明真实建议边界。
- [x] **CT13 · 完善变更差异、冲突核对与下游恢复。**
  - **依赖/落点**：CT08，可提前做，不依赖 CT09–CT12 或真实端点；状态面板、版本与依赖服务。
  - **交付/AC**：展示旧值→建议值、依据及影响镜头，撤销写新修订；复用 CT05 非破坏性失效，回放后只恢复实际依赖变化的结果，保留旧图与无关成品。首版不做 assign 提前截止；任何优化另证属性读写/关系依赖闭包。人工/规则输入完成 C09-A/C11-A/C13-A，新增模型属性后复用。
  - **Decision & Audit（2026-10-10）**：新增只读变更/撤销预览及影响指纹确认；镜头版本、图片或账本变化使旧预览失效。撤销追加具名、幂等新修订，后续场完整回放；按实际读取只恢复相关镜头的新无图版本，旧图和无关镜头保留。API 与页面针对性通过，浏览器完成预览→确认→局部恢复→撤销→再次恢复、并发与两个视口。详见 [CT13 验收](./archive/scene_continuity_diff_2026-10-10.md)。C09-A/C11-A/C13-A 通过，CT15–CT19 人工路径可继续；不声明真实 9B 或正式图片通过。
- [x] **CT14 · 实测真实 9B 建议能力，单独记录自动接受资格。**
  - **依赖/落点**：CT09–CT12 + CT13；独立回归脚本与报告。CT13/批次 C 人工路径不反向依赖本项。
  - **交付/AC**：先关键小集，再 E01–E12 各 3 变体×种子 41/97＝72 逻辑任务，另跑三场整链及专项；实际调用/子例数另计，离场互换真实成对运行。预先人工标注，分存原输出/规范化/确认；每个宣称支持类须有可接受正例，报告召回、误建议/误拦截、人工确认率与成本，未支持类回退人工。
  - **关闭边界**：真实全组和整链完成、结论可复核，可按“仅建议”关闭；模型未测仍未完成。自动接受默认关闭，接受数为零则错误接受率 N/A，不能作零错误证明；开放某属性须另立预先冻结的独立资格样本与非零完成目标。与 CT01 仅同能力同口径比较，新属性比较栏 N/A，不以全拦截通过。
  - **Decision & Audit（2026-10-11）**：真实关键小集、72 任务/72 推理、三场两种顺序 6 任务/59 推理、15 专项和新增 6 专项已运行并保留证据。全组标签可接受 11/72，必要变化 30/48；23 条误建议、53 个误拦截任务，E03/E04/E05/E07/E08/E11/E12 人工回退。共同持有和未知跳时保留待核对，单人衣物继承专项未通过；不得宣称全类支持。仅建议关闭，自动接受 0、错误接受率和实际人工确认率 N/A；详见 [真实模型验收](./archive/scene_continuity_real_model_2026-10-11.md)。

#### 批次 C 分轮完善 分场采纳与局部重做

- [x] **CT15 · 增加镜头骨架及覆盖缺口的分轮流程。**
  - **依赖/落点**：CT08 + CT13；规划预算、候选 schema、导演页面。人工/规则路径不等待 CT14；使用模型建议的类别另须 CT14。
  - **交付/AC**：区分剧情/连续性、骨架、定样、补齐轮次；先必要主镜头/变化/反应，再补细节。草稿允许待补覆盖但事实门禁持续有效；必要动作和声音来源未覆盖不得标整章完成。九机位数量不当作全部必须采用。C06/C08/C14。
  - **Decision & Audit（2026-10-11）**：四轮候选、完整来源及声音唯一分配、缺口提示、按场/章保留草稿和冲突基准已实现。三场浏览器各走骨架→定样→补齐；完整文字覆盖仍显示待核对图片。制作事务与媒体/建议针对性 25/25，前端 67/67、前后端类型及生产构建通过。C06/C08/C14 制作子集通过，成图旅程独立到 CT19；详见 [分轮制作验收](./archive/scene_continuity_production_2026-10-11.md)。
- [x] **CT16 · 新增明确的局部采纳事务。**
  - **依赖/落点**：CT15；分镜采纳路由、时间线版本服务、导演 UI。
  - **交付/AC**：实现独立 apply-scene 路由和局部事务，显式场次/镜头范围、基准修订、影响预览和幂等键，不放宽整章 apply；coverage 仍用自己接口。重复幂等、并发冲突、失败回滚，其他场次、声音和已有图不变；替换保留旧版本。C12/C13-A/C14。
  - **Decision & Audit（2026-10-11）**：独立预览/apply-scene 短事务、迁移027、修订与影响指纹、幂等收据及中途失败回滚通过；只替换所选场次范围，旁场和声音保持，旧图在原版本。三场浏览器逐场采纳完成；整章与coverage门禁保持。C12/C13-A/C14 局部事务通过，文件及下游见同一制作验收。
- [x] **CT17 · 按状态版本绑定参考素材和出图队列。**
  - **依赖/落点**：CT16；素材引用、镜头编译、单图/批量图任务。
  - **交付/AC**：镜头绑定人物、服装状态、实物及场景参考的具体版本；批量只处理当前可出图且缺图的镜头，明确列出跳过原因和数量；重复点击不重复排队；重做已有图是显式动作。C02/C04/C09/C14。
  - **Decision & Audit（2026-10-11）**：具体历史参考、冻结人物文字外观及实物状态接入素材队列和 Shot Master 输入；只处理有效缺图，重复点击单任务预约，旧图明确重绘且晚到结果不覆盖新版本。API/持久化及相同实物不同设计版本回归通过；浏览器第一场缺图重试实际跳过已有两图。C02/C04/C09/C14 队列子集通过，真实服务冷启动失败如实留到 CT19/CT22 评估，不等同图片内容通过。
- [x] **CT18 · 建立人工成图核对与局部修正。**
  - **依赖/落点**：CT17；图片对照、场记记录和重绘入口。
  - **交付/AC**：并列查看当前图、对应状态和相关参考/相邻镜头；核对衣着、损伤位置、数量、持有者、门窗及空间接点；错误图只影响相关版本，不反写剧情状态。区分文字通过和图片通过。C15。
  - **Decision & Audit（2026-10-11）**：六项图片核对、拒绝、明确重绘及旧状态冻结对照已实现；接受要求全部检查及当前输入，拒绝不写账本。针对性包含过期图可查看/拒绝但不可接受或生成。浏览器实际检查5张成图，均存在可见偏差，逐张拒绝并保留图，未虚标图片通过；C15 审核机制通过，素材质量与后续局部重做继续 CT19。
- [x] **CT19 · 浏览器验收分轮制作和恢复。**
  - **依赖/落点**：CT15–CT18；端到端旅程及仓库回归。
  - **交付/AC**：人工确认输入完成三场骨架→定样→补镜→局部采纳→出图→改状态→仅重做相关镜头，C12/C14/C15 通过；保留失败/待核对与恢复证据。验证旧项目、切章、脏缓冲、并发及两个约定视口；不以点击代替结果。模型建议路径在 CT14 后追加独立证据，不阻塞人工制作闭环。
  - **Decision & Audit（2026-10-11）**：隔离三场实际采纳 5 镜并完成真实出图。改伞状态后只恢复/重排 304、302、303，3/3 完成；301/305 图片和版本不变。合计 8 张图片逐张拒绝，未将文字、队列或错误图片标成图片通过。旧项目、切章草稿、双端 409 与 1280/1920 两视口通过；制作、媒体、参考/依赖哈希、生命周期与页面修正见 [制作验收](./archive/scene_continuity_production_2026-10-11.md)。下游 CT20–CT22；C12/C14/C15 的裁决和恢复机制关闭，图片内容仍不合格。

  - **提交前仓库复核（2026-10-11）**：前后端类型检查及构建通过，前端 72/72、制作脚本 34/34。受限环境后端为 810/816，六项本机模拟连接失败；正常本机环境全量为 815/816，`turnaround_composite.test.ts` 子进程以 `3221225477` 异常退出，该文件单独复核 7/7。不将全量记录改写为全部通过。原始日志及各次复核保存在本地忽略目录 `local/verification/commit-2026-10-11/`。

#### 批次 D 按真实案例选做 不阻塞前三批交付

- [x] **CT20 · 扩展故事日、回忆和返回现实。**
  - **依赖/落点**：CT08/CT13，发布到制作流程需 CT19；故事位置与快照范围。启用模型建议另需该类真实评估，不用端点阻塞确定性实现。
  - **交付/AC**：先支持明确跳时/回忆边界，时间关系不明待核对；衣着和损伤按属性决定继承，不能跨故事日一律重置或沿用。C16。
  - **Decision & Audit（2026-10-11）**：新增人工时间计划及 `time_scope`，逐属性继承/未知，回忆锚定前场现实状态，返回恢复保存的现实；未知时间阻断后续，旧线性哈希保留。来源更新可完整重新核对状态与时间计划，签名备份重映射并重验权威。API、回放、生命周期与 StrictMode UI 回归通过；五场浏览器确认次日湿度未知、损伤继承、回忆右手/受损不泄漏、现实明确晾干及第五场未知阻断，两视口通过。落点 schema/确认/回放/备份/review/导演面板，消费者为快照、coverage、参考/出图；C16 时间子集通过。单层明确边界受支持，嵌套和模型推断未启用，详见 [时间与手别验收](./archive/scene_continuity_time_hand_2026-10-11.md)。
- [x] **CT21 · 逐项增加消耗量和复杂空间关系。**
  - **依赖/落点**：CT19；属性扩展及镜头接点校验。模型建议另需对应真实小集，不阻塞人工路径。
  - **交付/AC**：每次只新增一种实需，如杯中水量、持物左右手、共同搬运或画面轴线；量值有单位，物理左右与画面左右分开；每项同时提供正例、反例、真实小集及回归，未做属性不宣称支持。C16 及新增专项编号。
  - **Decision & Audit（2026-10-11）**：只新增身体持物手别 v2，旧十一项保持 v1；要求同件物体已确认 holder，转移使接收手别未知，读取自动依赖 holder，换手必须取终点。H-A01–H-A04 正反、生命周期及浏览器错误左手拒绝/明确右手确认通过；真实 H01–H06×两种子 12 任务/12 调用，6/6 必要值提取但有多余转移，严格 0/12 可接受、自动接受 0，所以只发布人工确认能力。量值单位、共同搬运、多人持有和轴线未实现，不宣称支持。落点注册表、确认、编译、建议、UI与夹具，下游 coverage/图片门禁，C16 持物手别专项通过；实际失败与策略指纹见 [时间与手别验收](./archive/scene_continuity_time_hand_2026-10-11.md)。
  - **提交前类型复核（2026-10-11）**：`continuity_hand.test.ts` 的动作中及出场状态断言先验证 `knowledge_status=confirmed`，再读取 `value`，保留未知状态的区分；后端类型检查通过。
- [x] **CT22 · 根据实测评估视觉辅助与吞吐优化。**
  - **依赖/落点**：CT18/CT19；可选视觉检查、队列和指标。
  - **交付/AC**：先统计人工常见返工与耗时，再决定是否引入视觉模型、参考选择或批处理；证明硬件资源、错误率和完成率收益。视觉建议仍可人工裁决，不能用文本模型冒充视觉审核；缓存/并发优化不改变状态语义。
  - **Decision & Audit（2026-10-11）**：基于 8 张实图人工返工和任务时间，暂不引入视觉模型/自动选参考，保留人工六项裁决，质量错误率仍 8/8、未证实质量收益。采用 Comfy 单地址启动共享、存活启动复用及 300 秒就绪等待；协调器并发/超时/死亡后重启通过。3060 12GB 的 24 点采样最大 7711 MiB，局部重做确实省掉 2/5 无关任务（40%），两镜版本不变；初轮 5/6 与后轮 3/3 完成率作为观察值，未冒称受控速度或质量增益。改动 startup/comfy/vram，消费者为 GPU 串行队列；指标和限制见 [制作验收](./archive/scene_continuity_production_2026-10-11.md)。最终后端 797/797、UI 69/69、制作脚本 34/34、类型/构建通过。

**每项关闭要求**：写 Decision & Audit，列实际改动、下游调用方、C 编号/F 夹具证据、剩余范围与失败。CT01 的基线记录不等于新能力通过；CT08 不得只跑三场演示；CT14 建议与自动接受分结论。默认回归用内存数据库及模拟模型，真实 9B、浏览器和成图分别记录；不得因 prompt 已改、模拟全绿或全拦截就关闭能力任务。

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

---

<a id="track8-production-storyboards"></a>
## 📌 Track 8: 构图草稿保留与正式分镜生成

**用户确定的范围（2026-10-10）**：保留现有构图草稿及生成流程，明确新增“生成正式分镜图”按钮；优先接入本机已部署但尚未形成产品闭环的能力，再增加其他模型和功能。本节是 FS00–FS17 唯一任务勾选入口。2026-10-11 对抗式评审修订了下面的契约。业务功能仍未实施。

### 产品契约与实施顺序

- 导演镜头卡保留「生成构图草稿」，旁边新增「生成正式分镜图」。这是同一镜头的两个制作阶段，不另建时间线或剧本事实源。两个入口都使用项目已选模型和风格，不把草稿换成 SD 1.5，也不自动更换模型。用户可以明确改用另一条已验证方案；该选择只记在本镜请求上，不修改项目默认模型。
- 时间线接口旧称“正式分镜”，文字流程另有“生成分镜候选 / 采纳此候选”。Track 8 的正式图称为“正式分镜图”。候选、拒绝和采纳都与这两套现有用语分开。
- 草稿请求跳过 `requireCurrentContinuityShot` 和 `prepareProductionImage`。有 `script_scene_id` 但没有 `source.continuity.reference` 的旧镜头，包括 9995、9996，仍可生成草稿。正式请求才使用连续性门禁、参考 pin 和 CT18 核对。
- 正式按钮先展示本镜将使用的人物、场景、姿态/布局参考，以及缺项和实际可用方案。技术节点名留在详情。模型不兼容时明确提示，不得后台把 Krea2 换成 Pony，也不得把 SDXL IP-Adapter / ControlNet 注入 Krea2。
- 制作目标只表示本次请求是草稿还是正式。正式结果先写入未激活的 `scene_version`，验收状态复用 `scene_production_frame.image_review_json`。图片保存成功、较高分辨率或 LoRA 存在都不等于采纳。CT18 的六项检查必须全部通过，才允许把该版本激活为已采纳正式图。
- 9995、9996 及其他已选图片、历史版本和已被视频引用的文件保持原字节可访问。启动任务不得把活动版本 `asset_url` 置空。失败、取消和迟到结果不改活动图。候选完成不得调用 `recordShotMasterSnapshot`。只有显式采纳才激活版本并更新 Shot Master。存量图片没有采纳证据时保持原状态。
- 参考要求按镜头确定。纯空镜不挂人物适配器，简单姿态不强制 OpenPose。正式任务缺必要能力时列出缺项并停止，不能降级成纯文生图后标为正式通过。草稿入口仍可使用。
- 图像参考扩展现有 `ProductionReferencePin`，不新建会与视频 `subject_references[{ character_id, asset_ids[] }]` 同名的结构。视频 schema 继续拒绝多人身份。静态多人参考不开放 H3 多人身份。
- 第一批只用已部署权重和节点。Krea2 原生参考先做边界验证；缺专用权重时登记并转入 FS11。FS08 的边界记录可以是“未开放”，这不阻塞已满足条件的 SDXL 验收。
- 顺序：FS01 → FS02 → FS03 → FS04 → FS05 → FS06 → FS07 → FS08 → FS09；其后 FS10–FS17。FS09 依赖 FS01–FS07 的 SDXL 证据，以及 FS08 已写下的边界，不等待 Krea2 新权重。
- CT00–CT22 已经勾选。首批复用人工 pin 和 CT18 六项核对，不重做 CT17 队列，也不把 CT14/CT19 的真实出图拒绝当成视觉合格。FS14 只把过期标记扩展到未激活候选和已采纳版本，不建立第二套账本。镜头事实采纳仍走原接口。
- 与 Track 7 协作：正式图的像素目标是精确 16:9。方形容器里的裁切不能当作验收画面。视频继续执行自身模型和身份门禁。

- [x] **FS00 · 固定双入口产品目标与优先级任务清单。**
  - **Decision & Audit（2026-10-10）**：根据当前代码、本机模型目录和 9995/9996 日志拆解任务，更新本表、文档索引与 UI 范围说明。已核对 RTX 3060 12GB、Pony/AutismMix/Juggernaut、SDXL IP-Adapter Plus/Plus Face、CLIP Vision、OpenPoseXL2 和相关插件；Krea2 别名实际指向 INT8 ConvRot。未发现 SDXL Depth/Canny 或 Krea2 风格参考 LoRA 部署。两镜场景资产绑定为空，项目已有相关场景板和人物参考；人物新旧外貌字段存在冲突，需逐版本核对。
  - **验证边界**：此次分析的 47 项参考/编译测试通过，根类型检查通过；后端类型检查存在 6 项基线错误。使用现有模板的六类编译组合证明 Krea2 广角/多人参考未接入、Pony 广角/多人仅接姿态；ComfyUI 当时未连接，未完成新增实机成图。上述证据不等于 FS01 或 FS09 完成。未修改业务代码、模型配置或既有图片。原审计未记录 git 修订号；上述测试计数在 2026-10-11 评审中没有重跑。
  - **Decision & Audit（2026-10-11）**：对抗式评审修订契约，仍未修改业务代码、模型配置或既有图片。生产库 `backend/sql_app.db` 中 9995 为单人广角动作镜，9996 为三人广角动作镜；两镜都有 `script_scene_id`，`continuity_status=legacy`，source 没有 continuity，地点是名称而不是素材 ID。该库当时没有 `scene_production_frame` 表。现行 `assets.ts` 对带 `script_scene_id` 的镜头先要求连续性快照，并在启动时把版本 `asset_url` 置空；无 pin 的成功结果会写 Shot Master。修订后的 FS02/FS03 必须先拆开这条路径。

### 第一批：先接入当前已部署能力

- [x] **FS01 · 建立正式分镜能力基线与验收样本。**
  - **落点**：`formal_storyboard_capability.ts`、`GET /settings/tier-b-status`、`npm --prefix backend run formal:baseline`。
  - **交付/AC**：区分已安装、运行节点已加载、模型族匹配、镜头允许、实际接线、实机验证六种状态。校验完整节点链、必需输入和预处理器，不能只凭目录或单个节点报就绪。记录权重文件名和哈希。用稳定错误原因区分未安装、离线、不兼容、缺参考、策略跳过。冻结样本至少包括：隔离复制的 9995（单人广角动作）、隔离复制的 9996（三人广角动作）、单人特写、空场景、同场换机位、能力缺失。记录 git 修订号、当前失败和“生产库尚无 `scene_production_frame`”这一事实。测试只写隔离库。Pony、AutismMix、Juggernaut 按 SDXL 族登记；Krea2 INT8 ConvRot 单独登记。`pony_xl_tier_b_dual_ref_l40.json` 不作为 3060 模板。
  - **Decision & Audit（2026-10-11）**：新增能力判断与冻结样本，未改生成路由、未写生产库、未出图。`formal_storyboard_capability.test.ts` 5/5 通过；后端 `tsc --noEmit` 通过。全量后端套件另有 `english_visual_prompt.test.ts` 的测试运行器反序列化异常，子测试本身通过，与本次改动无关，不记为本项验收。只读基线见 [formal_storyboard_baseline_2026-10-11.json](./archive/formal_storyboard_baseline_2026-10-11.json)：git `6b4af001f3039317b3d2f1cb2d4c6ba782464026`，工作区有未提交改动；`scene_production_frame` 不存在。ComfyUI 离线，所以 IP-Adapter 与 OpenPose 为已安装但节点未加载。Depth/Canny 未安装。Krea2 参考接口不存在。实机验证保持 false。下游是 FS02。
- [x] **FS02 · 分离草稿、正式候选、正式采纳的数据与任务契约。**
  - **落点**：`backend/src/routes/assets.ts`、`scene_versions`、`scene_production_media.ts`、生图请求 schema、共用类型与 API。
  - **交付/AC**：请求携带 `production_stage=draft|production`，与分辨率和既有 `mode` 分开。草稿跳过 `requireCurrentContinuityShot` 与 `prepareProductionImage`；9995/9996 这种有 `script_scene_id`、无 continuity 的镜头仍能出草稿。正式请求沿用连续性门禁和 pin。候选调用新的未激活 `scene_version`，禁止复用 `createSceneVersion({ clearAsset: true, activate: true })`，禁止启动时 `syncActiveVersionAssets({ asset_url: null })`。失败、取消和迟到结果只更新任务状态，活动版本的 `asset_url` 保持原值。候选成功不调用 `recordShotMasterSnapshot`。采纳校验预期版本和参考哈希，写 CT18 六项全过的 `image_review_json` 后才激活版本并更新 Shot Master。拒绝保留图片且不改变活动指针。同一在途 `request_key` 返回原任务；之后的明确重做才是新候选。保存来源版本、pin、请求快照、工作流和模型指纹、实际控制分支及未用原因。导出、导入、复制和删除沿用现有生命周期，并保留新文件，不覆盖已被视频或已采纳版本引用的字节。
  - **Decision & Audit（2026-10-11）**：`production_stage` 默认 `draft`，与 `mode` 分开。带 `script_scene_id` 但没有 continuity 的镜头可以草稿生成，正式请求仍要求连续性快照和 pin。已有图的草稿、以及正式候选，都写入未激活版本；启动不再把活动图 URL 置空。候选完成只更新该版本，不写 Shot Master。`POST /api/assets/formal-decision/:scene_id` 在六项核对全过时才激活并记录 Shot Master，拒绝不改活动指针。同一 `request_key` 复用原任务，新的 key 才是下一次候选。既有连续性队列和重绘仍走 `production_guard`，不走这条正式候选路径。候选文件名含任务 ID，已存在的文件拒绝覆盖。测试：正式阶段与 9995 形态草稿、幂等、CT17/CT18 媒体回归共 20 项通过。未改导演按钮，未出图。下游是 FS03。
- [x] **FS03 · 增加「生成正式分镜图」并保留「生成构图草稿」。**
  - **落点**：`components/Director/DirectorTimeline.tsx`、`pages/DirectorMode.tsx`、`services/api.ts`、`types.ts`、`locales.ts`。按钮去向以 [UI 规则第 5 节](./3_UI_RULES.md) 为准。
  - **交付/AC**：两个入口同时可见并发送不同 `production_stage`。正式入口展示参考清单和预检；组合未开放时按钮可见，提交返回具体缺项，不生成正式候选。本项不要求正式出图成功。草稿重生成在已有图时写未激活草稿版本。关键帧页只展示带阶段标签的 16:9 图片，不再有第三条生成按钮。任务恢复读取已持久化的 `generation_task`，页面卸载导致的 EventSource 中断不得把活动图标成失败或清空。中英字典同步，testid 按 UI 规则保留。验证重复点击、刷新、失败保留旧图、切章慢响应和两个约定视口。
  - **Decision & Audit（2026-10-11）**：镜头卡同时显示「生成构图草稿」和「生成正式分镜图」。草稿不带 `new_version`，已有图时由 FS02 写入未激活版本。正式按钮在能力未实机开放时只列出缺项，不调用生成接口。关键帧页去掉生成按钮，按草稿、正式候选、已采纳图以 16:9 `object-contain` 展示。连接中断、失败和候选完成都不改已选图地址；切章后的迟到结果被丢弃。采纳和拒绝使用独立 testid。组件测试覆盖 390 与 1280 两种宽度。没有浏览器点击，也没有实机出图。下游是 FS04。
- [x] **FS04 · 在服务端按人物与镜头装配版本化参考。**
  - **落点**：`scene_production_media.ts` 的 pin 与 `choicesFor`、`reference_generation_policy`、`generation_service`。不新增视频同名 `subject_references`。
  - **交付/AC**：正式装配以服务端为准，忽略客户端的 `character_ref_url`、`ref_image_url`、`force_character_adapter` 和 `force_no_character_adapter`。把 pin 升到可被读出的 version 2：同一 `entity_id` 可按 `role` 同时有脸、全身、服装、场景、姿态和源草稿，并带版本与内容哈希；version 1 pin 继续有效。出镜名称先在项目内解析为人物 ID，歧义或缺失则正式装配失败。每人使用自己的参考和 LoRA；工作流放不下多人 LoRA 时列为缺项，不能只送第一个后标为正式通过。草稿仍可保持当前客户端选图和草稿门禁测试。地点名称与素材库场景板只显示待确认建议，用户确认后写入 pin 的场景 role，不改镜头地点原文，未确认不得当已绑定。校验项目归属、文件、版本、本地拷贝、远端上传和同名碰撞。人物标签、`character_version.visual_tags` 与旧 identity_lock 不一致时，正式路径展示冲突并要求显式选择版本，禁止自动覆盖。UI 与直接 API 调用同一装配。
  - **Decision & Audit（2026-10-11）**：`formal_storyboard_plan.ts` 负责正式装配。version 1 pin 原样可读，角色条目记在正式请求的 version 2。出镜名按项目解析，歧义、缺失和跨项目会拒绝。脸和全身分开；多人 LoRA 超出槽位时记缺项，不把第一个人物标成正式通过。场景板只给未确认建议。外貌字段冲突必须显式选版本。草稿的广角门禁测试仍拒绝 IP-Adapter。正式接口在创建候选前调用同一装配。相关测试通过。未出图。
  - **提交前类型复核（2026-10-11）**：`scene_production_media.ts` 为已有参考选项的 `roles` 补齐类型，服务端返回内容和角色分工不变；下游为 `productionMediaView`、制作路由及媒体面板。前后端类型检查和构建通过。
- [Blocked] **FS05 · 完整接入现有 SDXL IP-Adapter，先验收单人镜头。**
  - **落点**：`tier_b_adapters`、参考策略、单人正式工作流、12GB 工作流模板、权重/作用区间设置。
  - **交付/AC**：核对已部署 Plus/Plus Face 与 CLIP Vision 的文件名、哈希和模型族。确认 LoadImage → 图像编码/适配器 → 采样模型连通，且不覆盖 LoRA 链。脸/全身参考按用途裁切；未选择的三视图不得整张输入。正式单人广角可在可控权重下使用身份参考。草稿的 `shouldAllowCharacterAdapter` 结果和现有测试保持不变，禁止用 `force_character_adapter` 放开正式门禁。使用 12GB 模板，不用 L40 双参考模板。以冻结种子比较单人特写和单人广角的参考开/关，记录身份、动作、背景和失败。Plus Face 不称为 FaceID。
  - **Decision & Audit（2026-10-11）**：编译图可以接上 IP-Adapter，草稿广角门禁保持关闭，`FORMAL_OPEN_COMBINATIONS` 仍为空。正式渲染在实机验收前抛出 `FORMAL_NOT_LIVE_VERIFIED`，不会悄悄出纯文生图。冻结种子的特写/广角成图没有跑，本项不能关闭。
- [Blocked] **FS06 · 完整接入现有 OpenPoseXL2 与姿态预处理。**
  - **落点**：ControlNet 注入、参考类型校验、构图预览。姿态预处理器不可用时登记缺项，不因此阻止 FS07 对不需要姿态的镜头继续。
  - **交付/AC**：区分人物源图和已生成骨架。预处理只在需要时运行，节点和输入必须实时匹配。控制图随候选版本保存，并与 16:9 目标画布对齐。场景板只有被用户选为姿态 role 时才可进入姿态链；空场景板不是人体姿态。必要骨架数量与出镜人数不一致时，正式任务报缺项。单人和三人样本要留下控制图、ControlNet 和正负条件的连接证据；画面左右与目标画布对照归档。遮挡只进入视觉记录，不作为自动通过条件。
- [Blocked] **FS07 · 接入 IP-Adapter 的多人区域遮罩能力。**
  - **依赖/落点**：FS04、FS05；需要姿态的样本同时依赖 FS06。`IPAdapterAdvanced`、候选版本上的遮罩、参考预览。
  - **交付/AC**：人物 ID、各自参考和目标区域一一绑定，分别注入或串接适配器。同人物多视图与不同人物多参考不得混用。遮罩以 `role=identity_region` 存在候选版本上，尺寸和覆盖在提交前校验；明显冲突时停止。FS13 复用同一遮罩存储，并使用 `role=inpaint`。提供最小人工框选，在两个约定视口完成框选、生成和失败保留。用两人及 9996 类型的三人固定样本比较纯文生图、全局单参考和区域参考，记录串脸、属性交换、人数和动作。12GB 无法通过的组合登记为限用，正式按钮不再提交该组合；不能只保留第一人，也不能放开视频多人门禁。
- [x] **FS08 · 验证当前 Krea2 原生参考接口的可用边界。**
  - **落点**：Krea2 独立能力探测、参考工作流验证脚本。
  - **交付/AC**：用本机现有权重和原生参考节点分别记录接口存在、工作流有效、参考实际参与、效果适用。普通 VAE 图生图与 reference conditioning 分开。单人、场景和多人各自记已验证、失败或需额外权重。缺专用 LoRA 时本项可以“边界已记录、正式未开放”关闭，并转入 FS11。该结论不阻塞 FS09 的 SDXL 验收。只有有出图证据的能力可对正式入口开放。SDXL 适配器保持隔离。
  - **Decision & Audit（2026-10-11）**：`redcraft_krea2_12gb.json` 没有 reference conditioning 节点。图生图与参考调节分开记录。身份锁定、正式入口和 SDXL 适配器都保持关闭。缺专用权重，转入 FS11。没有把“接口不存在”记成已验证。
- [Blocked] **FS09 · 完成 3060 首批实机验收并开放已验证范围。**
  - **依赖/落点**：FS01–FS07，以及 FS08 已写明的边界。ComfyUI 端到端、浏览器旅程、生成证据归档。
  - **交付/AC**：按下方 M01–M09 验收。M03 等组合可以“失败/限用”关闭本项，前提是正式按钮拒绝该组合且证据齐全；静默退回第一人或纯文生图不能关闭。保留实际请求、参考、控制图、输出、种子、耗时、峰值显存和失败。串行 batch=1，使用既有 GPU 租约。冷/热启动及加载/采样分开统计。开放某组合时同步更新参考策略文档和 API 说明。采纳仍要求 CT18 六项全过。未测或失败的能力保持关闭。编译测试和全拦截都不能代替成图通过。

### 第二批：再补新权重与制作能力

- [Blocked] **FS10 · 补齐场景结构控制：SDXL Depth/Canny 与预处理。**
  - **依赖/落点**：FS09；模型清单、安装/预检、按类型选择控制图、编译器。
  - **交付/AC**：按冻结样本选择至少一种匹配的场景控制模型，记录来源、版本、许可与资源需求；提供对应深度/边缘预处理，不能把原 RGB 直接充当深度图。场景板用于同机位结构时控制布局，换机位采用匹配视角布局，不能机械复制原透视。与人物控制组合后验证建筑/家具位置、机位与人物身份；有效性未知不标正式通过。
- [Blocked] **FS11 · 接入 Krea2 专用参考工作流与所需权重。**
  - **依赖/落点**：FS08/FS09；独立工作流、专用参考 LoRA、模型能力目录。
  - **交付/AC**：优先验证官方风格参考流程；新增权重与当前 Krea2、编码器、VAE、节点版本匹配。分别验收风格、身份、场景结构，风格迁移通过不能标成人物身份锁定。身份/多人若仍不满足要求，保持限制并记录后续专用方案需求；不得通过加一个 LoadImage 或 NSFW/风格 LoRA 宣称身份已锁定。
- [Blocked] **FS12 · 增加有条件的上一镜／上一帧参考。**
  - **依赖/落点**：FS09；参考规划、镜头/帧来源与版本、连续性输入。
  - **交付/AC**：上一镜只按同一剧本场、已确认 moment 内的故事顺序选取，并且机位关系必须是明确的连续机位。不能只凭时间线 `index` 决定上一镜。同 moment 的另一覆盖机位不是上一帧。前一视频尾帧是单独来源，用 FFmpeg 从该视频资产的指定版本提取，记录 24fps 交付帧、源资产和时间位置。当前镜草稿是第三种来源。切场、跳时和相反机位重新判断。人物定妆和已确认状态始终保留。验证错误源图、来源过期、无上一镜、换机位和不形成循环依赖。
- [Blocked] **FS13 · 增加保留构图的局部修正与正式精修。**
  - **依赖/落点**：FS09、FS07 的遮罩存储；候选版本、输出规格。
  - **交付/AC**：可分别修正某个人物、道具或区域，遮罩使用 FS07 的存储且 `role=inpaint`。按模型支持选择图生图或局部重绘，并检查遮罩外变化。正式尺寸沿用 Track 7 的精确 16:9。提高清晰度与提高验收等级分开。重绘、超时和 OOM 保留草稿、已采纳图及来源。禁止只放大草稿就自动采纳。
- [Blocked] **FS14 · 扩展连续状态过期标记。**
  - **依赖/落点**：FS09。CT08/CT13/CT17/CT18 已实现；共享状态、pin 和 `image_review_json`。
  - **交付/AC**：不新增核对词表，不把文字通过写成图片通过。正式候选等于未激活版本且核对未完成；已采纳等于六项全过并已激活；拒绝等于 `rejected` 且未激活。参考或状态变化只把实际受影响的候选和已采纳图标为过期，旧字节保留，并列出恢复动作。图片不能反写剧情。必要状态未确认时不能采纳。视频使用正式图前重新检验来源版本。本项后置不得放宽现有门禁。
- [Blocked] **FS15 · 增加正式分镜批量队列与选择性重试。**
  - **依赖/落点**：FS09/FS14；现有 GPU 租约和导演进度列表。不建第二套队列。
  - **交付/AC**：提交前逐镜预检，只排被明确选择且当前可生成的任务。列出已通过、过期、缺项、跳过和失败数量。支持取消、从持久化任务恢复、幂等提交和仅失败重试。重做已有正式图必须显式选择。12GB 上保持串行，并占用既有 GPU 租约。无新的实测依据不启用多任务并发或批量覆盖。
- [Blocked] **FS16 · 完成正式版本的下游采用与导出。**
  - **依赖/落点**：FS09/FS14；媒体引用、Shot Master、视频预检、导出/备份。
  - **交付/AC**：新视频默认消费已采纳、未过期且镜头版本匹配的正式图。草稿预览标明用途。候选成功不替换视频输入，也不写 Shot Master；采纳和撤销都能追到版本。历史视频继续指向原来的资产字节。导出、回导和复制保留制作阶段、核对结果及来源关系。视频模型和身份门禁保持原样。
- [Blocked] **FS17 · 完成全流程回归与生产范围说明。**
  - **依赖/落点**：FS10–FS16；回归矩阵、使用说明、部署与限制文档。
  - **交付/AC**：验收草稿→正式生成→人工检查→采纳→引用变化→局部恢复→下游使用；核对旧项目、空场景、多人、换机位、服务离线及显存失败。报告各模型/镜头类别的通过数量、失败类型、返工率与耗时，不以总体平均掩盖三人失败。默认测试使用隔离库/模拟 Provider；真实 ComfyUI 和浏览器证据单独归档。
  - **Decision & Audit（2026-10-11）**：FS06、FS07、FS09–FS17 一起阻塞。规则测试已经覆盖姿态不替代人数、遮罩越界和重叠拒绝、上一镜必须是同一 moment 的连续机位、批量跳过缺项和已有正式图、过期不删字节、视频不读取未采纳候选、Krea2 不注入 SDXL。Depth/Canny 权重仍未安装。M02、M03、M07 没有实机成图、显存或浏览器证据，所以这些任务不能勾成通过。正式入口继续关闭。

### 首批验收矩阵

验收前冻结样本、种子组与预期结果。模型能力分别记“未测／通过／失败／不适用／限用”。编译、实机和视觉审核三列独立记录。每一项包含可复现输入和正反例。不要求每镜同时使用所有控制。记为“限用”的组合必须在正式入口被拒绝，并保留证据；静默改走纯文生图或只保留第一个人物，不能把该行关闭。

| 编号 | 场景 | 必须验证的结果 |
| --- | --- | --- |
| M01 | 保留现有草稿 | 隔离复制的 9995/9996 在无 continuity pin 时仍可草稿生成；原字节、历史和活动选中状态可查看。正式启动、失败、取消和迟到结果不改活动图，也不把 `asset_url` 置空 |
| M02 | 单人特写与广角 | 同一身份在特写和 9995 类型广角中可辨认。输出为精确 16:9 全幅。广角环境和动作未被人物参考压成肖像。保存实际参考及控制参数 |
| M03 | 两人／三人布局 | 以 9996 类型三人广角和一组两人样本比较纯文生图、全局单参考、区域参考。通过时人数、外观和位置绑定正确。失败则登记限用并关闭该正式组合 |
| M04 | 空场景与场景板 | 无人物不挂脸部或姿态控制。未确认的同名场景板不是绑定。无有效姿态不报构图锁定。未接结构控制不声称空间保持 |
| M05 | 参考或能力异常 | 跨项目、过期或缺失文件、外貌字段冲突、不兼容模型、节点未加载、预处理失败都给出真实原因。正式路径不静默降级，并忽略客户端 force 标志和参考 URL |
| M06 | UI 与直接 API 一致 | 草稿跳过连续性门禁，正式请求使用 pin 和六项核对。候选保持未激活。采纳才切换活动版本和 Shot Master。重复点击不产生第二个在途任务 |
| M07 | 12GB 运行恢复 | 使用既有 GPU 租约串行。OOM、离线、超时和页面卸载后任务可恢复，活动图保留。每个实际组合有显存和耗时证据 |
| M08 | Krea2 能力边界 | 不接 SDXL 适配器。图生图、原生参考和专用风格流程分项说明。缺权重或效果未测时正式入口不开放，且不阻塞已通过的 SDXL 组合 |
| M09 | 画布与下游指针 | 正式候选和已采纳图以 16:9 全幅验收，方形裁切不算通过。候选成功不写 Shot Master，不替换视频输入。采纳后新视频读取该版本；旧视频仍指向原字节 |

**每项关闭要求**：沿用“基线 → 静态检查 → 测试 → 验收矩阵”；记录 Decision & Audit、git 修订号、实际改动文件、下游调用方和剩余限制。FS00 只表示文档契约已修订。FS03 只表示两个入口和失败保留可用。FS09 是首批范围开放门槛。FS17 是全部列出范围的最终回归门槛。
