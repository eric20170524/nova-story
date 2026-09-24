# 0_TASKLIST.md: 全局开发任务与进度追踪

> **统一说明**：本文档为 NovaStory 仓库唯一的任务与进度追踪事实源（合并原 0827 分镜契约编译器、0907 H3 生视频部署、0907-2 RedCraft 双 Profile 接入三份离散 TODO）。
> 所有开发、Agent 编码、迭代评审均以此文档状态为准。

---

## 🎯 迭代概览与全局规则

### 当前活动工作流 (Active Tracks)
1. **Track 1 (当前默认主干)**: 梦核分镜 Prompt 契约与编译器闭环（Phase 0–4，已完成 Phase 0–2 及 Phase 4 验收，存量章节数据就绪）。
2. **Track 2**: 红潮 Hybrid H3 A2A 本机部署与黄金样片（P0–P5 已闭环，P6–P7 待 RTX 3060 实机联调）。
3. **Track 3**: RedCraft 赤佬 3.0 / Krea 2 INT4/INT8 双 Profile 接入（P0–P2 待实施）。

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
- [ ] **P1-4: 严禁自动挂载猜测的 Pony LoRA**（保持 RedCraft 与 Pony LoRA 隔离）。
- [ ] **P1-5: 保持 Tier B 隔离**（第一阶段只支持 T2I 与 Tier A img2img，不混用 SDXL IP-Adapter）。
- [ ] **P1-6: 后续单独支持 Krea2 原生 Style Reference**。
- [ ] **P1-7: 补齐 `generation_service.test.ts` 的 RedCraft fixture 测试**。
- [ ] **P1-8: 增加 `REDCRAFT_COMFY_SMOKE=1` 真实生图 Smoke Test**。
- [ ] **P1-9: 记录完整 generation provenance 元数据**。

### 3. P2 — 部署体验与文档
- [ ] **P2-1: 修订 `docs/deployment/local_image_generation_deployment_cn.md` 中的模型文件名与路径**。
- [ ] **P2-2: 在 `docs/deployment/comfyui_local_setup_guide_3060.md` 增加 RedCraft 配置清单**。
- [ ] **P2-3: 仅提供检测与下载指引，不内置第三方权重**。
- [ ] **P2-4: 记录 3060 Benchmark (INT4 vs INT8 耗时与峰值显存)**。

### 验收门槛 (DoD)
- RTX 3060 12GB + Project = RedCraft Krea2 + Profile = INT4 下 Preflight 报告 READY。
- 768×1024 / 1024×1024 正常生成真实 PNG 并持久化为 MediaAsset。
- 缺模型或节点时入队前明确报错，不发生静默退回。
