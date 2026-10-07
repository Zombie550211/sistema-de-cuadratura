"""cola de cambios de horario que van de Cuadratura al CRM

Revision ID: a7c9e1f3b524
Revises: f5a1b3c7d208
Create Date: 2026-10-07 16:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a7c9e1f3b524'
down_revision: str | None = 'f5a1b3c7d208'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'crm_outbox',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('queued_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_crm_outbox_employee_id_employees'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_outbox')),
        sa.UniqueConstraint('employee_id', 'work_date', name='uq_crm_outbox_employee_date'),
    )
    op.create_index(op.f('ix_crm_outbox_employee_id'), 'crm_outbox', ['employee_id'], unique=False)
    # Lo que RRHH ya había cambiado a mano (turnos y días libres desde la semana pasada) entra a
    # la cola: así el próximo envío del CRM no lo pisa y se le manda al CRM.
    op.execute("""
        INSERT INTO crm_outbox (employee_id, work_date)
        SELECT s.employee_id, s.work_date FROM shift_assignments s JOIN employees e ON e.id = s.employee_id
        WHERE s.source = 'manual' AND e.crm_agent_id IS NOT NULL AND s.work_date >= current_date - 7
        UNION
        SELECT d.employee_id, d.work_date FROM shift_days_off d JOIN employees e ON e.id = d.employee_id
        WHERE e.crm_agent_id IS NOT NULL AND d.work_date >= current_date - 7
    """)


def downgrade() -> None:
    op.drop_index(op.f('ix_crm_outbox_employee_id'), table_name='crm_outbox')
    op.drop_table('crm_outbox')
