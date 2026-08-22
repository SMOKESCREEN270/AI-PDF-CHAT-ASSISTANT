from typing import List
from sqlalchemy.orm import Session

from app.services import llm, document_context

QUIZ_SYSTEM_INSTRUCTION = (
    "You create multiple-choice quizzes strictly from the given document "
    'excerpts. Respond with strict JSON: {"quiz": [{"question": str, '
    '"options": [str, str, str, str], "correct_index": int, "explanation": '
    'str, "difficulty": str, "source_page": int}]}. Make exactly one option '
    "correct per question, and keep distractors plausible but clearly wrong "
    "on close reading of the source. \"difficulty\" must be one of \"easy\", "
    "\"intermediate\", or \"advanced\"; if the requested difficulty is "
    "'mixed', vary it across questions, otherwise use the requested level "
    "for every question."
)

FLASHCARD_SYSTEM_INSTRUCTION = (
    "You create study flashcards strictly from the given document excerpts. "
    'Respond with strict JSON: {"flashcards": [{"front": str, "back": str, '
    '"source_page": int, "difficulty": str}]}. "front" should be a short '
    'term/question, "back" a concise definition/answer, both derived only '
    "from the excerpts. Match each card's difficulty to the requested level "
    "(easy = definitions/recall, intermediate = explain relationships, "
    "advanced = apply/synthesize); if difficulty is 'mixed', vary it."
)


def generate_quiz(db: Session, document_id: str, num_questions: int = 10,
                   difficulty: str = "mixed", api_key: str = None) -> List[dict]:
    chunks = document_context.get_representative_chunks(db, document_id)
    context = document_context.chunks_to_context_block(chunks)
    prompt = (
        f"DOCUMENT EXCERPTS:\n{context}\n\n"
        f"num_questions = {num_questions}\ndifficulty = {difficulty}\n\n"
        "Generate the JSON quiz now."
    )
    data = llm.generate_json(prompt, api_key=api_key, system_instruction=QUIZ_SYSTEM_INSTRUCTION)
    return data.get("quiz", [])


def generate_flashcards(db: Session, document_id: str, num_cards: int = 15,
                         difficulty: str = "mixed", api_key: str = None) -> List[dict]:
    chunks = document_context.get_representative_chunks(db, document_id)
    context = document_context.chunks_to_context_block(chunks)
    prompt = (
        f"DOCUMENT EXCERPTS:\n{context}\n\n"
        f"num_cards = {num_cards}\ndifficulty = {difficulty}\n\n"
        "Generate the JSON flashcard set now, covering the most important "
        "terms, concepts, and facts in the document."
    )
    data = llm.generate_json(prompt, api_key=api_key, system_instruction=FLASHCARD_SYSTEM_INSTRUCTION)
    return data.get("flashcards", [])
