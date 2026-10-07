# ComfyUI 本地生图部署指南 (RTX 3060 12GB 专版)

为了让 NovaStory 在本地生成高质量分镜，需要配置 ComfyUI。本指南针对 **RTX 3060 (12GB)**；后端已内置对应工作流模板。

**本地策略：** 主力 **Pony / SDXL**，草稿 **SD 1.5**，次世代静帧 **RedCraft「赤佬 3.0 / Krea2」**（本机是 INT8 ConvRot）。Pony / SD1.5 / FLUX 的选型结论来自 2026-08；RedCraft 的文件与运行时以 2026-10-07 对本机的核对为准。  
**FLUX.1-dev GGUF 已退役**。权重原因与 1280×704 的运行时说明见 [local_image_generation_deployment_cn.md](./local_image_generation_deployment_cn.md) 第 3.2 节。  
**参考图 / IP-Adapter 何时生效：** [local_image_reference_policy_cn.md](./local_image_reference_policy_cn.md)。档位 B 只服务 Pony / SDXL。

文档总索引：[README.md](../README.md)。

## 1. 本机 ComfyUI 与启动

本机安装在 `D:\ComfyUI`，版本 **0.34.5**。`backend/system_settings.json` 的 `comfyui.install_path` 也是这个目录；环境变量 `NOVASTORY_COMFYUI_DIR` 可以覆盖它。

这里不是 Portable 包：没有 `run_nvidia_gpu.bat`，也没有 `python_embeded`。解释器是 `D:\ComfyUI\venv\Scripts\python.exe`。

在仓库根目录启动（会先放开本机文本模型占用的显存，再拉起 ComfyUI）：

```powershell
powershell -ExecutionPolicy Bypass -File .\start_all.ps1 -ComfyUIOnly
```

`start_all.ps1` 实际执行的是：

```text
D:\ComfyUI\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram --disable-pinned-memory --cache-none
```

浏览器打开 `http://127.0.0.1:8188`。`127.0.0.1:8188` 上只保留一个 `main.py`。

RedCraft 要在这张 3060 上出标准潜空间 1280×704，这个虚拟环境必须是：

| 包 | 版本 |
| --- | --- |
| PyTorch | 2.9.1+cu130 |
| torchvision | 0.24.1+cu130 |
| torchaudio | 2.9.1+cu130 |
| comfy-kitchen | 0.2.37 |

2026-10-07 在该环境中导入 comfy-kitchen 时，`cuda` 后端可用并实现了 `int8_linear`。不要把虚拟环境退回 PyTorch 2.6.0+cu124：那个组合会关掉 CUDA 后端，INT8 走 eager 反量化，1280×704 会溢出。`--lowvram` 不能代替这个内核。说明见部署文档第 3.2 节。

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

需要电影感/摄影风时，使用 **Juggernaut XL** / **RealVisXL** 等 SDXL 写实模：复制 Pony 工作流并改 checkpoint。**不要**再安装 FLUX.1-dev GGUF。次世代静帧也可以走下面的 RedCraft，而不是再装 FLUX。

### RedCraft「赤佬 3.0 / Krea2」配置清单

项目里选择 **RedCraft 3.0 (Krea2)**（模型族 `redcraft_krea2`）时，使用内置工作流 `backend/static/workflows/redcraft_krea2_12gb.json`。推理参数是 10 steps、CFG 1、`euler` + `simple`。标准 16:9 的交付图是 1280×720，送进 Comfy 的潜空间是 1280×704。耗时和峰值显存不在本指南记录。

官方文件来自 [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2)。该仓库没有约 6GB 的 INT4 扩散权重。本机用的是 turbo INT8 ConvRot；工作流里的文件名是硬链接，不是第二份权重。

| 组件 | 工作流请求的文件名 | 本机上的同一份文件 | 目录 |
| --- | --- | --- | --- |
| 扩散模型 | `redcraft_krea2_int4.safetensors` | `krea2_turbo_int8_convrot.safetensors`，13,492,686,496 字节（约 13.5 GB），INT8 ConvRot | `ComfyUI/models/diffusion_models/` |
| 文本编码器 | `qwen_vl.safetensors`（CLIPLoader 类型 `krea2`） | `qwen3vl_4b_fp8_scaled.safetensors`，5,242,467,968 字节（约 5.24 GB） | `models/clip/` 与 `models/text_encoders/` 各有一份硬链接 |
| VAE | `qwen_image_vae.safetensors` | 同名，253,806,246 字节（约 242 MB） | `ComfyUI/models/vae/` |

`models/unet/` 里没有这份扩散权重。ComfyUI 会搜索 `models/unet` 和 `models/diffusion_models`，本机文件在后者。

Pony / SDXL 的 LoRA 不要挂进这条工作流。档位 B 的 IP-Adapter 与 ControlNet 也不用于 RedCraft。可选的 Krea2 LoRA 放在 `ComfyUI/models/loras/`。

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
3. 系统设置：启用 ComfyUI。系统默认工作流保持 `pony_xl_12gb.json`（`selected_workflow_file` / `default_workflow`）。  
4. 项目设置可选 **Pony XL**、**SD 1.5 Draft** 或 **RedCraft 3.0 (Krea2)**。选 RedCraft 时走 `redcraft_krea2_12gb.json`，文件见上面的配置清单。  
5. Director Mode 生成素材；完成后图片回写到项目静态目录。

## FAQ

- **Q: 为什么不再推荐 FLUX？**  
  A: 3060 12GB 上 FLUX.1-dev GGUF（Q5）画质差、慢、东亚角色与 Tier B 不匹配。成片 Pony/SDXL，草稿 SD1.5，写实用 SDXL 写实模。

- **Q: 开了 Tier B 为什么双人打戏没有 IP？**  
  A: 这是预期行为。单张肖像参考会破坏双人/动作构图；身份请用标签或角色 LoRA。见参考策略文档。

- **Q: 生成内容偏软、不像分镜？**  
  A: 检查是否误传全镜 `character_ref` 且权重过高；关闭 NSFW 时尚在动作镜会剥离 alluring 类风格词；对比 `style_preset` 是否过「魅惑」。

- **Q: Workflow template not found？**  
  A: 确认 `backend/static/workflows/` 存在 `pony_xl_12gb.json`、`sd15_draft_12gb.json` 或 `redcraft_krea2_12gb.json`，重启后端以重新 seed。可用环境变量 `NOVASTORY_STATIC_DIR` 覆盖静态根目录。

- **Q: RedCraft 在 1280×704 显存溢出？**  
  A: 先看第 1 节的虚拟环境。PyTorch 2.9.1+cu130 与 comfy-kitchen 0.2.37 让 CUDA `int8_linear` 生效后，这个潜空间才能在 3060 上跑。PyTorch 2.6.0+cu124 会走 eager 反量化并溢出。`--lowvram` 不能代替该内核。

- **Q: 库里还有旧 flux 工作流？**  
  A: Workflow 管理页禁用/删除即可；后端启动也会清理已下架的 bundled `flux_dev_*` 名。
