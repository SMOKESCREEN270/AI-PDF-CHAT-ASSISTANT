"""
Embedding generation via Google Gemini's embedding model.

Every function accepts an optional `api_key` override so a user can bring
their own Gemini (or, in future, other-provider) key for a single request
without it ever being written to disk / the database.
"""
from typing import List, Optional
import google.generativeai as genai

from app.config import settings
from app.services.gemini import genai_lock


def _configure(api_key: Optional[str] = None):
    key = api_key or settings.DEFAULT_GEMINI_API_KEY
    if not key:
        raise RuntimeError(
            "No Gemini API key available. Set DEFAULT_GEMINI_API_KEY on the "
            "server, or have the user supply their own key."
        )
    genai.configure(api_key=key)


def embed_texts(texts: List[str], api_key: Optional[str] = None,
                 task_type: str = "retrieval_document") -> List[List[float]]:
    """Batch-embeds a list of chunk texts. task_type differs for docs vs queries."""
    # google-generativeai 0.8.2 stores authentication in module-global state.
    # Keep configuration and all batch requests in one shared critical section
    # so another request cannot replace this request's API key mid-operation.
    with genai_lock:
        _configure(api_key)
        vectors: List[List[float]] = []
        # Gemini's embed_content supports batching a handful at a time; chunk
        # requests to stay well under request-size limits.
        batch_size = 16
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            result = genai.embed_content(
                model=settings.GEMINI_EMBEDDING_MODEL,
                content=batch,
                task_type=task_type,
            )
            embeddings = result["embedding"]
            # google-generativeai returns a single list if content was a single
            # string; normalize to list-of-lists.
            if batch and isinstance(embeddings[0], float):
                embeddings = [embeddings]
            vectors.extend(embeddings)
        return vectors


def embed_query(query: str, api_key: Optional[str] = None) -> List[float]:
    return embed_texts([query], api_key=api_key, task_type="retrieval_query")[0]
