"""RRHH corrige o elimina marcas; huella de la planilla por reloj

Revision ID: c71f2a9e4b38
Revises: 6b3d9e2f7a14
Create Date: 2026-10-06 16:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'c71f2a9e4b38'
down_revision: str | None = '6b3d9e2f7a14'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('punches', sa.Column('original_punched_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('punches', sa.Column('edited_by_id', sa.Integer(), nullable=True))
    op.add_column('punches', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('punches', sa.Column('deleted_by_id', sa.Integer(), nullable=True))
    op.create_foreign_key(op.f('fk_punches_edited_by_id_users'), 'punches', 'users', ['edited_by_id'], ['id'], ondelete='SET NULL')
    op.create_foreign_key(op.f('fk_punches_deleted_by_id_users'), 'punches', 'users', ['deleted_by_id'], ['id'], ondelete='SET NULL')
    op.add_column('devices', sa.Column('fingerprint_key', sa.String(length=40), nullable=True))
    # El reloj principal es el LA17 de la planilla (60 de los 62 IDs de su archivo coinciden).
    op.execute("UPDATE devices SET fingerprint_key = 'LA17' WHERE serial_number = 'BINH221860214'")
    # Las marcas ya importadas toman el nombre por la huella de ese local en la planilla.
    op.execute(
        """
        UPDATE punches p SET employee_id = e.id
        FROM devices d, employees e
        WHERE p.device_id = d.id AND d.fingerprint_key IS NOT NULL AND p.employee_id IS NULL
          AND e.fingerprints::jsonb ->> d.fingerprint_key = p.badge
        """
    )


def downgrade() -> None:
    op.drop_column('devices', 'fingerprint_key')
    op.drop_constraint(op.f('fk_punches_deleted_by_id_users'), 'punches', type_='foreignkey')
    op.drop_constraint(op.f('fk_punches_edited_by_id_users'), 'punches', type_='foreignkey')
    op.drop_column('punches', 'deleted_by_id')
    op.drop_column('punches', 'deleted_at')
    op.drop_column('punches', 'edited_by_id')
    op.drop_column('punches', 'original_punched_at')
