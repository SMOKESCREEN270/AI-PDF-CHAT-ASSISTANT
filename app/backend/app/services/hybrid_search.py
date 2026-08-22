"""
Hybrid Search = keyword search (BM25 over chunk text pulled from Postgres)
fused with semantic search (embeddings via Chroma), combined with
Reciprocal Rank Fusion (RRF) so the two very different score scales don't
need manual normalization.

Why hybrid: pure semantic search misses exact terms (names, numbers, code
identifiers, acronyms); pure keyword search misses paraphrases / synonyms.
Combining both is standard practice for production RAG.
"""
from dataclasses import dataclass
from typing import List, Dict, Any
from rank_bm25 import BM25Okapi
import re

from sqlalchemy.orm import Session

from app import models
from app.services import vector_store, embeddings
from app.config import settings


@dataclass
class RetrievedChunk:
    chunk_id: str
    document_id: str
    filename: str
    page_number: int
    line_start: int
    line_end: int
    text: str
    semantic_score: float
    keyword_score: float
    fused_score: float


def _tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _keyword_search(db: Session, document_ids: List[str], query: str, top_k: int) -> List[Dict[str, Any]]:
    chunks = (
        db.query(models.Chunk)
        .filter(models.Chunk.document_id.in_(document_ids))
        .all()
    )
    if not chunks:
        return []

    corpus_tokens = [_tokenize(c.text) for c in chunks]
    bm25 = BM25Okapi(corpus_tokens)
    scores = bm25.get_scores(_tokenize(query))

    ranked = sorted(zip(chunks, scores), key=lambda x: x[1], reverse=True)[:top_k]
    return [{"chunk": c, "score": float(s)} for c, s in ranked if s > 0]


def _reciprocal_rank_fusion(semantic_ranked: List[str], keyword_ranked: List[str], k: int = 60) -> Dict[str, float]:
    """Standard RRF: score = sum(1 / (k + rank)) across each ranked list a key appears in."""
    fused: Dict[str, float] = {}
    for rank, key in enumerate(semantic_ranked):
        fused[key] = fused.get(key, 0.0) + 1.0 / (k + rank + 1)
    for rank, key in enumerate(keyword_ranked):
        fused[key] = fused.get(key, 0.0) + 1.0 / (k + rank + 1)
    return fused


def hybrid_retrieve(db: Session, document_ids: List[str], query: str,
                     api_key: str = None, top_k: int = None) -> List[RetrievedChunk]:
    top_k = top_k or settings.TOP_K_FINAL

    # 1) Semantic leg
    query_vec = embeddings.embed_query(query, api_key=api_key)
    collection_names = [vector_store.collection_name_for(d) for d in document_ids]
    semantic_hits = vector_store.semantic_search(collection_names, query_vec, top_k=settings.TOP_K_SEMANTIC)
    semantic_by_id = {h["metadata"]["chunk_id"]: h for h in semantic_hits}
    semantic_ranked_ids = [h["metadata"]["chunk_id"] for h in semantic_hits]

    # 2) Keyword leg (BM25 over Postgres-stored chunk text)
    keyword_hits = _keyword_search(db, document_ids, query, top_k=settings.TOP_K_KEYWORD)
    keyword_by_id = {h["chunk"].id: h for h in keyword_hits}
    keyword_ranked_ids = [h["chunk"].id for h in keyword_hits]

    # 3) Fuse via RRF
    fused_scores = _reciprocal_rank_fusion(semantic_ranked_ids, keyword_ranked_ids)
    if not fused_scores:
        return []

    all_ids = list(fused_scores.keys())
    top_ids = sorted(all_ids, key=lambda i: fused_scores[i], reverse=True)[:top_k]

    # 4) Hydrate full RetrievedChunk objects (need DB lookups for anything only hit by semantic leg)
    needed_from_db = [i for i in top_ids if i not in keyword_by_id]
    db_lookup = {}
    if needed_from_db:
        for c in db.query(models.Chunk).filter(models.Chunk.id.in_(needed_from_db)).all():
            db_lookup[c.id] = c

    results: List[RetrievedChunk] = []
    for cid in top_ids:
        chunk_row = keyword_by_id.get(cid, {}).get("chunk") or db_lookup.get(cid)
        if chunk_row is None:
            continue
        doc = chunk_row.document
        results.append(RetrievedChunk(
            chunk_id=cid,
            document_id=chunk_row.document_id,
            filename=doc.filename if doc else "",
            page_number=chunk_row.page_number,
            line_start=chunk_row.line_start,
            line_end=chunk_row.line_end,
            text=chunk_row.text,
            semantic_score=semantic_by_id.get(cid, {}).get("score", 0.0),
            keyword_score=keyword_by_id.get(cid, {}).get("score", 0.0),
            fused_score=fused_scores[cid],
        ))
    return results
