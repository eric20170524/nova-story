from fastapi import Depends, HTTPException, Header, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional, Dict, Any
from app.core.settings_manager import SettingsManager
from app.services.nebula import NebulaClient

security = HTTPBearer(auto_error=False)

def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
    x_device_fingerprint: Optional[str] = Header(None)
) -> Optional[Dict[str, Any]]:
    """
    Verifies the user against Nebula if enabled.
    """
    settings = SettingsManager.load_settings()
    nebula_config = settings.get("nebula", {})
    
    if not nebula_config.get("enabled"):
        # If Nebula is disabled, we assume local dev / single user mode
        # Return a mock admin user or None (depending on strictness)
        return {"id": "local_admin", "username": "admin", "role": "admin"}
    
    # If Nebula IS enabled, we enforce token validation
    token = None
    if credentials:
        token = credentials.credentials
    
    if not token:
        # Check if Guest Mode is allowed via Fingerprint?
        # For now, let's enforce Token for critical operations
        raise HTTPException(status_code=401, detail="Authentication required (Nebula Token)")
    
    # Verify against Nebula (Local JWT Validation)
    try:
        # Import here to avoid circular dependency
        import jwt
        from app.core.config import settings as app_settings
        
        # If NEBULA_JWT_SECRET is not set, we cannot validate.
        if not app_settings.NEBULA_JWT_SECRET:
             # Fallback to remote verification if secret is missing? 
             # Or just fail securely. Let's log warning and try remote if client exists.
             # For now, strict on secret.
             raise HTTPException(status_code=500, detail="Server misconfiguration: NEBULA_JWT_SECRET missing")

        payload = jwt.decode(token, app_settings.NEBULA_JWT_SECRET, algorithms=["HS256"])
        user_id = payload.get("sub") or payload.get("id")
        
        if not user_id:
             raise HTTPException(status_code=401, detail="Invalid token payload")
             
        # Return minimal user info from token
        return {"id": user_id, "username": payload.get("name", "Unknown"), "role": payload.get("role", "user")}
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

def get_current_active_user(
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    if not current_user:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user
