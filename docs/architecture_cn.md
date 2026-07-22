# NovaStory 架构文档 (Architecture)

## 1. 系统概览 (System Overview)

NovaStory 是一个基于 AI 的辅助创作工具，旨在帮助创作者从文本故事生成可视化的分镜脚本和视频素材。系统采用前后端分离架构，前端使用 React (Vite)，后端使用 FastAPI (Python)。

## 2. 核心功能 (Core Features)

### 2.1 故事编辑器 (Story Editor)
- **功能**: 提供沉浸式的文本创作环境。
- **AI 辅助**: 集成 AI 助手，支持续写、润色、分析等功能。
- **数据流**: 用户的输入实时保存，并可随时触发 AI 分析。

### 2.2 导演模式 (Director Mode)
导演模式是核心的视频生产环节，支持从文本到视频的完整工作流。

#### 自动分镜 (Auto-Storyboard) - 两步流程
为了提高分镜的专业性和一致性，我们采用了两步走的自动分镜策略：

1.  **Step 1: 场景拆解 (Scene Breakdown)**
    *   **输入**: 章节文本 (Chapter Text)。
    *   **处理**: LLM 分析文本，将其拆解为一系列叙事性的视觉场景 (Visual Scenes)。
    *   **输出**: 包含场景描述、对白、时长估算的场景列表。
    *   **API**: `POST /timeline/generate` (mode="standard")

2.  **Step 2: 电影感分镜生成 (Cinematic Grid Assets)**
    *   **输入**: 单个场景的描述。
    *   **处理**:
        1.  **Meta-Prompting**: 使用 "Cinematic Grid (Version 3)" 提示词模板，将简单的场景描述转化为包含 9 个镜头 (ELS, LS, MLS, MS, MCU, CU, ECU, Low, High) 的详细分镜提示词。
        2.  **Image Generation**: 调用绘图模型 (如 ComfyUI 或 DALL-E) 生成 3x3 的分镜网格图。
    *   **输出**: 一张包含 9 个不同景别/角度的拼图，供创作者选择最佳构图。
    *   **API**: `POST /assets/generate` (mode="cinematic_grid")

## 3. 后端架构 (Backend Architecture)

### 3.1 技术栈
- **框架**: FastAPI
- **数据库**: SQLite (开发环境) / PostgreSQL (生产环境)
- **任务队列**: `BackgroundTasks` (用于异步生成任务)
- **LLM 服务**: 集成 OpenAI/Gemini 等模型。

### 3.2 关键模块
- **`app/services/prompts.py`**: 管理所有 LLM 提示词。
    - `generate_cinematic_grid_timeline_prompt`: 核心的 9 镜头分镜提示词生成逻辑。
- **`app/services/llm.py`**: LLM 调用封装层。
    - `generate_timeline(mode="cinematic_grid")`: 支持不同模式的分镜生成。
- **`app/api/endpoints/timeline.py`**: 分镜相关接口。
- **`app/api/endpoints/assets.py`**: 素材生成接口，支持异步任务和 SSE 进度推送。

## 4. 前端架构 (Frontend Architecture)

### 4.1 技术栈
- **框架**: React 18 + Vite
- **UI 库**: Tailwind CSS + Lucide React
- **状态管理**: React Context + Hooks

### 4.2 关键组件
- **`DirectorTimeline.tsx`**: 
    - 展示分镜列表。
    - 集成 "生成场景" (Generate Scenes) 按钮，触发标准分镜生成 (Standard Breakdown)。
- **`DirectorRightPanel.tsx`**:
    - 提供全局设置，包括 "Asset Generation Mode" (Standard / Cinematic Grid) 切换。
    - 控制生成参数 (Style, Strength)。

## 5. 数据流 (Data Flow)

1.  **用户** 在导演模式选择章节。
2.  **前端** 调用 `generateTimeline` 接口。
3.  **后端** LLM 解析文本，返回场景列表。
4.  **用户** 点击 "Generate Asset" (或批量生成)。
5.  **前端** 根据 `assetMode` 调用 `generateAsset` 接口。
6.  **后端**:
    - 若 `mode="cinematic_grid"`: 先调用 LLM 生成 9 镜头提示词，再调用绘图服务。
    - 若 `mode="standard"`: 直接使用场景描述调用绘图服务。
7.  **后端** 通过 SSE 推送生成进度和结果 URL。
8.  **前端** 更新 UI 显示生成的图片。
