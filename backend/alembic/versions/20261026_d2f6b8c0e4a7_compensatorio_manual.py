"""compensatorio manual («Otro»): concedido a mano por RRHH

Revision ID: d2f6b8c0e4a7
Revises: c1e4a7b9d3f5
Create Date: 2026-10-26 17:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'd2f6b8c0e4a7'
down_revision: str | None = 'c1e4a7b9d3f5'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'manual_compensatories',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('earned_date', sa.Date(), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_manual_compensatories_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_manual_compensatories_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_manual_compensatories')),
    )
    op.create_index(op.f('ix_manual_compensatories_employee_id'), 'manual_compensatories', ['employee_id'], unique=False)
    op.create_index(op.f('ix_manual_compensatories_earned_date'), 'manual_compensatories', ['earned_date'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_manual_compensatories_earned_date'), table_name='manual_compensatories')
    op.drop_index(op.f('ix_manual_compensatories_employee_id'), table_name='manual_compensatories')
    op.drop_table('manual_compensatories')
