import json
import logging
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from ...db.session import SessionLocal
from ...models.chapter import Chapter
from ...models.character import Character
from ...models.scene import Scene
from ...schemas.agent import AgentRequest, AgentResponse, ToolCall
from .gemini_provider import GeminiProvider
from ...core.config import settings
from ...services.llm import LLMService 

logger = logging.getLogger(__name__)

class AgentService:
    def __init__(self):
        self.llm = GeminiProvider(api_key=settings.GEMINI_API_KEY)

    def process_request(self, request: AgentRequest) -> AgentResponse:
        db = SessionLocal()
        try:
            # 1. Build Context
            context_str = self._build_context(db, request)
            
            # 2. Build System Prompt
            language = request.context.language or "zh"
            system_prompt = self._build_system_prompt(context_str, language)
            
            # 3. Construct Message History
            messages_str = ""
            for msg in request.history:
                role = "User" if msg["role"] == "user" else "Agent"
                messages_str += f"{role}: {msg['content']}\n"
            messages_str += f"User: {request.message}\nAgent:"

            # 4. Call LLM
            full_prompt = f"{messages_str}"
            # Note: GeminiProvider.generate_text supports system_instruction
            raw_response = self.llm.generate_text(full_prompt, system_instruction=system_prompt)
            
            # 5. Parse Response
            agent_response = self._parse_response(raw_response)
            
            # 6. Execute Tool (if any)
            if agent_response.action:
                tool_result = self._execute_tool(db, agent_response.action, request)
                if tool_result:
                    agent_response.response += f"\n\n[Tool Output]: {tool_result}"
            
            return agent_response

        except Exception as e:
            logger.error(f"Agent processing failed: {e}")
            return AgentResponse(
                thought="System Error",
                response="I encountered an internal error while processing your request.",
                action=None
            )
        finally:
            db.close()

    def _build_context(self, db: Session, request: AgentRequest) -> str:
        ctx = request.context
        context_parts = []
        
        if ctx.project_id:
            chars = db.query(Character).filter(Character.project_id == ctx.project_id).all()
            char_list = ", ".join([c.name for c in chars])
            context_parts.append(f"Project Characters: {char_list}")

        if ctx.chapter_id:
            chapter = db.query(Chapter).filter(Chapter.id == ctx.chapter_id).first()
            if chapter:
                context_parts.append(f"Current Chapter: {chapter.title}")
                # Add summary or excerpt if needed, but keep it brief for now
                if chapter.summary:
                     context_parts.append(f"Chapter Summary: {chapter.summary}")
                if chapter.content:
                     # Provide first 500 chars as glimpse
                     snippet = chapter.content[:500] + "..." if len(chapter.content) > 500 else chapter.content
                     context_parts.append(f"Chapter Start: {snippet}")

        return "\n".join(context_parts)

    def _build_system_prompt(self, context_str: str, language: str = "zh") -> str:
        lang_instruction = "You MUST respond in CHINESE (Simplified)." if language == "zh" else "You MUST respond in ENGLISH."
        return f"""You are the 'Director's Assistant' in NovaStory, an AI-powered creative writing and directing platform.
Your goal is to assist the user in directing their story, managing characters, and visualizing scenes.

LANGUAGE:
{lang_instruction}

CONTEXT:
{context_str}

AVAILABLE TOOLS:
1. analyze_chapter(chapter_id: str) - Analyze the current chapter for mood, pacing, and characters.
2. generate_timeline(chapter_id: str) - Automatically break down the chapter into scenes (storyboard).
3. get_character_info(name: str) - Get details about a specific character.
4. update_character_info(name: str, description: str, visual_tags: dict) - Update a character's traits.

RESPONSE FORMAT:
You must output a JSON object with the following structure:
{{
  "thought": "Your internal reasoning process...",
  "response": "Your natural language response to the user...",
  "action": {{ "tool_name": "...", "arguments": {{...}}, "reason": "..." }} (OPTIONAL)
}}

Do not include markdown formatting (like ```json) in your output. Just the raw JSON.
If no tool is needed, set "action" to null.
"""

    def _parse_response(self, raw_text: str) -> AgentResponse:
        try:
            # Clean markdown if present
            clean_text = raw_text.replace("```json", "").replace("```", "").strip()
            data = json.loads(clean_text)
            return AgentResponse(**data)
        except json.JSONDecodeError:
            # Fallback for non-JSON responses (Self-Healing attempt could go here)
            return AgentResponse(
                thought="Failed to parse JSON",
                response=raw_text, # Assume the whole text is the response
                action=None
            )

    def _execute_tool(self, db: Session, action: ToolCall, request: AgentRequest) -> str:
        try:
            if action.tool_name == "analyze_chapter":
                chapter_id = action.arguments.get("chapter_id") or request.context.chapter_id
                if not chapter_id: return "Error: No chapter ID provided."
                
                chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
                if not chapter: return "Error: Chapter not found."
                
                # Reuse LLMService analysis
                analysis = LLMService.analyze_content(chapter.content or "")
                return f"Analysis Result: {json.dumps(analysis, indent=2)}"

            elif action.tool_name == "generate_timeline":
                chapter_id = action.arguments.get("chapter_id") or request.context.chapter_id
                if not chapter_id: return "Error: No chapter ID provided."
                
                # We can trigger the actual generation or just return a suggestion
                # Here we'll return a message that it's ready to be generated via UI, 
                # or actually call the generation service if we want to bypass UI state (risky for sync).
                # Better to just instruct the user or return a plan.
                # However, the user asked for "Automatic storyboard", so let's generate the data.
                
                chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
                if not chapter or not chapter.content: return "Error: Chapter content empty."
                
                timeline_data = LLMService.generate_timeline(chapter.content)
                
                # Optionally save to DB here? 
                # DirectorMode.tsx pulls from DB. So we should save it.
                # But that might overwrite existing work.
                # For now, let's return the plan and let the user confirm in chat? 
                # Or just save it. Let's save it for "Agentic" feel.
                
                # Clear old scenes?
                # db.query(Scene).filter(Scene.chapter_id == chapter_id).delete()
                
                # Add new scenes
                saved_count = 0
                for i, scene_data in enumerate(timeline_data):
                     scene = Scene(
                         chapter_id=chapter_id,
                         index=i,
                         visual_prompt=scene_data.get("visual_prompt", ""),
                         audio_prompt=scene_data.get("audio_prompt", ""),
                         duration=scene_data.get("duration", 3.0),
                         shot_type=scene_data.get("camera", {}).get("shot_type", "medium"),
                         camera_movement=scene_data.get("camera", {}).get("movement", "static"),
                         camera_angle=scene_data.get("camera", {}).get("angle", "eye_level")
                     )
                     db.add(scene)
                     saved_count += 1
                
                db.commit()
                return f"Successfully generated and saved {saved_count} scenes for chapter '{chapter.title}'."

            elif action.tool_name == "get_character_info":
                name = action.arguments.get("name")
                char = db.query(Character).filter(Character.name == name, Character.project_id == request.context.project_id).first()
                if char:
                    return f"Name: {char.name}\nRole: {char.role}\nDescription: {char.description}\nTags: {char.visual_tags}"
                return "Character not found."

            elif action.tool_name == "update_character_info":
                name = action.arguments.get("name")
                desc = action.arguments.get("description")
                tags = action.arguments.get("visual_tags")
                
                char = db.query(Character).filter(Character.name == name, Character.project_id == request.context.project_id).first()
                if char:
                    if desc: char.description = desc
                    if tags: char.visual_tags = tags
                    db.commit()
                    return f"Updated character '{name}'."
                return "Character not found."

            return "Unknown tool."
        
        except Exception as e:
            logger.error(f"Tool execution failed: {e}")
            return f"Tool execution failed: {str(e)}"