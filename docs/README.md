# NovaStory 文档索引

按主题浏览仓库文档。**本地生图默认栈为 Pony XL / SDXL 成片 + SD1.5 草稿（FLUX.1-dev GGUF 已退役）；视频管线推进至红潮 Hybrid H3 A2A。**

---

## 📁 目录组织 (最多一层子目录)

```text
docs/
├── [根目录] 核心 Vibe 合同与规范（开发唯一入口与红线）
├── deployment/   本地部署、环境配置与硬件/模型策略（RTX 3060 12GB）
├── architecture/ 系统架构分层、Agent OS 设计与特性清单
├── video/        生视频（红潮 Hybrid H3 A2A）方案、审计与修复记录
└── archive/      历史原型需求、阶段验收报告与基线记录
```

---

## 📜 Vibe 合同（现行迭代唯一入口）

Agent 改代码前先读 [`skills/vibe-coder/SKILL.md`](../skills/vibe-coder/SKILL.md)，只执行 [`0_TASKLIST.md`](./0_TASKLIST.md) 对应 Track 的第一个 `[ ]`。

| 合同 | 路径 | 核心职责 |
| --- | --- | --- |
| **全局任务全景** | [0_TASKLIST.md](./0_TASKLIST.md) | Prompt 编译器、H3 生视频、RedCraft、小说故事创作、结构化剧本与本机 TTS 角色音色的唯一任务事实源 |
| **产品范围** | [1_PRD.md](./1_PRD.md) | MVP 业务边界与产品规范 |
| **架构红线** | [2_ARCHITECTURE.md](./2_ARCHITECTURE.md) | 技术栈红线、目标管道约束（深入分层见 `architecture/`） |
| **UI 规则** | [3_UI_RULES.md](./3_UI_RULES.md) | i18n 规范、Tailwind、Toast、可测试性属性规则 |
| **数据与迁移** | [4_BACKEND_DB.md](./4_BACKEND_DB.md) | SQLite 严格迁移、project_id 隔离、结构持久化原则 |
| **Agent 行为** | [5_AGENT_RULES.md](./5_AGENT_RULES.md) | Agent 编码十诫、HITL 规则与本地验证命令 |
| **Prompt 编译规范** | [best_practice_scene_visual_prompt.md](./best_practice_scene_visual_prompt.md) | 镜头契约 → Pony 标签的唯一事实源，禁止多处抄录 |
| **接口规范** | [API.md](./API.md) | REST 与 SSE 端点协议清单（含资产与版本机制） |

---

## 🚀 快速入口

| 你想… | 推荐阅读 |
| --- | --- |
| 在 3060 上安装 ComfyUI 与模型 | [comfyui_local_setup_guide_3060.md](./deployment/comfyui_local_setup_guide_3060.md) |
| 本地生图选型 Pony vs SD1.5、为何不用 FLUX | [local_image_generation_deployment_cn.md](./deployment/local_image_generation_deployment_cn.md) |
| 角色参考 / IP-Adapter / ControlNet 何时生效与门禁 | [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md) |
| 保留构图草稿，新增正式分镜图按钮；候选不激活，采纳沿用 CT18 | [Track 8 正式分镜任务清单 FS00–FS17](./0_TASKLIST.md#track8-production-storyboards) |
| 本地 LLM（Ollama Qwen 等）部署与显存互斥 | [local_language_model_deployment_cn.md](./deployment/local_language_model_deployment_cn.md) |
| 本机中文 TTS、音色目录与角色绑音 | [local_chinese_tts_voice_cn.md](./deployment/local_chinese_tts_voice_cn.md) |
| 系统整体分层架构与运行时数据流 | [architecture_cn.md](./architecture/architecture_cn.md) |
| 弱模型只出语义、Harness 管协议的准入方案 | [model_semantics_harness_protocol_2026-10-20.md](./architecture/model_semantics_harness_protocol_2026-10-20.md) |
| 后端已实现能力完整清单 | [backend_implemented_features.md](./architecture/backend_implemented_features.md) |
| Agent OS / 小说创作核心落地计划 | [agent_os_plan_cn.md](./architecture/agent_os_plan_cn.md) |
| 新书与 Agent OS 对齐核查、10 万字内小说故事建设方案 | [creation_alignment_review_2026-09-28.md](./architecture/creation_alignment_review_2026-09-28.md) |
| 构思开书、自动新章、修订与扩展章纲的方案与任务 | [总体方案](./architecture/novel_creation_workflow_plan_2026-09-30.md)、[后端任务及核心代码](./architecture/novel_creation_backend_tasks_2026-09-30.md)、[前端任务及核心代码](./architecture/novel_creation_frontend_tasks_2026-09-30.md) |
| 小说故事与短剧剧本分层、Toonflow 核心能力收敛方案 | [structured_screenplay_module_2026-09-28.md](./architecture/structured_screenplay_module_2026-09-28.md) |
| 红潮 Hybrid H3 A2A 生视频方案与 TODO | [红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md](./video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md) |

---

## 📚 文档全景清单与状态

### 1. 部署与环境 (`docs/deployment/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [comfyui_local_setup_guide_3060.md](./deployment/comfyui_local_setup_guide_3060.md) | ✅ 现行 | RTX 3060 12GB 专版 ComfyUI 部署、工作流与模型放置指南 |
| [local_image_generation_deployment_cn.md](./deployment/local_image_generation_deployment_cn.md) | ✅ 现行 | 双轨生图策略（Pony XL 成片 + SD1.5 草稿），FLUX 退役说明 |
| [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md) | ✅ 现行 | 档位 A/B、IP-Adapter 与 ControlNet 门禁策略（防构图崩坏） |
| [local_language_model_deployment_cn.md](./deployment/local_language_model_deployment_cn.md) | ✅ 现行 | 本地 Ollama Qwen 写作模型配置与 GPU 显存互斥管理 |
| [local_chinese_tts_voice_cn.md](./deployment/local_chinese_tts_voice_cn.md) | 📝 Track 6 方案 | 连接 local-chinese-tts：查询、试听，并在角色上保存音色 |

### 2. 系统架构与深度设计 (`docs/architecture/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [architecture_cn.md](./architecture/architecture_cn.md) | ✅ 现行 | 系统分层总览、Node/Fastify 服务端、前端及工作流拓扑 |
| [backend_implemented_features.md](./architecture/backend_implemented_features.md) | ✅ 现行 | 后端已落地能力清单（DB 迁移、API、生图、版本管理、Agent） |
| [agent_os_plan_cn.md](./architecture/agent_os_plan_cn.md) | ⚠️ 落地中 | Agent OS 写作内核规格、多 Action 自愈决策与分层记忆体系 |
| [creation_alignment_review_2026-09-28.md](./architecture/creation_alignment_review_2026-09-28.md) | 📝 代码核查与建设方案 | DreamWaverAI 对齐核查；故事正文上限 10 万字；旧双形态要求按独立剧本方案修订 |
| [novel_creation_workflow_plan_2026-09-30.md](./architecture/novel_creation_workflow_plan_2026-09-30.md) | 📝 实施设计 | 三项小说创作流程的代码缺口、数据边界、接口与 NC01–NC14 验收矩阵 |
| [novel_creation_backend_tasks_2026-09-30.md](./architecture/novel_creation_backend_tasks_2026-09-30.md) | 📝 后端交接 | DreamWaver 原始片段、Zod/SQL、规划候选、精确修订和幂等建章核心代码 |
| [novel_creation_frontend_tasks_2026-09-30.md](./architecture/novel_creation_frontend_tasks_2026-09-30.md) | 📝 前端交接 | Agent 模式、规划与候选卡、类型/API、重试及编辑保护核心代码 |
| [novel_to_script_to_storyboard_concepts.md](./architecture/novel_to_script_to_storyboard_concepts.md) | ✅ 现行概念说明 | 小说→提纲→分场正文→导演镜头的分层、一对多对应、页面数字含义；先读这份再看实现文档 |
| [structured_screenplay_module_2026-09-28.md](./architecture/structured_screenplay_module_2026-09-28.md) | ✅ S0–S4 已闭环 | 故事→改编提纲→分场剧本→安全交接导演分镜；支持备份往返、级联清理、项目复制与来源过期检测 |
| [scene_continuity_workflow_2026-10-09.md](./architecture/scene_continuity_workflow_2026-10-09.md) | 📝 Track 5 S5 评审修订方案 | 确认状态契约、九机位接口边界、保留旧图的失效、独立夹具与 9B 建议验收；人工分轮制作不等待模型；任务状态见 0_TASKLIST.md 的 CT00–CT22 |
| [model_semantics_harness_protocol_2026-10-20.md](./architecture/model_semantics_harness_protocol_2026-10-20.md) | ✅ 已落地 | 模型出语义、Harness 管协议：原文切片、人物下标、译文、连续状态、年龄与参考图只拒绝，不改写通过 |

阶段基线、验收报告及 JSON 结果统一放在 `archive/`，架构目录保留设计与实施方案。

### 3. 生视频子系统 (`docs/video/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md](./video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md) | ✅ 现行 | 视频架构、VideoSpec 契约、G0 授权与模型指纹、分阶段规划 |
| [生视频最佳实践与TODO 分析报告.md](<./video/生视频最佳实践与TODO 分析报告.md>) | ✅ 现行 | 对照代码实现的深度技术评审与全景分析报告（2600+行） |
| [H3_P0_IMPLEMENTATION_STATUS_2026-09-07.md](./video/H3_P0_IMPLEMENTATION_STATUS_2026-09-07.md) | 📝 进度 | H3 P0/P1 基础能力修复与 CI 覆盖核验快照 |
| [H3_MAIN_OVERLAP_CONFLICT_FIXLIST_2026-09-08.md](./video/H3_MAIN_OVERLAP_CONFLICT_FIXLIST_2026-09-08.md) | 📝 进度 | 静态图与 H3 共用 GPU / Comfy 时的并发、租约与冲突修复清单 |

### 4. 历史归档 (`docs/archive/`)

归档目录仅保存在本地，已加入 Git 忽略规则，不随仓库提交到 GitHub；以下链接供本地查阅。验收与基线记录保留当时的结果和限制；当前任务状态以 [0_TASKLIST.md](./0_TASKLIST.md) 为准。配套 JSON 与报告同目录保存。

| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [NovaStory MVP.md](<./archive/NovaStory MVP.md>) | 📦 归档 | MVP 早期设想（含已退役的旧 FLUX 工作流举例），仅作背景 |
| [scene_continuity_baseline_2026-10-10.md](./archive/scene_continuity_baseline_2026-10-10.md) | ✅ CT01 基线与夹具 | 当前代码/未提交变更、F01–F08 预标注输入、离线模拟输出、既有失败与未支持/N/A；不代表 CT08 或真实模型验收通过 |
| [scene_continuity_identity_2026-10-10.md](./archive/scene_continuity_identity_2026-10-10.md) | ✅ CT02 身份与位置契约 | 同名实物独立 ID、角色/组件/关系归属、剧本顺序及 coverage 同刻来源引用；持久化、确认和端点门禁依原任务继续实施 |
| [scene_continuity_confirmation_2026-10-10.md](./archive/scene_continuity_confirmation_2026-10-10.md) | ✅ CT03 属性与确认契约 | 十一项属性、精确原文/设计证据、人工/具名规则确认、原子 holder 转移与待核对回退；回放/持久化/HTTP 门禁继续 CT04–CT06，全矩阵仍待 CT08 |
| [scene_continuity_replay_2026-10-10.md](./archive/scene_continuity_replay_2026-10-10.md) | ✅ CT04 回放与快照契约 | 明确人工入口、故事序 entry/exit、独立 during、多 moment、规范 state/source 哈希及实际镜头读取；持久化与写门禁继续 CT05–CT06 |
| [scene_continuity_persistence_2026-10-10.md](./archive/scene_continuity_persistence_2026-10-10.md) | ✅ CT05 持久化与生命周期 | 账本修订、每镜依赖、旧图保留、候选指纹、版本切换、签名备份/完整引用重映射和导入核对；HTTP 与界面继续 CT06–CT08 |
| [scene_continuity_consumption_2026-10-10.md](./archive/scene_continuity_consumption_2026-10-10.md) | ✅ CT06 单场与九机位消费 | 单场写范围、确认时刻读取、coverage 三入口/事务门禁、during 引用及镜头版本完整契约；核对界面与全矩阵继续 CT07–CT08 |
| [scene_continuity_review_2026-10-10.md](./archive/scene_continuity_review_2026-10-10.md) | ✅ CT07 核对与局部恢复 | 显式人工确认、来源/设计依据、动作中位置、待核对建议、旧图恢复及草稿/冲突保护；完整矩阵和浏览器继续 CT08 |
| [scene_continuity_matrix_2026-10-10.md](./archive/scene_continuity_matrix_2026-10-10.md) | ✅ CT08 完整确定性验收 | 33 项 F01–F08、coverage 三入口、两个视口浏览器、旧项目/冲突/恢复及旧图审计；真实模型与正式成图未运行 |
| [scene_continuity_suggestions_2026-10-10.md](./archive/scene_continuity_suggestions_2026-10-10.md) | ✅ CT09–CT12 建议与预算 | 冻结评估、建议任务 API、持久化取消/断点、父预算与完整分镜链路复用；真实能力结论另见 CT14 |
| [scene_continuity_categories_2026-10-11.md](./archive/scene_continuity_categories_2026-10-11.md) | ✅ CT10–CT12 属性与编译 | 逐件衣物、道具、场景物件的确定性验收；模型建议仍需人工确认 |
| [scene_continuity_diff_2026-10-10.md](./archive/scene_continuity_diff_2026-10-10.md) | ✅ CT13 差异与撤销 | 只读影响预览、指纹确认、撤销新增修订、实际依赖恢复和保留旧图；人工制作路径可继续 |
| [scene_continuity_real_model_2026-10-11.md](./archive/scene_continuity_real_model_2026-10-11.md) | ✅ CT14 真实 9B 评估 | 72 任务及整链/专项实测；分列提取、可接受结果与自动资格，保留失败，默认人工确认 |
| [scene_continuity_production_2026-10-11.md](./archive/scene_continuity_production_2026-10-11.md) | ✅ CT15–CT19、CT22 | 三场分轮制作、真实 8 图全部拒绝、只重做依赖三镜、旧图保留、两个视口与吞吐评估；不宣称成图质量通过 |
| [scene_continuity_time_hand_2026-10-11.md](./archive/scene_continuity_time_hand_2026-10-11.md) | ✅ CT20–CT21 | 人工故事日/回忆隔离与身体持物手别、生命周期及浏览器；真实手别小集 0/12 可接受，自动确认关闭 |
| [scene_continuity_completion_2026-10-11.json](./archive/scene_continuity_completion_2026-10-11.json) | 📦 CT00–CT22 汇总 | 最终验证结果、模型与成图质量限制的机器记录 |
| [formal_storyboard_baseline_2026-10-11.json](./archive/formal_storyboard_baseline_2026-10-11.json) | 📦 FS00 只读基线 | 正式分镜实施前的数据库、能力门禁与已有失败快照 |

---

## 🎨 生图策略一句话总结

```text
成片：Pony XL（pony_xl_12gb.json）+ 风格/细节 LoRA + 可选 Tier B
草稿：SD 1.5（sd15_draft_12gb.json），默认不做 IP-Adapter
叙事分镜：标签 + 文本构图优先；双人/远景/动作镜禁止单图 IP-Adapter 锁构图
```

详见 [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md)。

上面的方框是当前代码行为，不是 Track 8 的目标按钮。Track 8 的两个入口都使用项目已选模型，不把草稿悄悄换成 SD 1.5，也不在 Krea2 与 SDXL 之间自动换模。

**2026-10-11 修订后的计划**：[Track 8](./0_TASKLIST.md#track8-production-storyboards) 保留构图草稿，并新增“生成正式分镜图”。草稿请求跳过连续性 pin。正式生成写入未激活版本，完成时不改活动图、不写 Shot Master；采纳沿用 CT18 的六项核对后再切换。优先验证已部署的 SDXL IP-Adapter、OpenPose 和多人区域参考。广角/多人只对实机验证通过的正式组合开放。此段仍是计划，业务代码尚未替换。


## 媒体生产

- [分镜生图与生视频生产最佳实践（2026-10-03）](./video/分镜生图与生视频生产最佳实践_20261003.md)：统一 16:9 生图画布、H3 默认 720p/24fps、480p 预览与 Shot Master/多参考素材职责。
