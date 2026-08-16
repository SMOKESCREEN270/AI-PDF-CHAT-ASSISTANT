import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import jwt
from jwt.exceptions import InvalidTokenError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy.orm import Session
from sqlalchemy import or_

from app.config import settings
from app.database import get_db
from app import models

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ACCESS_TOKEN_COOKIE = "pdf_assistant_access_token"
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login", auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(
    subject: str,
    token_type: str = "access",
    expires_minutes: Optional[int] = None,
) -> str:
    expire = datetime.utcnow() + timedelta(
        minutes=expires_minutes
        if expires_minutes is not None
        else settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload = {"sub": subject, "type": token_type, "jti": str(uuid.uuid4()), "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_access_token(subject: str, expires_minutes: Optional[int] = None) -> str:
    return create_token(subject, "access", expires_minutes)


def set_auth_cookie(response: Response, token: str) -> None:
    # samesite="none" is required (together with secure=True) for the cookie
    # to be sent when the frontend and backend are on different domains
    # (e.g. Cloudflare Pages -> Render). "strict"/"lax" would silently drop
    # the cookie on every cross-site request in that setup. secure=True is
    # mandatory for SameSite=None and requires the backend to be served
    # over HTTPS, which Render provides by default.
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE,
        value=token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(key=ACCESS_TOKEN_COOKIE, path="/")


def decode_token(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        if (
            payload.get("sub") is None
            or payload.get("jti") is None
            or payload.get("exp") is None
        ):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return payload
    except InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


def decode_access_token(token: str) -> str:
    """Backward-compatible helper for callers that only need the subject."""
    payload = decode_token(token)
    if payload.get("type") not in (None, "access"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    return payload["sub"]


def get_auth_token(
    request: Request,
    bearer_token: Optional[str] = Depends(oauth2_scheme),
) -> str:
    token = request.cookies.get(ACCESS_TOKEN_COOKIE) or bearer_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


def get_current_user(
    token: str = Depends(get_auth_token),
    db: Session = Depends(get_db),
) -> models.User:
    payload = decode_token(token)
    if payload.get("type") not in (None, "access"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    jti = payload["jti"]
    user_id = payload["sub"]
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    if db.query(models.RevokedToken).filter(
        or_(
            models.RevokedToken.jti == jti,
            models.RevokedToken.user_id == user_id,
        ),
        models.RevokedToken.expires_at >= datetime.utcnow(),
    ).first():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has been revoked")
    return user
