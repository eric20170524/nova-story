from fastapi import Depends, HTTPException, Header, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional, Dict, Any

security = HTTPBearer(auto_error=False)

def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
    x_device_fingerprint: Optional[str] = Header(None)
) -> Optional[Dict[str, Any]]:
    """
    Returns current user. In standalone mode, defaults to local admin user.
    """
    return {"id": "local_admin", "username": "admin", "role": "admin"}

def get_current_active_user(
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    if not current_user:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user
