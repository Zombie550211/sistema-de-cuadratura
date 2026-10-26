"""llegadas tarde no aplicadas por quincena (decisión de RRHH)

Revision ID: b9d1f3a5c7e2
Revises: a8c0e2f4b6d1
Create Date: 2026-10-26 15:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b9d1f3a5c7e2'
down_revision: str | None = 'a8c0e2f4b6d1'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'lateness_waivers',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('quincena_start', sa.Date(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_lateness_waivers_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_lateness_waivers_created_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_lateness_waivers')),
        sa.UniqueConstraint('employee_id', 'quincena_start', name='uq_lateness_waivers_employee_quincena'),
    )
    op.create_index(op.f('ix_lateness_waivers_employee_id'), 'lateness_waivers', ['employee_id'], unique=False)
    op.create_index(op.f('ix_lateness_waivers_quincena_start'), 'lateness_waivers', ['quincena_start'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_lateness_waivers_quincena_start'), table_name='lateness_waivers')
    op.drop_index(op.f('ix_lateness_waivers_employee_id'), table_name='lateness_waivers')
    op.drop_table('lateness_waivers')
