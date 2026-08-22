"""add projects table, chat session project link + share link

Revision ID: 20260822_0006
Revises: 20260812_0005
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260822_0006"
down_revision: Union[str, None] = "20260812_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
        sa.Column("owner_id", sa.Uuid(as_uuid=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("memory_summary", sa.Text(), nullable=True),
        sa.Column("memory_updated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("project_id", sa.Uuid(as_uuid=False), nullable=True),
    )
    op.create_foreign_key(
        "fk_chat_sessions_project_id", "chat_sessions", "projects", ["project_id"], ["id"],
    )
    op.create_index("ix_chat_sessions_project_id", "chat_sessions", ["project_id"])
    op.add_column(
        "chat_sessions",
        sa.Column("share_token", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_chat_sessions_share_token", "chat_sessions", ["share_token"], unique=True,
    )
    op.add_column(
        "chat_sessions",
        sa.Column("shared_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "shared_at")
    op.drop_index("ix_chat_sessions_share_token", table_name="chat_sessions")
    op.drop_column("chat_sessions", "share_token")
    op.drop_index("ix_chat_sessions_project_id", table_name="chat_sessions")
    op.drop_constraint("fk_chat_sessions_project_id", "chat_sessions", type_="foreignkey")
    op.drop_column("chat_sessions", "project_id")
    op.drop_table("projects")
