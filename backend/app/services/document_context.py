"""
Whole-document tasks (questionnaire, quiz, flashcards, comparison, dashboard
seed summary) don't have a "query" to retrieve against - they need a
representative sample of the whole document instead. This evenly samples
chunks across the document (rather than just taking the first N, which would
bias everything toward the intro) and caps total characters sent to the LLM.
"""
from typing import List
from sqlalchemy.orm import Session

from app import models

MAX_CONTEXT_CHARS = 18000


def get_representative_chunks(db: Session, document_id: str) -> List[models.Chunk]:
    chunks = (
        db.query(models.Chunk)
        .filter(models.Chunk.document_id == document_id)
        .order_by(models.Chunk.chunk_index)
        .all()
    )
    if not chunks:
        return []

    total_chars = sum(len(c.text) for c in chunks)
    if total_chars <= MAX_CONTEXT_CHARS:
        return chunks

    # Evenly sample indices across the document to stay under the char budget
    keep_ratio = MAX_CONTEXT_CHARS / total_chars
    step = max(1, int(1 / keep_ratio))
    sampled = chunks[::step]
    return sampled


def chunks_to_context_block(chunks: List[models.Chunk]) -> str:
    return "\n\n".join(
        f"(Page {c.page_number}, Lines {c.line_start}-{c.line_end})\n{c.text}"
        for c in chunks
    )
