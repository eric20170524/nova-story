**“全能型 AI 短剧引擎” 最佳实践实施方案 (NovaStory MVP)**

---

### 第一步：明确核心价值主张 (Core Philosophy)

基于表格分析，新项目应定位为 **“可控性叙事视频引擎”**。

*   **摒弃：** 纯随机生成的粗糙感（黑盒模式）。
*   **保留：** 一键生成的便捷性（同时也支持一键流）。
*   **增加：**
    *   **深度可控：** 对分镜脚本（Script）、角色一致性（Consistency）的完全干预能力。
    *   **专业工作流：** 深度集成 **ComfyUI**，而非简单的 API 调用。

---

### 第二步：技术架构选型 (Tech Stack)

为了保证扩展性和性能，采用 **前后端分离 + 异步任务队列 + 工作流编排** 的架构：

| 模块 | 建议技术栈                 | 理由 |
| :--- |:----------------------| :--- |
| **前端 (Frontend)** | **Vite + React** | 构建复杂的交互界面（分镜编辑器、时间轴），生态最成熟。 |
| **后端 (Backend)** | **FastAPI (Python)**  | 高性能异步框架。数据库：**MySQL 8.0** (Docker部署，支持高并发任务状态读写)。 |
| **任务队列** | **FastAPI BackgroundTasks + Redis**    | 视频生成是长耗时任务，必须异步处理，支持批量并发。 |
| **图像/视频生成** | **ComfyUI (Service)** | **核心引擎。** 不写死 `diffusers` 代码。后端只负责发送 Workflow JSON 到 ComfyUI 实例，通过 WebSocket 监听进度。 |
| **大模型 (LLM)** | **LangChain**         | 用于处理剧本拆解、分镜描述优化。 |
| **合成引擎** | **FFmpeg / MoviePy**  | 基于 **Timeline DSL** 进行视频拼接、音画对齐。 |

#### 核心分层设计

**Layer 0：导演中枢 (The Director)**
*   **职责**：不处理具体媒体，只处理 **结构化数据 (JSON)**。
*   **流程**：`Idea` -> `Story Structure` -> `Review` -> `Shot List` -> `Review` -> `Production`.
*   **数据结构**：所有下游模块只认标准化的 JSON 指令。

**Layer 1：脚本 & 叙事引擎**
*   **策略**：分阶段生成。
    1.  **Story Spine**: 故事大纲。
    2.  **Shot Script**: 分镜脚本（含 Prompt、旁白、时长）。
*   **可控性**：在此层引入 **"Human-in-the-loop"**。用户在生成视频前，必须确认分镜脚本。

**Layer 2：素材生成层 (ComfyUI Gateway)**
*   **策略**：**Asset Provider Interface**。
*   **实现**：
    *   封装 ComfyUI API (`/prompt`, `/history`, `/view`).
    *   维护一套 `Workflow Templates` (e.g., `flux_dev_lora.json`, `sdxl_lightning.json`).
    *   支持动态替换节点参数（Seed, Prompt, Aspect Ratio）。

**Layer 3：配音 / 音乐**
*   **升级**：增加 **"Force Alignment" (强制对齐)**。
*   根据 TTS 生成的音频时长，反向计算视频片段需要的时长（Loop 或 变速）。

**Layer 4：剪辑 & 合成引擎**
*   **核心设计**：**Timeline DSL** (提前定义)。
*   后端生成器不直接调 FFmpeg，而是输出一个 Timeline JSON：
    ```json
    {
      "project_settings": { "width": 1080, "height": 1920, "fps": 30 },
      "tracks": [
        {
          "type": "video",
          "clips": [
             { "asset_id": "v1.mp4", "start": 0, "duration": 3.5, "effect": "zoom_in" }
          ]
        },
        {
          "type": "audio",
          "clips": [ ... ]
        }
      ]
    }
    ```

---

### 第三步：功能模块融合策略 (Feature Integration)

#### 1. 剧本与分镜 (The Brain)
*   **参考**：`huobao-drama` (Web管理) + `ai_story` (分镜拆解)。
*   **实施**：
    *   **Prompt Consistency**：在 MVP 阶段，通过 LLM 强制为每个分镜注入固定的角色 Tag（如：`masterpiece, best quality, (character:1.2), [features: red cap, blue jacket]`）。

#### 2. 视觉生成 (The Eye) - ComfyUI Native
*   **参考**：`Pixelle-Video`。
*   **实施**：
    *   后端加载 ComfyUI 的 JSON 工作流文件。
    *   通过 Python 脚本解析 JSON，找到 `KSampler` 的 Seed 和 `CLIP Text Encode` 的 Text 节点进行动态替换。

---

### 第四步：开发路线图 (Roadmap)

#### Phase 1: 核心链路跑通与验证 (Verified MVP)

**目标**：输入一段话 -> **确认分镜(JSON/Simple UI)** -> 调用 ComfyUI -> 输出视频。

1.  **基础设施 (Infrastructure)**:
    *   搭建 Docker 环境：MySQL 8.0, Redis, ComfyUI, FastAPI。
    *   初始化数据库 Schema (Projects, Scripts, Assets, Tasks)。
2.  **后端核心 (Backend Core)**:
    *   实现 **ComfyUI Client**：负责发送 Prompt Payload，通过 WebSocket 监听生成状态，下载生成的图片/视频。
    *   实现 **Script Engine**：LLM 拆解 Story -> JSON。
3.  **交互验证 (Interactivity)**:
    *   开发一个简单的 API/界面，允许用户**查看并修改** LLM 生成的分镜 JSON（修改 Prompt 或 旁白）后再触发生成。
    *   *验证点：用户是否愿意为了质量干预生成过程？*
4.  **合成 (Compositing)**:
    *   基于简单的 Timeline DSL 实现 MoviePy 拼接。
5.  **一致性 (Consistency v0.1)**:
    *   在 Prompt 层面硬编码角色特征，测试稳定性。

#### Phase 2: 增强可控性 (The "Pro" Editor)

1.  **可视化分镜编辑器**：将 Phase 1 的 JSON 编辑器升级为卡片式 UI（参考 Storyboarder）。
2.  **高级 ComfyUI 集成**：
    *   支持用户上传自定义 ComfyUI 工作流（.json）。
    *   支持 ControlNet 姿态控制（上传参考图）。
3.  **角色训练**：集成 FaceID 或 简易 LoRA 训练流程。

#### Phase 3: 商业化与规模化

1.  **分布式渲染**：ComfyUI 集群管理。
2.  **插件系统**：TTS、LLM 插件化。

---

### 第五步：关键差异化亮点 (The "Killer Feature")

> **"Interactive Storyboard (交互式分镜)"**

你的核心壁垒不是“生成视频”，而是 **“生成视频前的那一刻”**。
大多数产品：Input -> (Wait 5 mins) -> Bad Video -> Retry.
NovaStory：Input -> **Script Review (修改 Prompt/角色)** -> (Wait 5 mins) -> Better Video.
