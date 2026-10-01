"""nombres de empleados y teams con mayúscula inicial (no todo en mayúsculas)

Revision ID: 8a4d2c6e1b73
Revises: 5c1e7a2b9f40
Create Date: 2026-09-30 18:30:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.services.employee_roster import fix_case

revision: str = '8a4d2c6e1b73'
down_revision: str | None = '5c1e7a2b9f40'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    for emp_id, first, last in conn.execute(sa.text('SELECT id, first_name, last_name FROM employees')).all():
        new = (fix_case(first), fix_case(last))
        if new != (first, last):
            conn.execute(
                sa.text('UPDATE employees SET first_name = :f, last_name = :l WHERE id = :id'),
                {'f': new[0], 'l': new[1], 'id': emp_id},
            )

    taken = {name for (name,) in conn.execute(sa.text('SELECT name FROM departments')).all()}
    for dept_id, name in conn.execute(sa.text('SELECT id, name FROM departments')).all():
        new = fix_case(name)
        if new != name and new not in taken:  # dos teams que solo difieren en mayúsculas: se dejan
            conn.execute(sa.text('UPDATE departments SET name = :n WHERE id = :id'), {'n': new, 'id': dept_id})
            taken.discard(name)
            taken.add(new)


def downgrade() -> None:
    pass  # no se puede saber cómo venía escrito cada nombre
