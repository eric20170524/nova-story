# NovaStory 文档索引

按主题浏览仓库文档。**本地生图默认栈（2026-08）为 Pony XL / SDXL 成片 + SD1.5 草稿；FLUX.1-dev GGUF 已退役。**

## 快速入口

| 你想… | 文档 |
| --- | --- |
| 在 3060 上装 ComfyUI / 模型 | [comfyui_local_setup_guide_3060.md](./comfyui_local_setup_guide_3060.md) |
| 选型 Pony vs SD1.5、为何不用 FLUX | [local_image_generation_deployment_cn.md](./local_image_generation_deployment_cn.md) |
| 角色参考 / IP-Adapter / ControlNet 何时生效 | [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md) |
| 后端已实现能力清单 | [backend_implemented_features.md](./backend_implemented_features.md) |
| REST / SSE 接口 | [API.md](./API.md) |
| 系统分层与数据流 | [architecture_cn.md](./architecture_cn.md) |
| 本地 LLM（Ollama 等） | [local_language_model_deployment_cn.md](./local_language_model_deployment_cn.md) |
| Agent OS / 小说创作核心落地计划 | [agent_os_plan_cn.md](./agent_os_plan_cn.md) |

## 文档状态

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `comfyui_local_setup_guide_3060.md` | ✅ 现行 | 安装与对接 |
| `local_image_generation_deployment_cn.md` | ✅ 现行 | 双轨策略与退役说明 |
| `local_image_reference_policy_cn.md` | ✅ 现行 | 档位 A/B 与 IP 门禁（v4 踩坑后修订） |
| `backend_implemented_features.md` | ✅ 现行 | 后端能力摘要 |
| `API.md` | ✅ 现行 | 接口清单（含版本 / Tier B） |
| `architecture_cn.md` | ✅ 现行 | 架构总览 |
| `local_language_model_deployment_cn.md` | ✅ 现行 | 本地文本模型 |
| `agent_os_plan_cn.md` | ⚠️ 功能已落地 / 可靠性收口中 | Agent OS 规格；见 §17 P1/P2；勿过早称生产就绪 |
| `frontend_REQUIREMENTS_CN.md` | 📦 历史 | 早期前端需求，实现以代码与 `backend_implemented_features` 为准 |
| `frontend_TODO.md` | 📦 历史 | 早期前端待办，多数已完成；勿当现状清单 |
| `NovaStory MVP.md` | 📦 历史 | MVP 设想（含旧 FLUX 工作流举例），仅作背景 |

## 仓库外相关材料

| 路径 | 内容 |
| --- | --- |
| `local/shortstory/xianxia_duel/` | 仙门体术对决多版本生图对照（v1 Imagine / v2 Pony / v3 电影写实备片 / v4 失败 IP 实验 / **v4.1 无 IP 12/12**） |
| `local/Pony_XL与FLUX_Dev_GGUF生图风格对比.md` | 历史风格对照文（FLUX 仅作背景） |
| 仓库根 `README.md` | 启动、安全默认、架构入口 |
| `TODO.md` / `task.md`（若存在） | 工程备忘；以代码与本索引为准 |
| `backend/scripts/gen_duel_pony_v4.ts` | 对决对照批跑脚本（默认 v4.1 无角色参考） |

## 生图策略一句话

```text
成片：Pony XL（pony_xl_12gb.json）+ 风格/细节 LoRA + 可选 Tier B
草稿：SD 1.5（sd15_draft_12gb.json），默认不做 IP-Adapter
叙事分镜：标签 + 文本构图优先；双人/远景/动作镜禁止单图 IP-Adapter 锁构图
```

详见 [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。
