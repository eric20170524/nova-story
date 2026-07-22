from sqlalchemy import Column, Integer, String, Text, JSON, Boolean
from ..db.base import Base

class Workflow(Base):
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    content = Column(JSON, nullable=False) # The ComfyUI workflow JSON
    is_active = Column(Boolean, default=True)
