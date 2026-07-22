from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    PROJECT_NAME: str = "NovaStory"
    
    # Database
    DATABASE_URL: str = "sqlite:///./sql_app.db"
    
    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    
    # AI Providers
    AI_IMAGE_PROVIDER: str = "gemini" # gemini, openai, grok
    
    # Google Gemini
    GEMINI_API_KEY: str = ""
    GOOGLE_CLOUD_PROJECT_ID: Optional[str] = None
    
    # OpenAI
    OPENAI_API_KEY: str = ""
    
    # Grok (xAI)
    GROK_API_KEY: str = ""

    # Nebula V2 Integration
    NEBULA_API_URL: str = "https://api.chuangyi.chat/api/v1"
    NEBULA_JWT_SECRET: str = "" # Must match Nebula V2 Backend

    class Config:
        case_sensitive = True
        env_file = ".env"
        env_file_encoding = 'utf-8'
        extra = "ignore"

settings = Settings()