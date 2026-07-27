#!/usr/bin/env python3
"""
NovaStory - Automatic Recommended NSFW LoRA Downloader
Downloads recommended LoRA models for Pony XL and FLUX.1-dev GGUF.
Supports Civitai API tokens and direct browser link fallbacks.

Usage:
    python scripts/download_recommended_loras.py -o "D:/ComfyUI/models/loras" [--token YOUR_CIVITAI_TOKEN]
"""

import os
import sys
import argparse
import urllib.request
import urllib.error

RECOMMENDED_LORAS = [
    {
        "category": "Pony XL",
        "name": "Pony Detail Tweaker",
        "filename": "Pony_Detail_Tweaker.safetensors",
        "urls": [
            "https://civitai.com/api/download/models/310841",
            "https://huggingface.co/Shakker-Labs/SDXL-LoRA/resolve/main/Pony_Detail_Tweaker.safetensors"
        ],
        "civitai_page": "https://civitai.com/models/310841",
        "description": "Increases detail, lines, and shading without distorting anatomy (Weight: 0.6-1.0)"
    },
    {
        "category": "Pony XL",
        "name": "Incase Style [PonyXL]",
        "filename": "Incase_Style_PonyXL.safetensors",
        "urls": [
            "https://civitai.com/api/download/models/350000",
            "https://civitai.com/api/download/models/330541"
        ],
        "civitai_page": "https://civitai.com/models/330541",
        "description": "Western/Comic style NSFW LoRA (Weight: 0.4-0.6)"
    },
    {
        "category": "Pony XL",
        "name": "ExpressiveH (Hentai Style)",
        "filename": "ExpressiveH_PonyXL.safetensors",
        "urls": [
            "https://civitai.com/api/download/models/300123",
            "https://civitai.com/api/download/models/340000"
        ],
        "civitai_page": "https://civitai.com/models/300123",
        "description": "Classic Hentai style reference, trigger: Expressiveh (Weight: 0.4-0.6)"
    },
    {
        "category": "FLUX.1-dev",
        "name": "aidmaNSFWunlock",
        "filename": "aidmaNSFWunlock.safetensors",
        "urls": [
            "https://civitai.com/api/download/models/652699",
            "https://civitai.com/api/download/models/692795"
        ],
        "civitai_page": "https://civitai.com/models/652699",
        "description": "FLUX NSFW unlocker (~19MB), trigger: aidmaNSFWunlock (Weight: 0.7-0.8)"
    },
    {
        "category": "FLUX.1-dev",
        "name": "XLabs Flux Realism",
        "filename": "XLabs_Flux_Realism.safetensors",
        "urls": [
            "https://huggingface.co/XLabs-AI/flux-RealismLora/resolve/main/lora.safetensors",
            "https://civitai.com/api/download/models/638960",
            "https://huggingface.co/XLabs-AI/flux-lora-collection/resolve/main/flux_realism_lora.safetensors"
        ],
        "civitai_page": "https://civitai.com/models/638960",
        "description": "Enhances skin texture and photo realism for FLUX (Weight: 0.6-1.0)"
    }
]

def download_file(urls, output_path, civitai_token=None):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    for idx, url in enumerate(urls):
        target_url = url
        if civitai_token and "civitai.com" in url:
            sep = "&" if "?" in url else "?"
            target_url = f"{url}{sep}token={civitai_token}"

        print(f"  Attempting source {idx + 1}/{len(urls)}: {url[:60]}...")
        req = urllib.request.Request(target_url, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=30) as response, open(output_path, 'wb') as out_file:
                total_size = int(response.headers.get('content-length', 0))
                downloaded = 0
                block_size = 16384

                while True:
                    buffer = response.read(block_size)
                    if not buffer:
                        break
                    out_file.write(buffer)
                    downloaded += len(buffer)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        mb_downloaded = downloaded / (1024 * 1024)
                        mb_total = total_size / (1024 * 1024)
                        sys.stdout.write(f"\r  Progress: {percent:.1f}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)")
                        sys.stdout.flush()

            # Sanity check: Ensure downloaded file is valid (> 50KB)
            if os.path.exists(output_path) and os.path.getsize(output_path) > 50 * 1024:
                print("\n  [Success] Downloaded successfully!")
                return True
            else:
                if os.path.exists(output_path):
                    os.remove(output_path)
                print("\n  [Warning] Downloaded file was too small or invalid.")
        except urllib.error.HTTPError as he:
            print(f"\n  [HTTP Error {he.code}] {he.reason}")
        except Exception as e:
            print(f"\n  [Error] Failed to fetch: {e}")

    return False

def main():
    parser = argparse.ArgumentParser(description="Download recommended NSFW LoRAs for NovaStory")
    parser.add_argument(
        "-o", "--output-dir",
        default=os.path.join(os.getcwd(), "models", "loras"),
        help="Path to ComfyUI models/loras directory (default: ./models/loras)"
    )
    parser.add_argument(
        "-t", "--token",
        default=os.getenv("CIVITAI_TOKEN", ""),
        help="Optional Civitai API Key token for downloading age-restricted NSFW models"
    )
    args = parser.parse_args()

    target_dir = os.path.abspath(args.output_dir)
    os.makedirs(target_dir, exist_ok=True)

    print("=========================================================")
    print(" NovaStory - Recommended NSFW LoRA Installer")
    print(f" Target Directory: {target_dir}")
    if args.token:
        print(" Civitai API Token: Enabled (Auth active)")
    else:
        print(" Civitai API Token: Not provided (Using public endpoints)")
    print("=========================================================\n")

    success_count = 0
    skipped_count = 0
    failed_items = []

    for item in RECOMMENDED_LORAS:
        file_path = os.path.join(target_dir, item["filename"])
        print(f"[{item['category']}] {item['name']} ({item['filename']})")
        print(f"  Description: {item['description']}")

        if os.path.exists(file_path) and os.path.getsize(file_path) > 50 * 1024:
            print("  [Skipped] File already exists and valid.")
            skipped_count += 1
            print("-" * 55)
            continue

        ok = download_file(item["urls"], file_path, args.token)
        if ok:
            success_count += 1
        else:
            failed_items.append(item)
            print(f"  [Manual Action Needed] Web Page: {item['civitai_page']}")
        print("-" * 55)

    print("\n=========================================================")
    print(f" Summary: Downloaded: {success_count}, Skipped: {skipped_count}, Failed/Manual: {len(failed_items)}")
    print("=========================================================")

    if failed_items:
        print("\n💡 Note for items requiring Civitai Login (HTTP 401/404):")
        print("Civitai requires account authentication for downloading NSFW models via script API.")
        print("You can get a free API Token in your Civitai Account Settings (Account Settings -> API Keys), then run:")
        print(f'  python scripts/download_recommended_loras.py -o "{target_dir}" --token YOUR_CIVITAI_TOKEN\n')
        print("Or click the direct links below to download manually in your browser and place into D:\\ComfyUI\\models\\loras:")
        for item in failed_items:
            print(f"  - {item['name']} ({item['filename']}): {item['civitai_page']}")

if __name__ == "__main__":
    main()
