# NovaStory Backend API Documentation

Base URL: `http://127.0.0.1:8000/api`

This documentation details the available endpoints, their method, expected request body structures, and response formats.

---

## 1. Project API (Project Management)
**Prefix**: `/projects`

### 1.1 Create Project
Create a new story project.

*   **URL**: `/`
*   **Method**: `POST`
*   **Request Body** (`application/json`):
    ```json
    {
      "title": "string (required)",
      "description": "string (optional)",
      "settings": "string (optional JSON string)"
    }
    ```
*   **Response**: `Project` object.
    ```json
    {
      "id": 1,
      "title": "My Story",
      "description": "A scifi epic",
      "settings": "{}",
      "created_at": "2023-01-01T00:00:00"
    }
    ```

### 1.2 Get Projects
List all projects.

*   **URL**: `/`
*   **Method**: `GET`
*   **Response**: `List[Project]`

### 1.3 Get Project
*   **URL**: `/{project_id}`
*   **Method**: `GET`
*   **Response**: `Project` object.

### 1.4 Update Project
*   **URL**: `/{project_id}`
*   **Method**: `PUT`
*   **Request Body**:
    ```json
    {
      "title": "string (optional)",
      "description": "string (optional)",
      "settings": "string (optional)"
    }
    ```
*   **Response**: Updated `Project` object.

### 1.5 Delete Project
*   **URL**: `/{project_id}`
*   **Method**: `DELETE`
*   **Response**: `{}`

### 1.6 Import Project
Import a UTF-8, GBK, or GB18030 `.txt` file as a project. Chinese chapter
headings (including wrapped headings such as `《书名·第二章》`) and
`Chapter`/`Episode` headings are split into editable chapters.

*   **URL**: `/import`
*   **Method**: `POST`
*   **Content-Type**: `multipart/form-data`
*   **Form field**: `file`
*   **Response**: Created `Project` object.

---

## 2. Character API (Character Management)
**Prefix**: `/characters`

### 2.1 Create Character
*   **URL**: `/`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "project_id": 1,
      "name": "string (required)",
      "role": "string (optional)",
      "description": "string (optional)",
      "visual_tags": { "hair": "blue", "style": "cyberpunk" }  // Optional Dict
    }
    ```
*   **Response**: `Character` object.

### 2.2 Get Characters
*   **URL**: `/?project_id={id}`
*   **Method**: `GET`
*   **Response**: `List[Character]`

### 2.3 Update Character
*   **URL**: `/{character_id}`
*   **Method**: `PUT`
*   **Request Body**:
    ```json
    {
      "name": "string (optional)",
      "role": "string (optional)",
      "description": "string (optional)",
      "visual_tags": {}
    }
    ```
*   **Response**: Updated `Character` object.

### 2.4 Delete Character
*   **URL**: `/{character_id}`
*   **Method**: `DELETE`
*   **Response**: `{}`

---

## 3. Structure API (Chapter Management)
**Prefix**: `/chapters`

### 3.1 Create Chapter
Create a new chapter entry.

*   **URL**: `/`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "id": "string (UUID required)",
      "project_id": 1,
      "title": "string (required)",
      "index": 1,
      "content": "string (optional)"
    }
    ```
*   **Response**: `Chapter` object.

### 3.2 Get Chapters
List chapters for a project.

*   **URL**: `/?project_id={id}`
*   **Method**: `GET`
*   **Response**: `List[Chapter]` sorted by index.

### 3.3 Update Chapter
*   **URL**: `/{chapter_id}`
*   **Method**: `PATCH`
*   **Request Body**:
    ```json
    {
      "title": "string (optional)",
      "content": "string (optional)",
      "summary": "string (optional)"
    }
    ```
*   **Response**: Updated `Chapter` object.

### 3.4 Move Chapter
Reorder a chapter.

*   **URL**: `/{chapter_id}/move`
*   **Method**: `PUT`
*   **Request Body**: `{"new_index": integer}`
*   **Response**: `{"status": "moved", "new_index": integer}`

### 3.5 Delete Chapter
*   **URL**: `/{chapter_id}`
*   **Method**: `DELETE`
*   **Response**: `{"status": "success", "id": "..."}`

---

## 4. Timeline API (Director Mode)
**Prefix**: `/timeline`

### 4.1 Generate Timeline
Convert a chapter's text content into a list of visual scenes using LLM.

*   **URL**: `/generate`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "chapter_id": "string (UUID)"
    }
    ```
*   **Response**:
    ```json
    {
      "chapter_id": "...",
      "timeline": [
        {
          "id": 1,
          "chapter_id": "...",
          "index": 1,
          "visual_prompt": "A cyberpunk street...",
          "audio_prompt": "Rain sounds...",
          "dialogue": "Hello world",
          "duration": 5.0,
          "shot_type": "Wide",
          "camera_movement": "Pan Right",
          "asset_status": "idle",
          "asset_url": null
        }
      ]
    }
    ```

### 4.2 Get Timeline
Fetch existing timeline scenes.

*   **URL**: `/{chapter_id}`
*   **Method**: `GET`
*   **Response**: Same structure as Generate Timeline.

---

## 5. Workflow API (Asset Config)
**Prefix**: `/workflows`

### 5.1 Create Workflow
Register a new ComfyUI workflow template.

*   **URL**: `/`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "name": "string",
      "description": "string",
      "content": {}, // ComfyUI JSON object
      "is_active": true
    }
    ```

### 5.2 List Workflows
*   **URL**: `/`
*   **Method**: `GET`
*   **Response**: `List[Workflow]`

### 5.3 Update Workflow
*   **URL**: `/{workflow_id}`
*   **Method**: `PUT`
*   **Request Body**: `{"name": "...", "content": {...}}`

---

## 6. Asset API (Generation)
**Prefix**: `/assets`

### 6.1 Generate Asset
Trigger a media generation task (ComfyUI or LLM Provider).

*   **URL**: `/generate`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "workflow": { "prompt": "A robot in a garden" }, 
      "scene_id": 123
    }
    ```
    *Note: `workflow` can be a ComfyUI JSON or a simple dict with `prompt` for LLM generation.*

*   **Response**: 
    ```json
    {
      "task_id": "uuid-string", 
      "status": "processing"
    }
    ```

### 6.2 Stream Progress (SSE)
Real-time progress updates via Server-Sent Events.

*   **URL**: `/stream/{task_id}`
*   **Method**: `GET`
*   **Response**: Stream of events.
    *   `data: {"type": "connected"}`
    *   `data: {"type": "progress", "data": {"node": 1, "max": 10}}`
    *   `data: {"type": "complete", "status": "completed", "image_url": "/static/..."}`

### 6.3 Get Task Status
*   **URL**: `/status/{task_id}`
*   **Method**: `GET`
*   **Response**: `{"status": "...", "detail": "..."}`

---

## 7. Creative Agent API
**Prefix**: `/agent`

### 7.1 Draft Text
Generate story content.

*   **URL**: `/draft`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "instructions": "Write a scene where... (required)",
      "context_chapter_id": "optional-uuid",
      "context_text": "Direct text context (optional)"
    }
    ```
*   **Response**: `{"content": "Generated text..."}`

### 7.2 Analyze Content
Perform breakdown or analysis of text.

*   **URL**: `/analyze`
*   **Method**: `POST`
*   **Request Body**: `{"content": "Text to analyze..."}`
*   **Response**: JSON object with analysis results.

### 7.3 Get Context
*   **URL**: `/context/{chapter_id}`
*   **Method**: `GET`
*   **Response**: Project structure and chapter summary.

---

## 8. Assistant API (Agentic OS)
**Prefix**: `/assistant`

### 8.1 Chat with Agent
Interactive chat with the director agent.

*   **URL**: `/chat`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "message": "User input",
      "context": {
        "project_id": 1,
        "chapter_id": "...",
        "language": "zh"
      },
      "history": [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
      ]
    }
    ```
*   **Response**:
    ```json
    {
      "thought": "Internal reasoning...",
      "response": "Final answer to user",
      "action": null // Or {"tool_name": "...", "arguments": {...}}
    }
    ```

---

## 9. Comic API
**Prefix**: `/comics`

### 9.1 Generate Comic
Generate comic pages and PDF for a chapter.

*   **URL**: `/{chapter_id}/generate`
*   **Method**: `POST`
*   **Response**:
    ```json
    {
      "status": "completed",
      "pages": [{"scene_id": 1, "url": "/static/..."}],
      "pdf_url": "/static/..."
    }
    ```

---

## 10. Settings API
**Prefix**: `/settings`

### 10.1 Get Settings
*   **URL**: `/`
*   **Method**: `GET`
*   **Response**: JSON object of system settings.

### 10.2 Update Settings
*   **URL**: `/`
*   **Method**: `POST`
*   **Request Body**: Full settings object or partial update.

### 10.3 Verify Nebula Connection
*   **URL**: `/verify-nebula`
*   **Method**: `POST`
*   **Request Body**:
    ```json
    {
      "base_url": "...",
      "system_token": "..."
    }
    ```
    *Or nested under `nebula` key.*
*   **Response**: `{"status": "success", "user": {...}}`
