"""
Embedding generation via OpenRouter's OpenAI-compatible /embeddings endpoint
(currently liquid/lfm-2.5-embedding-350m:free - see app/config.py).

Every function accepts an optional `api_key` override so a user can bring
their own OpenRouter (or, in future, other-provider) key for a single
request without it ever being written to disk / the database.
"""
import time
from typing import List, Optional

import httpx

from app.config import settings
from app.services.openrouter_client import OpenRouterError, build_headers

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def _embed_batch_with_retry(batch: List[str], api_key: Optional[str], max_attempts: int = 4) -> dict:
    """Calls /embeddings with exponential backoff on 429 (rate limited).

    Free-tier OpenRouter endpoints are rate limited, and easy to burst past
    when several documents are ingesting at once, each firing several
    batches back-to-back with no pacing. OpenRouter doesn't reliably surface
    a structured retry-after here, so we back off with a fixed schedule
    instead: short waits first, growing if still rate-limited.
    """
    delays = [3, 8, 20, 45]
    last_error: Optional[OpenRouterError] = None
    for attempt in range(max_attempts):
        with httpx.Client(timeout=_TIMEOUT) as client:
            response = client.post(
                f"{settings.OPENROUTER_BASE_URL}/embeddings",
                headers=build_headers(api_key),
                json={"model": settings.OPENROUTER_EMBEDDING_MODEL, "input": batch},
            )
        if response.status_code == 200:
            return response.json()
        if response.status_code == 429:
            last_error = OpenRouterError(
                f"OpenRouter embeddings rate-limited ({response.status_code}): {response.text[:300]}"
            )
            if attempt < max_attempts - 1:
                time.sleep(delays[min(attempt, len(delays) - 1)])
                continue
        else:
            raise OpenRouterError(
                f"OpenRouter embeddings failed ({response.status_code}): {response.text[:500]}"
            )
    raise last_error


def embed_texts(texts: List[str], api_key: Optional[str] = None,
                 task_type: str = "retrieval_document") -> List[List[float]]:
    """Batch-embeds a list of chunk texts.

    `task_type` is kept in the signature for interface compatibility with
    callers (hybrid_search.py distinguishes document vs. query embedding
    calls) but isn't sent to OpenRouter - the OpenAI-compatible /embeddings
    endpoint has no equivalent parameter; the model embeds documents and
    queries the same way.
    """
    vectors: List[List[float]] = []
    # The free embedding model caps input at 512 tokens per item; keep
    # batches modest so a single oversized request doesn't fail outright.
    batch_size = 16
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        result = _embed_batch_with_retry(batch, api_key)
        # OpenAI-shaped response: data items may not come back in input order,
        # each carries its own `index` - sort to restore alignment with `batch`.
        items = sorted(result.get("data", []), key=lambda item: item.get("index", 0))
        vectors.extend(item["embedding"] for item in items)
    return vectors


def embed_query(query: str, api_key: Optional[str] = None) -> List[float]:
    return embed_texts([query], api_key=api_key, task_type="retrieval_query")[0]
