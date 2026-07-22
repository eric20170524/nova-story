from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx
from app.core.config import settings
from app.api import deps
from ...schemas.agent import AgentRequest, AgentResponse
from ...services.ai.agent_service import AgentService

router = APIRouter()
security = HTTPBearer(auto_error=False)

@router.post("/chat", response_model=AgentResponse)
async def chat_with_agent(
    request: AgentRequest,
    current_user: dict = Depends(deps.get_current_active_user),
    token_creds: HTTPAuthorizationCredentials = Depends(security)
):
    """
    Interact with the Agentic OS Assistant.
    Proxies to Nebula V2 if enabled for unified billing/auth.
    """
    # Check if we should proxy to Nebula
    # We use the token from the request to authenticate with Nebula
    if settings.NEBULA_API_URL and token_creds:
         token = token_creds.credentials
         nebula_url = f"{settings.NEBULA_API_URL}/chat/message"
         
         # Construct the prompt from the request context
         # This simple logic assumes the agent service builds a specific prompt structure.
         # For the proxy, we might need to send the raw request or a formatted one.
         # Let's keep it simple: We use the AgentService to build the prompt, then send IT to Nebula.
         
         # 1. Build Context/Prompt locally (Keep NovaStory logic hidden)
         service = AgentService()
         # internal_prompt = service.build_system_prompt(request) # Hypothetical method
         # For now, let's just forward the user's instruction combined with context
         
         full_content = f"Context: {request.context}\n\nInstruction: {request.instruction}"
         
         async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    nebula_url,
                    json={
                        "session_id": request.session_id or "temp_session",
                        "content": full_content,
                        # "model_override": "google/gemini-2.5-flash" # Optional
                    },
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"
                    },
                    timeout=60.0
                )
                
                if response.status_code == 402:
                    raise HTTPException(status_code=402, detail="Nebula Credit Insufficient")
                
                response.raise_for_status()
                nebula_data = response.json()
                
                # Adapt Nebula response to AgentResponse
                # Nebula returns stream or simple JSON? Docs say stream, but let's assume non-stream for this MVP proxy
                # If stream, we need to handle SSE.
                # Assuming simple response for now or we need to implement SSE handling.
                
                return AgentResponse(
                    response=nebula_data.get("text", ""),
                    thought="Processed by Nebula",
                    actions=[]
                )

            except httpx.HTTPStatusError as e:
                # Fallback or Error
                print(f"Nebula Error: {e}")
                # If Nebula fails, do we fallback to local? 
                # Probably not if billing is required.
                raise HTTPException(status_code=e.response.status_code, detail=f"Nebula API Error: {e.response.text}")
            except Exception as e:
                print(f"Proxy Error: {e}")
                # Fallback to local execution if configured?
                pass

    # Local Fallback (Original Logic)
    service = AgentService()
    response = service.process_request(request)
    return response
