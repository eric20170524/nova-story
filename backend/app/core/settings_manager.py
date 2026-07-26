import json
import os
from typing import Dict, Any
import dotenv

SETTINGS_FILE = "system_settings.json"
ENV_FILE = ".env"

DEFAULT_SETTINGS = {
    "llm_model": "gemini-2.5-flash",
    "image_model": "gemini-2.5-flash-image",
    "comfyui": {
        "base_url": "http://127.0.0.1:8188",
        "enabled": False,
        "selected_workflow_file": None,
        "install_path": "D:\\ComfyUI"
    },
    "llm": {
        "provider": "gemini",
        "api_key": "",
        "base_url": "",
        "model": "gemini-2.5-flash"
    }
}

class SettingsManager:
    @classmethod
    def _get_file_path(cls) -> str:
        # Resolves to backend/system_settings.json assuming this file is in backend/app/core/
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(base_dir, SETTINGS_FILE)

    @classmethod
    def _get_env_path(cls) -> str:
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(base_dir, ENV_FILE)

    @classmethod
    def load_settings(cls) -> Dict[str, Any]:
        file_path = cls._get_file_path()
        env_path = cls._get_env_path()
        settings = DEFAULT_SETTINGS.copy()
        
        # 1. Load from file first
        if os.path.exists(file_path):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    file_settings = json.load(f)
                    # Deep merge for nested dictionaries
                    for key, value in file_settings.items():
                        if key in settings and isinstance(settings[key], dict) and isinstance(value, dict):
                            settings[key].update(value)
                        else:
                            settings[key] = value
            except (json.JSONDecodeError, IOError):
                pass

        # 2. Load from .env and apply overrides
        if os.path.exists(env_path):
            dotenv.load_dotenv(env_path)

        llm_provider_env = os.getenv("LLM_PROVIDER")
        if llm_provider_env:
            if "llm" not in settings:
                settings["llm"] = {}
            settings["llm"]["provider"] = llm_provider_env

        llm_api_key_env = os.getenv("LLM_API_KEY")
        if llm_api_key_env:
            if "llm" not in settings:
                settings["llm"] = {}
            settings["llm"]["api_key"] = llm_api_key_env
            
        llm_base_url_env = os.getenv("LLM_BASE_URL")
        if llm_base_url_env:
            if "llm" not in settings:
                settings["llm"] = {}
            settings["llm"]["base_url"] = llm_base_url_env

        llm_model_env = os.getenv("LLM_MODEL")
        if llm_model_env:
            if "llm" not in settings:
                settings["llm"] = {}
            settings["llm"]["model"] = llm_model_env

        return settings

    @classmethod
    def get(cls, key: str, default: Any = None) -> Any:
        settings = cls.load_settings()
        return settings.get(key, default)

    @classmethod
    def save_settings(cls, new_settings: Dict[str, Any]) -> Dict[str, Any]:
        current_settings = cls.load_settings()
        env_path = cls._get_env_path()
        
        # Ensure .env exists
        if not os.path.exists(env_path):
            open(env_path, 'a').close()
            
        # Extract secrets to .env
        if "llm" in new_settings:
            llm_settings = new_settings["llm"]
            
            # API Key
            if "api_key" in llm_settings:
                # Set in .env
                api_key = llm_settings["api_key"]
                if api_key: # Only save if not empty, or overwrite even if empty?
                    dotenv.set_key(env_path, "LLM_API_KEY", api_key)
                # Remove from new_settings so it doesn't go to json
                # Create a copy so we don't modify the input dict unexpectedly
                llm_settings_copy = llm_settings.copy()
                llm_settings_copy.pop("api_key", None)
                new_settings = new_settings.copy()
                new_settings["llm"] = llm_settings_copy

            # Optional: base_url to .env too if you want, but for now we do api_key
            
        # Now update current_settings with the safe new_settings
        # Need deep update so we don't overwrite the whole 'llm' dict
        for key, value in new_settings.items():
            if key in current_settings and isinstance(current_settings[key], dict) and isinstance(value, dict):
                current_settings[key].update(value)
            else:
                current_settings[key] = value

        # Remove api_key from current_settings if it's there before saving to JSON
        json_settings_to_save = current_settings.copy()
        if "llm" in json_settings_to_save and "api_key" in json_settings_to_save["llm"]:
            json_settings_to_save["llm"] = json_settings_to_save["llm"].copy()
            json_settings_to_save["llm"]["api_key"] = ""

        file_path = cls._get_file_path()
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(json_settings_to_save, f, indent=4)
        except IOError as e:
            print(f"Error saving settings: {e}")
            pass
            
        # Return the merged settings including the secrets (which are now in current_settings or loaded from env)
        # Re-load to ensure we return exactly what's persisted/in-env
        return cls.load_settings()
