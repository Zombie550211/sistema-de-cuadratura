"""asuetos: días feriados que, trabajados, dan un compensatorio

Revision ID: e2c8f4a6d915
Revises: a3d5e7f9b104
Create Date: 2026-10-07 10:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'e2c8f4a6d915'
down_revision: str | None = 'a3d5e7f9b104'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'holidays',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_holidays')),
    )
    op.create_index(op.f('ix_holidays_day'), 'holidays', ['day'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_holidays_day'), table_name='holidays')
    op.drop_table('holidays')
