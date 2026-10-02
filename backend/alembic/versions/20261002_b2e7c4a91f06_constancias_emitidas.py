"""constancias salariales emitidas (quién, cuándo y la hoja descargada)

Revision ID: b2e7c4a91f06
Revises: 9d4f1b6c2e85
Create Date: 2026-10-02 17:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b2e7c4a91f06'
down_revision: str | None = '9d4f1b6c2e85'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'salary_certificates',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('template', sa.String(length=16), nullable=False),
        sa.Column('issue_date', sa.Date(), nullable=False),
        sa.Column('salary', sa.Numeric(12, 2), nullable=False),
        sa.Column('extra', sa.Numeric(12, 2), nullable=False),
        sa.Column('html', sa.Text(), nullable=False),
        sa.Column('issued_by_id', sa.Integer(), nullable=True),
        sa.Column('issued_by_name', sa.String(length=160), nullable=False),
        sa.Column('issued_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_salary_certificates_employee_id_employees'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['issued_by_id'], ['users.id'], name=op.f('fk_salary_certificates_issued_by_id_users'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_salary_certificates')),
    )
    op.create_index(op.f('ix_salary_certificates_employee_id'), 'salary_certificates', ['employee_id'], unique=False)
    op.create_index(op.f('ix_salary_certificates_issued_at'), 'salary_certificates', ['issued_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_salary_certificates_issued_at'), table_name='salary_certificates')
    op.drop_index(op.f('ix_salary_certificates_employee_id'), table_name='salary_certificates')
    op.drop_table('salary_certificates')
