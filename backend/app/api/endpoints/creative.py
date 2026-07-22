from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import logging

from ...db.session import SessionLocal
from ...models.chapter import Chapter
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

class DraftRequest(BaseModel):
    instructions: str
    context_chapter_id: Optional[str] = None
    context_text: Optional[str] = None

class AnalysisRequest(BaseModel):
    content: str

class StoryboardGridRequest(BaseModel):
    story_text: str

@router.post("/storyboard-grid")
async def generate_storyboard_grid(
    req: StoryboardGridRequest,
    auth: HTTPAuthorizationCredentials = Security(auth_security),
    current_user = Depends(get_current_active_user)
):
    logger.info(f"Received storyboard grid request. Story length: {len(req.story_text)}")
    token = auth.credentials if auth else None
    try:
        result = LLMService.generate_storyboard_grid(req.story_text, token=token)
        return {"prompt": result}
    except Exception as e:
        logger.error(f"Storyboard grid generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/draft")
async def draft_content(
    req: DraftRequest, 
    db: Session = Depends(get_db),
    auth: HTTPAuthorizationCredentials = Security(auth_security),
    current_user = Depends(get_current_active_user) # Ensure auth
):
    logger.info(f"Received draft request. Instructions: {req.instructions[:50]}...")
    context_text = req.context_text if req.context_text else ""
    token = auth.credentials if auth else None
    
    if not context_text and req.context_chapter_id:
        chapter = db.query(Chapter).filter(Chapter.id == req.context_chapter_id).first()
        if chapter:
            # Simple context: Summary of previous chapter + title + current content if available?
            # Actually usually context is what comes BEFORE. 
            context_text = f"Previous Chapter: {chapter.title}\nSummary: {chapter.summary or 'No summary'}"
            logger.info(f"Using context from chapter: {req.context_chapter_id}")
    
    try:
        generated_text = LLMService.generate_draft(req.instructions, context_text, token=token)
        logger.info("Draft generation successful")
        return {"content": generated_text}
    except Exception as e:
        logger.error(f"Draft generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/analyze")
async def analyze_impact(
    req: AnalysisRequest,
    auth: HTTPAuthorizationCredentials = Security(auth_security),
    current_user = Depends(get_current_active_user)
):
    logger.info(f"Received analysis request for content length: {len(req.content)}")
    token = auth.credentials if auth else None
    try:
        result = LLMService.analyze_content(req.content, token=token)
        logger.info("Content analysis successful")
        return result
    except Exception as e:
        logger.error(f"Content analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/context/{chapter_id}")
async def get_context(chapter_id: str, db: Session = Depends(get_db)):
    chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    # Get all chapters in project to show structure
    project_chapters = db.query(Chapter).filter(Chapter.project_id == chapter.project_id).order_by(Chapter.index).all()
    structure = [{"id": c.id, "title": c.title, "index": c.index} for c in project_chapters]
    
    return {
        "project_structure": structure,
        "focus": chapter.summary or "No summary available",
        "characters": [] # TODO: Implement Character model fetching
    }

