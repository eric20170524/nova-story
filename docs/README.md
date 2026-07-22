# NovaStory (NovaStory MVP)

#### 介绍
**NovaStory** 是一个**可控性叙事视频引擎**，旨在通过 "Human-in-the-loop"（人机交互）的方式，将剧本转化为高质量的视频分镜与最终成片。

本项目目前处于 MVP（最小可行性产品）阶段，核心实现了 **"主编级 OS" (Director OS)** 架构，允许用户通过自然语言指令（Agent）深度干预故事结构、内容创作以及视觉生成流程。

#### 软件架构

本项目采用前后端分离架构：

*   **Frontend (导演台)**: Vite + React + TypeScript + TailwindCSS.
    *   集成 Agent 对话侧边栏 (`AgentSidebar`)。
    *   实现 Zod 协议层，确保 AI 指令的安全执行（如删除章节需二次确认）。引入 Zod Schema 验证和重试循环
*   **Backend (引擎核心)**: FastAPI (Python) + SQLAlchemy (SQLite/MySQL).
    *   提供结构化数据管理（Project, Chapter, Character）。
    *   通过 JSON Schema（或 OpenAPI 3.0 兼容 schema）来生成受控结构化响应（即 Native Structured Output）
    *   集成 LLM 接口用于剧本生成与分析。
    *   集成 WebSocket 客户端连接本地 ComfyUI 实例。
*   **Visual Generation (视觉皮层)**: ComfyUI (Local Instance).
    *   通过 WebSocket 接收 Workflow JSON 并生成图像/视频。

#### 快速启动部署 (Deployment Guide)

##### 1. 环境准备 (Prerequisites)
*   **Python**: 3.10 或更高版本
*   **Node.js**: 18.0 或更高版本
*   **ComfyUI**: (可选，用于视觉生成功能) 需在本地 `8188` 端口运行

##### 2. 后端部署 (Backend Setup)

```bash
# 1. 进入后端目录
cd backend

# 2. (可选) 创建并激活虚拟环境
python -m venv venv
# Windows:
.\venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# 3. 安装依赖
pip install -r requirements.txt

# 4. 启动后端服务 (默认运行在 http://127.0.0.1:8000)
# 会自动创建 SQLite 数据库 sql_app.db
uvicorn main:app --reload
```

访问 `http://127.0.0.1:8000/docs` 查看 Swagger API 文档。

##### 3. 前端部署 (Frontend Setup)

```bash
# 1. 进入前端目录
cd frontend

# 2. 安装依赖
npm install

# 3. 启动开发服务器 (默认运行在 http://localhost:3000)
npm run dev
```

访问 `http://localhost:3000` 进入导演工作台。

##### 4. ComfyUI 集成 (可选)
如果需要测试图片生成功能：
1. 确保 ComfyUI 已启动并监听 `127.0.0.1:8188`。
2. 后端服务会自动尝试通过 WebSocket 连接该地址。

> **参考指南**: 有关在本地机器（如 RTX 3060 12GB）上部署和选择适合的生图模型（如 Flux Dev, Pony XL, SDXL 等）的详细建议，请参阅 [本地生图模型部署推荐](local_image_generation_deployment_cn.md)。

#### 使用说明

1.  **启动 Agent**: 在前端页面左侧侧边栏，你将看到 "DreamWeaver Agent"。
2.  **发送指令**: 
    *   尝试输入 "Draft a scene where Aria finds a mysterious artifact" (起草场景)。
    *   尝试输入 "Delete chapter 2" (删除章节) —— 此时会触发**安全确认弹窗**，演示 "Human-in-the-loop" 机制。
3.  **查看日志**: 后端控制台会显示 API 调用日志，前端侧边栏会显示 Agent 的 "思考过程" (Thought Process)。

#### 参与贡献

1.  Fork 本仓库
2.  新建 Feat_xxx 分支
3.  提交代码
4.  新建 Pull Request


✦ 基于对 NovaStory MVP.md 及其引用的三个项目架构文档的深度分析，以下是关于 NovaStory MVP 方案整合情况 的详细评估报告。

  总结
  NovaStory MVP
  方案并非简单的功能堆砌，而是极其精准地“取其精华，去其糟粕”。它从三个参考项目中提取了各自最强的架构模式，组合成了一个既具备
  工业级稳定性（来自 AiStory），又拥有 专业叙事能力（来自 Huobao Drama），同时保留了 自动化合成效率（来自
  MoneyPrinterTurbo）的现代生成式视频系统。

  ---

  1. 对 ai_story-main 的整合与改良
  核心提取：异步架构与流式交互

   * 架构一致性：
       * AiStory 模式：采用 Django + Celery + Redis (Pub/Sub) + SSE 的异步架构，解决了长耗时 AI 任务导致 HTTP 超时的问题。
       * NovaStory 实施：方案明确采用了 FastAPI + Celery + Redis 的组合。这完全复刻了 AiStory
         的核心通信机制，确保了在生成视频（可能耗时数分钟）时，前端用户体验的流畅性和系统的高并发处理能力。
   * 流程参考：
       * AiStory 的 Stage 概念（Rewrite -> Storyboard -> Video）被 NovaStory 吸收为 "Layer 0: The Director" 的流水线设计，但 NovaStory   
         更加强调了步骤之间的“可控性”而非全自动流。

  2. 对 huobao-drama-master 的整合与改良
  核心提取：领域模型与导演思维

   * 核心理念（The Brain）：
       * Huobao 模式：强调 Drama -> Episode -> Scene -> Storyboard 的层级结构，以及“导演代理”将剧本拆解为分镜的逻辑。
       * NovaStory 实施：方案在 "Step 3: Feature Integration" 中明确致敬了 Huobao。它采用了 Storyboard（分镜）
         作为核心数据单元，而非简单的“一句话生成视频”。
   * 一致性控制：
       * Huobao 强调角色画像（Character Profile）和场景一致性。NovaStory 将此转化为 "Prompt Consistency" 策略，在 MVP 阶段通过 LLM       
         强制注入角色 Tag，这是 Huobao 核心业务逻辑在 Generative AI 时代的直接映射。
   * 人机交互：
       * Huobao 的 "Review"（审核分镜）环节被 NovaStory 视为核心差异化亮点——"Interactive
         Storyboard"。即在生成昂贵的视频前，先让人类导演确认分镜脚本。

  3. 对 MoneyPrinterTurbo-main 的整合与改良
  核心提取：合成引擎与自动化剪辑

   * 合成逻辑（The Synthesis）：
       * MoneyPrinter 模式：Task Service 线性调用 Video Service，使用 moviepy 将素材、语音、字幕“缝合”在一起。
       * NovaStory 实施：Layer 4 (剪辑 & 合成引擎) 显然继承了这一思路。它同样使用 Timeline DSL 驱动 FFmpeg/MoviePy 进行拼接。
   * 关键差异（升级）：
       * MoneyPrinter 主要依赖 素材库（Pexels/Pixabay），属于“拼凑型”创作。
       * NovaStory 彻底摒弃了素材库模式，转而集成 ComfyUI 进行“生成型”创作。它保留了 MoneyPrinter
         的“一键成片”的工程化链路（自动配音、自动对齐、自动字幕），但将素材源替换为更具创造力的 AI 生成内容。

  ---

  综合对比表


  ┌──────────┬──────────────────┬───────────────────────┬────────────────────────────┬──────────────────────────────────────┐
  │ 特性维度 │ AiStory (参考源) │ Huobao Drama (参考源) │ MoneyPrinterTurbo (参考源) │ NovaStory MVP (最终方案)             │
  ├──────────┼──────────────────┼───────────────────────┼────────────────────────────┼──────────────────────────────────────┤
  │ 核心驱动 │ 异步任务流       │ 剧本/分镜结构         │ 自动化剪辑脚本             │ 异步任务 + 分镜结构 + 深度生成       │
  │ 素材来源 │ GenAI (简单)     │ GenAI (可控)          │ Stock Footage (素材库)     │ ComfyUI (专业级工作流)               │
  │ 用户介入 │ 弱 (Reactive)    │ 强 (Director Agent)   │ 弱 (配置为主)              │ 中强 (Human-in-the-loop 分镜审核)    │
  │ 技术栈   │ Django/Vue       │ Go/Vue                │ Python/Streamlit           │ FastAPI/React+Vite (性能与生态的最优解) │
  └──────────┴──────────────────┴───────────────────────┴────────────────────────────┴──────────────────────────────────────┘


  结论
  NovaStory MVP 方案完美整合了三者的优势。 它没有盲目重新发明轮子，而是：
   1. 用 AiStory 的骨架支撑系统高并发；
   2. 用 Huobao Drama 的灵魂（分镜/导演视角）提升内容质量；
   3. 用 MoneyPrinterTurbo 的手（自动化合成）保障落地效率。

  这是一个非常成熟且具可落地性的技术实施方案。


✦ 在 NovaStory 项目中，剧本拆解 (Script Breakdown) 与 自动分镜 (Automatic Storyboarding) 存在着 核心能力与功能呈现
  的因果关系。简单来说，“剧本拆解”是后端 LLM 执行的智能处理过程，而“自动分镜”是这一过程在导演模式（Director Mode）前端的具体功能体现。     

  以下是具体的分析：

  1. 核心关系：过程与结果
   * 剧本拆解 (Script Breakdown) 是 后端逻辑 (Process)。
       * 它是一个由 LLM (Gemini) 驱动的分析过程。
       * 输入：章节的纯文本内容 (Chapter Content)。
       * 动作：LLM 接收指令 "Break down the following story text into a sequence of visual
         scenes..."（将故事文本拆解为一系列视觉场景），并提取出视觉提示词 (visual_prompt)、音频提示词 (audio_prompt)、对白 (dialogue)      
         和时长 (duration)。
       * 代码位置：backend/app/services/llm.py 中的 generate_timeline 方法。

   * 自动分镜 (Automatic Storyboarding) 是 前端功能 (Feature)。
       * 它是用户在 导演模式 (Director Mode) 下触发的操作。
       * 操作：用户点击界面上的“自动分镜”按钮（对应代码中的 generate_scenes）。
       * 结果：前端调用后端的拆解 API，将返回的 JSON 数据渲染为时间轴上的一张张 分镜卡片 (Storyboards/Scenes)。
       * 代码位置：frontend/pages/DirectorMode.tsx 中的 generateTimeline 函数。

  2. 数据流向 (Data Flow)
  整个流程展示了两者如何协作：

   1. 用户动作：在导演模式选择一个章节，点击 “自动分镜”。
   2. 后端处理：系统调用 “剧本拆解” 能力 (POST /api/timeline/generate)。
   3. 智能转换：LLM 读取小说文本，将其转化为结构化的分镜列表 (JSON)。
   4. 可视化呈现：前端接收数据，在界面上生成对应的分镜卡片，每张卡片包含画面描述、台词和待生成的图像占位符。

  3. 总结
  在 NovaStory
  的架构中，“自动分镜”是“剧本拆解”能力的产品化包装。没有剧本拆解的算法支持，自动分镜就无法实现；而没有自动分镜的交互入口，剧本拆解的结果就 
  无法被导演（用户）所使用和编辑。

   * 剧本拆解 = 这里的 "Brain" (分析与理解)
   * 自动分镜 = 这里的 "UI/Workflow" (交互与呈现)

