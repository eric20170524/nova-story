from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List, Type, TypeVar
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

class AIProvider(ABC):
    @abstractmethod
    def generate_text(self, prompt: str, system_instruction: Optional[str] = None) -> str:
        """Generates text based on the prompt."""
        pass

    @abstractmethod
    def generate_structured(self, prompt: str, response_model: Type[T], system_instruction: Optional[str] = None) -> T:
        """Generates structured output based on the prompt and Pydantic model."""
        pass

    @abstractmethod
    async def generate_image(self, prompt: str, size: str = "1024x1024", token: Optional[str] = None) -> Dict[str, Any]:
        """
        Generates an image based on the prompt.
        Returns a dict containing either:
        - "url": url to the image
        - "b64_json": base64 encoded image
        - "data": binary data
        """
        pass
