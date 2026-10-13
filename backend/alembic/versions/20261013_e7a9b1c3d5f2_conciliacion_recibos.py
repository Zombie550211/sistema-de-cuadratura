"""conciliación de los recibos de Google Ads (la marca RRHH en Cuadratura)

Revision ID: e7a9b1c3d5f2
Revises: d6f8a0b2c4e1
Create Date: 2026-10-13 18:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'e7a9b1c3d5f2'
down_revision: str | None = 'd6f8a0b2c4e1'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('google_ads_receipts', sa.Column('reconciled', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.add_column('google_ads_receipts', sa.Column('reconciled_by', sa.String(length=160), nullable=True))
    op.add_column('google_ads_receipts', sa.Column('reconciled_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('google_ads_receipts', 'reconciled_at')
    op.drop_column('google_ads_receipts', 'reconciled_by')
    op.drop_column('google_ads_receipts', 'reconciled')
