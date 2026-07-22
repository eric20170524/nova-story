from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Dict, Any
import json
import asyncio
import uuid

from ...services.generation_service import generate_assets_service
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
            
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True)
                if message:
                    # message['data'] is a JSON string published by the task
                    yield f"data: {message['data']}\n\n"
                    
                    # Check if done
                    data_dict = json.loads(message['data'])
                    if data_dict.get('type') == 'complete':
                         logger.info(f"SSE Completed: {task_id}")
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
