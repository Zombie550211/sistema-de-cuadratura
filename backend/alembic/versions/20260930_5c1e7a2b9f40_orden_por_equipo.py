"""orden por equipo como en el CRM

Revision ID: 5c1e7a2b9f40
Revises: d09187b5f521
Create Date: 2026-09-30 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.models.employee import team_section, team_sort_key

revision: str = '5c1e7a2b9f40'
down_revision: str | None = 'd09187b5f521'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('departments', sa.Column('section', sa.String(length=16), server_default='residencial', nullable=False))
    op.add_column('departments', sa.Column('sort_key', sa.String(length=120), server_default='', nullable=False))
    op.create_index(op.f('ix_departments_sort_key'), 'departments', ['sort_key'], unique=False)
    op.add_column('employees', sa.Column('crm_order', sa.Integer(), nullable=True))

    conn = op.get_bind()
    for dept_id, name in conn.execute(sa.text('SELECT id, name FROM departments')).all():
        conn.execute(
            sa.text('UPDATE departments SET section = :s, sort_key = :k WHERE id = :id'),
            {'s': team_section(name), 'k': team_sort_key(name), 'id': dept_id},
        )


def downgrade() -> None:
    op.drop_column('employees', 'crm_order')
    op.drop_index(op.f('ix_departments_sort_key'), table_name='departments')
    op.drop_column('departments', 'sort_key')
    op.drop_column('departments', 'section')
