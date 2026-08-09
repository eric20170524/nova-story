# Frontend TODO List

> **状态：历史文档（2026-07 前后）**  
> 下列「待办」多数已在主线实现（Markdown 编辑器、章节删除、分镜生成、工作流 JSON 编辑等）。  
> **请勿当作现状清单。** 现行能力见 [backend_implemented_features.md](./backend_implemented_features.md) 与仓库根 `TODO.md`；文档索引见 [README.md](./README.md)。

## 🟢 Completed Features (已完成功能)

### Infrastructure
- [x] Project structure (React + Vite + TypeScript).
- [x] Routing setup (`App.tsx`, `Layout.tsx`).
- [x] API Service with Mock Data fallback (`services/api.ts`).
- [x] Localization support (`LanguageContext.tsx`, `locales.ts`).
- [x] Basic UI Components and Styling (Tailwind CSS).

### Story Editor (`StoryEditor.tsx`)
- [x] Chapter List Sidebar (View, Create).
- [x] Basic Text Editor (Textarea).
- [x] Auto-save / Manual Save (`updateChapter`).
- [x] AI Draft Integration (`/api/agent/draft`).
- [x] Right Sidebar layout for Analysis (UI only).

### Director Mode (`DirectorMode.tsx`)
- [x] Scene/Timeline Horizontal View.
- [x] Scene Card Display (Prompt, Dialogue, Duration).
- [x] Workflow Selection.
- [x] Asset Generation Trigger (Connects to `/api/assets/generate`).
- [x] SSE Real-time Progress Updates (`EventSource`).
- [x] Image Result Preview.
- [x] Video Rendering Trigger (Connects to `/api/assets/render-video`).

### Workflow Management (`WorkflowManager.tsx`)
- [x] Read-only Workflow List.
- [x] Status display (Active/Inactive).

---

## 🟡 Pending / Todo (待办事项)

### 1. Story Editor Improvements
- [ ] **Rich Text / Markdown Support**: Replace basic `textarea` with a Markdown editor (e.g., `react-markdown` or `monaco-editor`) for better writing experience.
- [ ] **Chapter Reordering**: Implement Drag-and-Drop for the chapter list (backend `reorder` API support needed).
- [ ] **Delete Chapter**: Add UI and logic to delete chapters.
- [ ] **Analyze Functionality**: Connect the "Analyze" button in the right sidebar to `/api/agent/analyze` and display results (Entities, Summary).
- [ ] **Generate Timeline Trigger**: Add a button to convert the current chapter to a timeline (calls `/api/timeline/generate`), then navigate to Director Mode.

### 2. Director Mode Enhancements
- [ ] **Edit Visual Prompts**: Make the visual prompt text area in Scene Cards editable so users can fine-tune prompts before generation.
- [ ] **Audio/Dialogue Editing**: Allow editing of dialogue or audio prompts.
- [ ] **Batch Generation**: (Optional) Button to generate assets for all scenes in the timeline.

### 3. Workflow Management (High Priority)
- [ ] **JSON Editor**: Implement a Create/Edit view with a JSON editor (e.g., `react-json-view` or CodeMirror) to allow users to modify ComfyUI workflows.
- [ ] **Status Toggle**: Allow users to toggle `is_active` state for workflows.
- [ ] **Validation**: Simple validation to ensure uploaded JSON is valid.

### 4. Character Management (To Verify)
- [ ] **Visual Tags Editor**: Ensure the Character Editor supports adding/editing structured Visual Tags (JSON or Key-Value pairs) for consistent character generation.

### 5. Project Management
- [ ] **Settings**: Allow updating project settings (resolution, default workflow, etc.).

---

## 🔵 Technical Debt & Suggestions (技术债与建议)

- **Error Handling**: Replace `alert()` and `console.error` with a proper Toast notification system (e.g., `react-hot-toast` or `sonner`) for better user feedback.
- **Loading States**: Add proper Skeleton loaders or spinners for initial data fetching across all pages.
- **Type Safety**: Strengthen TypeScript interfaces for API responses, especially for complex JSON structures like ComfyUI Workflows.
- **State Management**: As complexity grows (especially with Director Mode), consider using a stronger state manager (Zustand or Redux) or React Context for shared data like "Current Project".
