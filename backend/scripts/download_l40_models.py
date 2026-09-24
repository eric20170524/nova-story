#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NovaStory - L40 ComfyUI Model Downloader
Supports resume, retry, domestic mirror (hf-mirror.com), and target groups.
Usage:
    python3 download_l40_models.py [--dest /opt/ai/ComfyUI] [--target all|pony|autismmix|animagine|tier_b] [--official]
"""

import os
import sys
import argparse
import urllib.request
import urllib.error
import time

MODELS = [
    {
        "category": "vae",
        "subpath": "models/vae/sdxl_vae.safetensors",
        "desc": "SDXL 官方修复版 VAE",
        "hf_repo": "stabilityai/sdxl-vae",
        "hf_file": "sdxl_vae.safetensors",
        "targets": ["all", "pony", "autismmix", "animagine"]
    },
    {
        "category": "checkpoints",
        "subpath": "models/checkpoints/ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
        "desc": "Pony Diffusion V6 XL 官方底模 (~6.46GB)",
        "hf_repo": "LyliaEngine/Pony_Diffusion_V6_XL",
        "hf_file": "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
        "targets": ["all", "pony"]
    },
    {
        "category": "checkpoints",
        "subpath": "models/checkpoints/autismmixSDXL_autismmixPony.safetensors",
        "desc": "AutismMix SDXL Pony 版底模 (~6.46GB)",
        "hf_repo": "hitb0y/autismmixSDXL_autismmixPony",
        "hf_file": "autismmixSDXL_autismmixPony.safetensors",
        "targets": ["all", "autismmix"]
    },
    {
        "category": "checkpoints",
        "subpath": "models/checkpoints/animagine-xl-4.0-opt.safetensors",
        "desc": "Animagine XL 4.0 Opt 日漫画风底模 (~6.46GB)",
        "hf_repo": "cagliostrolab/animagine-xl-4.0",
        "hf_file": "animagine-xl-4.0-opt.safetensors",
        "targets": ["all", "animagine"]
    },
    {
        "category": "ipadapter",
        "subpath": "models/ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors",
        "desc": "IP-Adapter Plus SDXL (角色锁定)",
        "hf_repo": "h94/IP-Adapter",
        "hf_file": "sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors",
        "targets": ["all", "tier_b"]
    },
    {
        "category": "clip_vision",
        "subpath": "models/clip_vision/clip_vision_g.safetensors",
        "desc": "CLIP Vision ViT-bigG Encoder",
        "hf_repo": "h94/IP-Adapter",
        "hf_file": "models/image_encoder/model.safetensors",
        "targets": ["all", "tier_b"]
    },
    {
        "category": "controlnet",
        "subpath": "models/controlnet/OpenPoseXL2.safetensors",
        "desc": "ControlNet OpenPose XL (姿势构图)",
        "hf_repo": "thibaud/controlnet-openpose-sdxl-1.0",
        "hf_file": "OpenPoseXL2.safetensors",
        "targets": ["all", "tier_b"]
    }
]

def download_with_resume(url: str, output_path: str, desc: str):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temp_path = output_path + ".part"
    existing_size = os.path.getsize(temp_path) if os.path.exists(temp_path) else 0

    if os.path.exists(output_path) and os.path.getsize(output_path) > 10 * 1024 * 1024:
        print(f"✅ 已存在完整文件: {output_path} ({os.path.getsize(output_path) / 1024 / 1024:.1f} MB)，跳过。")
        return True

    print(f"\n⬇️  开始下载: {desc}")
    print(f"    来源: {url}")
    print(f"    目标: {output_path}")

    req = urllib.request.Request(url, headers={"User-Agent": "NovaStory-Downloader/1.0"})
    if existing_size > 0:
        req.add_header("Range", f"bytes={existing_size}-")
        print(f"    断点续传: 已完成 {existing_size / 1024 / 1024:.1f} MB")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            total_size = existing_size
            content_length = resp.headers.get("Content-Length")
            if content_length:
                total_size += int(content_length)

            mode = "ab" if existing_size > 0 else "wb"
            start_time = time.time()
            downloaded = existing_size

            with open(temp_path, mode) as f:
                while True:
                    chunk = resp.read(1024 * 1024) # 1MB buffer
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    elapsed = time.time() - start_time
                    speed = (downloaded - existing_size) / (elapsed + 0.001) / 1024 / 1024
                    percent = (downloaded / total_size * 100) if total_size > 0 else 0
                    sys.stdout.write(f"\r    进度: {downloaded/1024/1024:.1f}MB / {total_size/1024/1024:.1f}MB ({percent:.1f}%) - {speed:.2f} MB/s")
                    sys.stdout.flush()

            print()
            os.replace(temp_path, output_path)
            print(f"✅ 下载成功: {desc}")
            return True
    except Exception as e:
        print(f"\n❌ 下载失败: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="NovaStory Remote L40 ComfyUI Model Downloader")
    parser.add_argument("--dest", default="/opt/ai/ComfyUI", help="ComfyUI install path (default: /opt/ai/ComfyUI)")
    parser.add_argument("--target", default="all", choices=["all", "pony", "autismmix", "animagine", "tier_b"], help="Model group")
    parser.add_argument("--official", action="store_true", help="Use official huggingface.co instead of hf-mirror.com")
    args = parser.parse_args()

    hf_base = "https://huggingface.co" if args.official else "https://hf-mirror.com"
    print("=" * 60)
    print(f"🚀 NovaStory L40 模型批量下载工具")
    print(f"📂 根目录: {args.dest}")
    print(f"🎯 任务目标: {args.target}")
    print(f"🌐 镜像源: {hf_base}")
    print("=" * 60)

    selected = [m for m in MODELS if args.target in m["targets"]]
    for item in selected:
        url = f"{hf_base}/{item['hf_repo']}/resolve/main/{item['hf_file']}"
        dest_path = os.path.join(args.dest, item["subpath"])
        download_with_resume(url, dest_path, item["desc"])

    print("\n" + "=" * 60)
    print("🎉 所有目标模型下载流程处理完毕！")
    print("=" * 60)

if __name__ == "__main__":
    main()
