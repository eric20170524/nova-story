完整方案已写成两份文件，可直接下载后对照搭建。

下面是同一套管线的浓缩版，按部署顺序执行即可。

## 1. 运行环境

- ComfyUI + PyTorch CUDA 12.x  
- 自定义节点：`ComfyUI-Impact-Pack`、`ComfyUI-Impact-Subpack`（面部检测）  
- 启动参数（3060 12G）：

```bat
python main.py --normalvram --preview-method auto --reserve-vram 0.8
```

不要加 `--gpu-only` 或 `--highvram`。

## 2. 模型

| 类型 | 文件 | 目录 |
| --- | --- | --- |
| 底模（二选一） | WAI-Illustrious 或 Hassaku XL，fp16 | `models/checkpoints/` |
| LoRA A | 国风 / 仙侠材质 | `models/loras/` |
| LoRA B | 2.5D / 半厚涂 | `models/loras/` |
| 放大 | `4x-UltraSharp.pth` | `models/upscale_models/` |
| 检测器 | 二次元 face bbox，其次 `face_yolov8m` | `models/ultralytics/bbox/` |

## 3. 节点顺序

`Checkpoint` → `CLIP Set Last Layer = -2` → `LoRA A` → `LoRA B` → `KSampler1` → `VAE Decode` → `UltraSharp 放大` → `缩到 1248×1824` → `VAE Encode` → `KSampler2` → `VAE Decode Tiled` → `Face Detailer` → 保存

API JSON 覆盖到 Tiled Decode。Face Detailer 因 Impact Pack 接口随版本变化，需在导入后用图形界面补上，参数见下。

## 4. 默认参数

| 阶段 | 设置 |
| --- | --- |
| 潜空间 | **832×1216**，batch=1 |
| LoRA A | Model **0.55** / CLIP **0.62** |
| LoRA B | Model **0.32** / CLIP **0.30** |
| Sampler1 | euler_a，**28** step，CFG **5.0**，denoise **1.0** |
| 放大 | UltraSharp 后缩到 **1248×1824**，禁止把 4× 原图送进二阶段 |
| Sampler2 | **dpmpp_2m + karras**，**20** step，CFG **4.8**，denoise **0.35** |
| VAE2 | Tiled，tile **512** |
| Face Detailer | 二次元检测器，denoise **0.32**，CFG **4.5**，crop **1.7**，feather **8–16** |

## 5. 提示词

正向：

```text
masterpiece, best quality, very aesthetic, newest, absurdres,
1girl, solo, xianxia, chinese clothes, hanfu, wide sleeves,
translucent fabric, silk, layered clothes, embroidery,
hair ornament, hairpin, tassel, floating ribbon, long hair,
semi-realistic, 2.5d, painterly,
cinematic lighting, volumetric light, tyndall effect, cool light, rim light,
detailed eyes, long eyeliner, glowing skin, soft skin, depth of field
```

负向：

```text
worst quality, low quality, bad anatomy, bad hands, extra digits,
3d render, cgi, plastic skin, shiny skin,
photo, photorealistic, oil painting, sketch, watermark
```

## 6. 验收

1. 导入 JSON 后，把三个 `PLACEHOLDER` 文件名改成本机实际文件。  
2. 补上 Face Detailer，接在 Tiled Decode 之后。  
3. 固定种子出一张，分辨率应为 832×1216 → 1248×1824。  
4. 同一种子把 CFG 改到 7，应过饱和；改回 5.0 应恢复。  
5. 连续 5 张不 OOM。若二阶段爆显存：tile 改为 448，并确认没有把 4× 大图送进 VAE。

更完整的故障表、显存对照与「不要加的节点」写在部署方案文档第 7–10 节。
