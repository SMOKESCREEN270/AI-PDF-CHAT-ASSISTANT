"""add login lockout and flashcard progress

Revision ID: 20260812_0005
Revises: 20260812_0004
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260812_0005"
down_revision: Union[str, None] = "20260812_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("failed_login_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("users", sa.Column("locked_until", sa.DateTime(), nullable=True))
    op.create_table(
        "flashcard_progress",
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("user_id", sa.Uuid(as_uuid=False), nullable=False),
        sa.Column("flashcard_id", sa.String(), nullable=False),
        sa.Column("ease_factor", sa.Float(), nullable=False, server_default="2.5"),
        sa.Column("interval_days", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_review_at", sa.DateTime(), nullable=False),
        sa.Column("last_reviewed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint("user_id", "flashcard_id", name="uq_flashcard_progress_user_card"),
    )
    op.create_index(
        "ix_flashcard_progress_due",
        "flashcard_progress",
        ["user_id", "next_review_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_flashcard_progress_due", table_name="flashcard_progress")
    op.drop_table("flashcard_progress")
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_count")