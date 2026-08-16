"""Shared rate limiting configuration for public and AI-heavy endpoints."""
from contextvars import ContextVar, Token
from typing import Any

import jwt
from jwt.exceptions import InvalidTokenError
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import settings
from app.security import ACCESS_TOKEN_COOKIE


# Routes return typed Pydantic models, so avoid SlowAPI's optional response
# header injection (which requires a Response parameter on every limited route).
# The application-level 429 handler provides Retry-After explicitly.
limiter = Limiter(key_func=get_remote_address, headers_enabled=False)
_byok_request = ContextVar("byok_request", default=False)


def authenticated_user_key(request: Any) -> str:
    """Use the authenticated subject for quota accounting, falling back to IP."""
    authorization = request.headers.get("Authorization", "")
    access_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
    if access_token is None and authorization.lower().startswith("bearer "):
        access_token = authorization[7:]
    if access_token:
        try:
            payload = jwt.decode(
                access_token,
                settings.JWT_SECRET_KEY,
                algorithms=[settings.JWT_ALGORITHM],
            )
            if payload.get("sub"):
                return f"user:{payload['sub']}"
        except InvalidTokenError:
            pass
    return f"ip:{get_remote_address(request)}"


def set_byok_request(value: bool) -> Token:
    return _byok_request.set(value)


def reset_byok_request(token: Token) -> None:
    _byok_request.reset(token)


def request_has_byok(request: Any = None) -> bool:
    """Read BYOK state from a request or the current async request context.

    SlowAPI calls ``exempt_when`` without arguments, so the middleware stores
    the per-request decision in a ContextVar for the sync route wrapper.
    """
    if request is not None:
        return bool(getattr(request.state, "has_user_api_key", False))
    return _byok_request.get()


def reset_rate_limits() -> None:
    """Test helper; the in-memory limiter is reset between isolated test cases."""
    limiter.reset()