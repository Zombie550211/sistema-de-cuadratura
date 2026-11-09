"""compensatorio pagado: asueto trabajado que se pagó en dinero («Pagado»)

Revision ID: a5c9e1f3b7d2
Revises: f4b8d0e2a6c9
Create Date: 2026-11-09 11:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a5c9e1f3b7d2'
down_revision: str | None = 'f4b8d0e2a6c9'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'compensatory_payments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('holiday_id', sa.Integer(), nullable=False),
        sa.Column('earned_date', sa.Date(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_compensatory_payments_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_compensatory_payments_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_compensatory_payments')),
        sa.UniqueConstraint('employee_id', 'holiday_id', name='uq_compensatory_payments_employee_holiday'),
    )
    op.create_index(op.f('ix_compensatory_payments_employee_id'), 'compensatory_payments', ['employee_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_compensatory_payments_employee_id'), table_name='compensatory_payments')
    op.drop_table('compensatory_payments')
