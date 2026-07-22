from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from ...db.session import SessionLocal
from ...models.chapter import Chapter
from ...models.scene import Scene
from ...models.character import Character
from ...services.llm import LLMService
from ..deps import security as auth_security, get_current_active_user
import json

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class TimelineRequest(BaseModel):
    chapter_id: str
    mode: Optional[str] = "standard"

class SceneSchema(BaseModel):
    id: int
    chapter_id: str
    index: int
    visual_prompt: Optional[str]
    audio_prompt: Optional[str]
    dialogue: Optional[str]
    duration: float
    shot_type: Optional[str] = None
    camera_movement: Optional[str] = None
    camera_angle: Optional[str] = None
    asset_status: str
    asset_url: Optional[str]

    class Config:
        from_attributes = True

class TimelineResponse(BaseModel):
    chapter_id: str
    timeline: List[SceneSchema]

@router.get("/{chapter_id}", response_model=TimelineResponse)
async def get_timeline(chapter_id: str, db: Session = Depends(get_db)):
    """Fetch existing timeline (scenes) for a chapter."""
    chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
        
    scenes = db.query(Scene).filter(Scene.chapter_id == chapter_id).order_by(Scene.index).all()
    
    return {
        "chapter_id": chapter.id,
        "timeline": scenes
    }

@router.post("/generate", response_model=TimelineResponse)
async def generate_timeline(
    req: TimelineRequest, 
    db: Session = Depends(get_db),
    auth: HTTPAuthorizationCredentials = Security(auth_security),
    current_user = Depends(get_current_active_user)
):
    """Generate new timeline using LLM and save to DB (overwriting old ones)."""
    chapter = db.query(Chapter).filter(Chapter.id == req.chapter_id).first()
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    if not chapter.content:
         raise HTTPException(status_code=400, detail="Chapter has no content")

    token = auth.credentials if auth else None

    # Fetch Characters for Context
    characters = db.query(Character).filter(Character.project_id == chapter.project_id).all()
    char_profiles_str = ""
    if characters:
        profiles = []
        for c in characters:
            tags = c.visual_tags if c.visual_tags else {}
            tag_str = ""
            
            # Check for new structure (Base + Variants)
            if isinstance(tags, dict) and "base_model" in tags:
                # 1. Base Tags
                base_tags = tags.get("base_model", {}).get("tags", {})
                if isinstance(base_tags, str): base_tags = {"base": base_tags}
                
                # 2. Determine Active Variant for this Chapter
                active_variant_tags = {}
                timeline_map = tags.get("timeline_map", {})
                active_variant_id = timeline_map.get(req.chapter_id)
                
                variants = tags.get("variants", [])
                
                # If no mapping, try to use the first variant as default
                if not active_variant_id and variants:
                    active_variant_id = variants[0].get("id")
                
                if active_variant_id:
                    for v in variants:
                        if v.get("id") == active_variant_id:
                            active_variant_tags = v.get("tags", {})
                            if isinstance(active_variant_tags, str): active_variant_tags = {"variant": active_variant_tags}
                            break
                
                # Combine tags
                # Merge dictionaries or concatenate strings
                combined = {**base_tags, **active_variant_tags}
                tag_str = ", ".join([f"{k}: {v}" for k, v in combined.items()])
                
            else:
                # Legacy flat structure
                if isinstance(tags, dict):
                    tag_str = ", ".join([f"{k}: {v}" for k, v in tags.items()])
                else:
                    tag_str = str(tags)

            profiles.append(f"- Name: {c.name}\n  Description: {c.description}\n  Visual Tags: {tag_str}")
        char_profiles_str = "\n".join(profiles)
    
    # 1. Generate via LLM
    timeline_data = LLMService.generate_timeline(chapter.content, char_profiles_str, mode=req.mode, token=token)
    
    # 2. Clear existing scenes
    db.query(Scene).filter(Scene.chapter_id == chapter.id).delete()
    
    # 3. Save new scenes
    new_scenes = []
    for idx, item in enumerate(timeline_data):
        # Ensure item has keys matching model (LLM might return slightly different keys)
        scene = Scene(
            chapter_id=chapter.id,
            index=idx + 1,
            visual_prompt=item.get("visual_prompt", ""),
            audio_prompt=item.get("audio_prompt", ""),
            dialogue=item.get("dialogue", ""),
            duration=item.get("duration", 3.0),
            shot_type=item.get("shot_type", ""),
            camera_movement=item.get("camera_movement", ""),
            camera_angle=item.get("camera_angle", ""),
            asset_status="idle"
        )
        db.add(scene)
        new_scenes.append(scene)
    
    db.commit()
    
    # Refresh to get IDs
    for s in new_scenes:
        db.refresh(s)
    
    return {
        "chapter_id": chapter.id,
        "timeline": new_scenes
    }