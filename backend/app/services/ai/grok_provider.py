import requests
import logging
import time
from typing import Dict, Any, Optional
from app.services.ai.base import AIProvider

logger = logging.getLogger(__name__)

class GrokProvider(AIProvider):
    MAX_RETRIES = 3
    BASE_RETRY_DELAY = 2

    def __init__(self, api_key: str, model: str = "grok-beta"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://api.x.ai/v1"

    def _call_api(self, url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        retries = 0
        while retries < self.MAX_RETRIES:
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=60)
                response.raise_for_status()
                return response.json()
            except requests.exceptions.RequestException as e:
                wait_time = self.BASE_RETRY_DELAY * (2 ** retries)
                logger.warning(f"Grok API Error: {e}. Retrying in {wait_time}s...")
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
            logger.error(f"Failed to parse Grok response: {e}")
            return ""

    async def generate_image(self, prompt: str, size: str = "1024x1024", token: Optional[str] = None) -> Dict[str, Any]:
        # Grok/xAI Image generation API details are not fully standardized yet.
        # Placeholder.
        logger.warning("Grok Image Generation is not yet implemented.")
        return {"error": "Grok Image Generation not supported yet."}
