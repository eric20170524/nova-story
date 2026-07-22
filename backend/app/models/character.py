from sqlalchemy import Column, Integer, String, Text, ForeignKey, JSON
from ..db.base import Base

class Character(Base):
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("project.id"))
    
    name = Column(String(100), nullable=False)
    role = Column(String(50)) # Protagonist, Antagonist, Supporting
    description = Column(Text)
    
    # Visual Tags (for Stable Diffusion/ComfyUI)
    # e.g. {"hair": "blue", "style": "cyberpunk"}
    visual_tags = Column(JSON, nullable=True)
