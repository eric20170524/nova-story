# 本地生图模型部署推荐 (RTX 3060 12GB)

本文档整理了针对 RTX 3060 12GB 显卡的本地生图模型部署建议（支持 NSFW，2026 年最新推荐）。

**12GB VRAM 是生图的良好入门/中级配置**，比 8GB 舒服很多：可以跑 **Flux Dev GGUF**、**Pony XL**、**SDXL** 等主流模型，无需过多妥协，生成速度可接受（几秒到几十秒/张）。NSFW 支持非常成熟，Civitai 上资源丰富。

## 1. Flux.1 Dev / Flux.2（最推荐，当前质量顶尖）
- **为什么适合**：提示理解极强、细节丰富、解剖/手部好，支持复杂 NSFW 场景。
- **VRAM/表现**：**GGUF Q5/Q6** 在 12GB 上跑得很好（1024x1024，20 steps 约 20-60 秒）。Q4 更快更省。
- **NSFW**：加载 NSFW LoRA 或直接用自然语言 prompt 即可（“explicit, nude”等有效）。
- **部署**：ComfyUI + city96 GGUF 模型（Hugging Face）。推荐 Flux.2 Klein（更轻快）或 Dev 版。

## 2. Pony Diffusion V6 XL（NSFW 首选，神级 fine-tune）
- **为什么适合**：SDXL 优化版，**专为 anime/pony/NSFW 设计**，自然语言 + score 标签系统，生成高质量 explicit 内容（姿势、细节、互动极强）。
- **VRAM/表现**：FP16 下轻松跑 1024x1024，支持多 LoRA + ControlNet。
- **NSFW**：原生无审查，Civitai 上无数 Pony 专用 NSFW LoRA/embedding。
- **部署**：ComfyUI / Forge，下载主模型（safetensors）+ VAE + embeddings。CLIP skip=2。

## 3. SDXL / SD 3.5 + NSFW 模型（稳定可靠）
- **推荐子模型**：
  - **Realistic Vision / EpicRealism / Juggernaut**（写实 NSFW）。
  - **Animagine XL / AutismMix / Illustrious**（anime NSFW）。
  - **Wai / Anything XL** 等。
- **VRAM/表现**：12GB 非常舒适，支持高分辨率 + 多个 LoRA。
- **NSFW**：搭配对应 NSFW LoRA 解锁全部内容。

## 4. 其他强力选项
- **SD 1.5 生态**（Anything V5、Counterfeit、ChilloutMix 等）：最轻量、速度最快、NSFW LoRA 海量。适合快速迭代。
- **Flux Schnell**：更快轻量版，适合日常生成。

## 实用建议（3060 12GB）
- **首选平台**：**ComfyUI**（最省显存、节点灵活，推荐）。Forge / SwarmUI 也可。
- **优化技巧**：
  - Flux 用 **GGUF 量化** + T5 encoder 量化。
  - 启用 lowvram/medvram 模式。
  - 分辨率 768-1024px 起步，配合 Hires fix / upscaler。
  - 系统 RAM 建议 32GB+。
- **NSFW 提示**：在 Civitai 下载高质量 workflow + LoRA 组合，prompt 用详细描述 + 负面 prompt。
- **预期速度**（12GB）：
  - Pony/SDXL：几秒到十几秒/张。
  - Flux Dev GGUF：20-60 秒/张（视量化）。

**优先组合**：**Flux Dev GGUF（通用高质量） + Pony XL（NSFW 专用）**，基本覆盖所有需求。

> 提示：模型、LoRA、工作流资源主要前往 **Civitai** 获取，Flux GGUF 模型前往 **Hugging Face** 获取。
