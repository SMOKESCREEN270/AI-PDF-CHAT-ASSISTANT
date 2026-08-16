"""
Central app configuration. All secrets are read from environment variables
(.env file) - never hardcode API keys or DB credentials.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- App ---
    APP_NAME: str = "AI PDF Chat Assistant"
    ENV: str = "development"
    CORS_ORIGINS: str = "http://localhost:5173"

    # --- Database ---
    DATABASE_URL: str = "postgresql://localhost:5432/pdf_chat_assistant"

    # --- Auth ---
    JWT_SECRET_KEY: str = "CHANGE_ME_IN_PRODUCTION"
    SESSION_SECRET_KEY: str = "CHANGE_ME_IN_PRODUCTION"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24h

    GOOGLE_OAUTH_CLIENT_ID: str = ""
    GOOGLE_OAUTH_CLIENT_SECRET: str = ""
    GOOGLE_OAUTH_REDIRECT_URI: str = "http://localhost:8000/api/auth/google/callback"

    # --- Transactional email ---
    FRONTEND_URL: str = "http://localhost:5173"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = ""
    SMTP_FROM_NAME: str = "AI PDF Chat Assistant"
    SMTP_USE_TLS: bool = True
    SMTP_USE_SSL: bool = False
    SMTP_TIMEOUT_SECONDS: int = 10

    # --- LLM / Embeddings ---
    # Platform-provided default key (free tier). Users may override per-request
    # by supplying their own key via the `X-User-Api-Key` header / request body -
    # in that case we NEVER persist their key, we just use it for that call.
    DEFAULT_GEMINI_API_KEY: str = ""
    GEMINI_GENERATION_MODEL: str = "gemini-2.0-flash"
    GEMINI_EMBEDDING_MODEL: str = "models/text-embedding-004"

    # --- Vector store ---
    CHROMA_PERSIST_DIR: str = "./chroma_db"

    # --- Uploads ---
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_MB: int = 50
    # Explicit opt-out for deployments without a ClamAV daemon available
    # (e.g. free-tier hosting with only one container/process). Defaults to
    # True (secure by default) - set to False deliberately, and re-enable
    # once ClamAV is reachable again.
    MALWARE_SCAN_ENABLED: bool = True
    CLAMD_HOST: str = "localhost"
    CLAMD_PORT: int = 3310
    CLAMD_TIMEOUT_SECONDS: int = 10

    # --- RAG tuning ---
    CHUNK_SIZE: int = 800
    CHUNK_OVERLAP: int = 120
    TOP_K_SEMANTIC: int = 8
    TOP_K_KEYWORD: int = 8
    TOP_K_FINAL: int = 6
    HYBRID_ALPHA: float = 0.55  # weight given to semantic score vs keyword score
    MIN_CONFIDENCE_TO_ANSWER: float = 0.35  # below this -> hallucination-guard triggers

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()

if settings.ENV == "production":
    if settings.JWT_SECRET_KEY == "CHANGE_ME_IN_PRODUCTION":
        raise RuntimeError(
            "JWT_SECRET_KEY must be changed from CHANGE_ME_IN_PRODUCTION in production."
        )
    if settings.SESSION_SECRET_KEY == "CHANGE_ME_IN_PRODUCTION":
        raise RuntimeError(
            "SESSION_SECRET_KEY must be changed from CHANGE_ME_IN_PRODUCTION in production."
        )
    if settings.SESSION_SECRET_KEY == settings.JWT_SECRET_KEY:
        raise RuntimeError(
            "SESSION_SECRET_KEY must differ from JWT_SECRET_KEY in production."
        )
