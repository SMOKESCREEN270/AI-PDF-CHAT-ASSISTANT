"""
Thin wrapper around ChromaDB for per-document collections.

Each Document gets its own Chroma collection (named `doc_<document_id>`) so
deleting a document is a single collection drop, and retrieval can be scoped
cheaply to just the documents the user picked for a chat session.
"""
from typing import List, Dict, Any, Optional
import chromadb
from chromadb.config import Settings as ChromaSettings

from app.config import settings

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
    """Searches across one or more per-document collections and merges results."""
    client = get_client()
    hits: List[Dict[str, Any]] = []
    for name in collection_names:
        try:
            coll = client.get_collection(name)
        except Exception:
            continue
        res = coll.query(query_embeddings=[query_embedding], n_results=top_k,
                          include=["documents", "metadatas", "distances"])
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
