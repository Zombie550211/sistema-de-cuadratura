from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GoogleAdsReceipt(Base):
    """Recibo de pago de Google Ads con su PDF. Lo registran los administradores en el CRM
    (Recibos de Google Ads) y el CRM lo envía aquí al guardarlo; en Cuadratura es solo lectura,
    salvo la conciliación: RRHH marca aquí el recibo cuando ya revisó el documento, y la marca
    vuelve al CRM (services/recibos_crm.py), donde solo se muestra.
    `crm_id` es el id del recibo en el CRM: un reenvío del mismo recibo no lo duplica."""

    __tablename__ = "google_ads_receipts"
    __table_args__ = (CheckConstraint("amount_cents > 0", name="amount_positive"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    crm_id: Mapped[int] = mapped_column(Integer, unique=True)
    payment_date: Mapped[date] = mapped_column(Date, index=True)
    account_key: Mapped[str] = mapped_column(String(40))  # alexis, alexis2, garay_lineas, tito, tito_lineas
    account_name: Mapped[str] = mapped_column(String(60))
    amount_cents: Mapped[int] = mapped_column(Integer)
    billing_id: Mapped[str | None] = mapped_column(String(14), index=True)
    payment_method: Mapped[str | None] = mapped_column(String(40))
    file_name: Mapped[str] = mapped_column(String(160))
    storage_key: Mapped[str] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(64), unique=True)
    uploaded_by: Mapped[str] = mapped_column(String(150))  # usuario del CRM que lo subió
    crm_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    client_id: Mapped[int | None] = mapped_column(ForeignKey("api_clients.id", ondelete="SET NULL"))
    reconciled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    reconciled_by: Mapped[str | None] = mapped_column(String(160))
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
