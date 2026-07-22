from typing import Dict, Any, Optional, Type, TypeVar
from pydantic import BaseModel
from app.services.ai.base import AIProvider
from app.services.nebula import NebulaClient

T = TypeVar("T", bound=BaseModel)

class NebulaProvider(AIProvider):
    def __init__(self, api_key: Optional[str] = None):
        # NebulaClient loads configuration from SettingsManager
        # api_key here is ignored as we rely on NebulaClient's token or passed token
        self.client = NebulaClient()

    def generate_text(self, prompt: str, system_instruction: Optional[str] = None, token: Optional[str] = None) -> str:
        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})
        
        return self.client.chat_completion(messages, token=token)

    def generate_structured(self, prompt: str, response_model: Type[T], system_instruction: Optional[str] = None, token: Optional[str] = None) -> T:
        """
        Simulate structured output using JSON prompting and validation.
        """
        # Append JSON instruction if not present
        if "JSON" not in prompt:
            prompt += "\n\nPlease output the result as valid JSON."
            
        text = self.generate_text(prompt, system_instruction, token=token)
        
        # Clean markdown if present
        if text:
             text = text.replace("```json", "").replace("```", "").strip()
        
        return response_model.model_validate_json(text)

    async def generate_image(self, prompt: str, size: str = "1024x1024", token: Optional[str] = None) -> Dict[str, Any]:
        import asyncio
        loop = asyncio.get_running_loop()
        def _call_client():
            return self.client.generate_image(prompt, size, token=token)
        return await loop.run_in_executor(None, _call_client)
