"""
Shared plumbing for calling OpenRouter's OpenAI-compatible API.

Unlike google-generativeai (which stored the API key in module-global state
and needed a lock to stop concurrent requests from crossing keys), OpenRouter
is a plain stateless REST API - each request carries its own Authorization
header, so no cross-request locking is required here.
"""
from typing import Optional

from app.config import settings


class OpenRouterError(RuntimeError):
    """Raised for any non-2xx response from OpenRouter, with the body attached."""


def resolve_api_key(api_key: Optional[str]) -> str:
    # Defensive normalization: a copy-pasted key (especially via a UI that
    # accepts one field at a time) can easily pick up a leading/trailing
    # space, tab, or newline invisibly. OpenRouter rejects that outright as
    # an invalid key with no indication it was a whitespace issue, so strip
    # both the env-configured default and any user-supplied key before ever
    # sending them.
    key = (api_key or settings.DEFAULT_OPENROUTER_API_KEY or "").strip()
    if not key:
        raise RuntimeError(
            "No OpenRouter API key available. Set DEFAULT_OPENROUTER_API_KEY "
            "on the server, or have the user supply their own key."
        )
    return key


def build_headers(api_key: Optional[str]) -> dict:
    headers = {
        "Authorization": f"Bearer {resolve_api_key(api_key)}",
        "Content-Type": "application/json",
    }
    # Optional attribution headers OpenRouter recommends for free-tier
    # traffic; harmless to omit but nice for their rankings/rate-limit
    # heuristics, so only sent when configured.
    if settings.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
    if settings.OPENROUTER_APP_NAME:
        headers["X-Title"] = settings.OPENROUTER_APP_NAME
    return headers
