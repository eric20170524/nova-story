from sqlalchemy import Column, Integer, String, Text, ForeignKey, DateTime, func
from sqlalchemy.orm import relationship
from ..db.base import Base

class CoverageGroup(Base):
    __tablename__ = "coverage_group"

    id = Column(Integer, primary_key=True, index=True)
    source_scene_id = Column(Integer, ForeignKey("scene.id", ondelete="CASCADE"), nullable=False)
    version = Column(Integer, default=1)
    status = Column(String(50), default="completed") # processing, completed, failed
    created_at = Column(DateTime, server_default=func.now())

    source_scene = relationship("Scene", back_populates="coverage_groups")
    shots = relationship("CoverageShot", back_populates="group", cascade="all, delete-orphan", order_by="CoverageShot.slot")

class CoverageShot(Base):
    __tablename__ = "coverage_shot"

    id = Column(Integer, primary_key=True, index=True)
    coverage_group_id = Column(Integer, ForeignKey("coverage_group.id", ondelete="CASCADE"), nullable=False)
    slot = Column(Integer, nullable=False) # 1 to 9
    
    shot_size = Column(String(50), nullable=True) # ELS, LS, MLS, MS, MCU, CU, ECU
    camera_angle = Column(String(50), nullable=True) # Eye-level, Low Angle, High Angle
    camera_movement = Column(String(50), nullable=True)
    narrative_purpose = Column(String(255), nullable=True)
    visual_prompt = Column(Text, nullable=True)
    
    asset_status = Column(String(50), default="idle")
    task_id = Column(String(255), nullable=True)
    asset_url = Column(String(500), nullable=True)
    
    promoted_scene_id = Column(Integer, nullable=True) # If promoted to main timeline scene

    group = relationship("CoverageGroup", back_populates="shots")
