"""nombres y apellidos de los empleados en mayúsculas

Revision ID: e4a8c1f05d92
Revises: b2e7c4a91f06
Create Date: 2026-10-05 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'e4a8c1f05d92'
down_revision: str | None = 'b2e7c4a91f06'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    for emp_id, first, last in conn.execute(sa.text('SELECT id, first_name, last_name FROM employees')).all():
        new = (" ".join(first.split()).upper(), " ".join(last.split()).upper())
        if new != (first, last):
            conn.execute(
                sa.text('UPDATE employees SET first_name = :f, last_name = :l WHERE id = :id'),
                {'f': new[0], 'l': new[1], 'id': emp_id},
            )


def downgrade() -> None:
    pass  # no se puede saber cómo venía escrito cada nombre
