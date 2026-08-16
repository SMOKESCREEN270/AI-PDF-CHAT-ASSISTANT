from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.routers import auth, documents, chat, study_tools, compare, export
from app.rate_limit import limiter, set_byok_request, reset_byok_request


app = FastAPI(title=settings.APP_NAME)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Please try again later."},
        headers={"Retry-After": "60"},
    )


app.add_middleware(SlowAPIMiddleware)


@app.middleware("http")
async def mark_byok_requests(request: Request, call_next):
    """Make BYOK requests exempt without consuming the request body twice."""
    has_user_api_key = False
    if request.method == "POST" and (
        request.url.path == "/api/chat"
        or request.url.path.startswith("/api/study/")
        or request.url.path == "/api/compare"
    ):
        try:
            import json

            body = await request.body()
            payload = json.loads(body or b"{}")
            user_api_key = payload.get("user_api_key")
            has_user_api_key = bool(
                isinstance(user_api_key, dict) and user_api_key.get("api_key")
            )
        except Exception:
            has_user_api_key = False
    request.state.has_user_api_key = has_user_api_key
    token = set_byok_request(has_user_api_key)
    try:
        return await call_next(request)
    finally:
        reset_byok_request(token)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.CORS_ORIGINS.split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Required by authlib's OAuth2 flow to stash state/nonce between redirects
app.add_middleware(SessionMiddleware, secret_key=settings.SESSION_SECRET_KEY)

app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(chat.router)
app.include_router(study_tools.router)
app.include_router(compare.router)
app.include_router(export.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}
