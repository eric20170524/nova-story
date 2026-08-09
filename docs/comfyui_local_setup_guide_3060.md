# ComfyUI 本地生图部署指南 (RTX 3060 12GB 专版)

为了让 NovaStory 在您的机器上能生成高质量的分镜图像，您需要在本地配置好 ComfyUI。本指南专为 RTX 3060 (12GB) 编写，后端已内置与之适配的自动模板注入。

**本地策略（2026-08）：** 主力 **Pony / SDXL** + 草稿 **SD 1.5**。  
**FLUX.1-dev GGUF 已退役**，详见 `docs/local_image_generation_deployment_cn.md`。

## 1. 下载与运行 ComfyUI

1. 前往 [ComfyUI 官方 Releases](https://github.com/comfyanonymous/ComfyUI/releases) 下载最新的 **Portable 压缩包**（Windows 推荐）。
2. 解压到您剩余空间充裕的磁盘（如 `D:\ComfyUI`）。
3. 运行目录下的 `run_nvidia_gpu.bat` 启动。
4. 确保在浏览器中访问 `http://127.0.0.1:8188` 能够打开界面。

## 2. 下载推荐模型

系统默认配置为 **Pony XL**（动漫、插画、角色分镜、NSFW 生态成熟且速度快）。

### Pony V6 XL（默认成片）

1. 前往 Civitai 下载 [Pony Diffusion V6 XL](https://civitai.com/models/257749/pony-diffusion-v6-xl)。
2. 将 `ponyDiffusionV6XL_v6StartWithThisOne.safetensors` 放入 ComfyUI 的 `models/checkpoints/`。
3. （推荐）细节 LoRA `Pony_DetailV2.0.safetensors` 放入 `models/loras/`。
4. NovaStory 默认工作流：`pony_xl_12gb.json`。

### SD 1.5 精品模（可选草稿机）

用于姿势/构图快速迭代，不成片交付：

1. 下载如 Anything V5 / Counterfeit / MeinaMix 等 SD1.5 checkpoint。
2. 放入 `models/checkpoints/`。
3. 使用工作流 `sd15_draft_12gb.json`（默认 `ckpt_name`：`anything-v5.safetensors`；换模时改此字段即可）。
4. 建议分辨率 512×768，确认镜头后再切回 Pony 出成片。

### 写实向（可选，替代原 FLUX 写实位）

需要电影感/摄影风时，下载 **Juggernaut XL** 或 **RealVisXL** 等 SDXL 写实模，复制 Pony 工作流并改 checkpoint 即可。**不要**再安装 FLUX.1-dev GGUF。

## 2.5 档位 B：人物 + 构图双参考（Pony / SDXL）

NovaStory 在 **标签/LoRA/文本构图（档位 A）** 之上，支持可选的双参考增强：

| 支路 | 作用 | 依赖 |
|------|------|------|
| 人物 `character_ref_url` | 身份锁定（IP-Adapter） | `ComfyUI_IPAdapter_plus` + SDXL IP-Adapter 权重 + CLIP Vision |
| 构图 `composition_ref_url` | 姿势/布局锁定（ControlNet） | 原生 ControlNet + SDXL OpenPose/Depth/Canny 权重；可选 `comfyui_controlnet_aux` |

**一键安装（推荐）：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_tier_b_comfyui.ps1 -ComfyRoot "D:\ComfyUI"
```

装完后**重启 ComfyUI**，再访问后端：

`GET /api/settings/tier-b-status`

- `full_dual_ref: true` → 人物+构图双参考可用  
- 缺模型/节点时**自动回退档位 A**，不会硬失败  

导演模式行为：

- 有角色立绘/头像 → 始终作为 `character_ref_url` 提交（后端有 IP-Adapter 则用，否则仅特写走 img2img）
- **同一分镜原地重生成** → 上一张成图作为 `composition_ref_url`（锁构图微调）
- 新建版本 / 首次生成 → 无构图参考，纯文本构图 + 可选人物适配器

> Tier B 仅服务 Pony/SDXL 工作流。SD1.5 草稿机默认走档位 A。

## 3. 在 NovaStory 中对接

1. 保持 ComfyUI 终端窗口运行，不要关闭。
2. 启动 NovaStory 后端与前端（见仓库 `start_all.ps1` / README）。
3. 系统设置中确认 ComfyUI 已启用，`selected_workflow_file` 为 `pony_xl_12gb.json`。
4. 在 Director Mode 中 Generate Asset；ComfyUI 终端应出现进度，完成后图片回传到 NovaStory。

## FAQ

- **Q: 为什么不再推荐 FLUX？**  
  A: 在 RTX 3060 12GB 上 FLUX.1-dev GGUF（Q5）画质受损、速度慢、东亚角色与 Tier B 集成差。成片用 Pony/SDXL，草稿用 SD1.5，写实用 SDXL 写实模。详见 `local_image_generation_deployment_cn.md`。

- **Q: 为什么生成的内容不是我想要的内容？**  
  A: 后端会自动做 Prompt / Negative 注入。请确认角色标签、画风预设，以及项目 NSFW 开关。

- **Q: 遇到报错 “Workflow template ... not found” 怎么办？**  
  A: 检查 `backend/app/static/workflows/` 下是否存在 `pony_xl_12gb.json` 或 `sd15_draft_12gb.json`，并重启后端以重新 seed 工作流表。

- **Q: 数据库里还看到旧的 flux 工作流？**  
  A: 可在 Workflow 管理页禁用/删除；后端启动时也会清理已下架的 bundled flux 工作流名。
