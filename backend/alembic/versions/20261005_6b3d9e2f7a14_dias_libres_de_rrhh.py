"""días libres fijados por RRHH (al reagendar o quitar un turno; el CRM los respeta)

Revision ID: 6b3d9e2f7a14
Revises: e4a8c1f05d92
Create Date: 2026-10-05 15:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '6b3d9e2f7a14'
down_revision: str | None = 'e4a8c1f05d92'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'shift_days_off',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_shift_days_off_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_shift_days_off_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_shift_days_off')),
        sa.UniqueConstraint('employee_id', 'work_date', name='uq_shift_days_off_employee_date'),
    )
    op.create_index(op.f('ix_shift_days_off_employee_id'), 'shift_days_off', ['employee_id'], unique=False)
    op.create_index(op.f('ix_shift_days_off_work_date'), 'shift_days_off', ['work_date'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_shift_days_off_work_date'), table_name='shift_days_off')
    op.drop_index(op.f('ix_shift_days_off_employee_id'), table_name='shift_days_off')
    op.drop_table('shift_days_off')
