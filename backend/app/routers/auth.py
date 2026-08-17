import logging
import smtplib
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from authlib.integrations.starlette_client import OAuth
from starlette.responses import RedirectResponse, Response

from app.database import get_db
from app import models, schemas
from app.security import (
    create_access_token,
    create_token,
    decode_token,
    get_auth_token,
    get_current_user,
    hash_password,
    set_auth_cookie,
    clear_auth_cookie,
    verify_password,
)
from app.config import settings
from app.rate_limit import limiter

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger(__name__)


def _send_email(to_email: str, subject: str, text_body: str, html_body: str) -> bool:
    """Send a transactional email when SMTP is configured.

    Missing SMTP settings are allowed for local development so the existing
    development response can still expose a test link. In production, the
    link is never logged or returned; delivery failures are recorded without
    changing the generic auth response.
    """
    if not settings.SMTP_HOST or not settings.SMTP_FROM_EMAIL:
        logger.warning(
            "SMTP is not configured; %s email was not sent to %s",
            subject,
            to_email,
        )
        return False

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = (
        f"{settings.SMTP_FROM_NAME} <{settings.SMTP_FROM_EMAIL}>"
        if settings.SMTP_FROM_NAME
        else settings.SMTP_FROM_EMAIL
    )
    message["To"] = to_email
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")

    try:
        smtp_class = smtplib.SMTP_SSL if settings.SMTP_USE_SSL else smtplib.SMTP
        with smtp_class(
            settings.SMTP_HOST,
            settings.SMTP_PORT,
            timeout=settings.SMTP_TIMEOUT_SECONDS,
        ) as smtp:
            if settings.SMTP_USE_TLS and not settings.SMTP_USE_SSL:
                smtp.starttls()
            if settings.SMTP_USER:
                smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(message)
        logger.info("Sent %s email to %s", subject, to_email)
        return True
    except (OSError, smtplib.SMTPException):
        logger.exception("Unable to send %s email to %s", subject, to_email)
        return False


def _send_verification_email(email: str, verification_link: str) -> bool:
    return _send_email(
        email,
        "Verify your AI PDF Chat Assistant email",
        (
            "Welcome to AI PDF Chat Assistant.\n\n"
            f"Verify your email address here: {verification_link}\n\n"
            "This link expires in 30 minutes."
        ),
        (
            "<p>Welcome to AI PDF Chat Assistant.</p>"
            f'<p><a href="{verification_link}">Verify your email address</a></p>'
            "<p>This link expires in 30 minutes.</p>"
        ),
    )


def _send_password_reset_email(email: str, reset_link: str) -> bool:
    return _send_email(
        email,
        "Reset your AI PDF Chat Assistant password",
        (
            "A password reset was requested for your account.\n\n"
            f"Reset your password here: {reset_link}\n\n"
            "This link expires in 30 minutes. If you did not request this, "
            "you can safely ignore this email."
        ),
        (
            "<p>A password reset was requested for your account.</p>"
            f'<p><a href="{reset_link}">Reset your password</a></p>'
            "<p>This link expires in 30 minutes. If you did not request this, "
            "you can safely ignore this email.</p>"
        ),
    )


# ---- Google OAuth2 client (optional - only active if creds are configured) ----
oauth = OAuth()
if settings.GOOGLE_OAUTH_CLIENT_ID:
    oauth.register(
        name="google",
        client_id=settings.GOOGLE_OAUTH_CLIENT_ID,
        client_secret=settings.GOOGLE_OAUTH_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


@router.post("/register", response_model=schemas.UserOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
def register(
    request: Request,
    response: Response,
    payload: schemas.UserCreate,
    db: Session = Depends(get_db),
):
    existing = db.query(models.User).filter(models.User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = models.User(
        email=payload.email,
        full_name=payload.full_name,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    db.flush()
    verification_token = create_token(user.id, "email_verification", expires_minutes=30)
    access_token = create_access_token(subject=user.id)
    db.commit()
    db.refresh(user)
    set_auth_cookie(response, access_token)
    verification_link = (
        f"{settings.FRONTEND_URL.rstrip('/')}/verify-email"
        f"?token={verification_token}"
    )
    _send_verification_email(user.email, verification_link)
    if settings.ENV == "development":
        user.verification_token = verification_token
        logger.info("Email verification link: %s", verification_link)
    return user


@router.post("/login", response_model=schemas.LoginResponse)
@limiter.limit("10/minute")
def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """Authenticate and establish an httpOnly cookie session."""
    user = db.query(models.User).filter(models.User.email == form_data.username).first()
    now = datetime.utcnow()
    if user and user.locked_until and user.locked_until > now:
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Account temporarily locked after repeated failed login attempts. Try again in 15 minutes.",
        )
    if user and user.locked_until and user.locked_until <= now:
        user.failed_login_count = 0
        user.locked_until = None

    if (
        not user
        or not user.is_active
        or not user.hashed_password
        or not verify_password(form_data.password, user.hashed_password)
    ):
        if user and user.is_active:
            user.failed_login_count = (user.failed_login_count or 0) + 1
            if user.failed_login_count >= 5:
                user.locked_until = now + timedelta(minutes=15)
                db.commit()
                raise HTTPException(
                    status_code=status.HTTP_423_LOCKED,
                    detail="Account temporarily locked after 5 failed login attempts. Try again in 15 minutes.",
                )
            db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    user.failed_login_count = 0
    user.locked_until = None
    db.commit()
    access_token = create_access_token(subject=user.id)
    # Keep the legacy JSON token contract for API clients while the browser
    # session continues to use the secure httpOnly cookie.
    user.access_token = access_token
    user.token_type = "bearer"
    set_auth_cookie(response, access_token)
    return user


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    token: str = Depends(get_auth_token),
    db: Session = Depends(get_db),
):
    payload = decode_token(token)
    if payload.get("type") not in (None, "access"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    jti = payload["jti"]
    expires_at = datetime.utcfromtimestamp(payload["exp"])
    db.query(models.RevokedToken).filter(
        models.RevokedToken.expires_at < datetime.utcnow()
    ).delete(synchronize_session=False)
    if not db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
        db.add(models.RevokedToken(jti=jti, user_id=payload["sub"], expires_at=expires_at))
    db.commit()
    clear_auth_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/deactivate", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_account(
    payload: schemas.DeactivateAccountRequest,
    response: Response,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not current_user.hashed_password or not verify_password(
        payload.current_password, current_user.hashed_password
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    current_user.is_active = False
    db.query(models.RevokedToken).filter(
        models.RevokedToken.expires_at < datetime.utcnow()
    ).delete(synchronize_session=False)
    db.add(
        models.RevokedToken(
            jti=f"deactivated:{current_user.id}:{uuid.uuid4()}",
            user_id=current_user.id,
            expires_at=datetime.utcnow()
            + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        )
    )
    db.commit()
    clear_auth_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/request-password-reset", response_model=schemas.AuthMessage)
def request_password_reset(
    payload: schemas.PasswordResetRequest,
    db: Session = Depends(get_db),
):
    user = db.query(models.User).filter(models.User.email == payload.email).first()
    response = schemas.AuthMessage(
        message="If an account exists for that email, a reset link has been prepared."
    )
    if not user:
        return response

    reset_token = create_token(user.id, "password_reset", expires_minutes=30)
    reset_link = (
        f"{settings.FRONTEND_URL.rstrip('/')}/reset-password"
        f"?token={reset_token}"
    )
    _send_password_reset_email(user.email, reset_link)
    if settings.ENV == "development":
        response.reset_token = reset_token
        response.reset_link = reset_link
    return response


@router.post("/reset-password", response_model=schemas.AuthMessage)
def reset_password(
    payload: schemas.PasswordResetSubmit,
    db: Session = Depends(get_db),
):
    claims = decode_token(payload.token)
    if claims.get("type") != "password_reset":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid password reset token")
    user = db.query(models.User).filter(models.User.id == claims["sub"]).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User not found")
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
    return schemas.AuthMessage(message="Password updated. You can now sign in.")


@router.post("/verify-email", response_model=schemas.AuthMessage)
def verify_email(
    payload: schemas.EmailVerificationRequest,
    db: Session = Depends(get_db),
):
    claims = decode_token(payload.token)
    if claims.get("type") != "email_verification":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid email verification token")
    user = db.query(models.User).filter(models.User.id == claims["sub"]).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User not found")
    user.is_verified = True
    db.commit()
    return schemas.AuthMessage(message="Email verified. Your research desk is ready.")


@router.get("/google/login")
async def google_login(request: Request):
    if "google" not in oauth._clients:
        raise HTTPException(status_code=501, detail="Google OAuth not configured on this server")
    redirect_uri = settings.GOOGLE_OAUTH_REDIRECT_URI
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):
    if "google" not in oauth._clients:
        raise HTTPException(status_code=501, detail="Google OAuth not configured on this server")
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo") or {}
    email = userinfo.get("email")
    sub = userinfo.get("sub")
    if not email:
        raise HTTPException(status_code=400, detail="Google account did not return an email")

    user = db.query(models.User).filter(models.User.email == email).first()
    if user and not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is deactivated")
    if not user:
        user = models.User(email=email, full_name=userinfo.get("name"),
                            oauth_provider="google", oauth_sub=sub)
        db.add(user)
        db.commit()
        db.refresh(user)

    jwt_token = create_access_token(subject=user.id)
    # Must be absolute: a relative "/oauth-callback" resolves against the
    # backend's own domain (since that's where this redirect executes),
    # not the frontend - and /oauth-callback only exists in the frontend app.
    response = RedirectResponse(url=f"{settings.FRONTEND_URL.rstrip('/')}/oauth-callback")
    set_auth_cookie(response, jwt_token)
    return response
