import logging
import json
from typing import Optional, Dict, List, Any, Type, TypeVar
from pydantic import ValidationError, BaseModel

from app.core.config import settings
from app.core.settings_manager import SettingsManager
from app.core.log_utils import format_log_message
from app.services.ai.base import AIProvider
from app.services.ai.gemini_provider import GeminiProvider
from app.services.ai.openai_provider import OpenAIProvider
from app.services.ai.grok_provider import GrokProvider
from app.schemas.llm import (
    ContentAnalysis, 
    TimelineResponse, 
    CharacterProfilesResponse, 
    CharacterEvolution
)
from .prompts import Prompts

# Setup logger
logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

class LLMService:
    MAX_RETRIES = 3
    
    @classmethod
    def _get_provider(cls, token: Optional[str] = None) -> AIProvider:
        """
        Factory to get the appropriate AI Provider based on system settings.
        """
        llm_config = SettingsManager.get("llm", {})
        provider_type = (llm_config.get("provider") or SettingsManager.get("llm_provider", "gemini")).lower()
        api_key = llm_config.get("api_key") or getattr(settings, "GEMINI_API_KEY", "")
        base_url = llm_config.get("base_url")
        model = llm_config.get("model") or SettingsManager.get("llm_model", "gemini-2.5-flash")

        if provider_type in ("openai", "custom", "ollama"):
            effective_base_url = base_url or ("http://127.0.0.1:11434/v1" if provider_type == "ollama" else None)
            effective_model = model or ("qwen2.5-coder:7b" if provider_type == "ollama" else "gpt-4o")
            return OpenAIProvider(api_key=api_key or "ollama", model=effective_model, base_url=effective_base_url)
        elif provider_type == "grok":
            return GrokProvider(api_key=api_key or "", model=model or "grok-beta")
        else:
            if not api_key:
                logger.warning("GEMINI_API_KEY is not set.")
            return GeminiProvider(api_key=api_key, model=model or "gemini-2.5-flash")

    @classmethod
    def _generate_structured_with_retry(cls, prompt: str, response_model: Type[T], token: Optional[str] = None) -> Optional[T]:
        """
        Generates structured output with validation retries.
        """
        logger.info(format_log_message("LLM Request (Structured) - Prompt", prompt))
        
        provider = cls._get_provider(token)
        retries = 0
        last_error = None
        
        while retries < cls.MAX_RETRIES:
            try:
                result = provider.generate_structured(prompt, response_model)
                logger.info(format_log_message("LLM Response (Structured)", result.model_dump()))
                return result
            except (ValidationError, ValueError) as e:
                logger.warning(f"Structured generation validation failed (attempt {retries+1}/{cls.MAX_RETRIES}): {e}")
                last_error = e
                retries += 1
                # Optional: We could append the error to the prompt for the next try.
            except Exception as e:
                logger.error(f"Unexpected error in structured generation: {e}")
                return None
        
        logger.error(f"Failed to generate valid structure after {cls.MAX_RETRIES} attempts. Last error: {last_error}")
        return None

    @classmethod
    def generate_draft(cls, instructions: str, context: str = "", token: Optional[str] = None) -> str:
        logger.info(f"Generating draft with instructions: {instructions[:50]}...")
        prompt = Prompts.generate_draft(instructions, context)
        logger.info(format_log_message("LLM Request (Draft) - Prompt", prompt))
        provider = cls._get_provider(token)
        
        try:
            text = provider.generate_text(prompt)
            logger.info(format_log_message("LLM Response (Draft)", text))
            return text
        except Exception as e:
            logger.error(f"Draft generation failed: {e}")
            return f"[LLM Error] Could not generate draft. Error: {e}"

    @classmethod
    def analyze_content(cls, content: str, token: Optional[str] = None) -> Dict[str, Any]:
        logger.info("Analyzing content for impact...")
        prompt = Prompts.analyze_content(content)
        
        result = cls._generate_structured_with_retry(prompt, ContentAnalysis, token)
        
        if result:
            return result.model_dump()
        return {"new_entities": [], "updates": ["Analysis failed"]}

    @classmethod
    def _validate_nine_shot_coverage(cls, shots: List[Dict[str, Any]]) -> bool:
        if len(shots) != 9:
            return False
        for s in shots:
            if not s.get("visual_prompt") and not s.get("shot_type"):
                return False
        return True

    @classmethod
    def _generate_nine_shot_fallback(cls, content: str) -> List[Dict[str, Any]]:
        import re
        sentences = [s.strip() for s in re.split(r'[。！？\n]+', content) if s.strip()]
        base_sentence = sentences[0] if sentences else content[:100]
        
        nine_specs = [
            ("Extreme Long Shot", "Static", "Eye-level"),
            ("Long Shot", "Static", "Eye-level"),
            ("Medium Long Shot", "Pan", "Eye-level"),
            ("Medium Shot", "Static", "Eye-level"),
            ("Medium Close-Up", "Zoom In", "Eye-level"),
            ("Close-Up", "Static", "Eye-level"),
            ("Extreme Close-Up", "Static", "Eye-level"),
            ("Medium Shot", "Static", "Low Angle"),
            ("Medium Shot", "Static", "High Angle"),
        ]
        
        fallback_shots = []
        for idx, (st, mv, ag) in enumerate(nine_specs):
            s_text = sentences[idx % len(sentences)] if sentences else base_sentence
            fallback_shots.append({
                "id": idx + 1,
                "shot_type": st,
                "camera_movement": mv,
                "camera_angle": ag,
                "visual_prompt": f"Cinematic {st}: {s_text}, anime masterpiece, highly detailed",
                "audio_prompt": "Cinematic BGM",
                "dialogue": s_text if ("：" in s_text or ":" in s_text or "“" in s_text) else None,
                "duration": 3.0,
                "negative_prompt": None
            })
        return fallback_shots

    @classmethod
    def generate_timeline(cls, content: str, character_profiles: str = "", mode: str = "narrative", token: Optional[str] = None) -> List[Dict[str, Any]]:
        # Normalize mode
        normalized_mode = mode.lower()
        if normalized_mode in ("cinematic_grid", "nine_shot_coverage"):
            target_mode = "nine_shot_coverage"
        elif normalized_mode in ("standard", "narrative"):
            target_mode = "narrative"
        else:
            target_mode = normalized_mode

        logger.info(f"Generating timeline (raw_mode={mode}, normalized={target_mode})...")
        
        if target_mode == "nine_shot_coverage":
            prompt = Prompts.generate_cinematic_grid_timeline_prompt(content, character_profiles)
        else:
            prompt = Prompts.generate_timeline(content, character_profiles)
        
        result = cls._generate_structured_with_retry(prompt, TimelineResponse, token)
        
        if result and result.shots:
            shots_data = [shot.model_dump() for shot in result.shots]
            if target_mode == "nine_shot_coverage":
                if cls._validate_nine_shot_coverage(shots_data):
                    return shots_data
                else:
                    logger.warning("LLM response for nine_shot_coverage did not pass strict 9-shot validation. Retrying or using 9-shot fallback.")
                    # Attempt dedicated retry prompt once
                    retry_prompt = prompt + "\n\nCRITICAL MANDATORY REQUIREMENT: You MUST return EXACTLY 9 shots covering the 9 shot types specified above!"
                    retry_result = cls._generate_structured_with_retry(retry_prompt, TimelineResponse, token)
                    if retry_result and retry_result.shots:
                        retry_shots = [shot.model_dump() for shot in retry_result.shots]
                        if cls._validate_nine_shot_coverage(retry_shots):
                            return retry_shots
                    return cls._generate_nine_shot_fallback(content)
            else:
                # Enforce reasonable shot limit (max 20) for narrative mode
                return shots_data[:20]

        # Mode-specific Fallback if LLM output fails completely
        if target_mode == "nine_shot_coverage":
            logger.warning("LLM structured output failed for nine_shot_coverage, using dedicated 9-shot fallback.")
            return cls._generate_nine_shot_fallback(content)
            
        logger.warning("LLM structured output failed for narrative timeline, generating fallback scenes from chapter content.")
        import re
        sentences = [s.strip() for s in re.split(r'[。！？\n]+', content) if s.strip()]
        if not sentences:
            sentences = [content[:100]]
            
        fallback_shots = []
        shot_types = ["Medium Shot", "Close-Up", "Long Shot", "Medium Shot"]
        movements = ["Static", "Pan", "Tracking", "Zoom In"]
        angles = ["Eye-level", "Low Angle", "High Angle", "Eye-level"]
        
        for idx, sentence in enumerate(sentences[:10]):
            fallback_shots.append({
                "id": idx + 1,
                "shot_type": shot_types[idx % len(shot_types)],
                "camera_movement": movements[idx % len(movements)],
                "camera_angle": angles[idx % len(angles)],
                "visual_prompt": f"Cinematic shot: {sentence}, anime masterpiece, highly detailed",
                "audio_prompt": "Cinematic BGM",
                "dialogue": sentence if "：" in sentence or ":" in sentence or "“" in sentence else None,
                "duration": 3.0,
                "negative_prompt": None
            })
        return fallback_shots

    @classmethod
    def generate_scene_coverage(cls, scene_data: Dict[str, Any], character_profiles: str = "", token: Optional[str] = None) -> List[Dict[str, Any]]:
        raw_prompt = scene_data.get("visual_prompt", "")
        dialogue = scene_data.get("dialogue", "")
        logger.info(f"Generating single-scene 9-shot coverage for prompt: {raw_prompt[:40]}...")
        
        prompt = Prompts.generate_scene_coverage_prompt(raw_prompt, dialogue, character_profiles)
        result = cls._generate_structured_with_retry(prompt, TimelineResponse, token)
        
        if result and result.shots:
            shots_data = [shot.model_dump() for shot in result.shots]
            if cls._validate_nine_shot_coverage(shots_data):
                # Ensure slot is mapped
                for i, s in enumerate(shots_data):
                    s["slot"] = i + 1
                    s["shot_size"] = s.get("shot_type") or "Medium Shot"
                return shots_data

        logger.warning("LLM structured output for single-scene coverage failed or incomplete. Generating dedicated 9-candidate fallback.")
        nine_specs = [
            ("Extreme Long Shot", "Static", "Eye-level", "Establishing environment and spatial context"),
            ("Long Shot", "Static", "Eye-level", "Full body silhouette and posture"),
            ("Medium Long Shot", "Pan", "Eye-level", "Knees-up composition"),
            ("Medium Shot", "Static", "Eye-level", "Waist-up main action beat"),
            ("Medium Close-Up", "Zoom In", "Eye-level", "Chest-up emotion and reaction"),
            ("Close-Up", "Static", "Eye-level", "Tight facial expression"),
            ("Extreme Close-Up", "Static", "Eye-level", "Macro detail of eye, hand, or key prop"),
            ("Medium Shot", "Static", "Low Angle", "Dramatic low-angle view"),
            ("Long Shot", "Static", "High Angle", "High-angle overview of space"),
        ]
        
        fallback_shots = []
        for idx, (st, mv, ag, purpose) in enumerate(nine_specs):
            fallback_shots.append({
                "slot": idx + 1,
                "shot_type": st,
                "shot_size": st,
                "camera_movement": mv,
                "camera_angle": ag,
                "narrative_purpose": purpose,
                "visual_prompt": f"({st}, {ag}), {raw_prompt}",
                "audio_prompt": scene_data.get("audio_prompt", "Cinematic BGM"),
                "dialogue": dialogue,
                "duration": scene_data.get("duration", 3.0),
                "negative_prompt": scene_data.get("negative_prompt", None)
            })
        return fallback_shots

    @classmethod
    def extract_character_profiles(cls, content: str, token: Optional[str] = None) -> List[Dict[str, Any]]:
        logger.info("Extracting character profiles...")
        prompt = Prompts.extract_character_profiles(content)
        
        # Wrapped in CharacterProfilesResponse
        result = cls._generate_structured_with_retry(prompt, CharacterProfilesResponse, token)
        
        if result:
            return [profile.model_dump() for profile in result.profiles]
        return []

    @classmethod
    def generate_storyboard_grid(cls, story_text: str, token: Optional[str] = None) -> str:
        logger.info("Generating cinematic storyboard grid prompt...")
        prompt = Prompts.generate_storyboard_grid_prompt(story_text)
        
        provider = cls._get_provider(token)
        try:
            text = provider.generate_text(prompt)
            return text
        except Exception as e:
            logger.error(f"Storyboard grid generation failed: {e}")
            return f"[LLM Error] Could not generate storyboard grid. Error: {e}"

    @classmethod
    def analyze_character_evolution(cls, character_data: Dict[str, Any], new_text: str, token: Optional[str] = None) -> Dict[str, Any]:

        """
        Analyzes if a character's appearance has changed.
        """
        logger.info(f"Analyzing character evolution for: {character_data.get('name', 'Unknown')}")
        char_json_str = json.dumps(character_data, indent=2)
        prompt = Prompts.analyze_character_evolution(char_json_str, new_text)
        
        result = cls._generate_structured_with_retry(prompt, CharacterEvolution, token)
        
        if result:
            return result.model_dump()
        return {"action": "keep_current", "reason": "LLM failed to respond"}
