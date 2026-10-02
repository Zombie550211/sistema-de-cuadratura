"""área del empleado: administrativo, operativo, supervisor o ventas

Revision ID: 3f6b9d1e4a27
Revises: 8a4d2c6e1b73
Create Date: 2026-10-02 10:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.models.employee import area_for

revision: str = '3f6b9d1e4a27'
down_revision: str | None = '8a4d2c6e1b73'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'employees',
        sa.Column('area', sa.String(length=16), server_default='administrativo', nullable=False),
    )
    op.create_index(op.f('ix_employees_area'), 'employees', ['area'], unique=False)
    conn = op.get_bind()
    for emp_id, position, crm_id in conn.execute(sa.text('SELECT id, position, crm_agent_id FROM employees')).all():
        area = area_for(position, crm_id)
        if area != 'administrativo':
            conn.execute(sa.text('UPDATE employees SET area = :a WHERE id = :id'), {'a': area, 'id': emp_id})


def downgrade() -> None:
    op.drop_index(op.f('ix_employees_area'), table_name='employees')
    op.drop_column('employees', 'area')
