from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import logging

from ...db.session import SessionLocal
from ...models.scene import Scene
from ...models.coverage import CoverageGroup, CoverageShot
from ...models.character import Character
from ...services.llm import LLMService
from ..deps import security as auth_security, get_current_active_user

logger = logging.getLogger(__name__)

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class CoverageShotSchema(BaseModel):
    id: int
    coverage_group_id: int
    slot: int
    shot_size: Optional[str] = None
    camera_angle: Optional[str] = None
    camera_movement: Optional[str] = None
    narrative_purpose: Optional[str] = None
    visual_prompt: Optional[str] = None
    asset_status: str = "idle"
    asset_url: Optional[str] = None
    promoted_scene_id: Optional[int] = None

    class Config:
        from_attributes = True

class CoverageGroupSchema(BaseModel):
    id: int
    source_scene_id: int
    version: int
    status: str
    shots: List[CoverageShotSchema]

    class Config:
        from_attributes = True

class PromoteOptions(BaseModel):
    position: Optional[str] = "after" # "replace", "before", "after"

@router.post("/scenes/{scene_id}/coverage", response_model=CoverageGroupSchema)
async def generate_scene_coverage(
    scene_id: int,
    db: Session = Depends(get_db),
    auth: HTTPAuthorizationCredentials = Security(auth_security),
    current_user = Depends(get_current_active_user)
):
    """Generate 9 candidate coverage shots for a single source scene."""
    source_scene = db.query(Scene).filter(Scene.id == scene_id).first()
    if not source_scene:
        raise HTTPException(status_code=404, detail="Source scene not found")

    token = auth.credentials if auth else None

    # Fetch Character Context
    characters = db.query(Character).filter(Character.project_id == source_scene.chapter.project_id).all()
    char_profiles_str = ""
    if characters:
        char_profiles_str = "\n".join([f"- Name: {c.name}\n  Description: {c.description}" for c in characters])

    scene_data = {
        "visual_prompt": source_scene.visual_prompt or "",
        "dialogue": source_scene.dialogue or "",
        "shot_type": source_scene.shot_type or "",
        "camera_movement": source_scene.camera_movement or "",
        "camera_angle": source_scene.camera_angle or "",
        "audio_prompt": source_scene.audio_prompt or "",
        "duration": source_scene.duration or 3.0,
        "negative_prompt": source_scene.negative_prompt or ""
    }

    try:
        candidates_data = LLMService.generate_scene_coverage(scene_data, char_profiles_str, token=token)
    except Exception as e:
        logger.error(f"Failed to generate scene coverage for Scene {scene_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate coverage: {str(e)}")

    if not candidates_data or len(candidates_data) != 9:
        raise HTTPException(status_code=500, detail="Coverage generation failed to return 9 candidate shots")

    # Determine latest version for this scene
    latest_group = db.query(CoverageGroup).filter(CoverageGroup.source_scene_id == scene_id).order_by(CoverageGroup.version.desc()).first()
    new_version = (latest_group.version + 1) if latest_group else 1

    try:
        group = CoverageGroup(
            source_scene_id=scene_id,
            version=new_version,
            status="completed"
        )
        db.add(group)
        db.flush() # Get group.id

        shots = []
        for c in candidates_data:
            shot = CoverageShot(
                coverage_group_id=group.id,
                slot=c.get("slot", 1),
                shot_size=c.get("shot_size") or c.get("shot_type") or "Medium Shot",
                camera_angle=c.get("camera_angle") or "Eye-level",
                camera_movement=c.get("camera_movement") or "Static",
                narrative_purpose=c.get("narrative_purpose") or "",
                visual_prompt=c.get("visual_prompt") or "",
                asset_status="idle"
            )
            db.add(shot)
            shots.append(shot)

        db.commit()
        db.refresh(group)
        return group
    except Exception as e:
        db.rollback()
        logger.error(f"DB Error while saving coverage group: {e}")
        raise HTTPException(status_code=500, detail="Database transaction failed while saving coverage shots")

@router.get("/scenes/{scene_id}/coverage", response_model=List[CoverageGroupSchema])
async def get_scene_coverage(
    scene_id: int,
    db: Session = Depends(get_db)
):
    """Fetch coverage groups and candidate shots for a scene."""
    groups = db.query(CoverageGroup).filter(CoverageGroup.source_scene_id == scene_id).order_by(CoverageGroup.version.desc()).all()
    return groups

@router.post("/scenes/coverage/{shot_id}/apply")
async def apply_coverage_shot_to_scene(
    shot_id: int,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Apply candidate shot parameters (shot_size, angle, movement, visual_prompt) to overwrite source scene."""
    candidate = db.query(CoverageShot).filter(CoverageShot.id == shot_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate shot not found")

    source_scene = candidate.group.source_scene
    if not source_scene:
        raise HTTPException(status_code=404, detail="Source scene no longer exists")

    source_scene.shot_type = candidate.shot_size
    source_scene.camera_angle = candidate.camera_angle
    source_scene.camera_movement = candidate.camera_movement
    if candidate.visual_prompt:
        source_scene.visual_prompt = candidate.visual_prompt

    db.commit()
    db.refresh(source_scene)
    return {"status": "success", "message": "Candidate shot applied to source scene", "scene": {
        "id": source_scene.id,
        "shot_type": source_scene.shot_type,
        "camera_angle": source_scene.camera_angle,
        "camera_movement": source_scene.camera_movement,
        "visual_prompt": source_scene.visual_prompt
    }}

@router.post("/scenes/coverage/{shot_id}/promote")
async def promote_coverage_shot_to_timeline(
    shot_id: int,
    opts: PromoteOptions,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Promote candidate shot into the main timeline as a new Scene card."""
    candidate = db.query(CoverageShot).filter(CoverageShot.id == shot_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate shot not found")

    source_scene = candidate.group.source_scene
    if not source_scene:
        raise HTTPException(status_code=404, detail="Source scene no longer exists")

    chapter_id = source_scene.chapter_id

    # Shift indices of existing scenes if needed
    if opts.position == "after":
        insert_index = source_scene.index + 1
        db.query(Scene).filter(Scene.chapter_id == chapter_id, Scene.index >= insert_index).update({"index": Scene.index + 1})
    elif opts.position == "before":
        insert_index = source_scene.index
        db.query(Scene).filter(Scene.chapter_id == chapter_id, Scene.index >= insert_index).update({"index": Scene.index + 1})
    else: # replace
        source_scene.shot_type = candidate.shot_size
        source_scene.camera_angle = candidate.camera_angle
        source_scene.camera_movement = candidate.camera_movement
        source_scene.visual_prompt = candidate.visual_prompt
        candidate.promoted_scene_id = source_scene.id
        db.commit()
        return {"status": "success", "message": "Source scene replaced by candidate shot", "scene_id": source_scene.id}

    new_scene = Scene(
        chapter_id=chapter_id,
        index=insert_index,
        visual_prompt=candidate.visual_prompt or source_scene.visual_prompt,
        audio_prompt=source_scene.audio_prompt,
        dialogue=source_scene.dialogue,
        duration=source_scene.duration,
        shot_type=candidate.shot_size,
        camera_movement=candidate.camera_movement,
        camera_angle=candidate.camera_angle,
        negative_prompt=source_scene.negative_prompt,
        asset_status=candidate.asset_status or "idle",
        asset_url=candidate.asset_url
    )
    db.add(new_scene)
    db.flush()

    candidate.promoted_scene_id = new_scene.id
    db.commit()
    db.refresh(new_scene)

    return {"status": "success", "message": "Candidate shot promoted to main timeline", "scene_id": new_scene.id}
