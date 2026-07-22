from pydantic import BaseModel
from typing import Optional, Dict, Any

class WorkflowBase(BaseModel):
    name: str
    description: Optional[str] = None
    content: Dict[str, Any]
    is_active: bool = True

class WorkflowCreate(WorkflowBase):
    pass

class WorkflowUpdate(WorkflowBase):
    name: Optional[str] = None
    content: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None

class Workflow(WorkflowBase):
    id: int

    class Config:
        from_attributes = True
