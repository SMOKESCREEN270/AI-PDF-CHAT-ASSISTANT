"""
Thin wrapper around ChromaDB for per-document collections.

Each Document gets its own Chroma collection (named `doc_<document_id>`) so
deleting a document is a single collection drop, and retrieval can be scoped
cheaply to just the documents the user picked for a chat session.
"""
from typing import List, Dict, Any, Optional
import logging

import chromadb
from chromadb.config import Settings as ChromaSettings

from app.config import settings

logger = logging.getLogger(__name__)

_client = None


def get_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(
            path=settings.CHROMA_PERSIST_DIR,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
    return _client


def collection_name_for(document_id: str) -> str:
    return f"doc_{document_id.replace('-', '')}"


def get_or_create_collection(name: str):
    client = get_client()
    return client.get_or_create_collection(name=name, metadata={"hnsw:space": "cosine"})


def upsert_chunks(collection_name: str, ids: List[str], embeddings: List[List[float]],
                   documents: List[str], metadatas: List[Dict[str, Any]]):
    coll = get_or_create_collection(collection_name)
    coll.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)


def semantic_search(collection_names: List[str], query_embedding: List[float],
                     top_k: int = 8) -> List[Dict[str, Any]]:
    """Searches across one or more per-document collections and merges results.

    A collection can fail to query even after it's found - most commonly
    because it was embedded with a different model/dimensionality than the
    one currently configured (e.g. the embedding model changed, or a
    document was ingested under an older config). That's a per-document
    problem, not a request-wide one: skip that collection and keep going
    with whatever the rest can still contribute, rather than letting one
    stale document take down every chat turn that includes it.
    """
    client = get_client()
    hits: List[Dict[str, Any]] = []
    for name in collection_names:
        try:
            coll = client.get_collection(name)
            res = coll.query(query_embeddings=[query_embedding], n_results=top_k,
                              include=["documents", "metadatas", "distances"])
        except Exception as exc:
            # Most common cause: this document was embedded under a
            # different model/dimensionality than the one currently
            # configured, so its collection can't be queried with today's
            # query vector. Log it (so it's visible which document needs
            # re-ingesting) and fall back to keyword search alone for it.
            logger.warning("Skipping collection %s in semantic search: %s", name, exc)
            continue
        for doc_text, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
            similarity = 1 - dist  # cosine distance -> similarity
            hits.append({"text": doc_text, "metadata": meta, "score": similarity})
    hits.sort(key=lambda h: h["score"], reverse=True)
    return hits[:top_k]


def delete_collection(collection_name: str):
    client = get_client()
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
