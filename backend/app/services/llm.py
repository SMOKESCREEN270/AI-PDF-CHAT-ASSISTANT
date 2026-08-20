"""
Thin wrapper around OpenRouter's (OpenAI-compatible) chat-completions
endpoint. Centralizing this makes it easy to (a) swap the default platform
key for a user-supplied key on a per-call basis, and (b) swap the underlying
model/provider later, since the schema already carries `provider`.
"""
import json
from typing import Optional, Any

import httpx

from app.config import settings
from app.services.openrouter_client import OpenRouterError, build_headers

_TIMEOUT = httpx.Timeout(90.0, connect=10.0)


def generate(prompt: str, api_key: Optional[str] = None,
             system_instruction: Optional[str] = None,
             temperature: float = 0.3, json_mode: bool = False) -> str:
    messages = []
    if system_instruction:
        messages.append({"role": "system", "content": system_instruction})
    messages.append({"role": "user", "content": prompt})

    body = {
        "model": settings.OPENROUTER_GENERATION_MODEL,
        "messages": messages,
        "temperature": temperature,
    }
    if json_mode:
        # OpenAI-compatible structured-output flag; the configured free model
        # (openai/gpt-oss-20b:free) supports it. If a different model is
        # swapped in that doesn't, drop this and rely on generate_json's
        # markdown-fence-stripping fallback below.
        body["response_format"] = {"type": "json_object"}

    with httpx.Client(timeout=_TIMEOUT) as client:
        response = client.post(
            f"{settings.OPENROUTER_BASE_URL}/chat/completions",
            headers=build_headers(api_key),
            json=body,
        )
    if response.status_code != 200:
        raise OpenRouterError(
            f"OpenRouter generation failed ({response.status_code}): {response.text[:500]}"
        )
    data = response.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise OpenRouterError(f"Unexpected OpenRouter response shape: {data}") from exc


def generate_json(prompt: str, api_key: Optional[str] = None,
                   system_instruction: Optional[str] = None,
                   temperature: float = 0.2) -> Any:
    raw = generate(prompt, api_key=api_key, system_instruction=system_instruction,
                    temperature=temperature, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Occasionally a model wraps JSON in markdown fences despite json_mode; strip and retry.
        cleaned = raw.strip().strip("`")
        cleaned = cleaned[4:] if cleaned.lower().startswith("json") else cleaned
        return json.loads(cleaned)
