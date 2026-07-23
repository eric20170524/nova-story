import requests
import logging
import time
import json
from typing import Dict, Any, Optional, Type, TypeVar
from pydantic import BaseModel
from app.core.log_utils import format_log_message
from app.services.ai.base import AIProvider

T = TypeVar("T", bound=BaseModel)

logger = logging.getLogger(__name__)

class OpenAIProvider(AIProvider):
    MAX_RETRIES = 3
    BASE_RETRY_DELAY = 2

    def __init__(self, api_key: str, model: str = "gpt-4-turbo", base_url: Optional[str] = None):
        self.api_key = api_key
        self.model = model
        base = (base_url or "https://api.openai.com/v1").rstrip("/")
        self.base_url = base
        self.image_model = "dall-e-3"

    def _call_api(self, url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        retries = 0
        
        logger.debug(format_log_message("OpenAI Request Payload", payload, max_length=1000))
        
        while retries < self.MAX_RETRIES:
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=300)
                response.raise_for_status()
                data = response.json()
                logger.debug(format_log_message("OpenAI Response Data", data, max_length=1000))
                return data
            except requests.exceptions.RequestException as e:
                wait_time = self.BASE_RETRY_DELAY * (2 ** retries)
                logger.warning(f"OpenAI API Error: {e}. Retrying in {wait_time}s...")
                time.sleep(wait_time)
                retries += 1
        return None

    def generate_text(self, prompt: str, system_instruction: Optional[str] = None) -> str:
        url = f"{self.base_url}/chat/completions"
        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages
        }

        data = self._call_api(url, payload)
        if not data:
            return ""

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            logger.error(f"Failed to parse OpenAI response: {e}")
            return ""

    def generate_structured(self, prompt: str, response_model: Type[T], system_instruction: Optional[str] = None) -> T:
        """
        Generates structured output using OpenAI's Structured Outputs (json_schema),
        with fallback for local OpenAI-compatible providers like Ollama.
        """
        schema = response_model.model_json_schema()
        
        json_schema = {
            "name": response_model.__name__,
            "strict": False,
            "schema": schema
        }
        
        messages = []
        is_local = "127.0.0.1" in self.base_url or "localhost" in self.base_url or "11434" in self.base_url
        
        sys_prompt = system_instruction or ("You are a JSON generator. Respond only with valid JSON." if is_local else None)
        if sys_prompt:
            messages.append({"role": "system", "content": sys_prompt})
        
        user_content = prompt
        if is_local:
            user_content += "\n\nIMPORTANT: Return ONLY a valid JSON object or JSON list containing the result data."
        messages.append({"role": "user", "content": user_content})

        if is_local:
            payload = {
                "model": self.model,
                "messages": messages
            }
        else:
            payload = {
                "model": self.model,
                "messages": messages,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": json_schema
                }
            }
        
        url = f"{self.base_url}/chat/completions"
        data = self._call_api(url, payload)
        
        # Fallback if first attempt is rejected
        if not data and not is_local:
            payload["response_format"] = {"type": "json_object"}
            data = self._call_api(url, payload)
            
        if not data:
             raise ValueError("No response from OpenAI / Ollama API")

        try:
            msg = data["choices"][0]["message"]
            content = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or msg.get("thinking") or ""
            
            if not content:
                raise ValueError("Empty content from OpenAI / Ollama API")
            
            cleaned_content = content.strip()
            import re
            codeblock_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned_content, re.IGNORECASE)
            if codeblock_match:
                cleaned_content = codeblock_match.group(1).strip()

            if not (cleaned_content.startswith("{") or cleaned_content.startswith("[")):
                start_obj = cleaned_content.find("{")
                start_arr = cleaned_content.find("[")
                if start_obj != -1 or start_arr != -1:
                    valid_starts = [i for i in [start_obj, start_arr] if i != -1]
                    start_idx = min(valid_starts)
                    end_obj = cleaned_content.rfind("}")
                    end_arr = cleaned_content.rfind("]")
                    end_idx = max(end_obj, end_arr)
                    if end_idx > start_idx:
                        cleaned_content = cleaned_content[start_idx:end_idx+1]

            parsed_data = None
            try:
                import json_repair
                parsed_data = json_repair.repair_json(cleaned_content, return_objects=True)
            except Exception:
                try:
                    parsed_data = json.loads(cleaned_content)
                except Exception:
                    pass

            if parsed_data is not None:
                model_fields = getattr(response_model, 'model_fields', {})
                field_names = list(model_fields.keys())
                
                if isinstance(parsed_data, list):
                    normalized_items = []
                    for item in parsed_data:
                        if isinstance(item, dict):
                            normalized_items.append(item)
                        elif isinstance(item, str) and item.strip():
                            normalized_items.append({"visual_prompt": item.strip()})
                    if normalized_items:
                        parsed_data = normalized_items

                    if len(field_names) == 1:
                        parsed_data = {field_names[0]: parsed_data}
                    elif "shots" in field_names:
                        parsed_data = {"shots": parsed_data}
                    elif "profiles" in field_names:
                        parsed_data = {"profiles": parsed_data}

                elif isinstance(parsed_data, dict):
                    for fn in field_names:
                        if fn not in parsed_data:
                            for k, v in list(parsed_data.items()):
                                if isinstance(v, list) and k != fn:
                                    parsed_data[fn] = v
                                    break

                return response_model.model_validate(parsed_data)

            return response_model.model_validate_json(cleaned_content)
        except (KeyError, IndexError, Exception) as e:
            logger.error(f"Failed to parse OpenAI / Ollama response: {e}")
            raise ValueError(f"Failed to parse response: {e}")

    async def generate_image(self, prompt: str, size: str = "1024x1024", token: Optional[str] = None) -> Dict[str, Any]:
        """
        Async wrapper around sync implementation.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._generate_image_sync, prompt, size)

    def _generate_image_sync(self, prompt: str, size: str = "1024x1024") -> Dict[str, Any]:
        url = f"{self.base_url}/images/generations"
        payload = {
            "model": self.image_model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "response_format": "url" # or b64_json
        }

        data = self._call_api(url, payload)
        if not data:
            return {"error": "Failed to generate image"}

        try:
            # DALL-E 3 returns a list of data objects
            return {"url": data["data"][0]["url"]}
        except (KeyError, IndexError) as e:
            logger.error(f"Failed to parse OpenAI Image response: {e}")
            return {"error": str(e)}
