from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
import os
import json

from ...db.session import SessionLocal
from ...models.workflow import Workflow
from ...schemas import workflow as schemas

router = APIRouter()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/files", response_model=List[str])
def list_workflow_files():
    """
    List all workflow JSON files in the static directory.
    """
    static_workflows_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "static", "workflows")
    if not os.path.exists(static_workflows_dir):
        return []
    
    files = [f for f in os.listdir(static_workflows_dir) if f.endswith('.json')]
    return files

@router.post("/", response_model=schemas.Workflow)
def create_workflow(workflow: schemas.WorkflowCreate, db: Session = Depends(get_db)):
    db_workflow = Workflow(
        name=workflow.name,
        description=workflow.description,
        content=workflow.content,
        is_active=workflow.is_active
    )
    db.add(db_workflow)
    db.commit()
    db.refresh(db_workflow)
    return db_workflow

@router.get("/", response_model=List[schemas.Workflow])
def read_workflows(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    workflows = db.query(Workflow).filter(Workflow.is_active == True).offset(skip).limit(limit).all()
    return workflows

@router.get("/{workflow_id}", response_model=schemas.Workflow)
def read_workflow(workflow_id: int, db: Session = Depends(get_db)):
    db_workflow = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if db_workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return db_workflow

@router.put("/{workflow_id}", response_model=schemas.Workflow)
def update_workflow(workflow_id: int, workflow: schemas.WorkflowUpdate, db: Session = Depends(get_db)):
    db_workflow = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if db_workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    update_data = workflow.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_workflow, key, value)

    db.add(db_workflow)
    db.commit()
    db.refresh(db_workflow)
    return db_workflow

@router.delete("/{workflow_id}", response_model=schemas.Workflow)
def delete_workflow(workflow_id: int, db: Session = Depends(get_db)):
    db_workflow = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if db_workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    db.delete(db_workflow)
    db.commit()
    return db_workflow
