from fastapi import APIRouter, HTTPException
from typing import Dict, Any
from app.core.settings_manager import SettingsManager
from app.services.ai.gemini_provider import GeminiProvider
from app.services.ai.openai_provider import OpenAIProvider
from app.services.ai.grok_provider import GrokProvider
from app.core.config import settings as app_settings

router = APIRouter()

@router.get("/", response_model=Dict[str, Any])
def get_settings():
    """
    Get current system settings.
    """
    return SettingsManager.load_settings()

@router.post("/", response_model=Dict[str, Any])
def update_settings(settings: Dict[str, Any]):
    """
    Update system settings.
    """
    return SettingsManager.save_settings(settings)

@router.post("/verify-llm")
def verify_llm_connection(config: Dict[str, Any]):
    """
    Verifies LLM connection using the provided configuration.
    Expects 'llm' config dict or direct config dict containing provider, api_key, base_url, model.
    """
    llm_config = config.get("llm", config)
    provider_type = (llm_config.get("provider") or "gemini").lower()
    api_key = llm_config.get("api_key") or getattr(app_settings, "GEMINI_API_KEY", "")
    base_url = llm_config.get("base_url")
    model = llm_config.get("model") or "gemini-2.5-flash"

    try:
        if provider_type in ("openai", "custom"):
            provider = OpenAIProvider(api_key=api_key or "", model=model or "gpt-4o", base_url=base_url)
        elif provider_type == "grok":
            provider = GrokProvider(api_key=api_key or "", model=model or "grok-beta")
        else:
            provider = GeminiProvider(api_key=api_key, model=model or "gemini-2.5-flash")

        res = provider.generate_text("Test connection. Reply 'OK'.")
        if res and "[LLM Error]" not in res:
            return {"status": "success", "message": "LLM connection verified successfully", "response": res[:100]}
        else:
            raise HTTPException(status_code=400, detail=f"LLM verification failed: {res}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM verification error: {str(e)}")
