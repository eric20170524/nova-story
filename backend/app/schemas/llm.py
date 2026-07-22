from typing import List, Dict, Optional, Literal
from pydantic import BaseModel, Field

class ContentAnalysis(BaseModel):
    new_entities: List[str] = Field(description="List of new characters or entities found in the text")
    updates: List[str] = Field(description="List of key plot updates or events")

class TimelineShot(BaseModel):
    id: int = Field(description="Sequential number of the shot")
    shot_type: str = Field(description="Type of shot (e.g., Extreme Long Shot, Close-up)")
    camera_movement: str = Field(description="Camera movement (e.g., Pan, Tilt, Zoom In)")
    camera_angle: str = Field(description="Camera angle (e.g., Eye-level, Low Angle)")
    visual_prompt: str = Field(description="Detailed description for image generation (English)")
    audio_prompt: str = Field(description="Description of background music and sound effects (English)")
    dialogue: Optional[str] = Field(None, description="Dialogue line (Speaker: Line)")
    duration: float = Field(description="Estimated duration in seconds")

class TimelineResponse(BaseModel):
    shots: List[TimelineShot] = Field(description="List of storyboard shots")

class VisualTags(BaseModel):
    hair: str = Field(description="Hair color and style")
    eyes: str = Field(description="Eye color and shape")
    skin_tone: str = Field(description="Skin tone description")
    face_features: str = Field(description="Specific facial features like scars, freckles")
    build: str = Field(description="Body build description")
    clothing: str = Field(description="Clothing description")
    accessories: str = Field(description="Accessories like glasses, jewelry")

class CharacterProfile(BaseModel):
    name: str = Field(description="Name of the character")
    role: Literal["main", "supporting", "minor"] = Field(description="Role of the character")
    description: str = Field(description="Brief biography and personality")
    visual_tags: VisualTags = Field(description="Structured visual traits")

class CharacterProfilesResponse(BaseModel):
    profiles: List[CharacterProfile] = Field(description="List of extracted character profiles")

class NewVariant(BaseModel):
    name: str = Field(description="Name of the new variant")
    tags: str = Field(description="Visual tags for the new variant")

class CharacterEvolution(BaseModel):
    action: Literal["new_variant", "keep_current", "scene_modifier"] = Field(description="Action to take regarding character appearance")
    reason: str = Field(description="Explanation for the action")
    new_variant: Optional[NewVariant] = Field(None, description="Details of the new variant if action is 'new_variant'")
    modifier_tags: Optional[str] = Field(None, description="Keywords for prompt if action is 'scene_modifier'")
