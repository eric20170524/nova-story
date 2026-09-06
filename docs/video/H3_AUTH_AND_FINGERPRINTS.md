# 红潮 Hybrid H3 A2A 模型指纹与授权清单 (G0)

> 状态：本机技术实验与指纹归档
> 更新日期：2026-09-06
> 基准硬件：RTX 3060 12GB + 32GB RAM + NVMe

## 1. 核心模型与权重清单

| 组件 | 精确文件名 / 标识 | 格式 / 量化 | 来源 / 许可声明 |
|---|---|---|---|
| Diffusion Base | minimax_h3_ref2va_pruned_int8_convrot.safetensors | Pruned INT8 ConvRot | MiniMax / Apache-2.0 衍生研究，仅限本机 |
| Diffusion T2V/I2V | minimax_h3_fl2va_pruned_int8_convrot.safetensors | Pruned INT8 ConvRot | MiniMax / 开源研究版 |
| Text Encoder | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | NVFP4 / AWQ INT8 | Qwen / Tongyi 许可 + ComfyOrg 转换 |
| Video VAE | minimax_h3_video_vae_fp16.safetensors | FP16 | MiniMax H3 原生 Video VAE |
| Audio VAE | minimax_h3_audio_vae_fp32.safetensors | FP32 | 原生音频解码器 |

## 2. 授权门禁 (Gate G0)

- 本机运行红潮 H3 A2A 属于内部研发实验与验证阶段。
- 视频资产生成管线默认设置 video_generation.enabled = false 特性开关。
