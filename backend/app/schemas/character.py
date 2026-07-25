from pydantic import BaseModel
from typing import Optional, Any, Dict

class CharacterBase(BaseModel):
    name: str
    role: Optional[str] = None
    description: Optional[str] = None
    visual_tags: Optional[Dict[str, Any]] = None
    avatar_url: Optional[str] = None
    turnaround_url: Optional[str] = None
    face_url: Optional[str] = None
    model_type: Optional[str] = "pony"  # "pony" or "flux"

class CharacterCreate(CharacterBase):
    project_id: int

class CharacterUpdate(CharacterBase):
    name: Optional[str] = None
    project_id: Optional[int] = None

class Character(CharacterBase):
    id: int
    project_id: int

    class Config:
        from_attributes = True

