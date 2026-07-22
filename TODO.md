# Frontend TODO List

## 🟢 Completed Features (已完成功能)

### Infrastructure
- [x] Project structure (React + Vite + TypeScript).
- [x] Routing setup (`App.tsx`, `Layout.tsx`).
- [x] API Service with Mock Data fallback (`services/api.ts`).
- [x] Localization support (`LanguageContext.tsx`, `locales.ts`).
- [x] Basic UI Components and Styling (Tailwind CSS).
- [x] **Error Handling**: Implemented Global Toast Notification System replacing native alerts.
- [x] **Loading States**: Implemented Skeleton loaders for Dashboard and Director Mode.
- [x] **Mobile Responsiveness**: Implemented collapsible sidebars, mobile menus, and responsive layouts.
- [x] **Authentication**: Implemented `AuthGuard`, Login redirection, and Token management (`AuthService`).

### Story Editor (`StoryEditor.tsx`)
- [x] Chapter List Sidebar (View, Create).
- [x] Basic Text Editor (Textarea).
- [x] **Rich Text / Markdown Support**: Replaced basic `textarea` with `EasyMDE` (Markdown editor).
- [x] Auto-save / Manual Save (`updateChapter`).
- [x] AI Draft Integration (`/api/agent/draft`).
- [x] Right Sidebar layout for Analysis (UI only).
- [x] **Delete Chapter**: UI and logic implemented.
- [x] **Generate Timeline Trigger**: Integrated "Auto-Breakdown" button.
- [x] **Chapter Reordering**: Implemented Move Up/Down functionality.
- [x] **Analyze Functionality**: Added dedicated Analysis tab with deep content analysis (Entities & Plot).

### Character Management (`CharacterManager.tsx`)
- [x] **Character List**: View project characters.
- [x] **CRUD Operations**: Create, Edit, Delete characters.
- [x] **Visual Tags**: Management of ComfyUI-compatible visual tags.
- [x] **Auto-Extraction**: Extract characters from story content (`/characters/extract`).

### Director Mode (`DirectorMode.tsx`)
- [x] Scene/Timeline Horizontal View.
- [x] Scene Card Display (Prompt, Dialogue, Duration).
- [x] Workflow Selection.
- [x] Asset Generation Trigger (Connects to `/api/assets/generate`).
- [x] SSE Real-time Progress Updates (`EventSource`).
- [x] Image Result Preview.
- [x] Video Rendering Trigger (Connects to `/api/assets/render-video`).
- [x] **Prompt Engineering**: "Content First, Style Second" logic implemented.
- [x] **Style Decoupling**: Refined `constants.ts`.
- [x] **Edit Visual Prompts**: Scene Cards are editable.
- [x] **Negative Prompting**: Implemented.
- [x] **Prompt Weighting**: Style Strength slider implemented.
- [x] **Advanced Shot Control**: Camera parameters editable.
- [x] **Audio/Dialogue Editing**: Fields are editable.
- [x] **Batch Generation**: Implemented "Generate All".
- [x] **Comic Generation**: Generate comic pages and PDF from scenes (`/comics`).
- [x] **Comic Viewer**: UI for viewing generated pages and downloading PDF.
- [x] **Agent Assistant**: Integrated chat assistant for production support (`/assistant/chat`).

### Project Management
- [x] **Dashboard**: Project listing, creation, and text import (`/projects/import`).
- [x] **Project Settings**: Added Project Settings page (Title, Description, Defaults).

### System Settings (`Settings.tsx`)
- [x] **Global Configuration**: LLM Model selection, ComfyUI connection, and Nebula integration settings.
- [x] **Connection Verification**: Test functionality for external services.

### Workflow Management (`WorkflowManager.tsx`)
- [x] Read-only Workflow List.
- [x] Status display (Active/Inactive).
- [x] JSON Editor for Workflows.

---

## 🟡 Pending / Todo (待办事项)

### 1. Story Editor Improvements
- [ ] **Export Options**: Add ability to export story as PDF or Markdown file.
- [x] **Cinematic Grid (Version 3)**: Implement "Story-to-Storyboard" meta-prompt to generate 3x3 cinematic grid prompts.

### 2. Director Mode Improvements
- [x] **Auto-Storyboard Refinement (2-Step Process)**:
    - [x] **Step 1: Scene Breakdown**: Ensure `generate_timeline` focuses on breaking down chapter text into a list of narrative visual scenes (Standard Breakdown).
    - [x] **Step 2: Cinematic Grid Assets**: Implement "Cinematic Grid" generation for individual scenes.
        - [x] Backend: Update `/assets/generate` to support `mode="cinematic_grid"`.
        - [x] Backend: Implement logic to first call LLM with "Version 3 Meta-Prompt" to generate the image prompt, then call Image Provider.
        - [x] Frontend: Add "Asset Mode" toggle (Standard / Cinematic Grid) in Director Mode settings.
        - [x] Frontend: Update `generateAsset` calls to respect the selected mode.


---

## 🔵 Technical Debt & Suggestions (技术债与建议)

- **State Management**: Consider Zustand for complex cross-component state (e.g. sharing character data between Editor and Director modes).