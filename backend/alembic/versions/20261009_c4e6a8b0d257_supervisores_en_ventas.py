"""supervisores dentro de Agentes de ventas, etiquetados por el rol del CRM

Revision ID: c4e6a8b0d257
Revises: b3d5f7a9c146
Create Date: 2026-10-09 17:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'c4e6a8b0d257'
down_revision: str | None = 'b3d5f7a9c146'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('employees', sa.Column('crm_supervisor', sa.Boolean(), server_default='false', nullable=False))
    op.execute("UPDATE employees SET area = 'ventas' WHERE area = 'supervisor'")


def downgrade() -> None:
    op.execute("UPDATE employees SET area = 'supervisor' WHERE area = 'ventas' AND position ILIKE '%supervis%'")
    op.drop_column('employees', 'crm_supervisor')
