import requests
import logging
import time
import json
import re
from typing import Dict, Any, Optional, Type, TypeVar
from pydantic import BaseModel
from app.services.ai.base import AIProvider

T = TypeVar("T", bound=BaseModel)
logger = logging.getLogger(__name__)


class GrokProvider(AIProvider):
    """xAI Grok chat API (OpenAI-compatible)."""

    MAX_RETRIES = 3
    BASE_RETRY_DELAY = 2

    def __init__(self, api_key: str, model: str = "grok-3"):
        self.api_key = api_key
        self.model = model or "grok-3"
        self.base_url = "https://api.x.ai/v1"

    def _call_api(self, url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        retries = 0
        while retries < self.MAX_RETRIES:
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=180)
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

        payload = {"model": self.model, "messages": messages}
        data = self._call_api(url, payload)
        if not data:
            return ""

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            logger.error(f"Failed to parse Grok response: {e}")
            return ""

    def generate_structured(
        self,
        prompt: str,
        response_model: Type[T],
        system_instruction: Optional[str] = None,
    ) -> T:
        """Structured JSON via xAI chat completions + local parse/validate."""
        schema = response_model.model_json_schema()
        sys_prompt = system_instruction or (
            "You are a precise JSON generator for film storyboards. "
            "Respond with ONLY valid JSON matching the requested schema. No markdown."
        )
        user_content = (
            f"{prompt}\n\n"
            f"Return ONLY a valid JSON object matching this schema:\n"
            f"{json.dumps(schema, ensure_ascii=False)}\n"
        )
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ]
        # Prefer json_object when supported; fall back without format constraint
        url = f"{self.base_url}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }
        data = self._call_api(url, payload)
        if not data:
            payload.pop("response_format", None)
            data = self._call_api(url, payload)
        if not data:
            raise ValueError("No response from Grok API")

        try:
            content = data["choices"][0]["message"].get("content") or ""
            cleaned = content.strip()
            codeblock = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.I)
            if codeblock:
                cleaned = codeblock.group(1).strip()
            if not (cleaned.startswith("{") or cleaned.startswith("[")):
                start_obj, start_arr = cleaned.find("{"), cleaned.find("[")
                starts = [i for i in (start_obj, start_arr) if i != -1]
                if starts:
                    start_idx = min(starts)
                    end_idx = max(cleaned.rfind("}"), cleaned.rfind("]"))
                    if end_idx > start_idx:
                        cleaned = cleaned[start_idx : end_idx + 1]

            try:
                import json_repair

                parsed = json_repair.repair_json(cleaned, return_objects=True)
            except Exception:
                parsed = json.loads(cleaned)

            field_names = list(getattr(response_model, "model_fields", {}).keys())
            if isinstance(parsed, list):
                if "shots" in field_names:
                    parsed = {"shots": parsed}
                elif "profiles" in field_names:
                    parsed = {"profiles": parsed}
                elif len(field_names) == 1:
                    parsed = {field_names[0]: parsed}
            elif isinstance(parsed, dict):
                for fn in field_names:
                    if fn not in parsed:
                        for k, v in list(parsed.items()):
                            if isinstance(v, list) and k != fn:
                                parsed[fn] = v
                                break

            return response_model.model_validate(parsed)
        except Exception as e:
            logger.error(f"Failed to parse Grok structured response: {e}")
            raise ValueError(f"Failed to parse Grok response: {e}") from e

    async def generate_image(
        self, prompt: str, size: str = "1024x1024", token: Optional[str] = None
    ) -> Dict[str, Any]:
        logger.warning("Grok Image Generation is not yet implemented.")
        return {"error": "Grok Image Generation not supported yet."}
