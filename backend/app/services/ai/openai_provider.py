import requests
import logging
import time
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
                response = requests.post(url, json=payload, headers=headers, timeout=60)
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
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

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
        
        # Fallback if json_schema is rejected by local OpenAI API proxy (e.g. Ollama)
        if not data:
            payload["response_format"] = {"type": "json_object"}
            data = self._call_api(url, payload)
            
        if not data:
             raise ValueError("No response from OpenAI / Ollama API")

        try:
            content = data["choices"][0]["message"]["content"]
            if not content:
                raise ValueError("Empty content from OpenAI / Ollama API")
            
            # Clean markdown codeblocks ```json ... ``` if local LLM returns markdown wrapped text
            cleaned_content = content.strip()
            if cleaned_content.startswith("```"):
                lines = cleaned_content.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                cleaned_content = "\n".join(lines).strip()

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
