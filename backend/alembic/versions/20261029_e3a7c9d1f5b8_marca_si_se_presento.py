"""marcas «Sí se presentó»: RRHH las crea con el horario, sin archivo del reloj

Revision ID: e3a7c9d1f5b8
Revises: d2f6b8c0e4a7
Create Date: 2026-10-29 10:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'e3a7c9d1f5b8'
down_revision: str | None = 'd2f6b8c0e4a7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column('punches', 'import_batch_id', existing_type=sa.Integer(), nullable=True)
    op.add_column('punches', sa.Column('added_by_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f('fk_punches_added_by_id_users'), 'punches', 'users', ['added_by_id'], ['id'], ondelete='SET NULL'
    )


def downgrade() -> None:
    op.execute('DELETE FROM punches WHERE import_batch_id IS NULL')
    op.drop_constraint(op.f('fk_punches_added_by_id_users'), 'punches', type_='foreignkey')
    op.drop_column('punches', 'added_by_id')
    op.alter_column('punches', 'import_batch_id', existing_type=sa.Integer(), nullable=False)
