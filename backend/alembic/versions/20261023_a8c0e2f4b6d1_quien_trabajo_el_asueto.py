"""quién trabajó los asuetos anteriores a las marcaciones

Revision ID: a8c0e2f4b6d1
Revises: f1b3c5d7e9a2
Create Date: 2026-10-23 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a8c0e2f4b6d1'
down_revision: str | None = 'f1b3c5d7e9a2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'holiday_workers',
        sa.Column('holiday_id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['holiday_id'], ['holidays.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('holiday_id', 'employee_id'),
    )
    op.create_index('ix_holiday_workers_employee_id', 'holiday_workers', ['employee_id'])


def downgrade() -> None:
    op.drop_index('ix_holiday_workers_employee_id', table_name='holiday_workers')
    op.drop_table('holiday_workers')
