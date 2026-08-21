from io import BytesIO
from datetime import datetime, timedelta
import uuid

from app import models
from app.database import SessionLocal
from app.services import malware_scanner


def register(client, email="researcher@example.com"):
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "correct-horse-battery", "full_name": "Researcher"},
    )
    assert response.status_code == 201
    return response.json()


def login(client, email="researcher@example.com"):
    response = client.post(
        "/api/auth/login",
        data={"username": email, "password": "correct-horse-battery"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_register_and_login_return_jwt(client):
    user = register(client)
    assert user["email"] == "researcher@example.com"
    headers = login(client)
    assert headers["Authorization"].startswith("Bearer ")


def test_user_cannot_chat_with_another_users_document(client):
    user_a = register(client, "a@example.com")
    headers_b = login(client, "a@example.com")
    # A second user is created through the real route; the document belongs to A.
    register(client, "b@example.com")
    headers_b = login(client, "b@example.com")
    with SessionLocal() as db:
        document = models.Document(
            owner_id=user_a["id"],
            filename="private.pdf",
            filepath="/tmp/private.pdf",
            collection_name="doc-private",
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        document_id = document.id
    response = client.post(
        "/api/chat",
        headers=headers_b,
        json={"document_ids": [document_id], "message": "Read this"},
    )
    assert response.status_code == 404


def test_path_traversal_filename_is_rejected(client):
    register(client)
    headers = login(client)
    response = client.post(
        "/api/documents/upload",
        headers=headers,
        files={"files": ("../../outside.pdf", BytesIO(b"%PDF-1.7\n"), "application/pdf")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid filename"


def test_eleventh_login_attempt_is_rate_limited(client):
    register(client)
    responses = [
        client.post(
            "/api/auth/login",
            data={"username": "researcher@example.com", "password": "correct-horse-battery"},
        )
        for _ in range(11)
    ]
    assert all(response.status_code == 200 for response in responses[:10])
    assert responses[10].status_code == 429
    assert "rate limit" in responses[10].text.lower()


def test_five_failed_logins_lock_account_across_requests(client):
    register(client)
    failures = [
        client.post(
            "/api/auth/login",
            data={"username": "researcher@example.com", "password": "wrong-password"},
            headers={"X-Forwarded-For": f"198.51.100.{index + 1}"},
        )
        for index in range(5)
    ]
    assert [response.status_code for response in failures] == [401, 401, 401, 401, 423]

    correct = client.post(
        "/api/auth/login",
        data={"username": "researcher@example.com", "password": "correct-horse-battery"},
    )
    assert correct.status_code == 423
    assert "temporarily locked" in correct.json()["detail"].lower()


def test_infected_upload_is_rejected_before_permanent_storage(client, monkeypatch):
    register(client)
    headers = login(client)
    monkeypatch.setattr(malware_scanner, "scan_file", lambda filepath: True)
    response = client.post(
        "/api/documents/upload",
        headers=headers,
        files={"files": ("infected.pdf", BytesIO(b"%PDF-1.7\nEICAR"), "application/pdf")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "File failed security scan"


def test_logout_does_not_revoke_other_active_sessions_for_same_user(client):
    """Regression test: logging out one session must not lock the user out
    of every other session until the revoked token's original expiry - only
    the specific token that was logged out should stop working."""
    register(client)
    session_a = login(client)
    session_b = login(client)

    logout_response = client.post("/api/auth/logout", headers=session_a)
    assert logout_response.status_code == 204

    revoked_session_check = client.get("/api/auth/me", headers=session_a)
    assert revoked_session_check.status_code == 401

    other_session_check = client.get("/api/auth/me", headers=session_b)
    assert other_session_check.status_code == 200


def test_due_flashcards_only_include_passed_review_dates(client):
    user = register(client)
    headers = login(client)
    card_due_id = "flashcard-due"
    card_future_id = "flashcard-future"
    with SessionLocal() as db:
        db.add(
            models.QuizFlashcardSet(
                owner_id=user["id"],
                document_id=str(uuid.uuid4()),
                kind="flashcards",
                title="Study set",
                items=[
                    {"id": card_due_id, "front": "Due front", "back": "Due back"},
                    {"id": card_future_id, "front": "Future front", "back": "Future back"},
                ],
            )
        )
        db.add_all(
            [
                models.FlashcardProgress(
                    user_id=user["id"],
                    flashcard_id=card_due_id,
                    next_review_at=datetime.utcnow() - timedelta(minutes=1),
                ),
                models.FlashcardProgress(
                    user_id=user["id"],
                    flashcard_id=card_future_id,
                    next_review_at=datetime.utcnow() + timedelta(days=1),
                ),
            ]
        )
        db.commit()

    due = client.get("/api/study/flashcards/due", headers=headers)
    assert due.status_code == 200
    assert [card["flashcard_id"] for card in due.json()] == [card_due_id]

    easy = client.post(
        f"/api/study/flashcards/{card_due_id}/review",
        headers=headers,
        json={"quality": 5},
    )
    assert easy.status_code == 200
    assert easy.json()["next_review_at"] > datetime.utcnow().isoformat()

    due_after_review = client.get("/api/study/flashcards/due", headers=headers)
    assert due_after_review.status_code == 200
    assert due_after_review.json() == []


def test_new_chat_session_is_titled_from_first_message():
    """Sessions used to stay labelled 'New Chat' forever; the first turn
    should now give the session a real title, Claude-style."""
    from app.services import memory as memory_service

    with SessionLocal() as db:
        session = models.ChatSession(owner_id=str(uuid.uuid4()), document_ids=[])
        db.add(session)
        db.commit()
        db.refresh(session)
        assert session.title == "New Chat"

        memory_service.maybe_title_session(db, session, "  What does section 3 say about risk?  ")
        db.commit()
        db.refresh(session)
        assert session.title == "What does section 3 say about risk?"

        # A second turn must never overwrite the title that was already set.
        memory_service.maybe_title_session(db, session, "Follow-up question")
        db.commit()
        db.refresh(session)
        assert session.title == "What does section 3 say about risk?"


def test_study_sets_endpoint_lists_recent_sets_with_document_name(client):
    user = register(client)
    headers = login(client)
    with SessionLocal() as db:
        document = models.Document(
            owner_id=user["id"], filename="thesis.pdf", filepath="/tmp/thesis.pdf",
            collection_name="doc-thesis", status="ready",
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        quiz_set = models.QuizFlashcardSet(
            owner_id=user["id"], document_id=document.id, kind="quiz", title="Chapter 3 quiz",
            items=[{"question": "Q1"}, {"question": "Q2"}],
        )
        db.add(quiz_set)
        db.commit()

    response = client.get("/api/study/sets", headers=headers)
    assert response.status_code == 200
    sets = response.json()
    assert len(sets) == 1
    assert sets[0]["kind"] == "quiz"
    assert sets[0]["title"] == "Chapter 3 quiz"
    assert sets[0]["item_count"] == 2
    assert sets[0]["document_filename"] == "thesis.pdf"


def test_study_sets_endpoint_only_returns_the_current_users_sets(client):
    owner = register(client, "owner@example.com")
    register(client, "other@example.com")
    other_headers = login(client, "other@example.com")
    with SessionLocal() as db:
        document = models.Document(
            owner_id=owner["id"], filename="private.pdf", filepath="/tmp/private2.pdf",
            collection_name="doc-private2", status="ready",
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        db.add(models.QuizFlashcardSet(
            owner_id=owner["id"], document_id=document.id, kind="flashcards", title="Private set", items=[],
        ))
        db.commit()

    response = client.get("/api/study/sets", headers=other_headers)
    assert response.status_code == 200
    assert response.json() == []


def test_questionnaire_category_instruction_defaults_to_all_categories():
    from app.services.questionnaire import _category_instruction, CATEGORY_VERBS

    everything = _category_instruction([])
    for key, (label, _verbs) in CATEGORY_VERBS.items():
        assert label in everything

    scoped = _category_instruction(["analysis", "evaluation", "not-a-real-category"])
    assert CATEGORY_VERBS["analysis"][0] in scoped
    assert CATEGORY_VERBS["evaluation"][0] in scoped
    assert CATEGORY_VERBS["knowledge"][0] not in scoped