"""planilla completa en la ficha del empleado; área según el cargo con la regla de RRHH

Revision ID: 7c2e5a9d3b18
Revises: 3f6b9d1e4a27
Create Date: 2026-10-02 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.models.employee import area_for

revision: str = '7c2e5a9d3b18'
down_revision: str | None = '3f6b9d1e4a27'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = [
    sa.Column('payroll_date', sa.Date(), nullable=True),
    sa.Column('birthday', sa.String(length=5), nullable=True),
    sa.Column('gender', sa.String(length=10), nullable=True),
    sa.Column('bank_account', sa.String(length=30), nullable=True),
    sa.Column('locker', sa.String(length=10), nullable=True),
    sa.Column('fingerprints', sa.JSON(), server_default='{}', nullable=False),
    sa.Column('emergency_contact', sa.String(length=200), nullable=True),
    sa.Column('termination_note', sa.String(length=200), nullable=True),
    sa.Column('has_cv', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('has_contract', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('has_nda', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('has_memo', sa.Boolean(), server_default='false', nullable=False),
]


def upgrade() -> None:
    for column in COLUMNS:
        op.add_column('employees', column)
    conn = op.get_bind()
    for emp_id, position, crm_id in conn.execute(sa.text('SELECT id, position, crm_agent_id FROM employees')).all():
        conn.execute(sa.text('UPDATE employees SET area = :a WHERE id = :id'), {'a': area_for(position, crm_id), 'id': emp_id})


def downgrade() -> None:
    for column in reversed(COLUMNS):
        op.drop_column('employees', column.name)
