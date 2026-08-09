# ComfyUI 本地生图部署指南 (RTX 3060 12GB 专版)

为了让 NovaStory 在本地生成高质量分镜，需要配置 ComfyUI。本指南针对 **RTX 3060 (12GB)**；后端已内置对应工作流模板。

**本地策略（2026-08）：** 主力 **Pony / SDXL** + 草稿 **SD 1.5**。  
**FLUX.1-dev GGUF 已退役**，详见 [local_image_generation_deployment_cn.md](./local_image_generation_deployment_cn.md)。  
**参考图 / IP-Adapter 何时生效：** [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。

文档总索引：[README.md](./README.md)。

## 1. 下载与运行 ComfyUI

1. 前往 [ComfyUI 官方 Releases](https://github.com/comfyanonymous/ComfyUI/releases) 下载最新 **Portable**（Windows 推荐）。
2. 解压到空间充足的磁盘（如 `D:\ComfyUI`）。
3. 运行 `run_nvidia_gpu.bat`。
4. 浏览器访问 `http://127.0.0.1:8188` 确认界面可用。

## 2. 下载推荐模型

系统默认 **Pony XL**（动漫、插画、角色分镜、NSFW 生态成熟且速度快）。

### Pony V6 XL（默认成片）

1. Civitai 下载 [Pony Diffusion V6 XL](https://civitai.com/models/257749/pony-diffusion-v6-xl)。
2. 将 checkpoint 放入 `ComfyUI/models/checkpoints/`。
3. （推荐）细节 LoRA `Pony_DetailV2.0.safetensors` 放入 `models/loras/`。
4. NovaStory 默认工作流：`pony_xl_12gb.json`。

### SD 1.5 精品模（可选草稿机）

用于姿势/构图快速迭代，不成片交付：

1. 下载 Anything V5 / Counterfeit / MeinaMix 等 SD1.5 checkpoint。
2. 放入 `models/checkpoints/`。
3. 工作流 `sd15_draft_12gb.json`（默认 `ckpt_name`：`anything-v5.safetensors`）。
4. 建议分辨率 512×768，确认镜头后再切回 Pony 出成片。

### 写实向（可选，替代原 FLUX 写实位）

需要电影感/摄影风时，使用 **Juggernaut XL** / **RealVisXL** 等 SDXL 写实模：复制 Pony 工作流并改 checkpoint。**不要**再安装 FLUX.1-dev GGUF。

## 2.5 档位 B：人物 + 构图双参考（Pony / SDXL）

在 **标签 / LoRA / 文本构图（档位 A）** 之上，可选双参考增强：

| 支路 | 作用 | 依赖 |
|------|------|------|
| 人物 `character_ref_url` | 身份锁定（IP-Adapter） | `ComfyUI_IPAdapter_plus` + SDXL IP-Adapter 权重 + CLIP Vision |
| 构图 `composition_ref_url` | 姿势/布局锁定（ControlNet） | 原生 ControlNet + SDXL OpenPose/Depth/Canny；可选 `comfyui_controlnet_aux` |

**一键安装（推荐）：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_tier_b_comfyui.ps1 -ComfyRoot "D:\ComfyUI"
```

装完后**重启 ComfyUI**，检查：

`GET /api/settings/tier-b-status`

- `full_dual_ref: true` → 人物+构图双参考可用  
- 缺模型/节点时**自动回退档位 A**，不会硬失败  

### 导演模式与门禁（必读）

后端**不会**在每张叙事分镜上无脑开 IP-Adapter：

| 镜头类型 | 人物 IP-Adapter |
| --- | --- |
| 立绘 / 三视图 / 明确单人特写 | 可开 |
| 双人打戏 / 群像 / 远景建立 / 动作破损 | **关闭**（避免单张头像锁死构图） |
| 项目或请求 `reference_tier: "A"` | 强制仅文本+标签 |

- 有角色立绘/头像：前端可提交 `character_ref_url`；**是否启用 adapter 由后端策略决定**  
- **同一分镜原地重生成**：上一张成图可作为 `composition_ref_url`（锁构图微调）  
- **新建版本 / 首次生成**：通常无构图参考，以文本构图为主  

> Tier B 仅服务 Pony/SDXL。SD1.5 草稿默认档位 A。  
> 完整策略与对决实验（v4 失败 / v4.1 修复）：[local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。

## 3. 在 NovaStory 中对接

1. 保持 ComfyUI 终端运行。  
2. 启动 NovaStory（`start_all.ps1` 或 README 方式）。  
3. 系统设置：启用 ComfyUI，`selected_workflow_file` / `default_workflow` 为 `pony_xl_12gb.json`。  
4. 项目设置可选默认模型 **Pony XL** 或 **SD 1.5 Draft**。  
5. Director Mode 生成素材；完成后图片回写到项目静态目录。

## FAQ

- **Q: 为什么不再推荐 FLUX？**  
  A: 3060 12GB 上 FLUX.1-dev GGUF（Q5）画质差、慢、东亚角色与 Tier B 不匹配。成片 Pony/SDXL，草稿 SD1.5，写实用 SDXL 写实模。

- **Q: 开了 Tier B 为什么双人打戏没有 IP？**  
  A: 这是预期行为。单张肖像参考会破坏双人/动作构图；身份请用标签或角色 LoRA。见参考策略文档。

- **Q: 生成内容偏软、不像分镜？**  
  A: 检查是否误传全镜 `character_ref` 且权重过高；关闭 NSFW 时尚在动作镜会剥离 alluring 类风格词；对比 `style_preset` 是否过「魅惑」。

- **Q: Workflow template not found？**  
  A: 确认 `backend/app/static/workflows/` 存在 `pony_xl_12gb.json` 或 `sd15_draft_12gb.json`，重启后端以重新 seed。

- **Q: 库里还有旧 flux 工作流？**  
  A: Workflow 管理页禁用/删除即可；后端启动也会清理已下架的 bundled `flux_dev_*` 名。
