# 0_TASKLIST.md: 全局开发任务与进度

本文是仓库里任务勾选的唯一入口。方案细节留在链接文档和 git 历史里；这里只记当前状态和还没关的项。2026-10-29 按代码收过 Track 1–8：已闭环的长审计不再贴回。Track 9 仍以本节之后的原文为准。

---

## 当前状态

未指定 Track 时，从 Track 9 的第一个 `[ ]` 做起。Track 1–8 里仍为 `[ ]` 的项有效，不要回头重做已闭环段落。

| Track | 状态 | 还缺 |
| --- | --- | --- |
| 1 分镜 Prompt 编译 | 已闭环 | 梦核第 2–10 章弱镜是否点杀，由主人决定 |
| 2 H3 / 红潮部署 | 代码与工作流骨架已完成 | RTX 3060 黄金样片（P6–P7） |
| 3 Krea2 生图 | 单工作流已接入 | 双 Profile 计划作废；3060 文档与现行 JSON 不一致 |
| 4 小说创作 | 规划子集已在应用里 | 10 万字正文硬上限、正文候选采纳、TXT 导出、整链验收 |
| 5 结构化剧本与连续性 | S0–S5 已勾选 | 不把模型建议或当时被拒的成图当成质量通过 |
| 6 角色音色 | 查询、试听、保存已闭环 | 视频混音、克隆上传、旁白默认、Agent 挑音色 |
| 7 16:9 与 24fps | 产品合同已进代码 | 真实 ComfyUI / H3 端到端（P5） |
| 8 构图草稿与正式分镜 | 双入口和 SDXL 正式出图已开 | OpenPose、多人遮罩、3060 矩阵、Krea2 身份参考 |
| 9 时长 / 锚点 / 首尾帧 | DT00–DT12 已闭环 | 真实 ComfyUI 8s Multi-Frame 实机样片 |

漫画页和 PDF 导出已在 2026-09-30 移除。分镜静帧、时间线出图和风格预设还在。

### 执行规则

1. 一次只做指定 Track 里的一块 `[ ]`。做完改为 `[x]`，下面写三五行：决策、改动文件、下游、没做什么。
2. 验收沿用「基线 → 静态检查 → 测试 → 验收矩阵」。编译器和规划单测不连 ComfyUI、真实 LLM 或 8765。
3. 需求冲突或环境无法验证时标 `[Blocked]` 并停。
4. 自测：`cd backend && npm test`，根目录 `npm run typecheck`。
5. 合同索引：`docs/best_practice_scene_visual_prompt.md`、`docs/1_PRD.md`、`docs/2_ARCHITECTURE.md`、`docs/deployment/`、`docs/video/`、`docs/architecture/`。

### 仍有效的遗留

- 梦核第 2–10 章已重编译进新 scene version，不自动批量重生。
- `backend/sql_app.db-shm` / `*-wal` 禁止入库。
- H3 生产就绪开关仍要等目标硬件上的真实视频输出，不能把静态图运镜当成 H3 成功。

---

## Track 1: 梦核分镜 Prompt 契约与编译器

目标已经落地：镜头契约由代码编译成画面词，不再把整章 LLM 散文直接当生图 Prompt。第 1 章已接受的时间线和图片默认保留。本 Track 不再是默认主干。

现行配额在 `shot_intent_quota.ts`：满 5 镜时 establish + wide-action ≥ 35%，insert + reaction ≤ 20%；有关键道具时至少 1 个 Insert；单一 shot_type / intent 不得超过 65%。1–4 镜只拦「全部同型」。

- [x] Phase 0–2、Phase 4：契约文档、消毒、唯一性、负向编译、`compilePonyPrompt`、coverage 迁移与写入链路。
- [~] Phase 3：项目「失声的梦核游乐园」第 2–10 章已写入新 scene version。验收是 `cd backend && npm test -- src/services/dreamcore_ac_verify.test.ts`，不再依赖已删除的 fixture CLI。

---

## Track 2: 红潮 Hybrid H3 本机部署与黄金样片

代码侧 fail-closed、任务溯源、官方节点和 API workflow 骨架已完成。产品默认画布、分辨率和参考策略以 Track 7 为准：生图 16:9，视频默认 `standard_720p_5s`，另有 `preview_480p_5s`；H3 请求 124 帧，交付 120 帧 / 5.0 秒 / 24fps。红潮 Hybrid 只作试验预设，产品默认是 Official Ref2VA、Multi-Frame、FL2VA。

历史核验（权重 SHA、ComfyUI 0.34.5、864×480 / 121 帧）不再当作现行合同。实机真实出片仍未关闭。

- [x] P0–P5：失败不得静默降级成 FFmpeg 运镜；模型身份、原生 H3 节点、workflow 与预检骨架已落地。
- [ ] P6：黄金输入在目标机跑出真实 `comfy_prompt_id` 和视频，证明不是平移缩放。
- [ ] P7：保留 raw，LoopCloser 只产派生；连续稳定生成并有 pass / review / reject 门槛。

---

## Track 3: Krea2 生图接入

原「INT4 / INT8 双 Profile、3060 默认约 6GB INT4」没有实现，官方也没有那份 INT4 扩散权重。不要再按该前提改 Loader。

现行 `backend/static/workflows/redcraft_krea2_12gb.json` 固定为：

- UNET `krea2_raw_bf16.safetensors`
- CLIP `qwen3vl_4b_bf16.safetensors`（type `krea2`）
- VAE `qwen_image_vae.safetensors`
- 约 10 steps、cfg 1、euler、simple

Krea2 与 Pony LoRA、SDXL IP-Adapter 隔离。需要锁参考时，编译器可把文本节点升级为 `TextEncodeQwenImage21`（`use_qwen_vl_ref`），这不是 SDXL 适配器。Qwen-Image 2.1 是另一份工作流 `qwen_image_2_1.json`，不是 Krea2 的一档 Profile。

`docs/deployment/local_image_generation_deployment_cn.md` 和 `comfyui_local_setup_guide_3060.md` 仍按 2026-10-07 的 3060 硬链接记录：工作流名 `redcraft_krea2_int4.safetensors` 实际指向 INT8 ConvRot，CLIP 名 `qwen_vl.safetensors`。那两份文档描述的是当时那台机器，和现在这份共享 JSON 不一致。

- [x] 模型族、单工作流、项目可选、LoRA / Tier B 隔离、上述两份部署文档的当时记录。
- [x] P0 双 Profile、运行时注入、INT4 默认档：作废，不再实施。
- [ ] 让 3060 指南与现行工作流文件名一致，或写明两套机器各用哪份权重。缺文件必须在入队前失败，不能退回 Pony。
- [ ] Krea2 原生风格 / 身份参考仍归 Track 8，不在本 Track 标成已锁定。

---

## Track 4: 小说故事创作

范围只到小说正文。短剧结构在 Track 5，不写回 `chapter.content`。不建卷表。漫画导出已删除，不再作为本 Track 的回归项。

方案仍见 `docs/architecture/creation_alignment_review_2026-09-28.md` 和 2026-09-30 的三份小说创作文档。下面只记代码里已经有的，以及还不能勾的。

已有：`story_plan` / `story_plan_change`、故事页规划面板、`PLAN_STORY`、`PLAN_CHAPTERS`（initial / revise / extend）、`CREATE_NEXT_CHAPTER`。未来章留在规划文档里，实际章逐章创建。`countStoryWords` 按 NFC 后的字母和数字计字。`targetTotalWords` 可空；一旦设置，只允许 50,000–100,000，并且只约束规划预留。没有通用 `creative_change` 表。写作技能路径里已没有 `short_drama` 分支。单章剧本生成另有 30,000 字拒绝，那不是全书 10 万字门禁。

- [x] BE-A1：超预算、空输出和浓缩失败不得截断覆盖正文。
- [x] BE-C5：小说写作不再按短剧格式分流。
- [ ] 正文写入的 100,000 字硬上限，以及新建项目时的 5 / 8 / 10 万字目标入口。未设目标时规划预算直接放过。
- [ ] 编辑器脏缓冲、切章不串写、检查失败与「零问题」分开。
- [ ] 正文「生成候选 → 采纳才落库」。手写、续写和技能仍不是这条协议；不要补一个通用 `creative_change` 来假装已有。
- [ ] 「移到末尾」「改文风」不得把原句写进主线或默认 index 0。
- [ ] 小说 TXT / Markdown 导出（全部章 / 仅定稿）。项目 JSON 备份不是这份交付。
- [ ] 定稿差异审核、下一章只读已确认事实、5–10 万字一致性覆盖，以及创建到回导的整链验收。

---

## Track 5: 结构化剧本与单场连续性

设计见 `docs/architecture/structured_screenplay_module_2026-09-28.md` 和 `docs/architecture/scene_continuity_workflow_2026-10-09.md`。S0–S4 与 S5 的 CT00–CT22 都已勾选。分项证据在 `docs/archive/scene_continuity_*.md`。关闭任务不等于 9B 建议可自动确认，也不等于当时那 8 张成图视觉合格。

现行行为，和 2026-09 审计原文不同的地方：

- 剧本页是「脚本」和「地点 / 道具」两个标签。脚本标签左侧改编提纲、右侧分场正文。
- 一章一份剧本。`scriptScene` 是场戏，导演 `scene` 是镜头，一场可对多镜。交接写入 `shot_spec.source`。
- 分镜候选上限是 `STORYBOARD_CANDIDATE_SHOT_LIMIT = 35`，不再是 20。单条对白 / 画外音另有 15 秒预算，这是拆镜预算，不是 H3 成片时长。
- 采纳会重查覆盖、事实载荷和来源修订。单场候选不能走整章采纳。
- 连续性账本、人工确认、分场采纳、六项图片核对和局部重做已在导演流程里。模型只出建议。持物手别只发布了人工确认。视觉模型没有接入审核。

<a id="track5-s5-continuity"></a>

事实协议（`storyboard-facts-3.2`）失败后停在待核对，不把模型输出改写成通过。详见 `docs/architecture/model_semantics_harness_protocol_2026-10-20.md`。

---

## Track 6: 本机中文 TTS 与角色绑音

契约：`docs/deployment/local_chinese_tts_voice_cn.md`。T6.0–T6.7 已闭环。

浏览器只走 Fastify。默认根地址 `http://127.0.0.1:8765`，非回环须 `TTS_ALLOW_REMOTE=1`，非法地址是 `TTS_URL_REJECTED`。公开目录来自活的 `GET /api/voices`，不入库，响应里不带克隆参考的本机路径。角色上只存 `voice_id` 和服务器写的 `voice_label`。试听不落库。导出仍是 version 2。默认测试不连接 8765。

角色绑音之后，已确认剧本的对白 / 画外音块可以经 `ScriptAudioService` 生成 `script_speech`。视频混音、克隆上传、项目旁白默认和 Agent 自动挑音色仍不在本 Track。

---

## Track 7: 16:9 画布与 H3 24fps

方案：`docs/video/分镜生图与生视频生产最佳实践_20261003.md`。P0–P4 已进代码。P5 真实出片未记。

- 新请求画幅只有 `16:9 | 9:16 | 1:1 | auto`。旧的 3:4 / 4:3 读入后按 16:9 继续，不改已经生成的文件。
- 分镜和视频关键帧默认 16:9。定妆和三视图单格在没有单独指定输出时用 9:16 竖板，不受项目 16:9 画布影响。三视图拼图只用于展示。
- 视频预设只有 `standard_720p_5s`（默认）和 `preview_480p_5s`。两档都是 24fps、120 交付帧、5.0 秒。H3 内部仍按 124 帧请求。没有 30 / 60fps 主链。
- Shot Master 是视频视觉真值。身份参考按角色分开。Guide 帧位按 24fps 展示，合法索引到交付帧 119。Multi-Frame、Ref2VA、FL2VA 分职责；Hybrid 不是产品默认。

- [ ] P5：新项目 16:9 分镜到关键帧；720p 与 480p 各一条真实 H3 成片，规格仍是 24fps / 120 帧 / 5.0 秒。

更长成片和首尾帧接力属于 Track 9，不要在本 Track 里改时长合同。

---

<a id="track8-production-storyboards"></a>

## Track 8: 构图草稿与正式分镜图

同一镜头两个阶段：「生成构图草稿」和「生成正式分镜图」。都用项目已选模型，不把草稿偷偷换成 SD1.5，也不在 Krea2 和 SDXL 之间自动换模。正式图是未激活的 `scene_version`；六项核对（衣着、损伤、数量、持有者、门窗、空间）全过才采纳并切换活动图和 Shot Master。核对入口在导演工作台，不另建时间线。

草稿跳过连续性 pin。正式请求才用连续性门禁和版本化参考。客户端传来的参考 URL 和 force 标志不能放开正式门禁。

`FORMAL_OPEN_COMBINATIONS` 现为 `sdxl_ip_adapter`。`qwen_image_native_reference` 在 `formalRenderAllowed` 里直接放行。Krea2 的 `krea2_native_reference` 仍是 `formal_open: false`，缺身份锁定权重，不能注入 SDXL 适配器。其余组合提交时 `FORMAL_NOT_LIVE_VERIFIED`。

- [x] FS00–FS04：双入口、`production_stage`、未激活候选、采纳才激活、服务端装配人物与场景参考。
- [~] FS05：Pony / SDXL IP-Adapter 已允许正式渲染。冻结种子的特写 / 广角对照和 12GB 显存记录仍没有，不能当成实机验收通过。
- [x] FS08：Krea2 原生参考边界已记下，正式入口保持关闭。
- [ ] FS06：OpenPose 可探测，但 `sdxl_openpose` 不在开放组合。
- [ ] FS07：多人区域遮罩与 12GB 限用结论。失败必须拒绝该组合，不能只留第一个人。
- [ ] FS09：下面 M01–M09。编译测试和「全部拦截」不能代替成图。
- [ ] FS10–FS17：场景 Depth/Canny、Krea2 专用参考权重、上一镜、局部修、过期标记扩展、批量队列、下游只消费已采纳图、全流程回归。规则测试已经覆盖其中一部分，没有实机成图证据就不能勾选。

| 编号 | 仍要证明的事 |
| --- | --- |
| M01 | 无连续性 pin 时草稿仍可出；正式任务的失败和迟到结果不改活动图 |
| M02 | 同一身份在特写和广角里可辨认，广角不被参考压成肖像，输出是完整 16:9 |
| M03 | 两人 / 三人要么人数和位置正确，要么该组合被正式入口拒绝 |
| M04 | 空镜不挂脸和姿态；未确认的同名场景板不是绑定 |
| M05 | 跨项目、缺文件、外貌冲突、节点未加载都返回真实原因，不静默降级 |
| M06 | 草稿与正式走不同门禁；重复点击不产生第二个在途任务 |
| M07 | 沿用现有 GPU 租约串行；中断后可恢复，活动图还在 |
| M08 | Krea2 不接 SDXL 适配器；未测的参考能力保持关闭 |
| M09 | 候选成功不写 Shot Master、不替换视频输入；采纳后新视频才读该版本 |

---

<a id="track9-duration-anchor-relay"></a>
## 📌 Track 9: 视听时长拆镜、场次视觉锚点与首尾帧接力管线

> **方案事实源**：`docs/architecture/shot_timing_visual_anchor_first_last_frame_spec_2026-10-29.md`、配套独立任务文档 `docs/architecture/shot_timing_visual_anchor_first_last_frame_tasks_2026-10-29.md` 与 `docs/architecture/novel_to_script_to_storyboard_concepts.md` 第 8–9 节。  
> **核心目标**：双端修复带人物尾帧视频路由，建立 H3 5.0s（120帧）/ 8.0s（192帧）双档生成与装配防截断机制，在严守“单块单镜”与章节景别配额的前提下实现多块 8s 拆镜，落地场次环境按名绑定、180° 轴线运行时编译及首尾双帧/末帧接力管线。

### 🎯 批次划分与推进顺序

- **Batch A (DT01–DT04)**：视频路由先行修复、5s/8s 双档时长模型与防算术崩溃拆镜（双端路由、估算校准、多块 8s 扩槽、装配防截断）。
- **Batch B (DT05–DT08)**：场次环境资产按名自动绑定与 180° 空间轴线契约（不污染剧本哈希、基于已确认绑定人物推导正反打、接入真实提示词链路）。
- **Batch C (DT09–DT12)**：首尾双关键帧候选门禁与 8s 整段末帧接力（尾帧快照校验、119/191 动态帧位、精确抽末帧且链长 ≤ 2）。

### 📝 任务池

- [x] **DT00 · 完成三轮对抗式技术评审、终局裁决与实施方案冻结。**
  - **交付/AC**：基于 `256787f` 基线完成交叉审计，纠正“15s 模型物理上限”、“80% 伪配额”、“单块拆镜触发 L1197 算术崩溃与静音空镜”、“8s 成片被装配 `-t` 截断”、“只改 `compilePonyPrompt` 无运行时效果”及“地点绑定污染剧本哈希”等缺陷；完成 4 项待决事项终局裁决并同步修订方案与任务清单。
  - **Decision & Audit（2026-10-29，基线 `256787f`）**：
    - **决策**：① 冻结“1 个有声块严格归属 1 个镜头”不变量，废除 `AudibleBlock` 子句切片（`span_*` / `time_offset_ms`）与 `sub_clips`，多句长对白在剧本生成阶段按 ≤30 字拆为多个 `dialogue` 块；② 视频生成采用 `5.0s`（120 帧，尾帧 `119`）与 `8.0s`（192 帧，尾帧 `191`，$192 \bmod 17 = 5$ 零裁剪）双档按需选择，装配取 `finalDuration = Math.max(layout.duration, clipSeconds)` 防截断；③ 听者/正反打入镜人物仅从已确认事实绑定推导，双人镜朝向用 `each_other`，严守 35% / 20% / 65% 配额；④ 地点绑定复用 `resolveAssetBindings` 同名唯一匹配，不改 `ScriptLocationSchema`；⑤ 双端同步修复 `recommendVideoWorkflow` 与 `chooseShotVideoStrategy`。
    - **改动文件**：`docs/architecture/shot_timing_visual_anchor_first_last_frame_spec_2026-10-29.md`、`docs/architecture/shot_timing_visual_anchor_first_last_frame_tasks_2026-10-29.md`、`docs/0_TASKLIST.md`、`docs/architecture/novel_to_script_to_storyboard_concepts.md`、`docs/architecture/scene_continuity_workflow_2026-10-09.md`。
    - **边界**：本任务仅修订冻结技术方案与任务清单，未改动业务代码。下游首个可执行代码任务为 DT01。

#### Batch A: 视频路由先行、5s/8s 双档时长模型与防冲突拆镜

- [x] **DT01 · 修复前后端视频工作流路由策略（尾帧 + 人物参考 → Multi-Frame）。**
  - **依赖/落点**：DT00；`services/videoWorkflowPolicy.ts`、`scripts/production-references.mjs`、`services/videoWorkflowPolicy.test.ts`、`scripts/full-production.test.mjs`。
  - **交付/AC**：在 `recommendVideoWorkflow` 与 `chooseShotVideoStrategy` 中，当存在就绪的 `last_frame_reference` 且存在人物参考时，路由至 `minimax_h3_multiframe_official_12gb` 并携带 `last_frame_asset_id`（保留 `character_reference_asset_ids`）；仅无人物参考时走 `fl2va`。DT-AC01。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：双端统一路由优先级——有 `guide_frame_reference` / `composition_reference` 选 `Multi-Frame`；有就绪 `last_frame_reference` 且存在就绪 `character_reference` 时选 `minimax_h3_multiframe_official_12gb` 并传递 `last_frame_asset_id`（保留 `character_reference_asset_ids`）；仅纯空镜/无就绪人物参考时走 `minimax_h3_fl2va_official_12gb`。
    - **改动文件**：`services/videoWorkflowPolicy.ts`、`scripts/production-references.mjs`、`services/videoWorkflowPolicy.test.ts`、`scripts/full-production.test.mjs`。
    - **下游与未做事项**：下游进入 `DT02`（三级时长常量、台词估算器校准与 `FACT_POLICY_VERSION = 3.3`）；本任务未改动后端预设帧数或分镜拆镜逻辑。
- [x] **DT02 · 引入三级时长常量、校准台词估算器并升级 `FACT_POLICY_VERSION`。**
  - **依赖/落点**：DT01；`backend/src/services/storyboard_fact_workflow.ts`、`backend/src/schemas/storyboard_facts.ts`。
  - **交付/AC**：定义 `CLIP_SECONDS_SHORT=5.0`、`SOFT_MAX_SHOT_SECONDS=8.0`、`MAX_SHOT_SECONDS=15.0`。实现 `estimateAudioSeconds`，保留 `spokenCharacters` 引号提取，连续省略号 `……` 归并计 1 次停顿，结合 `delivery` 语速系数；升级 `FACT_POLICY_VERSION = 'storyboard-facts-3.3'`。DT-AC02。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `storyboard_fact_workflow.ts` 导出 `CLIP_SECONDS_SHORT = 5.0`、`SOFT_MAX_SHOT_SECONDS = 8.0`、`MAX_SHOT_SECONDS = 15.0`；② `spokenCharacters` 仅统计引号内可发音字符（`[\p{L}\p{N}]`），`estimateAudioSeconds` 合并连续省略号/句末标点（`/[。！？!?—]+|…+|\.{2,}/g`）与逗号停顿，并乘以 `delivery` 语速系数（缓慢 1.2、急促 0.85）；③ `FACT_POLICY_VERSION` 升至 `'storyboard-facts-3.3'`，同时在 `StoryboardFactContractSchema` 保留 `'storyboard-facts-3.2'` 兼容读取。
    - **改动文件**：`backend/src/schemas/storyboard_facts.ts`、`backend/src/services/storyboard_fact_workflow.ts`、`backend/src/services/ai/storyboard_generation_service.test.ts`。
    - **下游与未做事项**：下游进入 `DT03`（剧本单块 ≤30 字约束与 `allocateBudgets` 多块 8s 扩槽）；本任务未改动 `allocateBudgets` 槽位公式。
- [x] **DT03 · 剧本单块字数约束与分镜多块 8s 扩槽（防 L1197 算术崩溃与防配额击穿）。**
  - **依赖/落点**：DT02；`backend/src/services/ai/script_generation_service.ts`、`backend/src/services/ai/prompt_registry.ts`、`backend/src/services/storyboard_fact_workflow.ts`、`backend/src/services/ai/storyboard_generation_service.test.ts`。
  - **交付/AC**：剧本生成 Prompt 约束单块对白 ≤ 30 字（约 8s）；`allocateBudgets` 在多块/多节拍时按 8.0s 扩槽，单块 >8s 时由单镜包络整块时长（不拆出无声伴随槽位，杜绝 L1197 `有声对齐时长冲突` 与静音空镜）；景别维持在 L1087 槽位冻结阶段分配，120s 章节总镜数 ≤ 35 且通过 `assertChapterShotQuota`。DT-AC03。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `prompt_registry.ts`（`script_scene_gen` / `script_scene_rewrite`）与 `script_generation_service.ts` Stage 1 构思中加入单条 `dialogue` / `voiceover` ≤ 30 字（约 8s）、长独白按完整句号拆为多块的约束；② 在 `allocateBudgets` 中通过 `speechSlots = speechBlocks.length > 1 ? Math.min(speechBlocks.length, Math.ceil(speechSeconds / SOFT_MAX_SHOT_SECONDS)) : 1` 与 `minRequiredDuration = speechSeconds + Math.max(0, baseMinimum - speechBlocks.length)` 实现多块 8s 扩槽且杜绝单长块拆出无声伴随槽位导致 L1197 算术崩溃；③ 在有声块分配循环中按 `SOFT_MAX_SHOT_SECONDS` 推进槽位（确保剩余语音不超剩余槽位容量）。
    - **改动文件**：`backend/src/services/ai/prompt_registry.ts`、`backend/src/services/ai/script_generation_service.ts`、`backend/src/services/storyboard_fact_workflow.ts`、`backend/src/services/ai/storyboard_generation_service.test.ts`。
    - **下游与未做事项**：下游进入 `DT04`（H3 5.0s / 8.0s 双档预设与生产装配器防截断修复）；本任务未改动视频预设 schema 与 `full-production.mjs` 装配逻辑。
- [x] **DT04 · H3 5.0s / 8.0s 双档预设与生产装配器防截断修复。**
  - **依赖/落点**：DT03；`backend/src/schemas/video.ts`、`video_spec_compiler.ts`、`video_workflow_compiler.ts`、`loop_closer.ts`、`scripts/full-production.mjs`。
  - **交付/AC**：新增 `preview_480p_8s` / `standard_720p_8s`（192 帧）；解除编译器与 loop_closer 中 124/120 的硬编码；`full-production.mjs` 装配取 `finalDuration = Math.max(layout.duration, clipSeconds)` 并以 `finalDuration - clipSeconds` 算 `tpad`，杜绝 8s 视频被短语音截断。DT-AC04。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `VideoPresetSchema` 与前端 `types.ts` 新增 `'preview_480p_8s'` / `'standard_720p_8s'`；`resolvePresetDimensions` 对 8s 档输出 `frames: 192, delivery_frames: 192, fps: 24`，尾帧提示词动态锚定 `delivery_frames - 1`（5s 档 `119`，8s 档 `191`）；② `VideoWorkflowCompiler`、`LoopCloser` 与 `LoopAnalyzer` 解除 `124/120` 硬编码，支持 `192` 模型帧与 `192` 交付帧（8.0s）；③ 在 `scripts/production-contracts.mjs` 导出 `resolveAssembledShotTiming(layoutDuration, probeInfo)`、在 `scripts/production-references.mjs` 导出 `shotVideoPreset(shot)`，并在 `scripts/full-production.mjs` 与 `scripts/video-delivery-contract.mjs` 落地 `duration = Math.max(layout.duration, clipSeconds)` 与 `stopDuration = Math.max(0, duration - clipSeconds)`，确保 8s 源视频配 6s 语音时保持 8.0s 不截断，配 11s 语音时冻结尾帧 3.0s。
    - **改动文件**：`backend/src/schemas/video.ts`、`types.ts`、`backend/src/services/video/video_spec_compiler.ts`、`backend/src/services/video/video_workflow_compiler.ts`、`backend/src/services/video/loop_closer.ts`、`backend/src/services/video/loop_analyzer.ts`、`backend/src/services/video/video_generation_service.ts`、`scripts/production-contracts.mjs`、`scripts/production-references.mjs`、`scripts/video-delivery-contract.mjs`、`scripts/full-production.mjs`、`backend/src/services/video/video_spec_compiler.test.ts`、`backend/src/services/video/video_workflow_compiler.test.ts`、`scripts/full-production.test.mjs`。
    - **下游与未做事项**：Batch A（`DT01 ~ DT04`）全部收口；下游进入 Batch B 的 `DT05`（分镜采纳时按名自动绑定场次环境资产）。

#### Batch B: 场次环境资产按名绑定与 180° 空间轴线契约

- [x] **DT05 · 分镜采纳时按名自动绑定场次环境资产（不改动 ScriptLocationSchema）。**
  - **依赖/落点**：DT04；`backend/src/services/ai/storyboard_generation_service.ts`。
  - **交付/AC**：不改 `ScriptLocationSchema`（不污染剧本哈希）；在 `applyStoryboardCandidate` 及局部采纳事务中，按归一化名称唯一匹配已完成生图的 `library_asset(kind='location')` 并自动写入 `scene_asset_reference`。DT-AC05。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：保持 `ScriptLocationSchema` 不变（不污染 `factSourceHash`）；在 `AssetLibraryService` 新增 `resolveCompletedLocationAsset` 与 `autoBindLocationInTransaction`（按 NFKC + 标点/空白归一化精确匹配优先、次选唯一最长包含匹配，仅匹配 `status='completed'` 且有 `image_url` 的 `location` 资产），并在 `StoryboardGenerationService.applyStoryboardCandidate` 与 `applySceneProduction` 的写事务内自动写入 `scene_asset_reference (scene_id, asset_id, asset_revision)`。
    - **改动文件**：`backend/src/services/asset_library_service.ts`、`backend/src/services/ai/storyboard_generation_service.ts`、`backend/src/services/scene_production.ts`、`backend/src/services/ai/storyboard_generation_service.test.ts`、`backend/src/services/scene_production.test.ts`。
    - **下游与未做事项**：下游进入 `DT06`（在 `ShotContract` 中引入 `screen_direction` 并基于已确认绑定人物推导轴线）；本任务未改动提示词编译器。
- [x] **DT06 · 在 ShotContract 中引入 `screen_direction` 并基于已确认绑定人物推导轴线。**
  - **依赖/落点**：DT05；`backend/src/schemas/shot_contract.ts`、`backend/src/services/storyboard_fact_workflow.ts`。
  - **交付/AC**：扩展 `ScreenDirectionSchema`（`subject_placement`, `facing_direction`, `camera_side`）；依据本场已确认绑定（`boundVisibleEntities`）的入镜人物推导正反打互斥朝向（A 左面右，B 右面左，双人同框为 `two-shot-left-right + facing each_other`）。DT-AC06。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：在 `shot_contract.ts` 新增并导出 `ScreenDirectionSchema`，扩展 `ShotContractFieldsSchema` 与 `packShotSpec`；在 `storyboard_fact_workflow.ts` 导出 `deriveShotScreenDirection(sceneBoundCharacters, shotVisibleSubjects)`，严格按本场已确认绑定（`boundVisibleEntities(f.binding)`）的前两位交互角色推导 180° 轴线朝向（角色 A 单人镜 `left + facing right`、角色 B 单人镜 `right + facing left`、双人同框 `two-shot-left-right + facing each_other`），并在 `validateFactPayload` 中校验 `screen_direction` 结构。
    - **改动文件**：`backend/src/schemas/shot_contract.ts`、`backend/src/services/storyboard_fact_workflow.ts`、`backend/src/services/ai/storyboard_generation_service.test.ts`。
    - **下游与未做事项**：下游进入 `DT07`（将 `screen_direction` 接入运行时提示词与负向词编译链路）。
- [x] **DT07 · 将 `screen_direction` 接入真实运行时提示词与负向词编译链路。**
  - **依赖/落点**：DT06；`backend/src/services/english_visual_prompt.ts`、`scene_visual_prompt_service.ts`、`negative_prompt_compiler.ts`、`pony_prompt_compiler.ts`。
  - **交付/AC**：在运行时生效的英文视觉提示词与负向词编译链路中注入朝向动势词与反向视线抑制词，且双人同框镜不与 `looking at viewer` 冲突。DT-AC07。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `pony_prompt_compiler.ts` 导出 `formatScreenDirectionClause` 并接入 `compilePonyPrompt`；② 在 `english_visual_prompt.ts` 的 `shotImageMaterialsFromSpec` 与 `composeShotImagePrompt` 中透传并追加 180° 空间构图与视线短语（`positioned on left side of frame, facing right, looking to the right` / `positioned on right side of frame, facing left, looking to the left` / `two characters facing each other across the frame, profile/three-quarter view`）；③ 在 `negative_prompt_compiler.ts` 与 `scene_visual_prompt_service.ts` 中注入反向视线抑制词（`facing right` 排除 `facing left`，`facing left` 排除 `facing right`，非 `camera` 排除 `looking at viewer, front-facing passport photo`）。
    - **改动文件**：`backend/src/services/pony_prompt_compiler.ts`、`backend/src/services/english_visual_prompt.ts`、`backend/src/services/negative_prompt_compiler.ts`、`backend/src/services/scene_visual_prompt_service.ts`、`backend/src/services/pony_prompt_compiler.test.ts`、`backend/src/services/negative_prompt_compiler.test.ts`、`backend/src/services/english_visual_prompt.test.ts`。
    - **下游与未做事项**：下游进入 `DT08`（Batch B 轴线与环境绑定闭环验收）。
- [x] **DT08 · 验收 Batch B 轴线与环境绑定闭环。**
  - **依赖/落点**：DT05–DT07；单元测试与集成测试。
  - **交付/AC**：双人对话正反打切镜提示词与负向词断言通过，同场多镜环境参考按名绑定断言通过。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：完成 `DT-AC05`、`DT-AC06`、`DT-AC07` 全套单测与集成测试闭环（121/121 通过，`tsc --noEmit` 0 错误）。
    - **改动文件**：`backend/src/services/ai/storyboard_generation_service.test.ts`、`backend/src/services/scene_production.test.ts`、`backend/src/services/pony_prompt_compiler.test.ts`、`backend/src/services/negative_prompt_compiler.test.ts`、`backend/src/services/english_visual_prompt.test.ts`。
    - **下游与未做事项**：Batch B（`DT05 ~ DT08`）全部收口；下游进入 Batch C 的 `DT09`（状态跃迁镜尾帧候选采纳与角色快照门禁）。

#### Batch C: 首尾双关键帧门禁与 8s 整段末帧接力

- [x] **DT09 · 状态跃迁镜尾帧（`last_frame_reference`）候选采纳与角色快照门禁。**
  - **依赖/落点**：DT08；`backend/src/routes/assets.ts`、`shot_master_snapshot.ts`、`video_generation_service.ts`。
  - **交付/AC**：尾帧静图遵循候选→采纳流程，采纳时写入 `scene_asset_image_snapshot`；视频预检与提交时首帧与尾帧双双通过 `validateShotMasterCharacters` 角色一致性检查。DT-AC08。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `MediaAssetService` 新增 `adoptLastFrameCandidate(assetId)`，并在 `backend/src/routes/assets.ts`（`POST /api/assets/last-frame-decision/:scene_id`）与 `backend/src/routes/videos.ts`（`POST /api/videos/assets/:asset_id/adopt-last-frame`、上传与注册）中接入候选→采纳与 `recordShotMasterSnapshot`；② 在 `VideoGenerationService.preflight` 与 `createTask` 中拦截非 `ready` 尾帧，并对首帧（`keyframeAsset.url`）与尾帧（`lastFrameAsset.url`）双双执行 `validateShotMasterCharacters` 校验。
    - **改动文件**：`backend/src/services/video/media_asset_service.ts`、`backend/src/services/video/video_generation_service.ts`、`backend/src/routes/assets.ts`、`backend/src/routes/videos.ts`、`backend/src/services/video/video_storyboard_keyframe.test.ts`。
    - **下游与未做事项**：下游进入 `DT10`（Multi-Frame 动态尾帧与引导帧帧位上限 119/191）。
- [x] **DT10 · Multi-Frame 动态尾帧锚点（5s 档 119 / 8s 档 191）编译闭环。**
  - **依赖/落点**：DT09；`backend/src/schemas/video.ts`、`video_workflow_compiler.ts`、`video_spec_compiler.ts`、`scripts/production-references.mjs`。
  - **交付/AC**：将尾帧与引导帧帧位上限按预设动态扩展为 `delivery_frames - 1`（5s 档锚定 `frame 119`，8s 档锚定 `frame 191`）。DT-AC09。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：在 `backend/src/schemas/video.ts`（`refineVideoStrategy`）、`MediaAssetService.setGuideFrameIdx`、`backend/src/routes/videos.ts` 与 `scripts/production-references.mjs`（`chooseShotVideoStrategy`）中按预设动态计算 `maxFrameIdx = getPresetDeliveryFrames(preset) - 1`（5s 档 `119`，8s 档 `191`），配合 `video_workflow_compiler.ts` 节点 `23` 与 `video_spec_compiler.ts` 的 `delivery_frames - 1` 形成完整闭环。
    - **改动文件**：`backend/src/schemas/video.ts`、`backend/src/services/video/media_asset_service.ts`、`backend/src/routes/videos.ts`、`scripts/production-references.mjs`、`backend/src/schemas/video.test.ts`。
    - **下游与未做事项**：下游进入 `DT11`（精确末帧抽取与跨镜接力服务）。
- [x] **DT11 · 精确末帧抽取与跨镜接力服务（限制接力链长 ≤ 2）。**
  - **依赖/落点**：DT10；`backend/src/services/video/media_asset_service.ts`。
  - **交付/AC**：实现 `relayKeyframeFromPreviousShot`，优先复用已采纳静态尾帧，否则用 `select=eq(n\,delivery_frames-1)` 精确抽取末帧，记录 `parent_asset_id` 与 `relay_depth`（`<= 2`），采纳时写入角色快照。DT-AC10。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：在 `MediaAssetService` 实现 `relayKeyframeFromPreviousShot(targetSceneId, sourceSceneId, options)` 并暴露 `POST /api/videos/scenes/:scene_id/relay-keyframe`：① 优先直接复用源镜头已采纳的静态尾帧（`last_frame_reference`，零 VAE 衰减 Keyframe Bridge 模式）；② 无静态尾帧时从已完成的 `narrative_final` / `loop_master` 视频以 `ffmpeg -vf "select=eq(n\,${deliveryFrames - 1})" -frames:v 1` 精确抽取最后 1 帧（5s 档 `119`、8s 档 `191`）；③ 校验 `relay_depth < 2`（超过 2 代拒绝接力并提示重新生成静态关键帧），写入 `parent_asset_id` 与 `scene_asset_image_snapshot`。
    - **改动文件**：`backend/src/services/video/media_asset_service.ts`、`backend/src/routes/videos.ts`、`backend/src/services/video/video_storyboard_keyframe.test.ts`。
    - **下游与未做事项**：下游进入 `DT12`（全流程回归与验收矩阵 `DT-AC01 ~ DT-AC12`）。
- [x] **DT12 · 全流程回归与验收矩阵（DT-AC01 ~ DT-AC12）。**
  - **依赖/落点**：DT01–DT11；`backend/scripts/run-tests.ts` 及全栈回归。
  - **交付/AC**：新增单测全部登记进 `run-tests.ts`；备份导出导入无损；`npm run check`、`npm --prefix backend run test:full`、`node --test scripts/full-production.test.mjs` 全绿。DT-AC11、DT-AC12。
  - **Decision & Audit（2026-10-29）**：
    - **决策**：① 在 `restoreAssetLibrary`（`backend/src/services/asset_library_backup.ts`）中支持按新项目角色 ID 映射无损还原 `scene_asset_image_snapshot.character_versions_json`，验证 `screen_direction`、环境引用与角色版本快照在项目 JSON 备份导出/导入中无损还原（`DT-AC11`）；② 将 `asset_library_service.test.ts`、`scene_production.test.ts`、`video_storyboard_keyframe.test.ts` 登记入 `backend/scripts/run-tests.ts` 的 `CORE_TESTS`；③ 全量通过 `npm run check`、`node --test scripts/full-production.test.mjs` 与 `npm --prefix backend run test:full`（`DT-AC01 ~ DT-AC12` 全部闭环）。
    - **改动文件**：`backend/scripts/run-tests.ts`、`backend/src/services/asset_library_backup.ts`、`backend/src/services/import/novastory_json_import.ts`、`backend/src/routes/projects.ts`、`backend/src/services/asset_library_service.test.ts`。
    - **下游与未做事项**：Track 9（`DT00 ~ DT12`）全部收口。

