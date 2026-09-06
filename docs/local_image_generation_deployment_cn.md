# 本地生图模型部署推荐 (RTX 3060 12GB)

本文档整理了针对 **RTX 3060 12GB + 32GB 系统内存** 的 NovaStory 本地生图策略（2026-08 实测结论）。

文档索引：[README.md](./README.md) · ComfyUI 步骤：[comfyui_local_setup_guide_3060.md](./comfyui_local_setup_guide_3060.md) · 参考图策略：[local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)

## 0. 本机实测配置（参考）

| 项目 | 规格 |
| --- | --- |
| CPU | Intel i7-12700（12 核 / 20 线程） |
| 内存 | 32 GB |
| GPU | NVIDIA GeForce RTX 3060 **12GB** |
| 平台 | ComfyUI（`D:\ComfyUI`）+ NovaStory 内置工作流 |

**结论：12GB VRAM 非常适合 Pony / SDXL 与 SD1.5 草稿机；不适合把 FLUX.1-dev GGUF 当主力。**

---

## 1. 战略：本地生图引擎矩阵

| 轨道 | 模型族 | 用途 | 工作流 |
| --- | --- | --- | --- |
| **主力成片** | **Pony XL / SDXL 系** | 角色立绘、分镜、仙侠国漫、NSFW、Tier B 双参考 | `pony_xl_12gb.json` |
| **独立次世代** | **RedCraft「赤佬 3.0 / Krea2」** | 静态摄影/半写实、自然语言提示词、原生高细 NSFW | `redcraft_krea2_12gb.json` |
| **轻量草稿** | **SD 1.5 精品模** | 姿势/构图/镜头快速试错，几秒/张 | `sd15_draft_12gb.json` |

**已退役：FLUX.1-dev GGUF**（模型权重、下载脚本、内置工作流已从本机与仓库清理）。

### 为什么放弃 FLUX.1-dev GGUF（3060 12GB）

在 12GB 上跑 `flux1-dev-Q5_K_S.gguf` 的常见问题不是“装错”，而是 **能力被量化 + 卸载拖累**：

1. **Q5_K_S 有损**：相对满血 FLUX，细节、手部、材质、复杂 prompt 遵循都会掉一截  
2. **显存吃紧**：UNet + T5-XXL + VAE 峰值很高，常需 CPU offload → 慢、偶发糊、构图漂  
3. **题材不匹配**：NovaStory 偏仙侠 / 国漫 / 角色分镜；FLUX 底座偏写实西方面孔，要靠亚洲 LoRA 硬拧  
4. **生态断档**：Tier B（角色 IP-Adapter + 构图 ControlNet）已接 **Pony/SDXL**，未接 FLUX  
5. **速度**：同分辨率往往 **20–60 秒/张**，分镜迭代成本过高  

因此写实商业摄影若有硬需求，优先 **SDXL 写实 checkpoint**（如 Juggernaut / RealVis）或云端；**不要**再装 FLUX Dev GGUF 当本地主力。

---

## 2. 主推：Pony / SDXL 系（成片与角色一致性）

### 2.1 Pony Diffusion V6 XL（默认）

- **为什么适合**：SDXL 系、标签体系成熟，二次元 / 半写实 / 角色 / NSFW 资源极多  
- **VRAM**：FP16 下 1024×1024 在 12GB 上舒适；可挂多 LoRA + Tier B  
- **速度**：约 **数秒～十几秒/张**（视 steps、LoRA、参考图）  
- **部署**：
  1. Civitai 下载 [Pony Diffusion V6 XL](https://civitai.com/models/257749/pony-diffusion-v6-xl)
  2. 放入 `ComfyUI/models/checkpoints/`
  3. NovaStory 默认工作流：`pony_xl_12gb.json`
- **推荐 LoRA**（`models/loras/`）：
  - 细节：`Pony_DetailV2.0.safetensors`（或 Detail Tweaker）
  - NSFW（可选）：`Incase_Style_PonyXL.safetensors` 等 Incase / ExpressiveH 类

### 2.2 同档可换的 SDXL 子模型

| 方向 | 推荐 | 场景 |
| --- | --- | --- |
| 国漫 / 仙侠 | Illustrious XL、NoobAI-XL、国风 Pony 合并模 | 琼明类项目、古风幻想 |
| 半写实 / 厚涂 | AutismMix、Prefect Pony 类 | 国漫厚涂、概念插画 |
| 写实摄影 | Juggernaut XL、RealVisXL、EpicRealism XL | 电影分镜（替代原 FLUX 写实位） |

换 checkpoint 时：复制 `pony_xl_12gb.json`，改 `ckpt_name`，或在 ComfyUI 导出 API JSON 后导入 NovaStory Workflow。

### 2.3 Tier B（人物 + 构图双参考）

仅 **Pony / SDXL** 路线：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_tier_b_comfyui.ps1 -ComfyRoot "D:\ComfyUI"
```

装完后重启 ComfyUI，检查 `GET /api/settings/tier-b-status` → `full_dual_ref: true`。  
缺模型时自动回退档位 A，不会硬失败。详见 `docs/comfyui_local_setup_guide_3060.md`。

**门禁提醒：** 双人 / 远景 / 动作分镜**不会**对单张角色立绘启用 IP-Adapter（避免构图塌成软肖像）。立绘/三视图/单人特写才适合身份适配器。详见 [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。

---

## 3. 独立次世代：RedCraft「赤佬 3.0 / Krea2」（高质量静态摄影与半写实）

### 3.1 架构与定位
- **定位**：与 `pony_xl_12gb` 并列的**第一类独立静态文生图引擎**。
- **架构特点**：基于 Krea2 / DiT 架构 + Qwen3VL 文本编码器 + Qwen Image VAE。原生支持中文与自然语言叙事提示词，无需复杂的 Danbooru / `score_9` 标签。
- **NSFW 特性**：模型底座**原生具备极强的成人向/解剖学生成能力**，不依赖特定 NSFW LoRA 即可产出精细人体细节；NSFW 模式下自动解锁自然细节并释放负向约束。
- **LoRA 完全隔离**：
  - Pony / SDXL 的 LoRA **严禁**混入 RedCraft 工作流。
  - RedCraft 采用 `LoraLoaderModelOnly` 机制注入 Diffusion UNet/DiT，文本端不挂 LoRA。

### 3.2 RTX 3060 12GB 部署与运行参数推荐
- **模型文件与放置路径**：
  - **UNet / DiT**：推荐 **INT4 ConvRot 版本**（约 6GB，显存余量充足），放置于 `ComfyUI/models/diffusion_models/` 或 `unet/`（文件名如 `redcraft_krea2_int4.safetensors`）。*注：INT8 版本约 12GB，在 3060 上运行余量极小，不推荐。*
  - **Text Encoder / CLIP**：Qwen3VL 编码器，放置于 `ComfyUI/models/clip/`（如 `qwen3_vl_text.safetensors`，CLIPLoader 类型选 `krea2`）。
  - **VAE**：Qwen Image VAE，放置于 `ComfyUI/models/vae/`（如 `qwen_image_vae.safetensors`）。
  - **LoRA**（可选）：`ComfyUI/models/loras/`（风格增强或特定成人概念）。
- **推荐推理参数**：
  - **Steps**：10 步（DiT 快速收敛）
  - **CFG**：1.0（无需过高引导尺度）
  - **Sampler / Scheduler**：`euler` + `simple`
  - **分辨率**：768×1024 或 1024×1024
- **内置工作流**：`backend/static/workflows/redcraft_krea2_12gb.json`

---

## 4. 轻量高速：SD 1.5 精品模（草稿机）

用于 **构图试错、姿势探索、镜头语言预览**，不成片当最终交付。

| 模型示例 | 用途 |
| --- | --- |
| Anything V5 / Anything V5 Ink | 通用二次元草稿 |
| Counterfeit V3 | 精致插画向草稿 |
| MeinaMix / MeinaHentai 等 | 角色与氛围快出图 |
| ChilloutMix 等 | 半写实人像草稿 |

- **分辨率**：512×768 或 768×512 起步（工作流默认 512×768）  
- **速度**：12GB 上常可到 **数秒/张**  
- **工作流**：`sd15_draft_12gb.json`（默认 ckpt：`anything-v5.safetensors`，已按本机安装名配置）  
- **流程建议**：SD1.5 出构图 → 确认镜头 → 切回 **Pony/SDXL** 或 **RedCraft** 出成片与角色一致性  

将 checkpoint 放入 `ComfyUI/models/checkpoints/`，与 Pony 共存即可。

---

## 5. 按需求选型

| 你的目标 | 推荐 | 不推荐 |
| --- | --- | --- |
| 仙侠 / 国漫 / 角色一致性 / 二次元成人 | **Pony XL（默认）** | FLUX Dev GGUF |
| 次世代静态摄影 / 半写实 / 自然语言分镜 / 原生高细 NSFW | **RedCraft 3.0 (Krea2)** | 混用 Pony LoRA |
| 快速试镜、多角度构图探索 | **SD1.5 草稿** | 慢速大模硬扛 |
| 写实摄影、产品、复杂空间 | **RedCraft 3.0** 或 **SDXL 写实** | 再装 FLUX Q5 当主力 |
| 与 NovaStory 深度集成 | **`pony_xl_12gb.json` + Tier B** / **`redcraft_krea2_12gb.json`** | 指望 FLUX 用上 IP-Adapter |

**推荐组合（本机）：**

```text
1. Pony XL（二次元国漫主力成片 + 角色一致性）
2. RedCraft Krea2 INT4（次世代静态摄影/写实 + 原生高细 NSFW）
3. SD1.5 精品模（极速草稿机）
```

---

## 6. 实用建议（3060 12GB）

- **首选平台**：ComfyUI（省显存、节点灵活）  
- **系统 RAM**：32GB 足够；生图时尽量关闭占显存的其它程序  
- **分辨率**：
  - Pony/SDXL：768–1024，需要再 Hires / 放大  
  - RedCraft Krea2：768–1024  
  - SD1.5：512–768  
- **NSFW**：
  - Pony：Civitai 上 Pony/SDXL 专用 LoRA；系统设置里开启 NSFW 后自动叠加载细节 + 成人向 LoRA  
  - RedCraft：底座原生具备极强成人细节，无需挂载 NSFW LoRA 即可生成高质量成人画面；亦可按需选挂特定风格 LoRA  
- **提示词习惯**：
  - Pony：标签式（`score_9, source_anime, 1girl, ...`）  
  - RedCraft Krea2：自然语言叙事 / 摄影描述（`high quality portrait, cinematic studio lighting...`）  
  - SD1.5：标签式 + 质量词（`masterpiece, best quality, ...`）  
  - SDXL 写实：自然语言 + 摄影术语  

**预期速度（12GB，经验值）：**

| 模型 | 典型耗时 |
| --- | --- |
| SD1.5 草稿 | 约 2–8 秒/张 |
| Pony / SDXL | 约 5–20 秒/张 |
| RedCraft Krea2 INT4 (10 steps) | 约 6–18 秒/张 |
| ~~FLUX Dev GGUF~~ | ~~20–60 秒/张（已弃用）~~ |

---

## 7. 清理说明（FLUX.1-dev GGUF 退役清单）

以下内容已从本机 / 仓库移除或不再维护：

| 类别 | 路径 / 项 |
| --- | --- |
| UNet GGUF | `models/unet/flux1-dev-Q5_K_S.gguf` |
| T5 / CLIP | `models/clip/t5xxl_fp8_e4m3fn.safetensors`、`clip_l.safetensors` |
| FLUX VAE | `models/vae/ae.safetensors` |
| FLUX LoRA | `models/loras/XLabs_Flux_Realism.safetensors` |
| 内置工作流 | `flux_dev_gguf_12gb.json`、`flux_dev_example.json` |
| 下载脚本 | `scripts/download_flux_*`、`scripts/flux_dl_logs` |

**请勿再下载** city96 的 FLUX Dev GGUF 到本机「默认生图栈」。若历史项目数据库里仍残留 `flux_*` 工作流名，请在 NovaStory 工作流管理中禁用/删除，并改用 `pony_xl_12gb` 或 `sd15_draft_12gb`。

---

## 8. 资源获取

- **Checkpoint / LoRA / 工作流**：主要 [Civitai](https://civitai.com)  
- **ComfyUI 部署步骤**：`docs/comfyui_local_setup_guide_3060.md`  
- **参考 / IP-Adapter 策略**：`docs/local_image_reference_policy_cn.md`  
- **画风与模型对照（历史对比文，FLUX 仅作背景）**：`local/Pony_XL与FLUX_Dev_GGUF生图风格对比.md`  
- **分镜批跑对照实验**：`local/shortstory/xianxia_duel/`（v2 成功基线；v4 IP 失败；v4.1 无 IP 修复）

默认系统配置应保持：

```json
"default_workflow": "pony_xl_12gb.json",
"selected_workflow_file": "pony_xl_12gb.json"
```
