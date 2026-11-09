"""compensatorio: motivo de la baja (pagado / ajuste de saldo)

Revision ID: b6d0f2a4c8e1
Revises: a5c9e1f3b7d2
Create Date: 2026-11-09 13:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b6d0f2a4c8e1'
down_revision: str | None = 'a5c9e1f3b7d2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('compensatory_payments', sa.Column('reason', sa.String(length=16), server_default='pagado', nullable=False))


def downgrade() -> None:
    op.drop_column('compensatory_payments', 'reason')
