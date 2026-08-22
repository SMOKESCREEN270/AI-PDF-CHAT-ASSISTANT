"""
Generate Questionnaire mode - built for school/college students prepping for
tests and exams. Questions are drawn from one or more of six pedagogical
categories (each mapped to the verbs that define it), at a requested
difficulty, each with a model answer and a citation back to the source page.
"""
from typing import List
from sqlalchemy.orm import Session

from app.services import llm, document_context

# category key -> (label, representative verbs) shown to the model so it
# knows exactly what each category means and which verbs to use.
CATEGORY_VERBS = {
    "knowledge": ("Knowledge-based", ["Define", "Identify", "List", "State"]),
    "understanding": ("Understanding-based", ["Explain", "Describe", "Summarize"]),
    "application": ("Application-based", ["Apply", "Example", "Scenario", "Case Study"]),
    "analysis": ("Analysis-based", ["Analyze", "Compare", "Differentiate", "Cause & Effect"]),
    "evaluation": ("Evaluation-based", ["Evaluate", "Critically Discuss", "Justify", "Give your opinion"]),
    "creation": ("Creation/problem-solving", ["Suggest", "Recommend", "Design", "Propose a solution"]),
}

SYSTEM_INSTRUCTION_BASE = (
    "You are an exam-question setter for students. Generate questions strictly "
    "from the given document excerpts. Respond with strict JSON: "
    '{"questions": [{"question": str, "type": str, "difficulty": str, '
    '"model_answer": str, "source_page": int}]}. '
    '"type" must be the category key of the question (one of: knowledge, '
    "understanding, application, analysis, evaluation, creation). "
    '"difficulty" must be one of "easy", "intermediate", "advanced" '
    "(if the requested difficulty is 'mixed', vary it across questions, "
    "otherwise use the requested level for every question)."
)


def _category_instruction(question_types: List[str]) -> str:
    keys = [key for key in (question_types or []) if key in CATEGORY_VERBS]
    if not keys:
        keys = list(CATEGORY_VERBS.keys())
    lines = [
        f"- {label} (type=\"{key}\"): use verbs like {', '.join(verbs)}"
        for key, (label, verbs) in CATEGORY_VERBS.items()
        if key in keys
    ]
    return (
        "Draw questions ONLY from these categories, spreading num_questions "
        "roughly evenly across them:\n" + "\n".join(lines)
    )


def generate_questionnaire(db: Session, document_id: str, num_questions: int = 10,
                            difficulty: str = "mixed", question_types: List[str] = None,
                            api_key: str = None) -> List[dict]:
    chunks = document_context.get_representative_chunks(db, document_id)
    context = document_context.chunks_to_context_block(chunks)

    system_instruction = f"{SYSTEM_INSTRUCTION_BASE}\n\n{_category_instruction(question_types)}"

    prompt = (
        f"DOCUMENT EXCERPTS:\n{context}\n\n"
        f"num_questions = {num_questions}\n"
        f"difficulty = {difficulty}\n\n"
        "Generate the JSON questionnaire now."
    )
    data = llm.generate_json(prompt, api_key=api_key, system_instruction=system_instruction)
    return data.get("questions", [])
