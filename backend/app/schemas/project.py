from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class ProjectBase(BaseModel):
    title: str
    description: Optional[str] = None
    settings: Optional[str] = None # JSON string for now

class ProjectCreate(ProjectBase):
    pass

class ProjectUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    settings: Optional[str] = None

class ProjectImport(BaseModel):
    file_path: str

class Project(ProjectBase):
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    user_id: Optional[str] = None

    class Config:
        from_attributes = True