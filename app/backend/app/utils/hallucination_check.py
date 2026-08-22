"""
Hallucination Prevention.

Two layers of defense:

1. PROMPT-LEVEL GUARD: the RAG prompt (see rag_pipeline.py) explicitly
   instructs the model to answer *only* from the provided context, to say
   "I don't have enough information in the uploaded document(s) to answer
   this" when the context doesn't support an answer, and to tag every claim
   with a [source N] marker.

2. POST-HOC GROUNDING CHECK (this module): after generation, we split the
   answer into sentences and check each one against the retrieved context
   using lexical overlap (token Jaccard / containment) as a cheap, fast,
   fully local proxy for "is this sentence supported by the context".
   Sentences that aren't well supported are flagged; if too many sentences
   are unsupported we downgrade confidence and prepend a warning banner to
   the answer rather than silently presenting it as fact.
"""
import re
from dataclasses import dataclass
from typing import List, Tuple

STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "of", "in", "on", "to",
    "and", "or", "for", "with", "as", "by", "that", "this", "it", "its",
    "be", "at", "from", "which", "these", "those", "such", "than", "into",
}


@dataclass
class SentenceGrounding:
    sentence: str
    supported: bool
    best_overlap: float


def _split_sentences(text: str) -> List[str]:
    # lightweight sentence splitter - good enough for grounding checks
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in sentences if len(s.strip()) > 3]


def _tokens(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w for w in words if w not in STOPWORDS and len(w) > 2}


def _overlap_ratio(sentence_tokens: set, context_tokens: set) -> float:
    if not sentence_tokens:
        return 0.0
    return len(sentence_tokens & context_tokens) / len(sentence_tokens)


def check_grounding(answer: str, context_chunks: List[str],
                     support_threshold: float = 0.35) -> Tuple[List[SentenceGrounding], float]:
    """
    Returns (per-sentence grounding results, overall grounding_ratio in [0,1]).
    A sentence is "supported" if its token-containment in the union of
    context chunks is >= support_threshold. Short connective / meta
    sentences (e.g. "Here's a summary:") are auto-passed so they don't
    unfairly drag down the score.
    """
    context_tokens = set()
    for c in context_chunks:
        context_tokens |= _tokens(c)

    sentences = _split_sentences(answer)
    if not sentences:
        return [], 1.0

    results: List[SentenceGrounding] = []
    for sent in sentences:
        s_tokens = _tokens(sent)
        if len(s_tokens) <= 3:
            results.append(SentenceGrounding(sent, True, 1.0))
            continue
        overlap = _overlap_ratio(s_tokens, context_tokens)
        results.append(SentenceGrounding(sent, overlap >= support_threshold, overlap))

    supported_count = sum(1 for r in results if r.supported)
    grounding_ratio = supported_count / len(results)
    return results, grounding_ratio


def build_warning_banner(grounding_ratio: float, threshold: float = 0.5) -> str:
    if grounding_ratio >= threshold:
        return ""
    return (
        "⚠️ Low-confidence answer: parts of this response could not be strongly "
        "grounded in the uploaded document(s). Please verify against the cited "
        "source lines before relying on it.\n\n"
    )
