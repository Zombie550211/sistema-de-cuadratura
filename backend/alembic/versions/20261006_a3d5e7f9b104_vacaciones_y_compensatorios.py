"""días de vacación y compensatorios (tipo del día sin turno fijado por RRHH)

Revision ID: a3d5e7f9b104
Revises: c71f2a9e4b38
Create Date: 2026-10-06 17:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a3d5e7f9b104'
down_revision: str | None = 'c71f2a9e4b38'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('shift_days_off', sa.Column('kind', sa.String(length=20), server_default='libre', nullable=False))


def downgrade() -> None:
    op.drop_column('shift_days_off', 'kind')
