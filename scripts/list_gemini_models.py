import requests
import os
import json
import sys

# Add the current directory to sys.path to allow imports from backend
sys.path.append(os.getcwd())

from app.core.config import settings

def list_models():
    api_key = "AIzaSyBs4E1nTOAuK_VhQ3IQpE5weugXd5tgQjM"
    if not api_key:
        print("No GEMINI_API_KEY found in settings.")
        return

    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        response = requests.get(url)
        if response.status_code == 200:
            models = response.json().get('models', [])
            print(f"Found {len(models)} models:")
            for m in models:
                print(f"- {m['name']} (Supported methods: {m.get('supportedGenerationMethods')})")
        else:
            print(f"Error listing models: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    list_models()