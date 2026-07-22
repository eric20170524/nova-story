import logging
import asyncio
from typing import Dict, Any, Optional
from app.core.config import settings
from app.services.ai.base import AIProvider
from app.services.ai.gemini_provider import GeminiProvider
from app.services.ai.openai_provider import OpenAIProvider
from app.services.ai.grok_provider import GrokProvider
from app.services.ai.nebula_provider import NebulaProvider

logger = logging.getLogger(__name__)

class MediaService:
    def __init__(self):
        self.provider_name = settings.AI_IMAGE_PROVIDER.lower()
        self.provider = self._get_provider(self.provider_name)

    def _get_provider(self, name: str) -> AIProvider:
        if name == "gemini":
            return GeminiProvider(api_key=settings.GEMINI_API_KEY)
        elif name == "openai":
            return OpenAIProvider(api_key=settings.OPENAI_API_KEY)
        elif name == "grok":
            return GrokProvider(api_key=settings.GROK_API_KEY)
        elif name == "nebula":
            return NebulaProvider()
        else:
            logger.warning(f"Unknown provider '{name}', defaulting to Gemini.")
            return GeminiProvider(api_key=settings.GEMINI_API_KEY)

    async def generate_image(self, prompt: str, size: str = "1024x1024", progress_callback=None, token: Optional[str] = None) -> Dict[str, Any]:
        """
        Generates an image using the configured provider.
        
        :param prompt: Text description of the image.
        :param size: Image resolution.
        :param progress_callback: async function(type, data) to report progress.
        :param token: User token for billing (Nebula provider only).
        """
        logger.info(f"Generating image via {self.provider_name} with prompt: {prompt[:50]}...")
        
        if progress_callback:
            await progress_callback("started", {"provider": self.provider_name})

        try:
            # Call async provider directly
            # Note: providers should now implement async generate_image
            result = await self.provider.generate_image(prompt, size, token=token)
            
            if "error" in result:
                 return {"status": "error", "message": result["error"]}
            
            # Unify output structure to match what tasks/assets.py expects
            # tasks/assets.py expects: {"status": "completed", "images": [{"data": bytes} OR {"url": str}]}
            
            images = []
            if "url" in result:
                # We have a URL. Download it using async client.
                import httpx
                try:
                    async with httpx.AsyncClient() as client:
                        resp = await client.get(result["url"], timeout=60)
                        if resp.status_code == 200:
                            images.append({"filename": "generated.png", "data": resp.content})
                        else:
                            return {"status": "error", "message": "Failed to download image from provider URL."}
                except Exception as e:
                     return {"status": "error", "message": f"Download error: {e}"}

            elif "b64_json" in result:
                import base64
                img_data = base64.b64decode(result["b64_json"])
                images.append({"filename": "generated.png", "data": img_data})
            
            elif "data" in result:
                 images.append({"filename": "generated.png", "data": result["data"]})
            
            elif "images" in result:
                 # Provider already returned the standardized format
                 images.extend(result["images"])

            return {"status": "completed", "images": images}

        except Exception as e:
            logger.error(f"Media generation failed: {e}")
            return {"status": "error", "message": str(e)}
