import os
import json
import logging
from sqlalchemy.orm import Session
from ..models.workflow import Workflow
from ..db.session import SessionLocal

logger = logging.getLogger(__name__)

def init_workflows(db: Session):
    """
    Scans the static/workflows directory and populates the database 
    with any workflows that don't currently exist.
    """
    # Define path relative to this file
    # This file is in backend/app/db/
    # Workflows are in backend/app/static/workflows/
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    workflow_dir = os.path.join(base_dir, "static", "workflows")

    if not os.path.exists(workflow_dir):
        logger.warning(f"Workflow directory not found: {workflow_dir}")
        return

    files = [f for f in os.listdir(workflow_dir) if f.endswith('.json')]
    
    for filename in files:
        name = os.path.splitext(filename)[0]
        
        # Check if exists
        exists = db.query(Workflow).filter(Workflow.name == name).first()
        if exists:
            logger.info(f"Workflow '{name}' already exists in DB. Skipping.")
            continue
            
        file_path = os.path.join(workflow_dir, filename)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = json.load(f)
                
            new_workflow = Workflow(
                name=name,
                description=f"Auto-imported from {filename}",
                content=content,
                is_active=True
            )
            db.add(new_workflow)
            db.commit()
            logger.info(f"Imported workflow: {name}")
            
        except Exception as e:
            logger.error(f"Failed to import workflow {filename}: {e}")
            db.rollback()

def init():
    db = SessionLocal()
    try:
        init_workflows(db)
    finally:
        db.close()
