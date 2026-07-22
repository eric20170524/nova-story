from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
from sqlalchemy.orm import Session
from typing import List, Dict, Any

from ...db.session import SessionLocal
from ...models.project import Project
from ...models.chapter import Chapter
from ...schemas import project as schemas
from ..deps import get_current_active_user
import os
import re
import uuid

router = APIRouter()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.post("/import", response_model=schemas.Project)
async def import_project(
    file: UploadFile = File(...), 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    try:
        content_bytes = await file.read()
        content = content_bytes.decode("utf-8")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read file: {str(e)}")

    lines = content.splitlines()
    if not lines:
        raise HTTPException(status_code=400, detail="File is empty")

    # 1. Parse Title and Description
    # First line is usually title
    title = lines[0].strip().replace("Title:", "").replace("标题：", "").strip()
    
    # Description: Everything until the first chapter or separator
    description_lines = []
    
    # Find start of first chapter
    # Regex to match "第X章" or "Chapter X" with optional punctuation
    chapter_pattern = re.compile(r'^\s*(?:第[ \t]*[0-9零一二三四五六七八九十百千]+[ \t]*章|Chapter[ \t]*\d+)[ \t]*[：: ]*', re.IGNORECASE | re.MULTILINE)
    
    first_chapter_index = -1
    for i in range(1, len(lines)):
        if chapter_pattern.match(lines[i]):
            first_chapter_index = i
            break
        
    if first_chapter_index != -1:
        description_lines = lines[1:first_chapter_index]
    else:
        # No chapters found?
        description_lines = lines[1:]

    # ...
    description = "\n".join(description_lines).strip()
    
    print(f"DEBUG: Parsed Title: {title}")
    print(f"DEBUG: Parsed Description Length: {len(description)}")
    
    # Create Project
    db_project = Project(
        title=title,
        description=description,
        settings="{}",
        user_id=current_user["id"]
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)

    # 2. Parse Chapters
    # Split content by chapter headers
    # We use regex split to keep delimiters? No, finditer is better to get positions.
    
    matches = list(chapter_pattern.finditer(content))
    print(f"DEBUG: Found {len(matches)} chapter matches.")
    
    valid_chapters_count = 0
    
    for i, match in enumerate(matches):
        chapter_start = match.start()
        # End is start of next match or end of file
        chapter_end = matches[i+1].start() if i + 1 < len(matches) else len(content)
        
        full_chapter_text = content[chapter_start:chapter_end]
        
        # Extract title line
        lines_in_chapter = full_chapter_text.strip().splitlines()
        chapter_title_line = lines_in_chapter[0]
        
        # Extract pure title (remove "Chapter X: ")
        # match.group() is the "Chapter X: " part (or close to it)
        # Re-match the line to split prefix and title
        m = chapter_pattern.match(chapter_title_line)
        if m:
            prefix_len = m.end()
            chapter_title_text = chapter_title_line[prefix_len:].strip()
        else:
            chapter_title_text = chapter_title_line # Should not happen given logic
            
        chapter_content = "\n".join(lines_in_chapter[1:]).strip()
        
        print(f"DEBUG: Processing Chapter {i+1}: {chapter_title_text}")
        print(f"DEBUG: Content Length: {len(chapter_content)}")
        
        # Filter: Skip if content contains marker or is empty
        if "(章节内容尚未生成)" in chapter_content or not chapter_content:
            print(f"DEBUG: Skipping Chapter {i+1} (Incomplete or Empty)")
            continue
            
        # Create Chapter
        db_chapter = Chapter(
            id=str(uuid.uuid4()),
            project_id=db_project.id,
            index=valid_chapters_count + 1,
            title=chapter_title_text,
            content=chapter_content,
            status="draft"
        )
        db.add(db_chapter)
        valid_chapters_count += 1
        
    db.commit()
    print(f"DEBUG: Successfully imported {valid_chapters_count} chapters.")
    return db_project

@router.post("/", response_model=schemas.Project)
def create_project(
    project: schemas.ProjectCreate, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_project = Project(
        title=project.title,
        description=project.description,
        settings=project.settings,
        user_id=current_user["id"]
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)
    return db_project

@router.get("/", response_model=List[schemas.Project])
def read_projects(
    skip: int = 0, 
    limit: int = 100, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    query = db.query(Project)
    
    # Filter by user
    if current_user["id"] == "local_admin":
        # In local mode, we might typically see all or just local_admin's.
        # But since we just added the column, old projects have NULL user_id.
        # Let's allow local_admin to see NULLs too for backward compatibility.
        # Or better: show everything for local_admin to keep it simple for single-user dev.
        pass
    else:
        query = query.filter(Project.user_id == current_user["id"])
        
    projects = query.offset(skip).limit(limit).all()
    return projects

@router.get("/{project_id}", response_model=schemas.Project)
def read_project(
    project_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_project = db.query(Project).filter(Project.id == project_id).first()
    if db_project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    # Ownership Check
    if current_user["id"] != "local_admin" and db_project.user_id != current_user["id"]:
         raise HTTPException(status_code=403, detail="Not authorized to access this project")
         
    return db_project

@router.put("/{project_id}", response_model=schemas.Project)
def update_project(
    project_id: int, 
    project: schemas.ProjectUpdate, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_project = db.query(Project).filter(Project.id == project_id).first()
    if db_project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    # Ownership Check
    if current_user["id"] != "local_admin" and db_project.user_id != current_user["id"]:
         raise HTTPException(status_code=403, detail="Not authorized to update this project")
    
    update_data = project.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_project, key, value)

    db.add(db_project)
    db.commit()
    db.refresh(db_project)
    return db_project

@router.delete("/{project_id}", response_model=schemas.Project)
def delete_project(
    project_id: int, 
    db: Session = Depends(get_db),
    current_user: Dict[str, Any] = Depends(get_current_active_user)
):
    db_project = db.query(Project).filter(Project.id == project_id).first()
    if db_project is None:
        raise HTTPException(status_code=404, detail="Project not found")
        
    # Ownership Check
    if current_user["id"] != "local_admin" and db_project.user_id != current_user["id"]:
         raise HTTPException(status_code=403, detail="Not authorized to delete this project")
    
    db.delete(db_project)
    db.commit()
    return db_project