# NovaStory 本地语言模型部署说明

## 本机结论

本次部署以 `nvidia-smi` 的独显数据为准：

- Windows 11 专业版
- Intel Core i7-13620H，10 核 16 线程
- 16GB 系统内存
- NVIDIA GeForce RTX 4060 Laptop GPU，8188MiB 显存
- NVIDIA 驱动 596.49
- C 盘仅余约 16.7GB，D 盘余约 75.3GB
- ComfyUI 在加载生图模型后约占 5GB 显存

因此不采用 Docker、WSL 或同时常驻两个 GPU 模型。Ollama 使用 Windows 原生 CUDA
运行时，程序和模型均放在 D 盘；文本模型和 ComfyUI 通过启动脚本切换显存。

## 已选模型与运行参数

- 基础模型：`huihui_ai/qwen3-abliterated:8b-v2-q4_K_M`
- NovaStory 固定别名：`novastory-qwen3:8b`
- 权重量化：Q4_K_M，约 5.0GB
- 上下文：8192 tokens
- KV cache：q8_0
- Flash Attention：启用
- 并发：1
- 同时加载模型数：1
- 空闲保留：2 分钟，之后自动释放显存
- Ollama Cloud：禁用，确保请求只在本机执行
- 创作采样：temperature 0.85、top-p 0.92、top-k 40、min-p 0.05、
  repeat penalty 1.08
- 结构化输出：temperature 0.1、JSON Schema、关闭 thinking

8K 是这台 8GB 显存、16GB 内存机器的稳健起点。模型虽然支持更长上下文，但提升到
16K 或 32K 会增加 KV cache、首 token 延迟和内存压力，不适合作为默认值。

模型选择遵循 `docs/images.md` 对中文创作和低拒绝输出的优先级。官方
`qwen3.5:9b-q4_K_M` 约 6.6GB，通用能力更新，但在 8GB 显存上留给上下文和运行时的
余量更少，也不是低拒绝微调，因此没有设为本机默认模型。

## 安装位置

- Ollama 0.32.5：`D:\Program Files\Ollama`
- 模型缓存：`D:\ProgramData\Ollama\models`
- NovaStory 模型配置：`local-llm\Modelfile`
- 本机 API：`http://127.0.0.1:11434/v1`

API 只绑定回环地址，并显式设置 `OLLAMA_NO_CLOUD=1`；不应把 11434 端口暴露到
局域网或公网。NovaStory 使用 Ollama 的 OpenAI 兼容接口，API key 固定为占位值
`ollama`。

## 日常启动

### 文本创作模式

双击 `start_text_mode.bat`。脚本会：

1. 停止 8188 端口上的 ComfyUI，释放显存。
2. 以 8K、Flash Attention、q8 KV cache、单并发配置启动 Ollama。
3. 预热 `novastory-qwen3:8b`。
4. 启动 NovaStory 后端和前端，但不启动 ComfyUI。

只需要 LLM API、不需要启动 NovaStory 界面时，可双击 `start_local_llm.bat`。

### 生图模式

双击 `start_comfyui.bat`。`start_all.ps1` 会先卸载
`novastory-qwen3:8b`，再启动 ComfyUI。前后端已运行时，这相当于从文本模式切到
生图模式。

`stop_local_llm.bat` 只释放文本模型显存，`stop_comfyui.bat` 只停止 ComfyUI；
`stop_all.bat` 会停止 NovaStory、ComfyUI 和 Ollama 服务。

RTX 4060 8GB 不建议同时让 Qwen3-8B 和 **Pony / SDXL 生图**常驻显存。若在生图模式中调用
LLM，Ollama 可能部分回退到系统内存，速度会明显下降，也可能触发内存不足。
（本地生图默认已退役 FLUX.1-dev GGUF，见 `local_image_generation_deployment_cn.md`。）

## 配置与重新部署

本机实际配置写在被 Git 忽略的：

- `backend\.env`
- `backend\system_settings.json`

关键值为：

```dotenv
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=novastory-qwen3:8b
```

重新拉取或重建模型别名：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup_local_llm.ps1
```

`setup_local_llm.ps1` 可重复执行；Ollama 会复用已下载且校验通过的模型层。

## 验证

查看服务与已安装模型：

```powershell
& 'D:\Program Files\Ollama\ollama.exe' --version
& 'D:\Program Files\Ollama\ollama.exe' list
& 'D:\Program Files\Ollama\ollama.exe' ps
```

检查 OpenAI 兼容接口：

```powershell
$body = @{
  model = 'novastory-qwen3:8b'
  messages = @(@{ role = 'user'; content = '只回复：NOVASTORY_OK' })
  reasoning_effort = 'none'
  max_tokens = 16
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:11434/v1/chat/completions' `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body
```

NovaStory 设置页的“验证连接”现在会执行真实推理，不再返回模拟成功。

## 本机验收结果

2026-07-28 实测：

- Ollama：0.32.5，Windows 可执行文件签名有效，签发者为 Ollama Inc.
- 模型 ID：`409cae59e435`
- 上下文：8192
- 处理器：100% GPU
- 模型加载后显存：5277MiB / 8188MiB，剩余约 2680MiB
- 冷加载：约 19 秒
- 热启动中文生成：约 47 tokens/s
- 95 个输出 token 的实测墙钟时间：约 2.55 秒
- OpenAI 兼容聊天接口：通过
- JSON Schema 结构化输出：通过
- NovaStory `LLMService.generateTimeline` 实际分镜生成：通过
- 设置页 `/verify-llm` 真实推理验证：HTTP 200
- `stop_local_llm.ps1`：可将 Ollama GPU 占用释放到 0MiB

## 维护与可选升级

- Ollama 官方 Windows 文档：
  <https://docs.ollama.com/windows>
- Ollama OpenAI 兼容接口：
  <https://docs.ollama.com/api/openai-compatibility>
- Flash Attention 与 KV cache：
  <https://docs.ollama.com/faq>
- 基础模型说明：
  <https://huggingface.co/huihui-ai/Huihui-Qwen3-8B-abliterated-v2>
- Ollama 模型标签：
  <https://ollama.com/huihui_ai/qwen3-abliterated/tags>

若后续把系统内存升级到 32GB、显存升级到 12GB 以上，可再评估 12B/14B Q4_K_M
模型或 16K 上下文。当前硬件上，优先升级上下文或改装 9B 模型都应先做实际显存、
首 token 延迟和结构化输出成功率测试。

该模型为社区低拒绝衍生模型。仅应用于合法的成人虚构创作，不生成涉及未成年人、
非自愿行为或其他违法内容；对外发布前仍需人工审阅。
