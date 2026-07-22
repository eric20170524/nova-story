from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from sqlalchemy.sql import func
from ..db.base import Base

class Project(Base):
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Owner (Nebula User ID or local admin)
    user_id = Column(String(100), nullable=True, index=True)

    # Simple JSON config for MVP (e.g., {"width": 1080, "height": 1920})
    settings = Column(Text, nullable=True) 
