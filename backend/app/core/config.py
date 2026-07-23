import os
from pydantic_settings import BaseSettings
from typing import Optional

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DB_FILE = os.path.join(BACKEND_DIR, "sql_app.db").replace("\\", "/")

class Settings(BaseSettings):
    PROJECT_NAME: str = "NovaStory"
    
    # Database (Defaults to absolute path of sql_app.db in backend directory)
    DATABASE_URL: str = f"sqlite:///{DEFAULT_DB_FILE}"
    
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