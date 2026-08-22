"""add token revocation and email verification

Revision ID: 20260812_0002
Revises: 20260811_0001
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260812_0002"
down_revision: Union[str, None] = "20260811_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "revoked_tokens",
        sa.Column("jti", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("jti"),
    )
    # Batch mode keeps the migration usable by the SQLite-isolated test suite.
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("is_verified", server_default=None)


def downgrade() -> None:
    op.drop_table("revoked_tokens")
    op.drop_column("users", "is_verified")