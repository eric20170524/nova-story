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
└── archive/      历史原型需求、早期 TODO 与已闭环 PR 记录
```

---

## 📜 Vibe 合同（现行迭代唯一入口）

Agent 改代码前先读 [`skills/vibe-coder/SKILL.md`](../skills/vibe-coder/SKILL.md)，只执行 [`0_TASKLIST.md`](./0_TASKLIST.md) 对应 Track 的第一个 `[ ]`。

| 合同 | 路径 | 核心职责 |
| --- | --- | --- |
| **全局任务全景** | [0_TASKLIST.md](./0_TASKLIST.md) | 统一三条活动 Track（Prompt 编译器、H3 生视频、RedCraft INT4/8）的唯一任务事实源 |
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
| 从已导入小说一路创作到整本漫画 PDF | [novel-to-comic Skill](../skills/novel-to-comic/SKILL.md) |
| 在 3060 上安装 ComfyUI 与模型 | [comfyui_local_setup_guide_3060.md](./deployment/comfyui_local_setup_guide_3060.md) |
| 本地生图选型 Pony vs SD1.5、为何不用 FLUX | [local_image_generation_deployment_cn.md](./deployment/local_image_generation_deployment_cn.md) |
| 角色参考 / IP-Adapter / ControlNet 何时生效与门禁 | [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md) |
| 本地 LLM（Ollama Qwen 等）部署与显存互斥 | [local_language_model_deployment_cn.md](./deployment/local_language_model_deployment_cn.md) |
| 系统整体分层架构与运行时数据流 | [architecture_cn.md](./architecture/architecture_cn.md) |
| 后端已实现能力完整清单 | [backend_implemented_features.md](./architecture/backend_implemented_features.md) |
| Agent OS / 小说创作核心落地计划 | [agent_os_plan_cn.md](./architecture/agent_os_plan_cn.md) |
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

### 2. 系统架构与深度设计 (`docs/architecture/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [architecture_cn.md](./architecture/architecture_cn.md) | ✅ 现行 | 系统分层总览、Node/Fastify 服务端、前端及工作流拓扑 |
| [backend_implemented_features.md](./architecture/backend_implemented_features.md) | ✅ 现行 | 后端已落地能力清单（DB 迁移、API、生图、版本管理、Agent） |
| [agent_os_plan_cn.md](./architecture/agent_os_plan_cn.md) | ⚠️ 落地中 | Agent OS 写作内核规格、多 Action 自愈决策与分层记忆体系 |

### 3. 生视频子系统 (`docs/video/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md](./video/红潮_Hybrid_H3_A2A_生视频最佳实践与TODO.md) | ✅ 现行 | 视频架构、VideoSpec 契约、G0 授权与模型指纹、分阶段规划 |
| [生视频最佳实践与TODO 分析报告.md](<./video/生视频最佳实践与TODO 分析报告.md>) | ✅ 现行 | 对照代码实现的深度技术评审与全景分析报告（2600+行） |
| [H3_P0_IMPLEMENTATION_STATUS_2026-09-07.md](./video/H3_P0_IMPLEMENTATION_STATUS_2026-09-07.md) | 📝 进度 | H3 P0/P1 基础能力修复与 CI 覆盖核验快照 |
| [H3_MAIN_OVERLAP_CONFLICT_FIXLIST_2026-09-08.md](./video/H3_MAIN_OVERLAP_CONFLICT_FIXLIST_2026-09-08.md) | 📝 进度 | 静态图与 H3 共用 GPU / Comfy 时的并发、租约与冲突修复清单 |

### 4. 历史归档 (`docs/archive/`)
| 文档 | 状态 | 核心说明 |
| --- | --- | --- |
| [NovaStory MVP.md](<./archive/NovaStory MVP.md>) | 📦 归档 | MVP 早期设想（含已退役的旧 FLUX 工作流举例），仅作背景 |

---

## 🎨 生图策略一句话总结

```text
成片：Pony XL（pony_xl_12gb.json）+ 风格/细节 LoRA + 可选 Tier B
草稿：SD 1.5（sd15_draft_12gb.json），默认不做 IP-Adapter
叙事分镜：标签 + 文本构图优先；双人/远景/动作镜禁止单图 IP-Adapter 锁构图
```

详见 [local_image_reference_policy_cn.md](./deployment/local_image_reference_policy_cn.md)。
