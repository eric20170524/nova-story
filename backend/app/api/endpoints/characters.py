from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any

from ...db.session import SessionLocal
from ...models.character import Character
from ...models.project import Project
from ...schemas import character as schemas
from ..deps import get_current_active_user

router = APIRouter()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

from ...models.chapter import Chapter
from ...services.llm import LLMService
from pydantic import BaseModel

class ExtractRequest(BaseModel):
    chapter_id: str

@router.post("/extract", response_model=List[schemas.Character])
def extract_characters(
    req: ExtractRequest, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    chapter = db.query(Chapter).filter(Chapter.id == req.chapter_id).first()
    if not chapter or not chapter.content:
        raise HTTPException(status_code=400, detail="Chapter not found or empty")
    
    profiles = LLMService.extract_character_profiles(chapter.content)
    
    result_chars = []
    for p in profiles:
        # Check if exists in the same project
        existing = db.query(Character).filter(
            Character.project_id == chapter.project_id, 
            Character.name == p['name']
        ).first()
        
        if existing:
            # Analyze Evolution
            # Ensure visual_tags has the new structure
            current_tags = existing.visual_tags or {}
            if "base_model" not in current_tags:
                # Migrate legacy structure
                current_tags = {
                    "base_model": {"tags": current_tags},
                    "variants": [],
                    "timeline_map": {}
                }
            
            # Call LLM Analysis
            analysis = LLMService.analyze_character_evolution(current_tags, chapter.content)
            
            action = analysis.get("action", "keep_current")
            
            if action == "new_variant" and "new_variant" in analysis:
                variant_data = analysis["new_variant"]
                # Generate a simple ID if not provided
                import uuid
                variant_id = f"var_{str(uuid.uuid4())[:8]}"
                variant_data["id"] = variant_id
                
                # Add to variants
                if "variants" not in current_tags:
                    current_tags["variants"] = []
                current_tags["variants"].append(variant_data)
                
                # Update Timeline Map
                if "timeline_map" not in current_tags:
                    current_tags["timeline_map"] = {}
                current_tags["timeline_map"][chapter.id] = variant_id
                
                # Update DB
                existing.visual_tags = current_tags
                db.add(existing)
                db.commit()
                db.refresh(existing)
                
            elif action == "keep_current":
                # Ensure timeline map points to default or previous
                if "timeline_map" not in current_tags:
                    current_tags["timeline_map"] = {}
                
                # Logic: If no entry for this chapter, use default or last used?
                # For now, map to 'base' or 'default' if not specified
                # Ideally, analyze_character_evolution should tell us WHICH variant to use if keeping existing.
                # Simplified: default to base/latest if keep_current.
                pass 

            result_chars.append(existing)
        else:
            # New Character - Initialize with Best Practice Structure
            initial_tags = {
                "base_model": {"tags": p.get('visual_tags', {})},
                "variants": [{
                    "id": "v1_default",
                    "name": "Default",
                    "tags": p.get('visual_tags', {})
                }],
                "timeline_map": {
                    req.chapter_id: "v1_default"
                }
            }
            
            new_char = Character(
                project_id=chapter.project_id,
                name=p['name'],
                role=p.get('role', 'supporting'),
                description=p.get('description', ''),
                visual_tags=initial_tags
            )
            db.add(new_char)
            db.commit() 
            db.refresh(new_char)
            result_chars.append(new_char)
            
    return result_chars

@router.post("/", response_model=schemas.Character)
def create_character(
    character: schemas.CharacterCreate, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    # Verify project exists
    db_project = db.query(Project).filter(Project.id == character.project_id).first()
    if not db_project:
        raise HTTPException(status_code=404, detail="Project not found")

    db_character = Character(
        project_id=character.project_id,
        name=character.name,
        role=character.role,
        description=character.description,
        visual_tags=character.visual_tags
    )
    db.add(db_character)
    db.commit()
    db.refresh(db_character)
    return db_character

@router.get("/", response_model=List[schemas.Character])
def read_characters(
    skip: int = 0, 
    limit: int = 100, 
    project_id: Optional[int] = None, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    query = db.query(Character)
    if project_id:
        query = query.filter(Character.project_id == project_id)
    characters = query.offset(skip).limit(limit).all()
    return characters

@router.get("/{character_id}", response_model=schemas.Character)
def read_character(
    character_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if db_character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return db_character

@router.put("/{character_id}", response_model=schemas.Character)
def update_character(
    character_id: int, 
    character: schemas.CharacterUpdate, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if db_character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    
    update_data = character.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_character, key, value)

    db.add(db_character)
    db.commit()
    db.refresh(db_character)
    return db_character

@router.delete("/{character_id}", response_model=schemas.Character)
def delete_character(
    character_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if db_character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    
    db.delete(db_character)
    db.commit()
    return db_character
