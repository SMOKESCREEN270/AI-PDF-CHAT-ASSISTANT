"""
AI Document Summary Dashboard.

Every assistant turn gets, alongside the direct answer to what the user
asked: a short summary, a handful of key insights, and a conclusion -
all grounded in the same retrieved context used for the main answer (so
this doesn't introduce a second, unchecked source of hallucination).
"""
from typing import List
from app.services import llm
from app.services.hybrid_search import RetrievedChunk

SUMMARY_SYSTEM_INSTRUCTION = (
    "You produce structured JSON summaries of document excerpts. Only use "
    "information present in the given excerpts. Respond with strict JSON: "
    '{"short_summary": str, "key_insights": [str, ...], "conclusion": str}. '
    "key_insights should have 3-5 bullet-style items. Keep short_summary to "
    "2-3 sentences and conclusion to 1-2 sentences."
)


def generate_summary_block(question: str, answer: str, used_chunks: List[RetrievedChunk],
                            api_key: str = None) -> dict:
    context = "\n\n".join(f"- {c.text}" for c in used_chunks[:6])
    prompt = (
        f"USER TASK: {question}\n\nASSISTANT ANSWER: {answer}\n\n"
        f"SUPPORTING EXCERPTS:\n{context}\n\n"
        "Produce the JSON summary object now."
    )
    try:
        data = llm.generate_json(prompt, api_key=api_key, system_instruction=SUMMARY_SYSTEM_INSTRUCTION)
        return {
            "short_summary": data.get("short_summary", ""),
            "key_insights": data.get("key_insights", []),
            "conclusion": data.get("conclusion", ""),
        }
    except Exception:
        # Never let dashboard generation break the main chat turn
        return {
            "short_summary": "Summary unavailable for this turn.",
            "key_insights": [],
            "conclusion": "",
        }
