"""
Confidence Score for a RAG answer.

We combine three signals into a single 0-1 score:

1. Retrieval strength   - how strong the fused hybrid-search scores were for
                           the chunks actually used (weak retrieval -> low
                           confidence, regardless of how fluent the answer
                           sounds).
2. Source agreement     - how many *distinct* retrieved chunks corroborate
                           the answer (an answer resting on a single thin
                           chunk is riskier than one backed by several
                           independent passages).
3. Grounding ratio      - fraction of the answer's sentences that could be
                           matched back to retrieved context (see
                           hallucination_check.py) - this is the strongest
                           signal against hallucination.

Score = 0.35*retrieval + 0.25*agreement + 0.40*grounding
"""
from typing import List
from app.services.hybrid_search import RetrievedChunk


def _normalize(scores: List[float]) -> List[float]:
    if not scores:
        return []
    mx = max(scores) or 1e-6
    return [min(s / mx, 1.0) for s in scores]


def compute_confidence(used_chunks: List[RetrievedChunk], grounding_ratio: float) -> float:
    if not used_chunks:
        return 0.0

    fused_scores = _normalize([c.fused_score for c in used_chunks])
    retrieval_strength = sum(fused_scores) / len(fused_scores)

    distinct_docs = len(set(c.document_id for c in used_chunks))
    distinct_pages = len(set((c.document_id, c.page_number) for c in used_chunks))
    agreement = min(1.0, (distinct_pages) / 3.0)  # 3+ independent passages -> full credit

    score = 0.35 * retrieval_strength + 0.25 * agreement + 0.40 * grounding_ratio
    return round(max(0.0, min(1.0, score)), 3)
