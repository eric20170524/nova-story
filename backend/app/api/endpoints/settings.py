from fastapi import APIRouter, HTTPException
from typing import Dict, Any
from app.core.settings_manager import SettingsManager
from app.services.nebula import NebulaClient

router = APIRouter()

@router.get("/", response_model=Dict[str, Any])
def get_settings():
    """
    Get current system settings.
    """
    return SettingsManager.load_settings()

@router.post("/", response_model=Dict[str, Any])
def update_settings(settings: Dict[str, Any]):
    """
    Update system settings.
    """
    return SettingsManager.save_settings(settings)

@router.post("/verify-nebula")
def verify_nebula_connection(config: Dict[str, Any]):
    """
    Verifies Nebula connection and token using the provided settings.
    Expects a partial or full settings dict containing 'nebula' key, or the nebula config dict directly.
    """
    # Handle if full settings passed or just nebula config
    nebula_config = config.get("nebula", config)
    
    base_url = nebula_config.get("base_url")
    token = nebula_config.get("system_token")
    
    if not token:
        raise HTTPException(status_code=400, detail="No token provided for verification")
    
    try:
        # Use provided base_url if available, else NebulaClient uses saved default
        client = NebulaClient(base_url=base_url)
        result = client.verify_token(token)
        
        if result:
            return {"status": "success", "user": result}
        else:
            raise HTTPException(status_code=401, detail="Verification failed: Invalid token or unreachable host")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Verification error: {str(e)}")
