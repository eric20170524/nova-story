from ..services.media_service import MediaService
from ..services.ai.comfyui_service import ComfyUIService
from ..core.redis import get_redis_client
from ..core.settings_manager import SettingsManager
from ..db.session import SessionLocal
from ..models.scene import Scene
import asyncio
import base64
import json
import os
import logging
import random

logger = logging.getLogger(__name__)

from ..services.prompts import Prompts

async def generate_assets_service(task_id: str, workflow_data: dict, scene_id: int, user_token: str = None, mode: str = "standard"):
    """
    Async service to handle Asset generation via ComfyUI or LLM Providers.
    Replaces the old Celery task.
    """
    logger.info(f"[Task {task_id}] Asset generation started for Scene {scene_id} (Mode: {mode}, Token present: {bool(user_token)})")
    
    # Define paths
    static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "generated")
    os.makedirs(static_dir, exist_ok=True)

    redis = get_redis_client()
    
    async def progress_handler(msg_type, data):
        channel = f"task_progress:{task_id}"
        message = json.dumps({"type": msg_type, "data": data})
        await redis.publish(channel, message)
        logger.info(f"[Task {task_id}] Progress: {msg_type} - {data}")

    try:
        # Check Settings
        settings = SettingsManager.load_settings()
        comfy_settings = settings.get("comfyui", {})
        use_comfy = comfy_settings.get("enabled", False)
        
        result = None
        
        # 0. Pre-process Prompt for Cinematic Grid Mode
        if mode == "cinematic_grid":
            logger.info(f"[Task {task_id}] Cinematic Grid Mode: Building prompt locally (no LLM/Ollama)...")
            
            # Extract the raw scene description
            raw_prompt = ""
            if isinstance(workflow_data, dict):
                raw_prompt = workflow_data.get("prompt") or workflow_data.get("text") or workflow_data.get("description") or json.dumps(workflow_data)
            elif isinstance(workflow_data, str):
                raw_prompt = workflow_data
            
            if not raw_prompt:
                raise ValueError("No prompt found for Cinematic Grid generation")

            grid_prompt = Prompts.build_cinematic_grid_image_prompt(raw_prompt)
            
            logger.info(f"[Task {task_id}] Built-in Grid Prompt ready (Length: {len(grid_prompt)})")
            
            # Update workflow_data with the new prompt
            if isinstance(workflow_data, dict):
                workflow_data["prompt"] = grid_prompt
                # Ensure negative prompt doesn't conflict or is appended if needed
            else:
                workflow_data = {"prompt": grid_prompt}

        if use_comfy:
            base_url = comfy_settings.get("base_url", "http://127.0.0.1:8188")
            logger.info(f"[Task {task_id}] Using ComfyUI at {base_url}")
            
            service = ComfyUIService(base_url=base_url)
            is_running = await service.ensure_running()
            if not is_running:
                 result = {"status": "error", "message": "Failed to auto-start ComfyUI service"}
            else:
                 try:
                     # Workflow Template Mapping
                     logger.info(f"[Task {task_id}] Processing workflow payload for ComfyUI.")
                     
                     # 1. Extract prompt details from frontend payload
                     prompt = workflow_data.get("prompt", "") if isinstance(workflow_data, dict) else workflow_data
                     negative_prompt = workflow_data.get("negative_prompt", "") if isinstance(workflow_data, dict) else ""
                     
                     # 2. Determine Template (Default to Pony XL for RTX 3060)
                     template_name = comfy_settings.get("default_workflow", "pony_xl_12gb.json")
                     template_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "workflows", template_name)
                     preserve_template_conditioning = "pony" in template_name.lower()
                     is_flux = "flux" in template_name.lower()

                     # Option 1: FLUX East Asian Prompt Booster
                     if is_flux:
                         prompt_lower = (prompt or "").lower()
                         asian_keywords = ["east asian", "chinese", "japanese", "asian", "guofeng", "xianxia"]
                         if not any(kw in prompt_lower for kw in asian_keywords):
                             prompt = f"{prompt}, East Asian facial features, soft facial contour, East Asian beauty" if prompt else "East Asian facial features, soft facial contour, East Asian beauty"
                             logger.info(f"[Task {task_id}] Injected East Asian feature booster to FLUX prompt.")
                         
                         neg_lower = (negative_prompt or "").lower()
                         if "western face" not in neg_lower and "caucasian" not in neg_lower:
                             negative_prompt = f"{negative_prompt}, western face, caucasian" if negative_prompt else "western face, caucasian"

                     if not os.path.exists(template_path):
                         logger.error(f"[Task {task_id}] Workflow template {template_path} not found. Sending raw payload.")
                         final_workflow = workflow_data
                     else:
                         logger.info(f"[Task {task_id}] Loading workflow template: {template_name}")
                         with open(template_path, 'r', encoding='utf-8') as f:
                             final_workflow = json.load(f)

                         # Option 2: Dynamic LoRA Wiring for FLUX Workflows
                         if is_flux:
                             # Check if a LoRA model is installed in ComfyUI models/loras/
                             comfy_loras_dir = r"D:\ComfyUI\models\loras"
                             custom_lora = comfy_settings.get("flux_lora")
                             detected_lora = None

                             if custom_lora and os.path.exists(os.path.join(comfy_loras_dir, custom_lora)):
                                 detected_lora = custom_lora
                             elif os.path.exists(comfy_loras_dir):
                                 try:
                                     lora_files = [f for f in os.listdir(comfy_loras_dir) if f.endswith(('.safetensors', '.ckpt'))]
                                     # Priority match for asian/guofeng/flux loras
                                     match = next((f for f in lora_files if any(k in f.lower() for k in ["asian", "guofeng", "east_asian", "flux_asian"])), None)
                                     if match:
                                         detected_lora = match
                                     elif lora_files:
                                         detected_lora = lora_files[0]
                                 except Exception as ex:
                                     logger.warning(f"Error checking LoRA directory: {ex}")

                             if detected_lora:
                                 logger.info(f"[Task {task_id}] Dynamically attaching FLUX LoRA: {detected_lora}")
                                 lora_node_id = "7"
                                 final_workflow[lora_node_id] = {
                                     "inputs": {
                                         "lora_name": detected_lora,
                                         "strength_model": float(comfy_settings.get("flux_lora_strength", 0.8)),
                                         "strength_clip": float(comfy_settings.get("flux_lora_strength", 0.8)),
                                         "model": ["1", 0],
                                         "clip": ["2", 0]
                                     },
                                     "class_type": "LoraLoader",
                                     "_meta": { "title": "Load LoRA (East Asian / Guofeng)" }
                                 }

                                 # Rewire KSampler to use LoRA model and CLIPTextEncode to use LoRA clip
                                 for nid, n in final_workflow.items():
                                     if n.get("class_type") == "KSampler":
                                         n["inputs"]["model"] = [lora_node_id, 0]
                                     elif n.get("class_type") == "CLIPTextEncode":
                                         n["inputs"]["clip"] = [lora_node_id, 1]

                         # 3. Inject Prompts and Seed
                         for node_id, node in final_workflow.items():
                             class_type = node.get("class_type")
                             inputs = node.get("inputs", {})
                             
                             if class_type == "CLIPTextEncode":
                                 title = node.get("_meta", {}).get("title", "")
                                 template_text = str(inputs.get("text", "") or "").strip()
                                 if "Negative" in title:
                                     inputs["text"] = (
                                         f"{template_text}, {negative_prompt}"
                                         if preserve_template_conditioning and template_text and negative_prompt
                                         else negative_prompt or template_text
                                     )
                                 else:
                                     inputs["text"] = (
                                         f"{template_text}, {prompt}"
                                         if preserve_template_conditioning and template_text and prompt
                                         else prompt or template_text
                                     )
                                     
                             elif class_type == "KSampler":
                                 inputs["seed"] = random.randint(1, 1000000000000000)
                                 
                     result = await service.generate_image(final_workflow, progress_callback=progress_handler)
                 finally:
                     # Auto stop ComfyUI service after generation to release GPU VRAM for Ollama
                     # ComfyUI is now kept running for fast interactive generation
                     pass
            
        else:
            logger.info(f"[Task {task_id}] Using LLM MediaService")
            # 1. Extract Prompt
            prompt = ""
            if isinstance(workflow_data, dict):
                prompt = workflow_data.get("prompt") or workflow_data.get("text") or workflow_data.get("description")
                if not prompt:
                    prompt = json.dumps(workflow_data)
            elif isinstance(workflow_data, str):
                prompt = workflow_data
            
            if not prompt:
                result = {"status": "error", "message": "No prompt found in request"}
            else:
                # 2. Generate
                service = MediaService()
                result = await service.generate_image(prompt, progress_callback=progress_handler, token=user_token)
        
        # 3. Process Result
        final_status = "failed"
        asset_url = None
        
        logger.info(f"[Task {task_id}] Generation result status: {result.get('status')}")
        
        if result.get("status") == "completed" and "images" in result:
            images_list = result["images"]
            logger.info(f"[Task {task_id}] Processing {len(images_list)} images.")
            
            for idx, img in enumerate(images_list):
                has_data = "data" in img
                has_url = "url" in img
                data_type = type(img.get("data")) if has_data else "None"
                logger.info(f"[Task {task_id}] Image {idx}: {img.keys()} has_data={has_data} (type={data_type}), has_url={has_url}")
                
                if idx == 0:
                    # Handle Byte Data
                    if isinstance(img.get("data"), bytes):
                        filename = f"{scene_id}_{task_id}.png"
                        filepath = os.path.join(static_dir, filename)
                        
                        try:
                            with open(filepath, "wb") as f:
                                f.write(img["data"])
                            
                            asset_url = f"/static/generated/{filename}"
                            final_status = "completed"
                            logger.info(f"[Task {task_id}] Image saved to {filepath}")

                        except Exception as e:
                            logger.error(f"[Task {task_id}] Failed to write image file: {e}")
                            
                    # Handle URL Data (e.g. Placeholder or Remote)
                    elif "url" in img:
                         asset_url = img["url"]
                         final_status = "completed"
                         logger.info(f"[Task {task_id}] Using remote image URL: {asset_url}")
                         
                         # If it's already a URL, we assume the provider hosted it.
                         # If we strictly want ALL images in Nebula, we might need to download and re-upload 
                         # if the provider URL is temporary or from a different source.
                         # But typical flow is Provider -> Bytes -> Upload.

                    # If valid, update the return object (for consistency with old task)
                    if final_status == "completed":
                         img["url"] = asset_url
                         if "data" in img:
                            del img["data"]
                         
                         # Update DB on success
                         await asyncio.to_thread(update_scene_db, scene_id, "completed", asset_url, task_id)
                         break # Only process first image

        # 4. Publish Final Event

        if final_status == "completed":
            await redis.publish(
                f"task_progress:{task_id}", 
                json.dumps({"type": "complete", "status": "completed", "image_url": asset_url})
            )
        else:
            err_msg = result.get("message", "Unknown error")
            logger.error(f"[Task {task_id}] Generation failed: {err_msg}")
            
            # Update DB to failed
            await asyncio.to_thread(update_scene_db, scene_id, "failed", None, task_id)
            
            await redis.publish(
                f"task_progress:{task_id}", 
                json.dumps({"type": "complete", "status": "failed", "error": err_msg})
            )

    except Exception as e:
        logger.exception(f"[Task {task_id}] Unexpected error in async service")
        # Try to report failure
        try:
             await asyncio.to_thread(update_scene_db, scene_id, "failed", None, task_id)
             await redis.publish(f"task_progress:{task_id}", json.dumps({"type": "complete", "status": "failed", "error": str(e)}))
        except: 
            pass
    finally:
        await redis.close()

def update_scene_db(scene_id, status, url, task_id):
    """Synchronous DB update to be run in a thread."""
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == int(scene_id)).first()
        if scene:
            scene.asset_status = status
            if url:
                scene.asset_url = url
            scene.task_id = task_id
            db.commit()
            logger.info(f"Updated Scene {scene_id} in DB: status={status}, url={url}")
    except Exception as e:
        logger.error(f"DB Error: {e}")
    finally:
        db.close()
