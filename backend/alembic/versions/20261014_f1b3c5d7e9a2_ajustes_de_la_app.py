"""ajustes de la aplicación (fecha de corte de Marcaciones)

Revision ID: f1b3c5d7e9a2
Revises: e7a9b1c3d5f2
Create Date: 2026-10-14 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'f1b3c5d7e9a2'
down_revision: str | None = 'e7a9b1c3d5f2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'app_settings',
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('value', sa.JSON(), nullable=False),
        sa.Column('updated_by_id', sa.Integer(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('key'),
    )


def downgrade() -> None:
    op.drop_table('app_settings')
