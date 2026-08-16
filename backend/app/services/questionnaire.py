"""
Generate Questionnaire mode - built for school/college students prepping for
tests and exams. Beyond generic Q&A, it specifically surfaces:
  - What is the main objective?
  - Explain the methodology
  - Critically analyze the findings
...plus a spread of additional exam-style questions at the requested
difficulty, each with a model answer and a citation back to the source page.
"""
from typing import List
from sqlalchemy.orm import Session

from app.services import llm, document_context

SYSTEM_INSTRUCTION = (
    "You are an exam-question setter for students. Generate questions strictly "
    "from the given document excerpts. Respond with strict JSON: "
    '{"questions": [{"question": str, "type": str, "difficulty": str, '
    '"model_answer": str, "source_page": int}]}. '
    '"type" must be one of: "objective", "methodology", "critical_analysis", "general". '
    "Always include exactly one 'objective' question (What is the main "
    "objective of this document?), one 'methodology' question (Explain the "
    "methodology/approach used), and one 'critical_analysis' question "
    "(Critically analyze the findings/claims), then fill the remainder with "
    "'general' comprehension questions until num_questions is reached."
)


def generate_questionnaire(db: Session, document_id: str, num_questions: int = 10,
                            difficulty: str = "mixed", api_key: str = None) -> List[dict]:
    chunks = document_context.get_representative_chunks(db, document_id)
    context = document_context.chunks_to_context_block(chunks)

    prompt = (
        f"DOCUMENT EXCERPTS:\n{context}\n\n"
        f"num_questions = {num_questions}\n"
        f"difficulty = {difficulty} (if 'mixed', vary difficulty across questions)\n\n"
        "Generate the JSON questionnaire now."
    )
    data = llm.generate_json(prompt, api_key=api_key, system_instruction=SYSTEM_INSTRUCTION)
    return data.get("questions", [])
