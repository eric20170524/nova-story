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
        try:
            content = content_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            content = content_bytes.decode("gbk", errors="ignore")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read file: {str(e)}")

    if not content.strip():
        raise HTTPException(status_code=400, detail="File is empty")

    filename = file.filename or ""

    # 1. Regex to match chapter / episode headers
    chapter_pattern = re.compile(
        r'^\s*(?:#{1,6}\s*)?(?:(?:第[ \t]*[0-9零一二三四五六七八九十百千]+[ \t]*[章集幕])|(?:Chapter|Episode|EP)[ \t]*\d+)[ \t]*[：: \t]*',
        re.IGNORECASE | re.MULTILINE
    )
    
    matches = list(chapter_pattern.finditer(content))
    first_match_start = matches[0].start() if matches else len(content)
    header_text = content[:first_match_start]

    # Extract Title
    title = ""
    header_lines = [l.strip() for l in header_text.splitlines()]
    non_decor_lines = [l for l in header_lines if l and not re.match(r'^[=\-*#~_]+$', l)]
    
    if non_decor_lines:
        first_line = non_decor_lines[0]
        m_book = re.search(r'《([^》]+)》', first_line)
        if m_book:
            title = m_book.group(1).strip()
        else:
            title = first_line.lstrip('#=*- ').strip()
            
    if not title:
        title = os.path.splitext(filename)[0] if filename else "Imported Project (导入项目)"

    # Extract Description
    description_lines = [l for l in header_lines if l and not re.match(r'^[=\-*#~_]+$', l)]
    if description_lines and title in description_lines[0]:
        description_lines = description_lines[1:]
    description = "\n".join(description_lines).strip()

    # Create Project DB instance
    db_project = Project(
        title=title,
        description=description,
        settings="{}",
        user_id=current_user["id"]
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)

    # Extract Characters from Header if character list exists
    from ...models.character import Character
    extracted_chars = []
    for line in header_lines:
        if line.startswith('·') or line.startswith('-') or line.startswith('*'):
            clean_line = line.lstrip('·-* ').strip()
            if '：' in clean_line or ':' in clean_line:
                parts = re.split(r'[：:]', clean_line, 1)
                c_name = parts[0].strip()
                c_desc = parts[1].strip()
                c_role = "Supporting"
                if any(k in c_desc or k in c_name for k in ["男主", "女主", "主角", "Protagonist"]):
                    c_role = "Protagonist"
                elif any(k in c_desc or k in c_name for k in ["反派", "敌", "督军", "监军", "伪神", "Antagonist"]):
                    c_role = "Antagonist"
                
                if c_name and not any(c.name == c_name for c in extracted_chars):
                    db_char = Character(
                        project_id=db_project.id,
                        name=c_name,
                        role=c_role,
                        description=c_desc
                    )
                    db.add(db_char)
                    extracted_chars.append(db_char)
    
    if extracted_chars:
        db.commit()
        print(f"DEBUG: Parsed and saved {len(extracted_chars)} characters.")

    # Extract Chapters / Episodes
    valid_chapters_count = 0
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i+1].start() if i + 1 < len(matches) else len(content)
        full_chapter_text = content[start:end].strip()
        
        chunk_lines = [l for l in full_chapter_text.splitlines() if not re.match(r'^[=\-*#~_]+$', l.strip())]
        if not chunk_lines:
            continue

        chapter_title_line = chunk_lines[0].lstrip('#=*- ').strip()
        chapter_content = "\n".join(chunk_lines[1:]).strip() if len(chunk_lines) > 1 else ""

        if "(章节内容尚未生成)" in chapter_content or not chapter_content:
            print(f"DEBUG: Skipping Chapter {i+1} (Empty)")
            continue
            
        db_chapter = Chapter(
            id=str(uuid.uuid4()),
            project_id=db_project.id,
            index=valid_chapters_count + 1,
            title=chapter_title_line,
            content=chapter_content,
            status="draft"
        )
        db.add(db_chapter)
        valid_chapters_count += 1
        
    db.commit()
    print(f"DEBUG: Successfully imported project '{db_project.title}' with {valid_chapters_count} chapters.")
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