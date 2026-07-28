# 本地语言模型

> 本机已按本文首选方案落地：`Qwen3-8B Abliterated v2 / Q4_K_M`，通过 Ollama 的
> OpenAI 兼容接口接入 NovaStory。针对 RTX 4060 Laptop 8GB + 16GB 内存，固定为
> 8K 上下文、Flash Attention、q8 KV cache、单并发，并与 ComfyUI 采用显存互斥运行。
> 安装路径、启动方式、验证和调参依据见
> [本地语言模型部署说明](./local_language_model_deployment_cn.md)。

**针对 8GB 显存、支持 NSFW（无审查）、主要用于小说创作、漫剧分镜和生图提示词的本地语言模型推荐如下**（基于 2026 年社区实测与评测，优先选 Q4_K_M 量化版本，约 4.5–6GB VRAM 占用，留余量给上下文）。

### 核心推荐（按优先级）

1. **Qwen3-8B Abliterated v2（huihui-ai 或类似 abliterated / Heretic 版本）**  
   - **最推荐的当前首选**。Q4_K_M 约 5GB，8GB 显存跑得稳，支持较长上下文。  
   - 通用能力强、中文优秀、指令遵循好，适合小说剧情推进、分镜描述、结构化输出。  
   - Abliterated 版本几乎无拒绝，NSFW 内容直接输出。  
   - 来源：Hugging Face（huihui-ai/Huihui-Qwen3-8B-abliterated-v2 或类似），Ollama/LM Studio/KoboldCPP 都可直接用。  
   - 适合：小说写作 + 分镜 + 提示词生成。

2. **Dolphin 3.0 Llama 3.1 8B**  
   - 经典可靠的 uncensored 模型（Eric Hartford 系），128K 上下文，创作向表现稳定。  
   - Q4_K_M 轻松进 8GB，散文风格自然，适合长篇小说和角色一致性。  
   - NSFW 支持好，不易说教或拒绝。  
   - 来源：dphn/Dolphin3.0-Llama3.1-8B（GGUF 版）。

3. **Llama 3.1 8B Instruct Abliterated（bartowski 或 mlabonne 量化）**  
   - 成熟基线，社区生态好，指令跟随强。  
   - Q4_K_M 约 5GB，适合快速生成分镜脚本、场景描述、生图提示词。  
   - 有专门 RP/创作微调变体（如 Stheno、Dirty Harry、Dark Planet 等），更偏角色扮演和故事感。  
   - 来源：bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF。

4. **Stheno L3 8B v3.2（或类似 Llama-3 系 RP 微调）**  
   - 专为角色扮演和创意写作优化，角色声音一致性好，长对话/故事连贯。  
   - 适合漫剧分镜（人物互动、场景转换）、小说对话。  
   - Q4/Q5 可跑，NSFW 友好。  
   - 注意部分版本可能有非商业许可限制。

### 其他值得尝试的选项
- **Undi95 DPO Mistral 7B 或类似 Mistral 系 uncensored**：速度快、大胆，适合快速草稿和成人向内容。
- **Gemma 系 8B/9B Abliterated（Heretic 等）**：部分评测中散文质量不错，中文可用，但整体不如 Qwen 系列稳定。
- **专门 RP/NSFW 微调**：如 L3.1-RP-Hero-Dirty_Harry-8B、Dark Planet Uncensored 等，社区在 SillyTavern 场景下反馈较好。

### 使用建议（8GB 显存关键）
- **量化**：优先 **Q4_K_M**（平衡质量与速度），有余量可试 Q5_K_M。避免更高量化以免爆显存。
- **工具推荐**：
  - **LM Studio** 或 **Ollama**：最简单上手。
  - **KoboldCPP** 或 **text-generation-webui**：更灵活，支持 GGUF。
  - **SillyTavern**：做角色扮演、漫剧分镜、长篇互动小说时强烈推荐（配合世界书/角色卡）。
- **上下文**：建议 4K–8K tokens 起步，过长会挤占 VRAM 导致变慢。用 Flash Attention、KV cache 量化可进一步优化。
- **采样参数（创作向）**：Temperature 0.8–1.1，Top-P 0.9–0.95，适当提高 repetition penalty，减少重复。
- **工作流技巧**：
  - 小说：分章节/场景写，保持角色卡 + 大纲摘要在 prompt 中。
  - 漫剧分镜：要求输出结构化（镜头号、画面描述、对白、情绪）。
  - 生图提示词：让模型直接输出 SDXL/Flux/Pony 风格的详细 prompt（可指定风格、构图、光照等）。

### 注意事项
- 8GB 是预算档，7–9B 模型质量够用日常创作，但复杂长篇逻辑和细节记忆不如更大模型。若后续升级到 12GB+，可考虑 12B 级（如 Mistral-Nemo 系）。
- 模型更新很快，优先从 Hugging Face 找最新 abliterated/Heretic 版本，确认有 GGUF。
- 本地运行完全私密，适合 NSFW 内容；请遵守当地法律法规，仅用于成人虚构创作。

如果告诉我你的具体工具（Ollama / LM Studio / SillyTavern 等）、更偏向中文还是英文、或主要场景（纯小说 / 强角色扮演 / 提示词），我可以再细化下载链接和参数设置。

---

# 生图模型、生视频模型
- RedCraft-3.0-Krea2-Int4-Convrot https://pan.quark.cn/s/32e54c437036
- Scail-2-GGUF-Relay https://pan.quark.cn/s/c9623c92a927
- LTX-2.3-MSR-V2.0 https://pan.quark.cn/s/b44e47bb1cda
- Krea-2-Trainer https://pan.quark.cn/s/b2635fa9495c
- Bernini-Studio-GGUF https://pan.quark.cn/s/ce950a1cee7c
- Krea-2-GGUF-Style https://pan.quark.cn/s/ba7770e8bc9e
- IdeoGram-4-Instant_int8-convrot https://pan.quark.cn/s/066b7dbf7a9a
- Krea-2-GGUF-ControlNet https://pan.quark.cn/s/90a691fa6bb7
- Anima-Turbo https://pan.quark.cn/s/be6fa02634a1
- Krea-2-GGUF-Edit https://pan.quark.cn/s/5c4ab35f1e4e
- LTX-2.3-10Eros-V1.3 https://pan.quark.cn/s/2aedcb3b4707
- Boogu-Image-fix-4step https://pan.quark.cn/s/5a59d038eccc
