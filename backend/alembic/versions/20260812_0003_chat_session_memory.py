"""add rolling chat memory

Revision ID: 20260812_0003
Revises: 20260812_0002
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260812_0003"
down_revision: Union[str, None] = "20260812_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("rolling_summary", sa.Text(), nullable=True))
    op.add_column(
        "chat_sessions",
        sa.Column("rolling_summary_through", sa.Integer(), nullable=False, server_default="0"),
    )
    # Batch mode keeps the migration usable by the SQLite-isolated test suite.
    with op.batch_alter_table("chat_sessions") as batch_op:
        batch_op.alter_column("rolling_summary_through", server_default=None)


def downgrade() -> None:
    op.drop_column("chat_sessions", "rolling_summary_through")
    op.drop_column("chat_sessions", "rolling_summary")