import requests
import json
import logging
import re
from typing import Optional, Dict, Any, List
from app.core.settings_manager import SettingsManager

logger = logging.getLogger(__name__)

class NebulaClient:
    def __init__(self, base_url: Optional[str] = None):
        self._load_config()
        if base_url:
            self.base_url = base_url

    def _load_config(self):
        self.settings = SettingsManager.get("nebula", {})
        self.base_url = self.settings.get("base_url", "https://www.chuangyi.chat/v2")
        self.token = self.settings.get("system_token", "")

    def _get_headers(self, token: Optional[str] = None) -> Dict[str, str]:
        t = token or self.token
        return {
            "Authorization": f"Bearer {t}",
            "Content-Type": "application/json"
        }

    def verify_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Verifies the token by calling /user/me"""
        url = f"{self.base_url}/api/user/me"
        try:
            response = requests.get(url, headers=self._get_headers(token))
            if response.status_code == 200:
                return response.json()
            return None
        except Exception as e:
            logger.error(f"Nebula verify error: {e}")
            return None

    def upload_file(self, file_path: str, token: Optional[str] = None) -> Optional[str]:
        """
        Uploads file.
        NOTE: API docs do not explicitly list a file upload endpoint.
        Assuming /api/upload based on common convention or previous context, 
        but flagging as potentially unsupported.
        """
        url = f"{self.base_url}/api/upload" 
        t = token or self.token
        headers = {"Authorization": f"Bearer {t}"}
        
        try:
            with open(file_path, 'rb') as f:
                files = {'file': f}
                response = requests.post(url, headers=headers, files=files)
            
            if response.status_code in [200, 201]:
                data = response.json()
                if "url" in data:
                    return data["url"]
                if "data" in data and "url" in data["data"]:
                    return data["data"]["url"]
                return str(data)
            
            # logger.error(f"Upload failed: {response.status_code} - {response.text}")
            return None
        except Exception as e:
            logger.error(f"Nebula upload error: {e}")
            return None

    def chat_completion(self, messages: List[Dict[str, str]], model: str = "nebula-default", token: Optional[str] = None) -> str:
        """
        Calls /api/chat/completions (Nebula V2).
        Consumes SSE stream to get full response.
        """
        url = f"{self.base_url}/api/chat/completions"
        
        payload = {
            "modelId": model,
            "messages": messages,
            "sessionId": "temp_session_nova_chat",
            "stream": True
        }
        
        try:
            full_text = ""
            with requests.post(url, headers=self._get_headers(token), json=payload, stream=True) as response:
                if response.status_code != 200:
                    return f"Error: {response.status_code} - {response.text}"
                
                # Parse SSE
                for line in response.iter_lines():
                    if line:
                        decoded_line = line.decode('utf-8')
                        if decoded_line.startswith('data: '):
                            json_str = decoded_line[6:]
                            if json_str.strip() == "[DONE]":
                                break
                            try:
                                data = json.loads(json_str)
                                if "text" in data:
                                    full_text += data["text"]
                                elif "content" in data: # Fallback
                                    full_text += data["content"]
                            except:
                                pass
            return full_text
            
        except Exception as e:
            logger.error(f"Nebula chat error: {e}")
            return f"Error: {str(e)}"

    def generate_image(self, prompt: str, size: str = "1024x1024", model: str = "dall-e-3", token: Optional[str] = None) -> Dict[str, Any]:
        """
        Calls /api/chat/completions with an image model to generate image.
        Synchronous blocking call that consumes SSE stream until image URL is found in markdown.
        """
        url = f"{self.base_url}/api/chat/completions"
        
        # Nebula V2 triggers image generation via chat completion with specific models
        payload = {
            "modelId": model,
            "messages": [{"role": "user", "content": prompt}],
            "sessionId": "temp_session_image_gen",
            "stream": True
        }
        
        try:
            logger.info(f"NebulaClient: Requesting image from {url} with model {model}")
            # Use longer timeout for image generation
            with requests.post(url, headers=self._get_headers(token), json=payload, stream=True, timeout=120) as response:
                if response.status_code != 200:
                    logger.error(f"Nebula Image Gen Error: {response.status_code} - {response.text}")
                    return {"error": f"API Error: {response.status_code}", "details": response.text}
                
                full_text = ""
                for line in response.iter_lines():
                    if line:
                        decoded_line = line.decode('utf-8')
                        if decoded_line.startswith('data: '):
                            json_str = decoded_line[6:]
                            # Check for DONE signal
                            if json_str.strip() == "[DONE]":
                                break
                                
                            try:
                                data = json.loads(json_str)
                                
                                # Nebula TaskHandler returns {"text": "..."} where text contains markdown image
                                if "text" in data:
                                    chunk = data["text"]
                                    full_text += chunk
                                    
                                    # Try to extract image URL from markdown: ![Generated](url)
                                    match = re.search(r'!\[.*?\]\((.*?)\)', full_text)
                                    if match:
                                        img_url = match.group(1)
                                        logger.info(f"Nebula Image Generated: {img_url}")
                                        return {"status": "completed", "url": img_url, "images": [{"url": img_url}]}
                                     
                            except json.JSONDecodeError:
                                pass
            
            return {"error": "Stream ended but no image was found in response."}
            
        except Exception as e:
            logger.error(f"Nebula Image Gen Exception: {e}")
            return {"error": str(e)}
