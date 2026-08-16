"""
"Always highlight important sections": every answer should point back at
the exact passages that mattered most, so the reader can jump straight to
them in the PDF viewer. We reuse the retrieved+cited chunks, rank by fused
hybrid-search score, and cap to a sensible number so the UI isn't flooded.
"""
from typing import List
from app.services.hybrid_search import RetrievedChunk

MAX_HIGHLIGHTS = 5


def select_highlights(used_chunks: List[RetrievedChunk]) -> List[RetrievedChunk]:
    ranked = sorted(used_chunks, key=lambda c: c.fused_score, reverse=True)
    return ranked[:MAX_HIGHLIGHTS]
