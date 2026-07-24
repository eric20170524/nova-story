import json
import uuid
import websockets
import asyncio
import aiohttp
import logging
from typing import Dict, Any, Callable, Optional

import os
import subprocess

logger = logging.getLogger(__name__)

class ComfyUIService:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip('/')
        self.client_id = str(uuid.uuid4())
        self.ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://") + f"/ws?client_id={self.client_id}"

    async def check_status(self) -> bool:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.base_url}/system_stats", timeout=aiohttp.ClientTimeout(total=2)) as resp:
                    return resp.status == 200
        except Exception:
            return False

    async def ensure_running(self, timeout: int = 45) -> bool:
        """
        Ensures ComfyUI service is running. If not running, automatically launches it.
        """
        if await self.check_status():
            logger.info("ComfyUI is already running.")
            return True

        logger.info("ComfyUI is not running. Auto-starting ComfyUI service...")
        comfy_dir = r"D:\ComfyUI"
        python_exe = os.path.join(comfy_dir, "venv", "Scripts", "python.exe")
        main_py = os.path.join(comfy_dir, "main.py")

        if not os.path.exists(python_exe) or not os.path.exists(main_py):
            logger.error(f"ComfyUI executable or main.py not found at {comfy_dir}")
            return False

        try:
            cmd = [python_exe, main_py, "--listen", "127.0.0.1", "--port", "8188", "--disable-mmap"]
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            subprocess.Popen(cmd, cwd=comfy_dir, creationflags=creationflags)
            
            start_time = asyncio.get_running_loop().time()
            while asyncio.get_running_loop().time() - start_time < timeout:
                await asyncio.sleep(2)
                if await self.check_status():
                    logger.info("ComfyUI auto-started successfully and is ready.")
                    return True
            
            logger.error(f"ComfyUI did not become ready within {timeout} seconds.")
            return False
        except Exception as e:
            logger.error(f"Failed to auto-start ComfyUI: {e}")
            return False

    async def cancel_execution(self) -> bool:
        """
        Interrupts current execution and clears prompt queue in ComfyUI.
        """
        logger.info("Interrupting current ComfyUI execution and clearing queue...")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{self.base_url}/interrupt") as resp1:
                    logger.info(f"ComfyUI /interrupt response: {resp1.status}")
                async with session.post(f"{self.base_url}/queue", json={"clear": True}) as resp2:
                    logger.info(f"ComfyUI /queue clear response: {resp2.status}")
            return True
        except Exception as e:
            logger.error(f"Failed to cancel ComfyUI execution: {e}")
            return False

    @staticmethod
    def stop_comfyui():
        """
        Stops ComfyUI and frees GPU VRAM.
        """
        logger.info("Auto-stopping ComfyUI service to free GPU VRAM...")
        try:
            if os.name == 'nt':
                cmd = 'powershell -Command "Get-NetTCPConnection -LocalPort 8188 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like \'*ComfyUI*\' } | Stop-Process -Force -ErrorAction SilentlyContinue"'
                subprocess.run(cmd, shell=True, capture_output=True)
            logger.info("ComfyUI stopped.")
        except Exception as e:
            logger.error(f"Error stopping ComfyUI: {e}")

    async def generate_image(self, workflow: Dict[str, Any], progress_callback: Optional[Callable] = None) -> Dict[str, Any]:
        """
        Executes a ComfyUI workflow and returns the generated images.
        """
        logger.info(f"Starting ComfyUI generation. Client ID: {self.client_id}")
        logger.info(f"Generating image via ComfyUI with workflow: {str(workflow)[:50]}...")
        
        # 1. Connect to WebSocket
        ws = None
        try:
            ws = await websockets.connect(self.ws_url)
            logger.info("Connected to ComfyUI WebSocket")
        except Exception as e:
            logger.error(f"Failed to connect to ComfyUI WebSocket: {e}")
            return {"status": "error", "message": f"Connection Refused: {e}"}

        try:
            # 2. Queue Prompt
            prompt_id = None
            async with aiohttp.ClientSession() as session:
                payload = {
                    "prompt": workflow,
                    "client_id": self.client_id
                }
                async with session.post(f"{self.base_url}/prompt", json=payload) as resp:
                    if resp.status != 200:
                        err_text = await resp.text()
                        logger.error(f"ComfyUI /prompt Error: {resp.status} - {err_text}")
                        return {"status": "error", "message": f"Queue failed: {err_text}"}
                    
                    resp_data = await resp.json()
                    prompt_id = resp_data.get("prompt_id")
                    logger.info(f"Workflow queued. Prompt ID: {prompt_id}")

            if not prompt_id:
                return {"status": "error", "message": "No prompt_id received"}

            # 3. Listen for Execution
            generated_images = []
            current_node = ""
            
            while True:
                try:
                    try:
                        out = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        # Check history if prompt_id is completed in ComfyUI
                        if prompt_id:
                            try:
                                async with aiohttp.ClientSession() as check_session:
                                    async with check_session.get(f"{self.base_url}/history/{prompt_id}") as h_resp:
                                        if h_resp.status == 200:
                                            h_data = await h_resp.json()
                                            if prompt_id in h_data:
                                                logger.info(f"Prompt {prompt_id} confirmed completed in ComfyUI history.")
                                                break
                            except Exception:
                                pass
                        continue

                    if isinstance(out, str):
                        message = json.loads(out)
                        msg_type = message.get("type")
                        data = message.get("data", {})
                        
                        # logger.debug(f"WS Message: {msg_type}") # Verbose

                        if msg_type == "execution_start":
                            if data.get("prompt_id") == prompt_id:
                                logger.info("ComfyUI Execution Started")
                                if progress_callback:
                                    await progress_callback("started", {})

                        elif msg_type == "executing":
                            node = data.get("node")
                            if node:
                                current_node = node
                                # Try to find node title in workflow if possible
                                # logger.info(f"Executing node: {node}")
                                if progress_callback:
                                    await progress_callback("progress", {"node": node})
                            else:
                                # Execution finished (node is null)
                                logger.info("ComfyUI Execution Finished (Logic)")
                                p_id = data.get("prompt_id")
                                if not p_id or p_id == prompt_id:
                                    await asyncio.sleep(0.5)
                                    break

                        elif msg_type == "execution_cached":
                            if data.get("prompt_id") == prompt_id:
                                logger.info("ComfyUI Used Cache")

                        elif msg_type == "executed":
                            if data.get("prompt_id") == prompt_id:
                                output = data.get("output", {})
                                # Check for images
                                if "images" in output:
                                    for img_info in output["images"]:
                                        filename = img_info.get("filename")
                                        subfolder = img_info.get("subfolder", "")
                                        img_type = img_info.get("type", "output")
                                        
                                        logger.info(f"Image generated: {filename}")
                                        
                                        # Download Image
                                        img_data = await self._download_image(filename, subfolder, img_type)
                                        if img_data:
                                            generated_images.append({
                                                "filename": filename,
                                                "data": img_data
                                            })

                        elif msg_type == "status":
                             pass # Queue status updates

                        elif msg_type == "progress":
                             value = data.get("value")
                             max_val = data.get("max")
                             if progress_callback and value and max_val:
                                 await progress_callback("progress", {"current": value, "total": max_val})

                        elif msg_type == "execution_error":
                             data_prompt_id = data.get("prompt_id")
                             if not data_prompt_id or data_prompt_id == prompt_id:
                                 node_id = data.get("node_id", "")
                                 node_type = data.get("node_type", "")
                                 exception_msg = data.get("exception_message") or "Unknown ComfyUI node error"
                                 err_msg = f"ComfyUI Error in [{node_type} (node {node_id})]: {exception_msg}"
                                 logger.error(err_msg)
                                 return {"status": "error", "message": err_msg}

                        elif msg_type == "execution_interrupted":
                             if data.get("prompt_id") == prompt_id or not data.get("prompt_id"):
                                 logger.info("ComfyUI Execution Interrupted by user request.")
                                 return {"status": "error", "message": "Generation interrupted by user."}

                except websockets.exceptions.ConnectionClosed:
                    logger.warning("WebSocket closed unexpectedly")
                    break
            
            if not generated_images and prompt_id:
                logger.info(f"WebSocket finished without images. Querying ComfyUI history for prompt_id: {prompt_id}...")
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(f"{self.base_url}/history/{prompt_id}") as resp:
                            if resp.status == 200:
                                history_data = await resp.json()
                                prompt_output = history_data.get(prompt_id, {}).get("outputs", {})
                                for node_id, node_out in prompt_output.items():
                                    if "images" in node_out:
                                        for img_info in node_out["images"]:
                                            fn = img_info.get("filename")
                                            sf = img_info.get("subfolder", "")
                                            it = img_info.get("type", "output")
                                            img_data = await self._download_image(fn, sf, it)
                                            if img_data:
                                                generated_images.append({
                                                    "filename": fn,
                                                    "data": img_data
                                                })
                except Exception as ex:
                    logger.error(f"Failed to fetch images from history fallback: {ex}")

            if not generated_images:
                logger.warning("Workflow finished but no images captured.")
                return {"status": "completed", "images": []} 
            
            return {"status": "completed", "images": generated_images}

        except Exception as e:
            logger.error(f"Error during ComfyUI execution: {e}")
            return {"status": "error", "message": str(e)}
        finally:
            if ws:
                await ws.close()

    async def _download_image(self, filename, subfolder, img_type) -> Optional[bytes]:
        url = f"{self.base_url}/view?filename={filename}&subfolder={subfolder}&type={img_type}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    if resp.status == 200:
                        return await resp.read()
                    else:
                        logger.error(f"Failed to download image {filename}: {resp.status}")
                        return None
        except Exception as e:
            logger.error(f"Download exception for {filename}: {e}")
            return None
