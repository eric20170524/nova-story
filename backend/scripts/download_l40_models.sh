#!/usr/bin/env bash
# ==============================================================================
# 算力机 L40 ComfyUI 模型一键下载脚本
# 支持断点续传、hf-mirror 国内高速镜像、aria2c 多线程下载
#
# 使用方法:
#   bash download_l40_models.sh [COMFY_DIR] [TARGET]
#
# 参数说明:
#   COMFY_DIR: ComfyUI 根目录，默认为 /opt/ai/ComfyUI
#   TARGET:
#     all       - 下载所有模型 (默认)
#     pony      - 方案 1: Pony Diffusion V6 XL + Detail LoRA + VAE
#     autismmix - 方案 2: AutismMix SDXL (Pony版)
#     animagine - 方案 3: Animagine XL 4.0 Opt
#     tier_b    - Tier B 角色一致性组件 (IP-Adapter + CLIP Vision + ControlNet OpenPose)
#
# 环境变量:
#   HF_MIRROR=1 (默认启用国内镜像 https://hf-mirror.com，设置为 0 则使用官方 huggingface.co)
# ==============================================================================

set -euo pipefail

COMFY_ROOT="${1:-/opt/ai/ComfyUI}"
TARGET="${2:-all}"
USE_MIRROR="${HF_MIRROR:-1}"

if [ "$USE_MIRROR" = "1" ]; then
    HF_BASE="https://hf-mirror.com"
    echo "⚡ 已启用国内高速镜像: $HF_BASE"
else
    HF_BASE="https://huggingface.co"
    echo "🌐 使用 Hugging Face 官方源: $HF_BASE"
fi

echo "=========================================================="
echo "🎯 ComfyUI 目标目录: $COMFY_ROOT"
echo "📦 下载模式: $TARGET"
echo "=========================================================="

# 确保目录存在
mkdir -p "$COMFY_ROOT/models/checkpoints"
mkdir -p "$COMFY_ROOT/models/loras"
mkdir -p "$COMFY_ROOT/models/vae"
mkdir -p "$COMFY_ROOT/models/ipadapter"
mkdir -p "$COMFY_ROOT/models/clip_vision"
mkdir -p "$COMFY_ROOT/models/controlnet"

download_file() {
    local url="$1"
    local dest="$2"
    local desc="$3"

    echo ""
    echo "----------------------------------------------------------"
    echo "⬇️  正在下载: $desc"
    echo "    URL:  $url"
    echo "    目标: $dest"
    echo "----------------------------------------------------------"

    if [ -f "$dest" ] && [ -s "$dest" ]; then
        local size
        size=$(stat -c%s "$dest" 2>/dev/null || stat -f%z "$dest" 2>/dev/null || echo 0)
        # 如果文件大小大于 50MB，假定已基本完成或支持续传
        if [ "$size" -gt 52428800 ]; then
            echo "ℹ️  已存在有效文件 (大小: $((size / 1024 / 1024)) MB)，检查续传..."
        fi
    fi

    if command -v aria2c &>/dev/null; then
        aria2c -c -x 16 -s 16 -k 2M --check-certificate=false \
            -d "$(dirname "$dest")" -o "$(basename "$dest")" "$url"
    elif command -v wget &>/dev/null; then
        wget -c -O "$dest" --no-check-certificate "$url"
    elif command -v curl &>/dev/null; then
        curl -C - -L -k -o "$dest" "$url"
    else
        echo "❌ 错误: 系统中未找到 aria2c / wget / curl，无法下载" >&2
        return 1
    fi

    echo "✅ 完成: $desc"
}

# 1. SDXL VAE (通用修复)
if [ "$TARGET" = "all" ] || [ "$TARGET" = "pony" ] || [ "$TARGET" = "autismmix" ] || [ "$TARGET" = "animagine" ]; then
    download_file \
        "$HF_BASE/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors" \
        "$COMFY_ROOT/models/vae/sdxl_vae.safetensors" \
        "SDXL 官方修复版 VAE (sdxl_vae.safetensors)"
fi

# 2. 方案 1: Pony Diffusion V6 XL
if [ "$TARGET" = "all" ] || [ "$TARGET" = "pony" ]; then
    download_file \
        "$HF_BASE/LyliaEngine/Pony_Diffusion_V6_XL/resolve/main/v6_start_with_this_one.safetensors" \
        "$COMFY_ROOT/models/checkpoints/ponyDiffusionV6XL_v6StartWithThisOne.safetensors" \
        "Pony Diffusion V6 XL 官方底模 (~6.46GB)"

    download_file \
        "$HF_BASE/Linaqruf/animagine-xl-2.0/resolve/main/Pony_DetailV2.0.safetensors" \
        "$COMFY_ROOT/models/loras/Pony_DetailV2.0.safetensors" \
        "Pony Detailer 细节增强 LoRA (Pony_DetailV2.0.safetensors)"
fi

# 3. 方案 2: AutismMix SDXL (Pony 版)
if [ "$TARGET" = "all" ] || [ "$TARGET" = "autismmix" ]; then
    download_file \
        "$HF_BASE/stablediffusionapi/autismmix-sdxl-pony/resolve/main/autismmixSDXL_autismmixPony.safetensors" \
        "$COMFY_ROOT/models/checkpoints/autismmixSDXL_autismmixPony.safetensors" \
        "AutismMix SDXL Pony 版底模 (~6.46GB)"
fi

# 4. 方案 3: Animagine XL 4.0 Opt
if [ "$TARGET" = "all" ] || [ "$TARGET" = "animagine" ]; then
    download_file \
        "$HF_BASE/cagliostrolab/animagine-xl-4.0/resolve/main/animagine-xl-4.0-opt.safetensors" \
        "$COMFY_ROOT/models/checkpoints/animagine-xl-4.0-opt.safetensors" \
        "Animagine XL 4.0 Opt 日漫画风底模 (~6.46GB)"
fi

# 5. Tier B 角色一致性组件 (IP-Adapter + ControlNet)
if [ "$TARGET" = "all" ] || [ "$TARGET" = "tier_b" ]; then
    download_file \
        "$HF_BASE/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors" \
        "$COMFY_ROOT/models/ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors" \
        "IP-Adapter Plus SDXL (角色面容与服饰锁定)"

    download_file \
        "$HF_BASE/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors" \
        "$COMFY_ROOT/models/clip_vision/clip_vision_g.safetensors" \
        "CLIP Vision 大模型 (ViT-bigG / G Encoder)"

    download_file \
        "$HF_BASE/thibaud/controlnet-openpose-sdxl-1.0/resolve/main/OpenPoseXL2.safetensors" \
        "$COMFY_ROOT/models/controlnet/OpenPoseXL2.safetensors" \
        "ControlNet OpenPose XL (姿势与构图控制)"
fi

echo ""
echo "=========================================================="
echo "🎉 下载任务完成！"
echo "可在 ComfyUI 界面点击 Refresh，或重启 ComfyUI 服务加载新模型。"
echo "=========================================================="
