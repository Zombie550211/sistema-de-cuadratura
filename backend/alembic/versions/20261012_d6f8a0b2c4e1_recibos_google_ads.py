"""recibos de Google Ads que envía el CRM (solo lectura en Cuadratura)

Revision ID: d6f8a0b2c4e1
Revises: c4e6a8b0d257
Create Date: 2026-10-12 19:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'd6f8a0b2c4e1'
down_revision: str | None = 'c4e6a8b0d257'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'google_ads_receipts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('crm_id', sa.Integer(), nullable=False),
        sa.Column('payment_date', sa.Date(), nullable=False),
        sa.Column('account_key', sa.String(length=40), nullable=False),
        sa.Column('account_name', sa.String(length=60), nullable=False),
        sa.Column('amount_cents', sa.Integer(), nullable=False),
        sa.Column('billing_id', sa.String(length=14), nullable=True),
        sa.Column('payment_method', sa.String(length=40), nullable=True),
        sa.Column('file_name', sa.String(length=160), nullable=False),
        sa.Column('storage_key', sa.String(length=200), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('uploaded_by', sa.String(length=150), nullable=False),
        sa.Column('crm_created_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('client_id', sa.Integer(), nullable=True),
        sa.CheckConstraint('amount_cents > 0', name=op.f('ck_google_ads_receipts_amount_positive')),
        sa.ForeignKeyConstraint(['client_id'], ['api_clients.id'], name=op.f('fk_google_ads_receipts_client_id_api_clients'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_google_ads_receipts')),
        sa.UniqueConstraint('crm_id', name=op.f('uq_google_ads_receipts_crm_id')),
        sa.UniqueConstraint('sha256', name=op.f('uq_google_ads_receipts_sha256')),
    )
    op.create_index(op.f('ix_google_ads_receipts_payment_date'), 'google_ads_receipts', ['payment_date'])
    op.create_index(op.f('ix_google_ads_receipts_billing_id'), 'google_ads_receipts', ['billing_id'])


def downgrade() -> None:
    op.drop_index(op.f('ix_google_ads_receipts_billing_id'), table_name='google_ads_receipts')
    op.drop_index(op.f('ix_google_ads_receipts_payment_date'), table_name='google_ads_receipts')
    op.drop_table('google_ads_receipts')
