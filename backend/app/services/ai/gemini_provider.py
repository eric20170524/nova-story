import requests
import logging
import time
import json
from typing import Dict, Any, Optional, Type, TypeVar
from pydantic import BaseModel
from app.core.config import settings
from app.core.settings_manager import SettingsManager
from app.core.log_utils import format_log_message
from app.services.ai.base import AIProvider

T = TypeVar("T", bound=BaseModel)

logger = logging.getLogger(__name__)

class GeminiProvider(AIProvider):
    MAX_RETRIES = 3
    BASE_RETRY_DELAY = 2

    def __init__(self, api_key: str, model: str = "gemini-1.5-flash"):
        self.api_key = api_key
        self.model = model

    def _get_url(self, model: Optional[str] = None) -> str:
        target_model = model or self.model
        return f"https://generativelanguage.googleapis.com/v1beta/models/{target_model}:generateContent?key={self.api_key}"

    def _call_with_retry(self, url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        headers = {"Content-Type": "application/json"}
        retries = 0
        
        logger.debug(format_log_message("Gemini Request Payload", payload, max_length=1000))
        
        while retries < self.MAX_RETRIES:
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=60)
                response.raise_for_status()
                data = response.json()
                logger.debug(format_log_message("Gemini Response Data", data, max_length=1000))
                return data
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 429:
                    wait_time = self.BASE_RETRY_DELAY * (2 ** retries)
                    logger.warning(f"Gemini API rate limit (429). Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                    retries += 1
                else:
                    logger.error(f"Gemini API HTTP Error: {e.response.status_code} - {e.response.text}")
                    return None
            except requests.exceptions.RequestException as e:
                wait_time = self.BASE_RETRY_DELAY * (2 ** retries)
                logger.warning(f"Gemini API Network Error: {e}. Retrying in {wait_time}s...")
                time.sleep(wait_time)
                retries += 1
            except Exception as e:
                logger.error(f"Unexpected error calling Gemini API: {e}")
                return None
        return None

    def generate_text(self, prompt: str, system_instruction: Optional[str] = None) -> str:
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }
        if system_instruction:
             payload["system_instruction"] = {"parts": [{"text": system_instruction}]}

        url = self._get_url()
        data = self._call_with_retry(url, payload)
        
        if not data:
            return ""
            
        try:
            if "candidates" in data and data["candidates"]:
                parts = data["candidates"][0]["content"]["parts"]
                if parts:
                    return parts[0]["text"]
            return ""
        except (KeyError, IndexError, TypeError) as e:
            logger.error(f"Failed to parse Gemini response: {e}. Data: {data}")
            return ""

    def _resolve_schema_refs(self, schema: Dict[str, Any], defs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Recursively resolves $ref in JSON schema by replacing them with the definition.
        Gemini API does not support $defs/$ref in responseSchema.
        """
        if defs is None:
            defs = schema.get("$defs") or schema.get("definitions", {})

        if isinstance(schema, dict):
            if "$ref" in schema:
                ref_path = schema["$ref"]
                # Assume local ref like #/$defs/ModelName or #/definitions/ModelName
                model_name = ref_path.split("/")[-1]
                if model_name in defs:
                    # Get the definition
                    definition = defs[model_name]
                    # Recursively resolve refs in the definition itself
                    resolved_def = self._resolve_schema_refs(definition, defs)
                    return resolved_def
                else:
                    return schema
            
            # Recurse into dict values
            new_schema = {}
            for k, v in schema.items():
                if k == "$defs" or k == "definitions":
                    continue # Skip definitions in output
                new_schema[k] = self._resolve_schema_refs(v, defs)
            return new_schema
        
        elif isinstance(schema, list):
            # Recurse into list items
            return [self._resolve_schema_refs(item, defs) for item in schema]
        
        return schema

    def generate_structured(self, prompt: str, response_model: Type[T], system_instruction: Optional[str] = None) -> T:
        """
        Generates structured output using Gemini's native JSON mode.
        """
        raw_schema = response_model.model_json_schema()
        # Resolve references to make it compatible with Gemini API
        schema = self._resolve_schema_refs(raw_schema)
        
        # Create generation config with schema
        generation_config = {
            "response_mime_type": "application/json",
            "response_schema": schema
        }
        
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": generation_config
        }
        
        if system_instruction:
             payload["system_instruction"] = {"parts": [{"text": system_instruction}]}

        url = self._get_url()
        data = self._call_with_retry(url, payload)
        
        if not data:
            raise ValueError("No response from Gemini API")
            
        try:
            if "candidates" in data and data["candidates"]:
                candidate = data["candidates"][0]
                if "finishReason" in candidate and candidate["finishReason"] not in ["STOP", "MAX_TOKENS"]:
                     logger.warning(f"Gemini stopped with reason: {candidate['finishReason']}")
                
                parts = candidate["content"]["parts"]
                if parts:
                    text_response = parts[0]["text"]
                    return response_model.model_validate_json(text_response)
            raise ValueError("Empty or invalid response structure from Gemini API")
        except (KeyError, IndexError, TypeError) as e:
            logger.error(f"Failed to parse Gemini response: {e}. Data: {data}")
            raise ValueError(f"Failed to parse Gemini response: {e}")

    async def generate_image(self, prompt: str, size: str = "1024x1024", token: Optional[str] = None) -> Dict[str, Any]:
        """
        Generates an image using Gemini Image Generation models (e.g., gemini-2.5-flash-image).
        Async wrapper around sync implementation.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._generate_image_sync, prompt, size)

    def _generate_image_sync(self, prompt: str, size: str = "1024x1024") -> Dict[str, Any]:
        """
        Generates an image using Gemini Image Generation models (e.g., gemini-2.5-flash-image).
        """
        # Determine model from settings or default
        settings = SettingsManager.load_settings()
        image_model = settings.get("image_model", "gemini-2.5-flash-image")
        
        logger.info(f"Generating image with Gemini model: {image_model}")

        # Check if using Imagen models (which use :predict) or Gemini models (which use :generateContent)
        if "imagen" in image_model or "veo" in image_model:
             # Use legacy predict endpoint for Imagen
             url = f"https://generativelanguage.googleapis.com/v1beta/models/{image_model}:predict?key={self.api_key}"
             payload = {
                "instances": [{"prompt": prompt}],
                "parameters": {"sampleCount": 1}
             }
             is_predict = True
        else:
             # Use generateContent for Gemini Image models
             url = f"https://generativelanguage.googleapis.com/v1beta/models/{image_model}:generateContent?key={self.api_key}"
             payload = {
                "contents": [{"parts": [{"text": prompt}]}]
             }
             is_predict = False

        try:
            headers = {"Content-Type": "application/json"}
            print(f"DEBUG: Sending Gemini Image Request to: {url}")
            print(f"DEBUG: Payload: {json.dumps(payload)}")
            
            logger.info(f"Sending Gemini Image Request to: {url}")
            logger.debug(f"Payload: {json.dumps(payload)}")
            
            response = requests.post(url, json=payload, headers=headers, timeout=60)
            
            if response.status_code != 200:
                print(f"DEBUG: Gemini Image API Error: {response.status_code} - {response.text}")
                logger.error(f"Gemini Image API Error: {response.status_code} - {response.text}")
                return self._generate_placeholder(prompt)
                
            data = response.json()
            
            if is_predict:
                # ... (Imagen parsing logic remains same)
                if "predictions" in data and data["predictions"]:
                    b64_data = data["predictions"][0].get("bytesBase64Encoded") or data["predictions"][0].get("image", {}).get("bytesBase64Encoded")
                    if b64_data:
                        import base64
                        try:
                            img_bytes = base64.b64decode(b64_data)
                            return {"status": "completed", "images": [{"data": img_bytes}]}
                        except Exception as e:
                            logger.error(f"Failed to decode base64 image: {e}")
            else:
                # Parse Gemini generateContent response
                # Look for inline_data in candidates
                if "candidates" in data and data["candidates"]:
                    candidate = data["candidates"][0]
                    # Check for safety ratings or finish reason
                    if "finishReason" in candidate and candidate["finishReason"] != "STOP":
                        msg = f"Gemini Generation stopped. Reason: {candidate.get('finishReason')}. Safety: {candidate.get('safetyRatings')}"
                        print(f"DEBUG: {msg}")
                        logger.warning(msg)
                    
                    parts = candidate.get("content", {}).get("parts", [])
                    for part in parts:
                        # Check for text refusal
                        if "text" in part:
                            print(f"DEBUG: Gemini Text Response: {part['text']}")
                            logger.warning(f"Gemini returned text instead of image: {part['text']}")

                        # Check for both snake_case (standard Python client) and camelCase (raw API)
                        inline_data = part.get("inlineData") or part.get("inline_data")
                        
                        if inline_data:
                             b64_data = inline_data.get("data")
                             if b64_data:
                                import base64
                                try:
                                    img_bytes = base64.b64decode(b64_data)
                                    return {"status": "completed", "images": [{"data": img_bytes}]}
                                except Exception as e:
                                    logger.error(f"Failed to decode base64 image: {e}")
            
            # Helper function for debug output truncation
            def truncate_long_strings(obj):
                if isinstance(obj, dict):
                    return {k: truncate_long_strings(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [truncate_long_strings(i) for i in obj]
                elif isinstance(obj, str) and len(obj) > 100:
                    return obj[:50] + "...(truncated)"
                return obj
            
            truncated_data = truncate_long_strings(data)
            print("DEBUG: No image data found in Gemini response.")
            print(f"DEBUG: Full Gemini Response: {json.dumps(truncated_data, indent=2)}")
            
            logger.warning("No image data found in Gemini response.")
            logger.info(f"Full Gemini Response: {json.dumps(truncated_data, indent=2)}") 
            return self._generate_placeholder(prompt)

        except Exception as e:
            logger.error(f"Gemini Image Generation Exception: {e}")
            return self._generate_placeholder(prompt)

    def _generate_placeholder(self, prompt: str) -> Dict[str, Any]:
        logger.warning("Gemini Image Generation: Returning placeholder.")
        import urllib.parse
        encoded_prompt = urllib.parse.quote(prompt[:20])
        url = f"https://placehold.co/1024x1024/1e293b/6366f1.png?text=Gemini+Mock:+{encoded_prompt}"
        
        return {
            "status": "completed",
            "url": url,
            "images": [{"url": url}]
        }
