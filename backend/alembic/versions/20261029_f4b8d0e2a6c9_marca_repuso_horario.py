"""marcas manuales con motivo: «Sí se presentó» o «Repuso horario»

Revision ID: f4b8d0e2a6c9
Revises: e3a7c9d1f5b8
Create Date: 2026-10-29 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'f4b8d0e2a6c9'
down_revision: str | None = 'e3a7c9d1f5b8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('punches', sa.Column('manual_reason', sa.String(length=16), nullable=True))
    op.execute("UPDATE punches SET manual_reason = 'presente' WHERE import_batch_id IS NULL")


def downgrade() -> None:
    op.drop_column('punches', 'manual_reason')
