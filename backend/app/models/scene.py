from sqlalchemy import Column, Integer, String, Text, ForeignKey, Float
from ..db.base import Base

class Scene(Base):
    id = Column(Integer, primary_key=True, index=True)
    chapter_id = Column(String(36), ForeignKey("chapter.id", ondelete="CASCADE"), nullable=False)
    
    index = Column(Integer, nullable=False) # Order in the timeline
    visual_prompt = Column(Text, nullable=True)
    audio_prompt = Column(Text, nullable=True)
    dialogue = Column(Text, nullable=True)
    duration = Column(Float, default=3.0)
    
    # Camera/Shot Details
    shot_type = Column(String(50), nullable=True)
    camera_movement = Column(String(50), nullable=True)
    camera_angle = Column(String(50), nullable=True)

    # Asset Generation Status
    asset_status = Column(String(50), default="idle") # idle, generating, completed, failed
    task_id = Column(String(255), nullable=True) # To track async generation task
    asset_url = Column(String(500), nullable=True) # URL/Path to generated image/video
