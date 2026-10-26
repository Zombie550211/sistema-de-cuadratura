"""agregado a planilla: empleado cuadrado en un periodo

Revision ID: c1e4a7b9d3f5
Revises: b9d1f3a5c7e2
Create Date: 2026-10-26 15:20:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'c1e4a7b9d3f5'
down_revision: str | None = 'b9d1f3a5c7e2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'payroll_marks',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('period_start', sa.Date(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_payroll_marks_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_payroll_marks_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_payroll_marks')),
        sa.UniqueConstraint('employee_id', 'period_start', name='uq_payroll_marks_employee_period'),
    )
    op.create_index(op.f('ix_payroll_marks_employee_id'), 'payroll_marks', ['employee_id'], unique=False)
    op.create_index(op.f('ix_payroll_marks_period_start'), 'payroll_marks', ['period_start'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_payroll_marks_period_start'), table_name='payroll_marks')
    op.drop_index(op.f('ix_payroll_marks_employee_id'), table_name='payroll_marks')
    op.drop_table('payroll_marks')
