"""add per-user token revocation markers

Revision ID: 20260812_0004
Revises: 20260812_0003
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260812_0004"
down_revision: Union[str, None] = "20260812_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "revoked_tokens",
        sa.Column("user_id", sa.Uuid(as_uuid=False), nullable=True),
    )
    op.create_index(
        "ix_revoked_tokens_user_id",
        "revoked_tokens",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_revoked_tokens_user_id", table_name="revoked_tokens")
    op.drop_column("revoked_tokens", "user_id")