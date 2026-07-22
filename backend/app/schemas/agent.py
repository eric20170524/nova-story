from typing import List, Optional, Dict, Any, Union
from pydantic import BaseModel, Field

class AgentContext(BaseModel):
    project_id: Optional[int] = None
    chapter_id: Optional[str] = None
    scene_id: Optional[str] = None
    selected_text: Optional[str] = None
    language: Optional[str] = "zh"

class AgentRequest(BaseModel):
    message: str
    context: AgentContext
    history: List[Dict[str, str]] = [] # [{"role": "user", "content": "..."}, ...]

class ToolCall(BaseModel):
    tool_name: str
    arguments: Dict[str, Any]
    reason: str

class AgentResponse(BaseModel):
    thought: str = Field(..., description="The internal reasoning process of the agent.")
    response: str = Field(..., description="The natural language response to the user.")
    action: Optional[ToolCall] = Field(None, description="An optional tool call to execute.")

class ToolResult(BaseModel):
    tool_name: str
    result: Any
    status: str = "success" # success, error
