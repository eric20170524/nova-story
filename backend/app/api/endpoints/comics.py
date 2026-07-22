from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from ...db.session import SessionLocal
from ...models.scene import Scene
from ...models.chapter import Chapter
from ...services.comic_service import ComicService
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.post("/{chapter_id}/generate")
async def generate_comic(chapter_id: str, db: Session = Depends(get_db)):
    """
    Generate comic pages and PDF for a chapter.
    """
    chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
        
    scenes = db.query(Scene).filter(Scene.chapter_id == chapter_id).order_by(Scene.index).all()
    
    if not scenes:
        raise HTTPException(status_code=400, detail="No scenes found in chapter")
        
    # Check if we have generated assets
    valid_scenes = [s for s in scenes if s.asset_url]
    if not valid_scenes:
        raise HTTPException(status_code=400, detail="No scenes have generated images")
        
    service = ComicService()
    
    generated_pages = []
    page_paths = []
    
    for scene in valid_scenes:
        text = scene.dialogue or ""
        
        try:
            # Synchronous call for now. 
            # In production, this should be a Celery task or proper async loop
            # if downloading many remote images.
            res = service.generate_page(scene.id, scene.asset_url, text)
            if res:
                url, path = res
                generated_pages.append({"scene_id": scene.id, "url": url})
                page_paths.append(path)
        except Exception as e:
            logger.error(f"Failed to generate comic page for scene {scene.id}: {e}")
            
    if not generated_pages:
        raise HTTPException(status_code=500, detail="Failed to generate any comic pages")
        
    # Generate PDF
    pdf_url = None
    try:
        pdf_url = service.generate_pdf(chapter_id, page_paths)
    except Exception as e:
        logger.error(f"Failed to generate PDF: {e}")
        
    return {
        "status": "completed",
        "chapter_id": chapter_id,
        "total_scenes": len(scenes),
        "generated_count": len(generated_pages),
        "pages": generated_pages,
        "pdf_url": pdf_url
    }
