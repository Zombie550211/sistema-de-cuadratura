"""ID de usuario: iniciales del nombre y apellido + día y mes de nacimiento (KR1907)

Revision ID: 9d4f1b6c2e85
Revises: 7c2e5a9d3b18
Create Date: 2026-10-02 15:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.models.employee import user_code_base
from app.services.user_code import unique_code

revision: str = '9d4f1b6c2e85'
down_revision: str | None = '7c2e5a9d3b18'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('employees', sa.Column('user_code', sa.String(length=16), nullable=True))
    op.create_index(op.f('ix_employees_user_code'), 'employees', ['user_code'], unique=True)
    conn = op.get_bind()
    taken: set[str] = set()
    rows = conn.execute(sa.text('SELECT id, first_name, last_name, birthday FROM employees ORDER BY id')).all()
    for emp_id, first, last, birthday in rows:
        base = user_code_base(first, last, birthday)
        if base:
            code = unique_code(base, taken)
            taken.add(code)
            conn.execute(sa.text('UPDATE employees SET user_code = :c WHERE id = :id'), {'c': code, 'id': emp_id})


def downgrade() -> None:
    op.drop_index(op.f('ix_employees_user_code'), table_name='employees')
    op.drop_column('employees', 'user_code')
