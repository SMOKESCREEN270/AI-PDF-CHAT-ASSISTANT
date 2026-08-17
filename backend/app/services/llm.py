"""
Thin wrapper around Gemini generation calls. Centralizing this makes it easy
to (a) swap the default platform key for a user-supplied key on a per-call
basis, and (b) later add other providers (OpenAI/Anthropic) behind the same
interface, since the schema already carries `provider`.
"""
import json
from typing import Optional, List, Dict, Any

import google.generativeai as genai

from app.config import settings
from app.services.gemini import genai_lock


def _get_model(api_key: Optional[str], system_instruction: Optional[str] = None):
    # Strip whitespace for the same reason as embeddings.py's _configure -
    # a stray space/newline from copy-pasting a key makes Google reject it
    # as "API key not valid" with no hint that whitespace was the cause.
    key = (api_key or settings.DEFAULT_GEMINI_API_KEY or "").strip()
    if not key:
        raise RuntimeError("No Gemini API key configured (server default or user-supplied).")
    genai.configure(api_key=key)
    return genai.GenerativeModel(
        settings.GEMINI_GENERATION_MODEL,
        system_instruction=system_instruction,
    )


def generate(prompt: str, api_key: Optional[str] = None,
             system_instruction: Optional[str] = None,
             temperature: float = 0.3, json_mode: bool = False) -> str:
    # google-generativeai 0.8.2 stores authentication in module-global state.
    # Keep configuration and the request in one shared critical section so a
    # concurrent request cannot replace another request's API key.
    with genai_lock:
        model = _get_model(api_key, system_instruction)
        gen_config = {"temperature": temperature}
        if json_mode:
            gen_config["response_mime_type"] = "application/json"
        response = model.generate_content(prompt, generation_config=gen_config)
        return response.text


def generate_json(prompt: str, api_key: Optional[str] = None,
                   system_instruction: Optional[str] = None,
                   temperature: float = 0.2) -> Any:
    raw = generate(prompt, api_key=api_key, system_instruction=system_instruction,
                    temperature=temperature, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Occasionally the model wraps JSON in markdown fences despite json_mode; strip and retry.
        cleaned = raw.strip().strip("`")
        cleaned = cleaned[4:] if cleaned.lower().startswith("json") else cleaned
        return json.loads(cleaned)
