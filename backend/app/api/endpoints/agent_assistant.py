from fastapi import APIRouter, Depends
from app.api import deps
from ...schemas.agent import AgentRequest, AgentResponse
from ...services.ai.agent_service import AgentService

router = APIRouter()

@router.post("/chat", response_model=AgentResponse)
async def chat_with_agent(
    request: AgentRequest,
    current_user: dict = Depends(deps.get_current_active_user)
):
    """
    Interact with the Agentic OS Assistant using independent LLM service.
    """
    service = AgentService()
    response = service.process_request(request)
    return response
