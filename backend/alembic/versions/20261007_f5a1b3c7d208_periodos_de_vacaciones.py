"""períodos de vacaciones: días trabajados y períodos cerrados como completos

Revision ID: f5a1b3c7d208
Revises: e2c8f4a6d915
Create Date: 2026-10-07 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'f5a1b3c7d208'
down_revision: str | None = 'e2c8f4a6d915'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'vacation_periods',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('period_start', sa.Date(), nullable=False),
        sa.Column('worked_days', sa.Integer(), server_default='0', nullable=False),
        sa.Column('settled', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_vacation_periods_employee_id_employees'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_vacation_periods')),
        sa.UniqueConstraint('employee_id', 'period_start', name='uq_vacation_periods_employee_start'),
    )
    op.create_index(op.f('ix_vacation_periods_employee_id'), 'vacation_periods', ['employee_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_vacation_periods_employee_id'), table_name='vacation_periods')
    op.drop_table('vacation_periods')
