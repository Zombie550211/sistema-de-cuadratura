"""origen del día libre (rrhh o crm) e incapacidad como tipo

Revision ID: b3d5f7a9c146
Revises: a7c9e1f3b524
Create Date: 2026-10-07 18:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b3d5f7a9c146'
down_revision: str | None = 'a7c9e1f3b524'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('shift_days_off', sa.Column('source', sa.String(length=16), server_default='rrhh', nullable=False))


def downgrade() -> None:
    op.drop_column('shift_days_off', 'source')
