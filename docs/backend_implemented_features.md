# NovaStory Backend - Implemented Features & Key Processes

## 1. Overview
The backend is built using **FastAPI** and **SQLAlchemy**. It provides a RESTful API for managing the novel creation process, including project structure, character management, timeline generation, and integration with AI agents/services (Google Gemini, OpenAI, Grok, Nebula).

**Entry Point:** `backend/main.py`
**API Router:** `backend/app/api/api.py`

## 2. API Endpoints

### Project Management (`/api/projects`)
Handled by `backend/app/api/endpoints/projects.py`.
*   **CRUD**: Create, Read, Update, Delete projects.
*   *Status:* ✅ Implemented.

### Character Management (`/api/characters`)
Handled by `backend/app/api/endpoints/characters.py`.
*   **CRUD**: Manage characters per project, including visual tags for AI generation.
*   *Status:* ✅ Implemented.

### Structure Management (`/api/chapters`)
Handled by `backend/app/api/endpoints/structure.py`.
*   **CRUD**: Manage chapters.
*   **Reordering**: Move chapters within a project.
*   *Status:* ✅ Implemented.

### Timeline Service (`/api/timeline`)
Handled by `backend/app/api/endpoints/timeline.py`.
*   **POST /generate**: Uses LLM (Gemini/Nebula) to break down chapter text into a list of visual scenes (Timeline DSL).
*   *Status:* ✅ Implemented.

### Workflow Management (`/api/workflows`)
Handled by `backend/app/api/endpoints/workflows.py`.
*   **CRUD**: Manage ComfyUI workflow templates (JSON).
*   *Status:* ✅ Implemented.

### Asset Generation (`/api/assets`)
Handled by `backend/app/api/endpoints/assets.py`.
*   **POST /generate**: Triggers MediaService image generation (Async via BackgroundTasks).
*   **GET /stream/{task_id}**: Server-Sent Events (SSE) for real-time generation progress.
*   *Status:* ✅ Implemented.

### Creative Agent (`/api/agent`)
Handled by `backend/app/api/endpoints/creative.py`.
*   **Drafting & Analysis**: LLM-based text generation and entity extraction.
*   *Status:* ✅ Implemented.

### Agentic Assistant (`/api/assistant`)
Handled by `backend/app/api/endpoints/agent_assistant.py`.
*   **Chat Interface**: Conversational agent for directing the story.
*   **Tools**:
    *   `analyze_chapter`: Mood and pacing analysis.
    *   `generate_timeline`: Automatic storyboard creation.
    *   `get/update_character_info`: Character management.
*   *Status:* ✅ Implemented.

## 3. Data Models
Defined in `backend/app/models/`.

*   **Project**: Container for the story (Title, Description, Settings).
*   **Character**: Story characters with roles and visual descriptions.
*   **Chapter**: Story units with content, summary, and order index.
*   **Scene**: Visual breakdown units with prompts, duration, and asset links.
*   **Workflow**: Stored ComfyUI JSON templates.

## 4. Key Services

### Media Service (`backend/app/services/media_service.py`)
Unified interface for asset generation.
*   **Providers**:
    *   `GeminiProvider`: Uses Google Imagen.
    *   `OpenAIProvider`: Uses DALL-E 3.
    *   `GrokProvider`: Uses Flux (via xAI).
    *   `ComfyUIService`: Uses local ComfyUI instance.

### LLM Service (`backend/app/services/llm.py` & `gemini_provider.py`)
Wrapper for Large Language Models.
*   **Routing**: Supports direct Gemini API or routing via Nebula platform.
*   **Capabilities**: Text generation, Timeline breakdown, Character analysis.

### Agent Service (`backend/app/services/ai/agent_service.py`)
Orchestrates the Director's Assistant.
*   **Context Awareness**: Injects project state (Characters, Chapter Content) into prompts.
*   **Tool Use**: Parses and executes JSON-based tool calls.

### Nebula Client (`backend/app/services/nebula.py`)
Integration client for the Nebula Ecosystem.
*   **Authentication**: Verifies system tokens.
*   **Storage**: Uploads generated assets to cloud storage.
*   **Model Relay**: Routes chat completion requests.

## 5. Summary of Status
*   **Core Logic**: ✅ Complete (Projects, Characters, Chapters, Workflows).
*   **Database**: ✅ Managed via Alembic Migrations.
*   **AI Architecture**: ✅ Modular Provider System (Gemini, OpenAI, Grok, Nebula).
*   **Agentic Features**: ✅ Director's Assistant with Tool Use.
*   **Infrastructure**: ✅ Redis + BackgroundTasks for async processing.