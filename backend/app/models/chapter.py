from sqlalchemy import Column, Integer, String, Text, ForeignKey, Float
from sqlalchemy.orm import relationship
from ..db.base import Base

class Chapter(Base):
    id = Column(String(36), primary_key=True) # UUID
    project_id = Column(Integer, ForeignKey("project.id"))
    
    index = Column(Integer, nullable=False)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=True) # The draft text
    summary = Column(Text, nullable=True) # Summary for context
    
    # Status
    status = Column(String(50), default="draft") # draft, reviewed, script_ready
    
    project = relationship("Project", backref="chapters")
    scenes = relationship("Scene", backref="chapter", cascade="all, delete-orphan")
