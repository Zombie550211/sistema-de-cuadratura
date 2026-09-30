from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ApiClient(TimestampMixin, Base):
    """Sistema externo (p. ej. el CRM) autorizado a llamar la API con una clave.
    Solo se guarda el hash SHA-256 de la clave; la clave completa se muestra una sola vez."""

    __tablename__ = "api_clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    key_prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class IntegrationSync(Base):
    """Registro de cada envío recibido del CRM, con el resultado de aplicarlo."""

    __tablename__ = "integration_syncs"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("api_clients.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(32))  # 'schedules'
    idempotency_key: Mapped[str | None] = mapped_column(String(128), unique=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    date_from: Mapped[date | None] = mapped_column(Date)
    date_to: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16))  # ok | parcial | error
    agents_received: Mapped[int] = mapped_column(Integer, default=0)
    employees_created: Mapped[int] = mapped_column(Integer, default=0)
    shifts_created: Mapped[int] = mapped_column(Integer, default=0)
    shifts_updated: Mapped[int] = mapped_column(Integer, default=0)
    shifts_removed: Mapped[int] = mapped_column(Integer, default=0)
    conflicts: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    details: Mapped[dict | None] = mapped_column(JSON)

    client = relationship(ApiClient, lazy="joined")
