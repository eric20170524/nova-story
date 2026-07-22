# NovaStory 与 Nebula V2 深度集成最佳实践指南

本文档描述了 **NovaStory** (独立应用) 如何无缝集成 **Nebula V2** (平台) 的认证、计费与大模型能力，实现“轻量化后端，平台化赋能”的架构目标。

## 1. 核心架构原则

*   **单一身份源 (Single Sign-On)**: Nebula V2 作为 Identity Provider (IdP)，NovaStory 不维护用户密码，仅存储业务数据（Project/Character/Story）。
*   **统一计费 (Unified Billing)**: 所有 AI 消耗（对话、生图）均通过 Nebula V2 的 API 发生，自动扣除用户在 Nebula 平台的积分/余额。NovaStory 无需自建支付系统。
*   **透传鉴权 (Pass-through Auth)**: NovaStory 前端获取 Nebula 的 JWT Token，在调用 NovaStory 后端时携带该 Token。NovaStory 后端（或前端直接）使用该 Token 调用 Nebula API。

---

## 2. 认证与用户流 (Authentication Flow)

### 2.1 登录流程

NovaStory 不提供“注册/登录”页面，而是引导用户前往 Nebula 授权。

1.  **用户访问 NovaStory**: 检查本地存储是否有有效 `nebula_token`。
2.  **未登录/Token无效**:
    *   跳转至 Nebula 登录页: `https://www.chuangyi.chat/login?redirect=https://novastory.ai/callback`
    *   或者使用弹出窗口/iframe (如果同域) 进行登录。
3.  **登录回调**:
    *   用户在 Nebula 登录成功后，Nebula 将 Token 附带在 URL 中重定向回 NovaStory (e.g., `https://novastory.ai/callback?token=eyJ...`).
    *   NovaStory 前端解析 Token，存储至 `localStorage`。
4.  **用户信息同步**:
    *   NovaStory 前端使用 Token 调用 Nebula 的 `/user/profile` 接口获取用户基本信息 (ID, 昵称, 头像, 余额)。
    *   NovaStory 后端（可选）: 首次请求时，解析 Token 中的 `sub` (User ID)，在本地 `users` 表中建立映射记录（仅存 ID 和配置，不存密码）。

### 2.2 请求鉴权 (Backend Middleware)

NovaStory 后端 (FastAPI) 需要验证请求头中的 `Authorization: Bearer <token>`。

*   **方案 A (推荐 - 共享密钥)**:
    *   在 NovaStory 后端配置与 Nebula 相同的 `JWT_SECRET`。
    *   使用 `jose` 或 `pyjwt` 库本地校验 Token 签名和有效期。
    *   优点: 速度快，无需网络请求。
**代码示例 (FastAPI Dependency)**:

```python
# nova-story/backend/app/api/deps.py

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt
from app.core.config import settings

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

def get_current_user_id(token: str = Depends(oauth2_scheme)) -> str:
    try:
        # 假设 settings.NEBULA_JWT_SECRET 已配置
        payload = jwt.decode(token, settings.NEBULA_JWT_SECRET, algorithms=["HS256"])
        user_id: str = payload.get("sub") or payload.get("id")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")
        return user_id
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
```

---

## 3. 大模型与计费集成 (LLM & Billing Integration)

NovaStory 的 AI 功能（续写、扩写、分析）应直接复用 Nebula 的通道。

### 3.1 架构选择
*   **后端代理 (Server-Side Proxy) —— **推荐****
    *   NovaStory 前端调用 NovaStory 后端 (`/api/agent/draft`)。
    *   NovaStory 后端组装 Context (如查询向量库、读取上文章节)，构建最终 Prompt。
    *   NovaStory 后端使用**用户传入的 Token**，向 Nebula 发起请求。
    *   **优点**: 保护 Prompt 资产；支持复杂逻辑（RAG）；**自动计费归属到用户**。

### 3.2 实现细节 (后端代理模式)

在 `nova-story/backend/app/api/endpoints/agent_assistant.py` 中：

```python
import httpx
from fastapi import APIRouter, Depends
from app.api import deps

router = APIRouter()

NEBULA_API_BASE = "https://api.chuangyi.chat/api/v1"

@router.post("/draft")
async def draft_content(
    payload: DraftRequest,
    user_id: str = Depends(deps.get_current_user_id),
    token: str = Depends(deps.oauth2_scheme) # 获取原始 Token
):
    # 1. 组装 Prompt (NovaStory 的核心价值)
    system_prompt = "You are a professional novelist..."
    full_prompt = f"{system_prompt}

Context: {payload.context}

Instruction: {payload.instruction}"

    # 2. 调用 Nebula API (透传 Token，实现计费)
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{NEBULA_API_BASE}/chat/message",
            json={
                "session_id": "temp_session", # 或为每个 Story 创建一个 Session
                "content": full_prompt,
                "model_override": "google/gemini-2.5-flash" # 指定模型
            },
            headers={
                "Authorization": f"Bearer {token}", # 关键：透传用户 Token
                "Content-Type": "application/json"
            },
            timeout=60.0
        )

    # 3. 处理响应
    if response.status_code == 402:
        raise HTTPException(402, detail="Nebula 积分不足，请充值")
    elif response.status_code != 200:
        raise HTTPException(response.status_code, detail="AI Service Error")

    # 4. 返回结果 (支持流式转发)
    return response.json()
```

---

## 4. 积分不足处理 (Error Handling)

当 Nebula 返回 `402 Payment Required` 或余额不足错误时：

1.  **后端**: 捕获该错误，透传给前端 `402` 状态码。
2.  **前端**:
    *   拦截 `402` 响应。
    *   弹窗提示：“您的 Nebula 积分不足”。
    *   提供按钮：“前往充值”，链接至 `https://market.chuangyi.chat/wallet` (或嵌入 Nebula 的充值组件 iframe)。

---

## 5. 环境配置 (Configuration)

### NovaStory Backend `.env`

```ini
# Nebula Integration
NEBULA_API_URL="https://api.chuangyi.chat/api/v1"
NEBULA_JWT_SECRET="<Copy from Nebula Backend>" # 必须保持一致
```

### NovaStory Frontend `.env`

```ini
VITE_NEBULA_LOGIN_URL="https://www.chuangyi.chat/login"
VITE_NEBULA_REGISTER_URL="https://www.chuangyi.chat/register"
VITE_NEBULA_WALLET_URL="https://market.chuangyi.chat/wallet"
```

## 6. 总结

通过这种集成方式，NovaStory 能够：
1.  **节省开发成本**: 0 代码实现用户系统、支付系统、模型接入。
2.  **统一用户体验**: 用户使用通用的 Nebula 账号，资产互通。
3.  **专注核心业务**: NovaStory 团队只需专注于“故事引擎”、“导演模式”等垂直场景的 Prompt Engineering 和交互设计。
