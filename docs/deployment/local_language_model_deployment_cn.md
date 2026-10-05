# NovaStory 本地语言模型部署说明

## 本机结论

本次部署以 `nvidia-smi` 的独显数据为准。本机 GPU 是 **NVIDIA GeForce RTX 3060（12GB）**：

- Windows 11
- NVIDIA GeForce RTX 3060，12288MiB 显存
- NVIDIA 驱动 596.36，CUDA 13.2（llama.cpp 使用 CUDA 12.4 运行时）
- 程序和模型均放在 D 盘
- 文本模型和 ComfyUI 通过启动脚本切换显存，避免双模型同时常驻

因此不采用 Docker、WSL 或同时常驻两个 GPU 模型。推理引擎为 **llama.cpp**
（`llama-server` 的 OpenAI 兼容接口），不再使用 Ollama。

## 已选模型与运行参数

- 基础模型：`huihui-ai/Huihui-Qwen3.5-9B-abliterated`
- GGUF：`mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF` 的 `Q4_K_M`
- NovaStory 固定别名：`novastory-qwen3.5:9b`
- 权重量化：Q4_K_M，约 5.6GB
- 上下文：16384 tokens（12GB 显存默认；8K 是旧 8GB 机器的取值）
- KV cache：q8_0
- Flash Attention：启用
- GPU 层：全部（`-ngl 99`）
- 并发：1
- 思考链：关闭（`--reasoning off`）
- 创作采样：temperature 0.85、top-p 0.92、top-k 40、min-p 0.05、
  repeat penalty 1.08
- 结构化输出：temperature 0.1、JSON Schema

16K 是这张 12GB 卡上的默认上下文。Q4_K_M 约占用 6.2GB 显存（8K 实测），16K 会再增加 KV cache，仍留出生图切换余量。32K 会明显抬高首 token 延迟，不作为默认值。

模型选择遵循中文创作和低拒绝输出的优先级。该权重是 Qwen3.5-9B 的 abliterated
衍生，用于合法成人虚构创作。

## 安装位置

- llama.cpp `b11390` CUDA 12.4：`D:\llama.cpp`
- 模型文件：`D:\ProgramData\NovaStory\models\Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf`
- 聊天模板参数：`local-llm\chat-template-kwargs.json`
- 本机 API：`http://127.0.0.1:11434/v1`

API 只绑定回环地址；不应把 11434 端口暴露到局域网或公网。NovaStory 使用
llama.cpp 的 OpenAI 兼容接口，API key 固定为占位值 `ollama`。

本机若仍安装 Ollama 托盘应用，它会抢占 11434 端口。`start_local_llm.ps1`
会先结束 `ollama.exe` / `ollama app`，再启动 llama.cpp。日常请关掉 Ollama
托盘，避免它自动拉起旧的 `novastory-qwen3:8b`。

## 日常启动

### 文本创作模式

双击 `start_text_mode.bat`。脚本会：

1. 停止 8188 端口上的 ComfyUI，释放显存。
2. 以 16K、Flash Attention、q8 KV cache、单并发配置启动 `llama-server`。
3. 预热 `novastory-qwen3.5:9b`。
4. 启动 NovaStory 后端和前端，但不启动 ComfyUI。

只需要 LLM API、不需要启动 NovaStory 界面时，可双击 `start_local_llm.bat`。

### 生图模式

双击 `start_comfyui.bat`。`start_all.ps1` 会先停止 llama.cpp，再启动 ComfyUI。
前后端已运行时，这相当于从文本模式切到生图模式。

`stop_local_llm.bat` 只释放文本模型显存，`stop_comfyui.bat` 只停止 ComfyUI；
`stop_all.bat` 会停止 NovaStory、ComfyUI 和 llama.cpp 服务。

12GB 上 Qwen3.5-9B Q4_K_M 约 6GB，Pony / SDXL 再吃 5GB 以上。生图前仍应释放 LLM
显存。设置页顶部的显存指示灯可以一键释放。

## 配置与重新部署

本机实际配置写在被 Git 忽略的：

- `backend\.env`
- `backend\system_settings.json`

关键值为：

```dotenv
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=novastory-qwen3.5:9b
```

`LLM_PROVIDER=ollama` 在 NovaStory 里表示「本地 OpenAI 兼容接口」，实际后端是
llama.cpp。`local_llm` 作为同一类提供方也能用。

重新下载二进制或模型：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup_local_llm.ps1
```

`setup_local_llm.ps1` 可重复执行；已存在且完整的 llama.cpp 与 GGUF 会被跳过。

## 验证

查看服务：

```powershell
Invoke-RestMethod http://127.0.0.1:11434/v1/models
```

检查 OpenAI 兼容接口：

```powershell
$body = @{
  model = 'novastory-qwen3.5:9b'
  messages = @(@{ role = 'user'; content = '只回复：NOVASTORY_OK' })
  max_tokens = 16
  chat_template_kwargs = @{ enable_thinking = $false }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:11434/v1/chat/completions' `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body
```

NovaStory 设置页的“验证连接”会执行真实推理。

## 本机验收结果

2026-10-04 实测（RTX 3060 12GB）：

- llama.cpp：b11390，Windows CUDA 12.4
- 模型：Huihui Qwen3.5-9B abliterated Q4_K_M（约 5.24GB）
- 别名：`novastory-qwen3.5:9b`
- 上下文：16384（由 8K 上调，匹配 12GB 显存）
- 冷加载：约 3.4 秒
- 热启动生成：约 42–50 tokens/s
- 模型加载后整卡显存：6416MiB / 12288MiB（16K 上下文）
- OpenAI 兼容聊天接口：`NOVASTORY_OK` 通过
- JSON Schema 结构化输出：通过
- `stop_local_llm.ps1`：结束 llama-server，释放 11434 端口

## 维护与参考

- llama.cpp 发行页：
  <https://github.com/ggml-org/llama.cpp/releases>
- llama.cpp OpenAI 兼容接口：
  <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
- 基础模型：
  <https://huggingface.co/huihui-ai/Huihui-Qwen3.5-9B-abliterated>
- GGUF：
  <https://huggingface.co/mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF>

该模型为社区低拒绝衍生模型。仅应用于合法的成人虚构创作，不生成涉及未成年人、
非自愿行为或其他违法内容；对外发布前仍需人工审阅。
