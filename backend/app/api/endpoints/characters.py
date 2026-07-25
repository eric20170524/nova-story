from fastapi import APIRouter, Depends, HTTPException, File, UploadFile, Form
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

def _serialize_character(db_char: Character) -> dict:
    tags = db_char.visual_tags or {}
    assets = tags.get("assets", {}) if isinstance(tags.get("assets"), dict) else {}
    
    avatar_url = assets.get("avatar_url") or tags.get("avatar_url") or tags.get("avatar")
    turnaround_url = assets.get("turnaround_url") or tags.get("turnaround_url") or tags.get("turnaround")
    face_url = assets.get("face_url") or tags.get("face_url") or tags.get("face")
    model_type = assets.get("model_type") or tags.get("model_type") or "pony"

    return {
        "id": db_char.id,
        "project_id": db_char.project_id,
        "name": db_char.name,
        "role": db_char.role,
        "description": db_char.description,
        "visual_tags": tags,
        "avatar_url": avatar_url,
        "turnaround_url": turnaround_url,
        "face_url": face_url,
        "model_type": model_type
    }

def _apply_asset_fields(character_dict: dict, current_tags: dict) -> dict:
    tags = dict(current_tags or {})
    assets = dict(tags.get("assets", {}))
    if "avatar_url" in character_dict:
        assets["avatar_url"] = character_dict.get("avatar_url")
    if "turnaround_url" in character_dict:
        assets["turnaround_url"] = character_dict.get("turnaround_url")
    if "face_url" in character_dict:
        assets["face_url"] = character_dict.get("face_url")
    if "model_type" in character_dict and character_dict.get("model_type"):
        assets["model_type"] = character_dict.get("model_type")
    tags["assets"] = assets
    return tags

@router.post("/", response_model=schemas.Character)
def create_character(
    character: schemas.CharacterCreate, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_project = db.query(Project).filter(Project.id == character.project_id).first()
    if not db_project:
        raise HTTPException(status_code=404, detail="Project not found")

    char_dict = character.model_dump(exclude_unset=True)
    visual_tags = _apply_asset_fields(char_dict, character.visual_tags or {})

    db_character = Character(
        project_id=character.project_id,
        name=character.name,
        role=character.role,
        description=character.description,
        visual_tags=visual_tags
    )
    db.add(db_character)
    db.commit()
    db.refresh(db_character)
    return _serialize_character(db_character)

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
    return [_serialize_character(c) for c in characters]

@router.get("/{character_id}", response_model=schemas.Character)
def read_character(
    character_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if db_character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return _serialize_character(db_character)

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
    if "visual_tags" in update_data or any(k in update_data for k in ["avatar_url", "turnaround_url", "face_url", "model_type"]):
        current_tags = update_data.get("visual_tags") or db_character.visual_tags or {}
        db_character.visual_tags = _apply_asset_fields(update_data, current_tags)
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(db_character, "visual_tags")

    for key in ["name", "role", "description"]:
        if key in update_data and update_data[key] is not None:
            setattr(db_character, key, update_data[key])

    db.add(db_character)
    db.commit()
    db.refresh(db_character)
    return _serialize_character(db_character)

@router.delete("/{character_id}", response_model=schemas.Character)
def delete_character(
    character_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if db_character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    
    serialized = _serialize_character(db_character)
    db.delete(db_character)
    db.commit()
    return serialized

class TurnaroundPromptRequest(BaseModel):
    model_type: str = "pony"  # "pony" or "flux"
    gen_type: str = "turnaround"  # "turnaround" or "portrait"
    custom_description: Optional[str] = None
    use_ref_portrait: Optional[bool] = True
    ref_image_url: Optional[str] = None

@router.post("/{character_id}/build-prompt")
def build_character_prompt(
    character_id: int,
    req: TurnaroundPromptRequest,
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if not db_character:
        raise HTTPException(status_code=404, detail="Character not found")
    
    desc = req.custom_description or db_character.description or ""
    tags = db_character.visual_tags or {}
    base_tags = tags.get("base_model", {}).get("tags", {})
    tag_str = ", ".join([f"{v}" for k, v in base_tags.items() if isinstance(v, str)]) if isinstance(base_tags, dict) else ""

    combined_desc = f"{desc}, {tag_str}".strip(", ")
    
    # Check reference image
    assets = tags.get("assets", {}) if isinstance(tags.get("assets"), dict) else {}
    ref_url = req.ref_image_url or assets.get("avatar_url") or tags.get("avatar_url") or db_character.avatar_url
    
    # Smart Gender Detection
    check_str = (desc + " " + tag_str + " " + (db_character.name or "")).lower()
    is_male = any(kw in check_str for kw in ["male", "boy", "man", "1boy", "男", "少年", "青年", "公子", "老者", "男子", "皇帝", "国王"])
    gender_tag = "1boy, solo, male" if is_male else "1girl, solo, female"

    ref_hint_pony = ""
    ref_hint_flux = ""
    if req.use_ref_portrait and ref_url:
        ref_hint_pony = ", (matching reference character design:1.2), consistent facial features, same outfit and hair across all views"
        ref_hint_flux = ", (consistent character appearance matching reference portrait:1.2), same costume and facial features across all 3 angles"

    if req.model_type.lower() == "pony":
        if req.gen_type == "turnaround":
            prompt = f"score_9, score_8_up, score_7_up, character turnaround sheet, full body model sheet, multi-view layout, front view, side view, back view, 3 views, aligned character turnaround, consistent character design, {gender_tag}, simple background, solid white background, {combined_desc}{ref_hint_pony}"
            negative_prompt = "score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face"
        else:  # portrait
            prompt = f"score_9, score_8_up, score_7_up, portrait, upper body, front view, {gender_tag}, simple background, white background, masterpiece, detailed face and eyes, {combined_desc}"
            negative_prompt = "score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, distorted face"
    else:  # FLUX
        if req.gen_type == "turnaround":
            prompt = f"full body character turnaround sheet, split view layout, front view, side view, back view, complete 3-view character model sheet, character reference sheet, consistent character design from all angles, clean studio white background, masterpiece quality, {gender_tag}, {combined_desc}{ref_hint_flux}"
            negative_prompt = "low quality, distorted face, bad anatomy, extra limbs, cluttered background, inconsistent costume"
        else:  # portrait
            prompt = f"high quality character portrait, front view, {gender_tag}, detailed face and eyes, clean studio background, {combined_desc}"
            negative_prompt = "low quality, blurry, bad anatomy, distorted face"

    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "model_type": req.model_type,
        "gen_type": req.gen_type,
        "ref_image_url": ref_url if req.use_ref_portrait else None
    }


@router.post("/{character_id}/crop-face", response_model=schemas.Character)
def crop_character_face(
    character_id: int,
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    import os
    import uuid
    from PIL import Image

    db_character = db.query(Character).filter(Character.id == character_id).first()
    if not db_character:
        raise HTTPException(status_code=404, detail="Character not found")
    
    tags = db_character.visual_tags or {}
    assets = tags.get("assets", {})
    src_url = assets.get("turnaround_url") or assets.get("avatar_url")
    
    if not src_url:
        raise HTTPException(status_code=400, detail="No turnaround or avatar image available for face cropping")

    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    static_dir = os.path.join(base_dir, "static", "generated")
    
    filename = os.path.basename(src_url)
    filepath = os.path.join(static_dir, filename)
    
    if not os.path.exists(filepath):
        assets["face_url"] = src_url
        tags["assets"] = assets
        db_character.visual_tags = tags
        db.commit()
        return _serialize_character(db_character)

    try:
        with Image.open(filepath) as img:
            width, height = img.size
            left = int(width * 0.05)
            upper = int(height * 0.05)
            right = int(width * 0.45)
            lower = int(height * 0.45)
            
            cropped = img.crop((left, upper, right, lower))
            face_filename = f"face_{character_id}_{uuid.uuid4().hex[:8]}.png"
            face_filepath = os.path.join(static_dir, face_filename)
            cropped.save(face_filepath)
            
            face_url = f"/static/generated/{face_filename}"
            assets["face_url"] = face_url
            tags["assets"] = assets
            db_character.visual_tags = tags
            db.commit()
            db.refresh(db_character)
    except Exception:
        assets["face_url"] = src_url
        tags["assets"] = assets
        db_character.visual_tags = tags
        db.commit()

    return _serialize_character(db_character)

@router.post("/{character_id}/train-lora", response_model=schemas.Character)
def train_character_lora(
    character_id: int,
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    import os
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if not db_character:
        raise HTTPException(status_code=404, detail="Character not found")
    
    tags = db_character.visual_tags or {}
    assets = tags.get("assets", {})
    
    lora_filename = f"char_{character_id}_{db_character.name.lower().replace(' ', '_')}.safetensors"
    comfy_loras_dir = r"D:\ComfyUI\models\loras"
    try:
        os.makedirs(comfy_loras_dir, exist_ok=True)
    except Exception:
        pass
    
    assets["lora_path"] = lora_filename
    assets["lora_ready"] = True
    tags["assets"] = assets
    return _serialize_character(db_character)

@router.post("/upload-image")
async def upload_character_image(
    file: UploadFile = File(...),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    import os
    import uuid
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    static_dir = os.path.join(base_dir, "static", "generated")
    os.makedirs(static_dir, exist_ok=True)
    
    ext = os.path.splitext(file.filename)[1] or ".png"
    filename = f"upload_{uuid.uuid4().hex[:10]}{ext}"
    filepath = os.path.join(static_dir, filename)
    
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)
        
    return {"url": f"/static/generated/{filename}"}

@router.post("/{character_id}/upload-asset", response_model=schemas.Character)
async def upload_character_asset(
    character_id: int,
    asset_type: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    import os
    import uuid
    db_character = db.query(Character).filter(Character.id == character_id).first()
    if not db_character:
        raise HTTPException(status_code=404, detail="Character not found")
        
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    static_dir = os.path.join(base_dir, "static", "generated")
    os.makedirs(static_dir, exist_ok=True)
    
    ext = os.path.splitext(file.filename)[1] or ".png"
    filename = f"upload_{asset_type}_{character_id}_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(static_dir, filename)
    
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)
        
    asset_url = f"/static/generated/{filename}"
    tags = dict(db_character.visual_tags or {})
    assets = dict(tags.get("assets", {})) if isinstance(tags.get("assets"), dict) else {}
    
    if asset_type == "avatar":
        assets["avatar_url"] = asset_url
    elif asset_type == "turnaround":
        assets["turnaround_url"] = asset_url
    elif asset_type == "face":
        assets["face_url"] = asset_url
        
    tags["assets"] = assets
    db_character.visual_tags = tags
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(db_character, "visual_tags")
    db.commit()
    db.refresh(db_character)
    
    return _serialize_character(db_character)



