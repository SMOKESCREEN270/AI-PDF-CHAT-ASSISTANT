"""
Document Comparison Mode: compares a set of uploaded documents across a
consistent set of dimensions in a table, then gives a "best for which
scenario" recommendation grounded in that table.
"""
from typing import List
from sqlalchemy.orm import Session

from app import models
from app.services import llm, document_context

SYSTEM_INSTRUCTION = (
    "You compare multiple documents strictly using the excerpts given for "
    "each. Respond with strict JSON: "
    '{"dimensions": [str, ...], '
    '"table": [{"document": str, "values": {dimension: str, ...}}], '
    '"recommendations": [{"scenario": str, "best_document": str, "reason": str}]}. '
    "Pick 4-7 comparison dimensions relevant to the documents' actual content "
    "(e.g. scope, depth, methodology, target audience, strengths, "
    "limitations - adapt to what's actually in the documents). Give 2-4 "
    "scenario recommendations."
)


def compare_documents(db: Session, document_ids: List[str], scenario_context: str = None,
                       api_key: str = None) -> dict:
    sections = []
    for doc_id in document_ids:
        doc = db.query(models.Document).filter(models.Document.id == doc_id).first()
        if not doc:
            continue
        chunks = document_context.get_representative_chunks(db, doc_id)
        context = document_context.chunks_to_context_block(chunks)
        sections.append(f"===== DOCUMENT: {doc.filename} =====\n{context}")

    full_context = "\n\n".join(sections)
    scenario_hint = f"\nUser's context for recommendations: {scenario_context}\n" if scenario_context else ""

    prompt = f"{full_context}\n{scenario_hint}\nGenerate the JSON comparison now."
    data = llm.generate_json(prompt, api_key=api_key, system_instruction=SYSTEM_INSTRUCTION)
    return data
