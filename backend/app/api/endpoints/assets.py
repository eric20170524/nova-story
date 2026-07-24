from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Dict, Any
import json
import asyncio
import uuid

from ...services.generation_service import generate_assets_service
from ...services.ai.comfyui_service import ComfyUIService
from ...core.settings_manager import SettingsManager
from ...core.redis import get_redis_client
from ..deps import get_current_active_user, security as auth_security

import logging

logger = logging.getLogger(__name__)

router = APIRouter()

class GenerateRequest(BaseModel):
    workflow: Dict[str, Any]
    scene_id: int
    mode: str = "standard"  # "standard" or "cinematic_grid"

@router.post("/generate")
async def generate_asset(
    req: GenerateRequest, 
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_active_user),
    auth: HTTPAuthorizationCredentials = Security(auth_security)
):
    """
    Triggers generation via FastAPI BackgroundTasks.
    Returns a task ID immediately.
    """
    logger.info(f"Received generation request for Scene {req.scene_id} from user {current_user.get('id')} (Mode: {req.mode})")
    
    # Generate a random Task ID since we don't have Celery anymore
    task_id = str(uuid.uuid4())
    
    # Get token for billing
    token = auth.credentials if auth else None
    
    # Schedule the task
    background_tasks.add_task(generate_assets_service, task_id, req.workflow, req.scene_id, token, req.mode)
    
    logger.info(f"Task scheduled: {task_id}")
    return {"task_id": task_id, "status": "processing"}

@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    # Without Celery result backend, we can't easily query status unless we store it in Redis or DB.
    # However, the frontend mainly uses the SSE stream or the Scene object in DB.
    # For now, we can return a generic response or check the DB for the scene status if we had scene_id.
    # But this endpoint is likely polled.
    # Let's just return "unknown" or "processing" if not found, since we don't have a task store.
    # Alternatively, we could query Redis if we stored state there.
    return {"task_id": task_id, "status": "UNKNOWN", "detail": "Use SSE stream for real-time status"}

from ...db.session import SessionLocal
from ...models.scene import Scene

@router.get("/stream/{task_id}")
async def stream_progress(task_id: str):
    """
    Server-Sent Events (SSE) endpoint to stream task progress.
    """
    logger.info(f"SSE Connection requested for Task {task_id}")
    async def event_generator():
        redis = get_redis_client()
        pubsub = redis.pubsub()
        channel = f"task_progress:{task_id}"
        await pubsub.subscribe(channel)
        
        try:
            # Yield initial connection message
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            logger.debug(f"SSE Connected: {task_id}")
            
            def check_db_status():
                db = SessionLocal()
                try:
                    return db.query(Scene).filter(Scene.task_id == task_id).first()
                finally:
                    db.close()

            # 1. Immediate DB check in case task finished before SSE connected
            scene = await asyncio.to_thread(check_db_status)
            if scene and scene.asset_status == 'completed' and scene.asset_url:
                logger.info(f"SSE Initial DB Check: Task {task_id} already completed ({scene.asset_url})")
                yield f"data: {json.dumps({'type': 'complete', 'status': 'completed', 'image_url': scene.asset_url})}\n\n"
                return
            elif scene and scene.asset_status == 'failed':
                logger.info(f"SSE Initial DB Check: Task {task_id} already failed")
                yield f"data: {json.dumps({'type': 'complete', 'status': 'failed', 'error': 'Generation failed'})}\n\n"
                return

            tick_counter = 0
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True)
                if message:
                    # message['data'] is a JSON string published by the task
                    yield f"data: {message['data']}\n\n"
                    
                    # Check if done
                    try:
                        data_dict = json.loads(message['data'])
                        if data_dict.get('type') == 'complete' or data_dict.get('status') in ('completed', 'failed'):
                             logger.info(f"SSE Completed: {task_id}")
                             break
                    except Exception:
                        pass
                
                # Every ~2 seconds (4 ticks * 0.5s), poll DB as safety fallback
                tick_counter += 1
                if tick_counter % 4 == 0:
                    scene = await asyncio.to_thread(check_db_status)
                    if scene and scene.asset_status == 'completed' and scene.asset_url:
                        logger.info(f"SSE DB Fallback: Task {task_id} completed ({scene.asset_url})")
                        yield f"data: {json.dumps({'type': 'complete', 'status': 'completed', 'image_url': scene.asset_url})}\n\n"
                        break
                    elif scene and scene.asset_status == 'failed':
                        logger.info(f"SSE DB Fallback: Task {task_id} failed")
                        yield f"data: {json.dumps({'type': 'complete', 'status': 'failed', 'error': 'Generation failed'})}\n\n"
                        break

                await asyncio.sleep(0.5) # Avoid tight loop
        except asyncio.CancelledError:
            # Client disconnected
            logger.info(f"SSE Client disconnected: {task_id}")
            pass
        finally:
            await pubsub.close()
            await redis.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.post("/cancel")
async def cancel_asset_generation():
    """
    Cancels/interrupts any running or queued generation tasks in ComfyUI.
    """
    logger.info("Cancel asset generation endpoint triggered.")
    try:
        settings = SettingsManager.load_settings()
        comfy_settings = settings.get("comfyui", {})
        base_url = comfy_settings.get("base_url", "http://127.0.0.1:8188")
        
        comfy_service = ComfyUIService(base_url=base_url)
        cancelled = await comfy_service.cancel_execution()
        return {"status": "success" if cancelled else "failed", "message": "Interrupted active tasks."}
    except Exception as e:
        logger.error(f"Error cancelling asset generation: {e}")
        return {"status": "error", "message": str(e)}

