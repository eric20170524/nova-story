# ComfyUI 本地生图部署指南 (RTX 3060 12GB 专版)

为了让 NovaStory 在您的机器上能生成高质量的分镜图像，您需要在本地配置好 ComfyUI。本指南专为 RTX 3060 (12GB) 编写，后端已内置与之适配的自动模板注入。

## 1. 下载与运行 ComfyUI

1. 前往 [ComfyUI 官方 Releases](https://github.com/comfyanonymous/ComfyUI/releases) 下载最新的 **Portable 压缩包**（Windows 推荐）。
2. 解压到您剩余空间充裕的磁盘（如 `D:\ComfyUI_windows_portable`）。
3. 运行目录下的 `run_nvidia_gpu.bat` 启动。
4. 确保在浏览器中访问 `http://127.0.0.1:8188` 能够打开界面。

## 2. 下载推荐模型

系统默认配置为 **Pony XL**（生成动漫、插画风格极佳且速度快）。

### Pony V6 XL (默认支持)
1. 前往 Civitai 下载 [Pony Diffusion V6 XL](https://civitai.com/models/257749/pony-diffusion-v6-xl)。
2. 将下载的 `ponyDiffusionV6XL_v6StartWithThisOne.safetensors` 文件放入 ComfyUI 的 `models/checkpoints/` 目录下。

### Flux Dev GGUF (进阶支持)
如果您需要最高质量写实画面，可以使用 Flux GGUF。
1. 需要通过 ComfyUI Manager 安装 `ComfyUI-GGUF` 自定义节点（由 city96 开发）。
2. 前往 HuggingFace 下载 `flux1-dev-Q5_K_S.gguf`。将其放入 `models/unet/`。
3. 下载 `t5xxl_fp16.safetensors` 和 `clip_l.safetensors`，放入 `models/clip/`。
4. 下载 Flux VAE (`ae.safetensors`)，放入 `models/vae/`。
5. （可选）在系统的 `system_settings.json` 中配置 `default_workflow` 为 `flux_dev_gguf_12gb.json` 即可启用 Flux 流程。

## 3. 在 NovaStory 中对接

1. 保持 ComfyUI (即那个终端窗口) 一直处于运行状态，不要关闭。
2. 启动 NovaStory 后端：
   ```bash
   cd backend
   python -m venv venv
   .\venv\Scripts\activate
   pip install -r requirements.txt
   uvicorn app.main:app --reload
   ```
3. 在系统前端通过 Director Mode 的 "Generate Asset" 生成图像，您应该会看到 ComfyUI 终端里开始跑进度条，并在几秒到几十秒后将最终结果传回至 NovaStory 界面。

## FAQ

- **Q: 为什么生成的内容不是我想要的内容？**
  A: 后端会自动帮您进行 Prompt 和 Negative Prompt 的替换。确保您选对了角色或输入了更精确的场景描述。

- **Q: 遇到报错 “Workflow template ... not found” 怎么办？**
  A: 检查后端项目的 `backend/app/static/workflows/` 下是否存在 `pony_xl_12gb.json`，确保路径未发生改变。
