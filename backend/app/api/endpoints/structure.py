from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from pydantic import BaseModel
import logging

from ...db.session import SessionLocal
from ...models.chapter import Chapter

# Setup logger
logger = logging.getLogger(__name__)

router = APIRouter()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Pydantic Models
class ChapterCreate(BaseModel):
    id: str
    project_id: int
    title: str
    index: int
    content: Optional[str] = None

class ChapterUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None

class ChapterMove(BaseModel):
    new_index: int

# Endpoints
@router.post("/")
def create_chapter(chapter: ChapterCreate, db: Session = Depends(get_db)):
    logger.info(f"Create chapter request: {chapter}")
    try:
        db_chapter = Chapter(**chapter.dict())
        db.add(db_chapter)
        db.commit()
        db.refresh(db_chapter)
        logger.info(f"Chapter created: {db_chapter.id}")
        return db_chapter
    except Exception as e:
        logger.error(f"Error creating chapter: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/")
def get_chapters(project_id: int, db: Session = Depends(get_db)):
    logger.info(f"Get chapters for project_id: {project_id}")
    try:
        chapters = db.query(Chapter).filter(Chapter.project_id == project_id).order_by(Chapter.index).all()
        logger.info(f"Found {len(chapters)} chapters for project {project_id}")
        return chapters
    except Exception as e:
        logger.error(f"Error fetching chapters for project {project_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{chapter_id}")
def delete_chapter(chapter_id: str, db: Session = Depends(get_db)):
    logger.info(f"Delete chapter request: {chapter_id}")
    db_chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not db_chapter:
        logger.warning(f"Chapter not found for deletion: {chapter_id}")
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    try:
        db.delete(db_chapter)
        db.commit()
        logger.info(f"Chapter deleted: {chapter_id}")
        return {"status": "success", "id": chapter_id}
    except Exception as e:
        logger.error(f"Error deleting chapter {chapter_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/{chapter_id}")
def update_chapter(chapter_id: str, update: ChapterUpdate, db: Session = Depends(get_db)):
    logger.info(f"Update chapter request: {chapter_id}, Data: {update}")
    db_chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not db_chapter:
        logger.warning(f"Chapter not found for update: {chapter_id}")
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    try:
        update_data = update.dict(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_chapter, key, value)
        
        db.commit()
        db.refresh(db_chapter)
        logger.info(f"Chapter updated: {chapter_id}")
        return db_chapter
    except Exception as e:
        logger.error(f"Error updating chapter {chapter_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{chapter_id}/move")
def move_chapter(chapter_id: str, move: ChapterMove, db: Session = Depends(get_db)):
    logger.info(f"Move chapter request: {chapter_id} to index {move.new_index}")
    db_chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not db_chapter:
        logger.warning(f"Chapter not found for move: {chapter_id}")
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    try:
        old_index = db_chapter.index
        new_index = move.new_index
        project_id = db_chapter.project_id

        if old_index == new_index:
            return {"status": "no_change", "new_index": new_index}

        if new_index > old_index:
            # Moving down: shift items between old and new UP (index - 1)
            # Actually, if I move 1 to 3:
            # 1(A), 2(B), 3(C) -> A moves to 3
            # B becomes 1, C becomes 2, A becomes 3.
            # So items in (old, new] decrease index by 1.
            chapters_to_shift = db.query(Chapter).filter(
                Chapter.project_id == project_id,
                Chapter.index > old_index,
                Chapter.index <= new_index
            ).all()
            for ch in chapters_to_shift:
                ch.index -= 1
                
        else: # new_index < old_index
            # Moving up: shift items between new and old DOWN (index + 1)
            # 1(A), 2(B), 3(C) -> C moves to 1
            # C becomes 1, A becomes 2, B becomes 3.
            # So items in [new, old) increase index by 1.
            chapters_to_shift = db.query(Chapter).filter(
                Chapter.project_id == project_id,
                Chapter.index >= new_index,
                Chapter.index < old_index
            ).all()
            for ch in chapters_to_shift:
                ch.index += 1

        db_chapter.index = new_index
        db.commit()
        logger.info(f"Chapter moved: {chapter_id} from {old_index} to {new_index}")
        
        return {"status": "moved", "new_index": new_index}
    except Exception as e:
        logger.error(f"Error moving chapter {chapter_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
