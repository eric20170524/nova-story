import json
import os
from typing import Dict, Any

SETTINGS_FILE = "system_settings.json"

DEFAULT_SETTINGS = {
    "llm_model": "gemini-3-flash-preview",
    "image_model": "gemini-2.5-flash-image",
    "comfyui": {
        "base_url": "http://127.0.0.1:8188",
        "enabled": False,
        "selected_workflow_file": None
    },
    "nebula": {
        "enabled": False,
        "base_url": "https://www.chuangyi.chat/v2",
        "system_token": "" 
    }
}

class SettingsManager:
    @classmethod
    def _get_file_path(cls) -> str:
        # Resolves to backend/system_settings.json assuming this file is in backend/app/core/
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(base_dir, SETTINGS_FILE)

    @classmethod
    def load_settings(cls) -> Dict[str, Any]:
        file_path = cls._get_file_path()
        settings = DEFAULT_SETTINGS.copy()
        
        # Apply environment variable overrides (as defaults before file load)
        # This allows Docker/Env vars to set initial state, but file settings (user saves) take precedence.
        nebula_enabled_env = os.getenv("NEBULA_ENABLED")
        if nebula_enabled_env is not None:
            is_enabled = nebula_enabled_env.lower() in ('true', '1', 'yes', 'on')
            if "nebula" not in settings:
                settings["nebula"] = {}
            settings["nebula"]["enabled"] = is_enabled
            
        nebula_base_url = os.getenv("NEBULA_BASE_URL")
        if nebula_base_url:
            if "nebula" not in settings:
                settings["nebula"] = {}
            settings["nebula"]["base_url"] = nebula_base_url
            
        nebula_token = os.getenv("NEBULA_SYSTEM_TOKEN")
        if nebula_token:
            if "nebula" not in settings:
                settings["nebula"] = {}
            settings["nebula"]["system_token"] = nebula_token
        
        if os.path.exists(file_path):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    file_settings = json.load(f)
                    # Deep merge for nested dictionaries like 'comfyui'
                    for key, value in file_settings.items():
                        if key in settings and isinstance(settings[key], dict) and isinstance(value, dict):
                            settings[key].update(value)
                        else:
                            settings[key] = value
            except (json.JSONDecodeError, IOError):
                pass
                
        return settings

    @classmethod
    def get(cls, key: str, default: Any = None) -> Any:
        settings = cls.load_settings()
        return settings.get(key, default)

    @classmethod
    def save_settings(cls, new_settings: Dict[str, Any]) -> Dict[str, Any]:
        current_settings = cls.load_settings()
        current_settings.update(new_settings)
        
        file_path = cls._get_file_path()
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(current_settings, f, indent=4)
        except IOError as e:
            print(f"Error saving settings: {e}")
            # In a real app, you might want to log this or raise HTTP exception
            pass
            
        return current_settings
