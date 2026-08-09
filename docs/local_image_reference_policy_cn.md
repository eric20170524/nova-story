# 本地生图参考策略（档位 A / B）

本文说明 NovaStory 如何使用**角色标签、角色 LoRA、角色参考图、构图参考图**，以及何时**禁止** IP-Adapter。  
实现：`backend/src/services/reference_generation_policy.ts`、`tier_b_adapters.ts`、`image_generation_policy.ts`。

## 1. 两档分工

| 档位 | 始终/条件 | 内容 | 失败行为 |
| --- | --- | --- | --- |
| **A（默认）** | 始终 | 视觉标签 + 可选角色 LoRA + 文本构图（`visual_prompt` / 镜头字段） | — |
| **A + img2img** | 仅立绘 / 三视图 / 单人特写等 | 角色图作 init，denoise 中等 | 宽叙事镜不启用 |
| **B** | 本机装好适配器且策略允许 | 人物 `character_ref_url` → **IP-Adapter**；构图 `composition_ref_url` → **ControlNet** | 缺节点/模型时静默回退 A |

探测：`GET /api/settings/tier-b-status`（`full_dual_ref` 等）。  
安装：`scripts/setup_tier_b_comfyui.ps1`。

**模型族：**

- **Pony / SDXL**：可走 A + B  
- **SD1.5 草稿**：默认仅 A（不做 Pony/SDXL 系 IP-Adapter）  
- **legacy `flux`**：客户端映射为 pony；自定义 FLUX 图若仍存在则 **不走** Tier B  

## 2. 身份锁门禁（重要）

IP-Adapter 与轻度 img2img 都会「锁构图」。在**双人、远景、动作**镜上用**单张立绘/头像**当 `character_ref`，会把分镜压成软光单人像（2026-08 仙门对决 **pony_v4** 全批失败的主因）。

因此 `planReferenceGeneration` 对 **character adapter** 与 **img2img** 共用构图门禁：

| 场景 | IP-Adapter | 角色 img2img |
| --- | --- | --- |
| `gen_type=portrait` / `turnaround` / `turnaround_panel` | ✅ 允许 | 按原策略 |
| 提示/镜头含 **2girls / 双人 / two-shot** 等 | ❌ | ❌ |
| 远景 / establishing / wide / 空镜场地 | ❌ | ❌ |
| 动作 / 对打 / kick / throw / battle damage 等 | ❌ | ❌ |
| 单人 close-up / portrait 语义 | ✅ | ✅（denoise 可控） |
| `reference_tier: "A"` 或 `force_no_character_adapter: true` | ❌ 强制关 | 不强制关 img2img（仍走 img2img 策略） |
| `force_character_adapter: true` | ✅ 强制开（调试用） | — |

实现函数：`shouldAllowCharacterAdapter()`、`resolveReferenceImg2ImgPolicy()`。

### 推荐接法

| 目标 | 推荐 |
| --- | --- |
| 叙事分镜（多角色、动作、环境） | **纯档位 A**：标签 + 文本 + 风格 LoRA；**不要**塞 portrait 当 character_ref |
| 角色立绘 / 头像 / 三视图 | `gen_type=portrait` 或 turnaround 流水线；可用 IP-Adapter 或 img2img |
| 原地微调构图 | 上一张成图作 `composition_ref_url`（ControlNet）；人物身份仍靠标签/LoRA |
| 身份极强一致 | 训练/挂 **角色 LoRA**，不要用单图 IP 扛双人打戏 |

## 3. 导演模式默认行为

- 角色被分镜提及时：外观 snippet（标签）并入 prompt（A）。  
- 若前端附带 `character_ref_url`：仅在上表「允许」时启用 IP-Adapter；否则只保留文本身份，**不会**静默用 0.75 权重锁死构图。  
- 原地重生成：可用上一帧作构图参考（B 构图支路）。  
- 新建版本 / 首次生成：通常无构图参考。  

项目设置 `default_model_type`：`pony` | `sd15`（旧 `flux` 读入时回落 `pony`）。

## 4. 风格与 NSFW（摘要）

详见 `image_generation_policy.ts` 与设置页 Advanced：

- **NSFW 关**：风格/细节 LoRA + 硬 SFW 负向；动作/战后镜会剥离 alluring/portrait 类风格叙事词。  
- **NSFW 开**：可再叠成人向 LoRA（Pony Incase 类等）；国风预设会避免 Incase 冲脸。  
- **SD1.5**：不自动挂 Pony/SDXL LoRA；用 masterpiece 质量词而非 score/rating 体系。  

## 5. 对照实验（仙门体术对决）

路径：`local/shortstory/xianxia_duel/`

| 版本 | 要点 | 结果 |
| --- | --- | --- |
| v1 | Grok Imagine | 可用对照 |
| v2 | Pony + `sensual_gufeng`，**无** character_ref | 叙事可读，成功基线 |
| v3 | 目标 FLUX GGUF；实际 GGUF 损坏，备用 Pony 电影写实标签 | FLUX 路径废弃 |
| v4 | 新策略 + **每镜 IP-Adapter@0.75** | 构图崩坏（软肖像） |
| v4.1 | 新策略 + **无** character_ref / Tier A only | **12/12 完成**（脚本默认；目录 `pony_v4_1/`） |

批跑：

```bash
cd backend
npx tsx scripts/gen_duel_pony_v4.ts          # v4.1，无 IP
npx tsx scripts/gen_duel_pony_v4.ts --legacy-v4   # 仅复现失败路径
```

## 6. 相关文档

- 部署与选型：`local_image_generation_deployment_cn.md`  
- ComfyUI 安装：`comfyui_local_setup_guide_3060.md`  
- 后端能力：`backend_implemented_features.md`  
