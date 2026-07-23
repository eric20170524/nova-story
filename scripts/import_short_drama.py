import os
import sys
import re
import uuid

# Ensure backend directory is in sys.path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.db.session import SessionLocal, engine
from app.db.base import Base
from app.models import Project, Chapter, Character, Scene, Workflow

def import_short_drama(file_path: str):
    # Ensure tables exist
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(file_path, 'r', encoding='gbk', errors='ignore') as f:
            content = f.read()

    filename = os.path.basename(file_path)

    # Regex for chapter / episode headers
    chapter_pattern = re.compile(
        r'^\s*(?:#{1,6}\s*)?(?:(?:第[ \t]*[0-9零一二三四五六七八九十百千]+[ \t]*[章集幕])|(?:Chapter|Episode|EP)[ \t]*\d+)[ \t]*[：: \t]*',
        re.IGNORECASE | re.MULTILINE
    )

    matches = list(chapter_pattern.finditer(content))
    first_match_start = matches[0].start() if matches else len(content)
    header_text = content[:first_match_start]

    # Parse Title
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
        title = os.path.splitext(filename)[0]

    # Description
    description_lines = [l for l in header_lines if l and not re.match(r'^[=\-*#~_]+$', l)]
    if description_lines and title in description_lines[0]:
        description_lines = description_lines[1:]
    description = "\n".join(description_lines).strip()

    # Clear old import of the same project if exists
    existing = db.query(Project).filter(Project.title == title).first()
    if existing:
        print(f"Removing existing project '{title}' (ID: {existing.id}) for clean re-import.")
        db.query(Chapter).filter(Chapter.project_id == existing.id).delete()
        db.query(Character).filter(Character.project_id == existing.id).delete()
        db.query(Project).filter(Project.id == existing.id).delete()
        db.commit()

    # Create Project
    db_project = Project(
        title=title,
        description=description,
        settings="{}",
        user_id="local_admin"
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)

    # Extract Characters
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

    # Extract Episodes / Chapters
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

        if not chapter_content:
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
    print(f"Successfully created project '{db_project.title}' (ID: {db_project.id})")
    print(f"Extracted {len(extracted_chars)} characters and {valid_chapters_count} episodes.")
    db.close()
    return db_project.id

if __name__ == "__main__":
    target = os.path.join(os.path.dirname(__file__), "..", "docs", "短剧", "万兽崩解：血脉的终局_12集完整短剧.txt")
    import_short_drama(target)
