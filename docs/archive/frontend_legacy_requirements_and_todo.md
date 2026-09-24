# NovaStory 前端早期需求与待办清单 (归档)

> **状态：历史归档文档（2026-07 前后早期原型设计）**  
> 合并原 `docs/frontend_REQUIREMENTS_CN.md` 与 `docs/frontend_TODO.md`。  
> **请勿当作现状清单。** 现行能力与架构请参考 [docs/architecture/backend_implemented_features.md](../architecture/backend_implemented_features.md) 与 [docs/README.md](../README.md)。

---

## 目录
1. [第一阶段前端功能需求](#1-第一阶段前端功能需求)
2. [早期前端待办清单与完成情况](#2-早期前端待办清单与完成情况)
3. [早期技术债与建议记录](#3-早期技术债与建议记录)

---

## 1. 第一阶段前端功能需求

基于后端早期 API（项目、角色、工作流、时间轴服务），前端最初规划的功能模块闭环：

### 1.1 项目管理 (Project Management)
**目标**: 允许用户创建和管理不同的故事项目。
* **项目列表页**:
  * 展示所有项目的卡片视图（标题、描述、创建时间）。
  * **新建项目**: 弹窗表单，输入标题、描述和基础设置（如分辨率设置）。
  * **编辑/删除**: 修改项目元数据或删除整个项目。
* **项目仪表盘**: 进入项目后的概览页，显示当前章节数、角色数等统计信息。

### 1.2 角色管理 (Character Management)
**目标**: 为每个项目维护一致的角色库，供 AI 写作和绘画参考。
* **角色列表**: 在项目内展示角色卡片网格。
* **角色编辑表单**:
  * **基本信息**: 姓名、角色定位 (主角/配角/反派)、描述。
  * **视觉标签 (Visual Tags)**: 提供键值对或 JSON 编辑器，定义外观特征（如 `{"hair": "blue", "style": "cyberpunk"}`），供后续提示词生成。

### 1.3 故事编辑器 (Story Editor)
**目标**: 核心写作界面，集成 AI 辅助功能。
* **章节导航**: 侧边栏显示章节列表，支持拖拽排序（对应后端 Reordering API），新建/删除章节。
* **富文本/Markdown 编辑器**: 用于撰写章节正文。
* **AI 侧边栏/工具栏**:
  * **续写 (Draft)**: 调用 `/api/agent/draft`，根据上下文和指令生成内容。
  * **分析 (Analyze)**: 调用 `/api/agent/analyze`，分析当前文本中的新实体和剧情更新。
  * **生成时间轴**: “转为脚本/生成分镜”按钮，调用 `/api/timeline/generate` 转化为场景列表。

### 1.4 导演模式/时间轴 (Director Mode / Timeline)
**目标**: 将文本转化为视听分镜，并进行资产生成。
* **分镜视图 (Scene View)**:
  * 接收后端返回的 Timeline JSON 数据，以时间轴或卡片流展示 Scene。
  * **卡片内容**: 序号 ID、视觉提示词 (Visual Prompt, 支持手动微调)、音频提示词、对白、预估时长。
* **资产生成触发**:
  * “生成画面”按钮，下拉选择 ComfyUI Workflow。
  * **生成状态**: 加载动画与进度条（监听 SSE `/api/assets/stream/{task_id}`）。
  * **结果预览**: 生成完成后卡片上直接显示图片预览。

### 1.5 工作流管理 (Workflow Management)
**目标**: 管理 ComfyUI 的图生图/文生图模板。
* **工作流列表**: 展示系统内可用的生成模板。
* **JSON 编辑器**: 允许高级用户粘贴/编辑 ComfyUI API JSON，配置名称、描述与激活状态。

### 1.6 全局/系统设置
* **API 配置**: 前端配置或展示 ComfyUI 地址与模型连接状态。

---

## 2. 早期前端待办清单与完成情况

### 🟢 Completed Features (早期已完成功能)
- **Infrastructure**: Project structure (React + Vite + TypeScript), routing (`App.tsx`, `Layout.tsx`), API Service (`services/api.ts`), i18n (`LanguageContext.tsx`, `locales.ts`), Tailwind CSS.
- **Story Editor (`StoryEditor.tsx`)**: Chapter sidebar (view/create), basic text editor, auto/manual save (`updateChapter`), AI Draft integration (`/api/agent/draft`), analysis right sidebar.
- **Director Mode (`DirectorMode.tsx`)**: Horizontal timeline/scene view, scene cards (prompt, dialogue, duration), workflow selection, generation trigger (`/api/assets/generate`), SSE updates (`EventSource`), image preview, video trigger (`/api/assets/render-video`).
- **Workflow Management (`WorkflowManager.tsx`)**: Workflow list, active/inactive status display.

### 🟡 Pending / Todo (早期待办跟踪)
*注：下列功能在后续迭代中多已在主线演进实现。*
- **Story Editor Improvements**: Rich Text / Markdown editor, chapter drag-and-drop reordering, chapter deletion, analyze integration (`/api/agent/analyze`), timeline generation button.
- **Director Mode Enhancements**: Editable visual prompts in scene cards, dialogue editing, batch generation.
- **Workflow Management**: JSON editor for ComfyUI workflows, status toggle, JSON validation.
- **Character Management**: Structured Visual Tags editor.
- **Project Management**: Resolution and default workflow configuration in Project Settings.

---

## 3. 早期技术债与建议记录

- **Error Handling**: 将 `alert()` 和 `console.error` 统一替换为 Toast 通知系统（Toast 组件已落地）。
- **Loading States**: 为初始数据加载增加 Skeleton 骨架屏与 Spinner 动画。
- **Type Safety**: 强化 API 响应与 ComfyUI Workflow 复杂 JSON 的 TypeScript 契约校验。
- **State Management**: 随着分镜与导演模式复杂度提升，保持状态边界收敛，强化 Project 上下文管理。
