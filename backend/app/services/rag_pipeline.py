"""
Orchestrates a single RAG turn:

  hybrid retrieve -> build grounded prompt (with [source N] markers)
  -> generate -> parse citations mentioned by the model
  -> post-hoc grounding check (hallucination guard)
  -> confidence score
  -> highlight selection
  -> summary/insights/conclusion block

This is the piece that ties RAG architecture + hybrid search + confidence
score + hallucination prevention together, per the project requirements.
"""
import re
from dataclasses import dataclass
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from app.services.hybrid_search import hybrid_retrieve, RetrievedChunk
from app.services import llm
from app.utils.confidence import compute_confidence
from app.utils.hallucination_check import check_grounding, build_warning_banner
from app.utils.highlighting import select_highlights
from app.config import settings

SYSTEM_INSTRUCTION = (
    "You are an AI document assistant. You must answer ONLY using the "
    "numbered SOURCE excerpts given to you in the prompt. Rules:\n"
    "1. Every factual claim must end with a bracketed citation like [S1] or "
    "[S2] referencing the source number it came from.\n"
    "2. If the sources do not contain enough information to answer, say so "
    "explicitly instead of guessing or using outside knowledge.\n"
    "3. Never invent page numbers, statistics, or quotes that are not in the "
    "sources.\n"
    "4. Be concise, structured, and use the user's own document terminology."
)


@dataclass
class RagResult:
    answer_text: str
    citations: List[Dict[str, Any]]
    highlighted: List[Dict[str, Any]]
    confidence_score: float
    hallucination_flag: bool
    used_chunks: List[RetrievedChunk]


def _build_prompt(question: str, chunks: List[RetrievedChunk], chat_history: str = "") -> str:
    sources_block = "\n\n".join(
        f"[S{i+1}] (Document: {c.filename}, Page {c.page_number}, "
        f"Lines {c.line_start}-{c.line_end})\n{c.text}"
        for i, c in enumerate(chunks)
    )
    history_block = f"\nCONVERSATION SO FAR:\n{chat_history}\n" if chat_history else ""
    return (
        f"SOURCES:\n{sources_block}\n"
        f"{history_block}\n"
        f"USER QUESTION: {question}\n\n"
        f"Answer the question using only the sources above, citing as [S1], [S2], etc."
    )


def _parse_cited_source_numbers(answer_text: str) -> List[int]:
    return sorted({int(n) for n in re.findall(r"\[S(\d+)\]", answer_text)})


def _chunk_to_citation(c: RetrievedChunk, relevance_score: float) -> Dict[str, Any]:
    snippet = c.text if len(c.text) <= 280 else c.text[:277] + "..."
    return {
        "document_id": c.document_id,
        "filename": c.filename,
        "page": c.page_number,
        "line_start": c.line_start,
        "line_end": c.line_end,
        "snippet": snippet,
        "relevance_score": round(relevance_score, 3),
    }


def run_rag_turn(db: Session, document_ids: List[str], question: str,
                  api_key: Optional[str] = None, chat_history: str = "") -> RagResult:
    retrieved = hybrid_retrieve(db, document_ids, question, api_key=api_key)

    if not retrieved:
        return RagResult(
            answer_text=("I couldn't find anything relevant to that question in the "
                          "uploaded document(s). Try rephrasing, or check that the right "
                          "document is selected."),
            citations=[], highlighted=[], confidence_score=0.0,
            hallucination_flag=True, used_chunks=[],
        )

    prompt = _build_prompt(question, retrieved, chat_history)
    raw_answer = llm.generate(prompt, api_key=api_key, system_instruction=SYSTEM_INSTRUCTION, temperature=0.25)

    cited_numbers = _parse_cited_source_numbers(raw_answer)
    used_chunks = [retrieved[n - 1] for n in cited_numbers if 0 < n <= len(retrieved)] or retrieved

    # ---- Hallucination guard: sentence-level grounding check ----
    context_texts = [c.text for c in used_chunks]
    _, grounding_ratio = check_grounding(raw_answer, context_texts)

    # ---- Confidence score ----
    confidence = compute_confidence(used_chunks, grounding_ratio)
    hallucination_flag = confidence < settings.MIN_CONFIDENCE_TO_ANSWER or grounding_ratio < 0.4

    banner = build_warning_banner(grounding_ratio)
    display_answer = banner + re.sub(r"\[S(\d+)\]", "", raw_answer).strip()

    citations = [_chunk_to_citation(c, c.fused_score) for c in used_chunks]
    highlighted = [_chunk_to_citation(c, c.fused_score) for c in select_highlights(used_chunks)]

    return RagResult(
        answer_text=display_answer,
        citations=citations,
        highlighted=highlighted,
        confidence_score=confidence,
        hallucination_flag=hallucination_flag,
        used_chunks=used_chunks,
    )
