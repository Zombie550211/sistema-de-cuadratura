from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Device(TimestampMixin, Base):
    """Reloj de marcación, identificado por número de serie (p. ej. BINH221860214)."""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    serial_number: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    location: Mapped[str | None] = mapped_column(String(160))
    # Columna HUELLA de la planilla que corresponde a este reloj (p. ej. "LA17"): con ella se
    # reconoce al empleado aunque no tenga ID de reloj.
    fingerprint_key: Mapped[str | None] = mapped_column(String(40))


class ImportBatch(Base):
    """Cada archivo attlog subido. Se conserva el original para auditoría."""

    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    sha256: Mapped[str] = mapped_column(String(64), unique=True)
    storage_key: Mapped[str] = mapped_column(String(512))
    uploaded_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    total_lines: Mapped[int] = mapped_column(Integer, default=0)
    inserted: Mapped[int] = mapped_column(Integer, default=0)
    already_present: Mapped[int] = mapped_column(Integer, default=0)
    double_taps: Mapped[int] = mapped_column(Integer, default=0)
    invalid_lines: Mapped[int] = mapped_column(Integer, default=0)
    unknown_badges: Mapped[int] = mapped_column(Integer, default=0)
    date_from: Mapped[date | None] = mapped_column(Date)
    date_to: Mapped[date | None] = mapped_column(Date)

    device = relationship(Device, lazy="joined")
    uploaded_by = relationship("User", lazy="joined")


class Punch(Base):
    """Marcación tal como viene del reloj. RRHH puede corregir la hora o eliminarla, pero nunca
    se pierde el dato: se guarda la hora original y la eliminación es lógica (deleted_at), para
    que el reloj no la vuelva a meter en la próxima importación."""

    __tablename__ = "punches"
    __table_args__ = (
        UniqueConstraint("device_id", "badge", "punched_at", name="uq_punches_device_badge_time"),
        Index("ix_punches_employee_time", "employee_id", "punched_at"),
        Index("ix_punches_badge_time", "badge", "punched_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"))
    badge: Mapped[str] = mapped_column(String(32))
    employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id", ondelete="SET NULL")
    )
    punched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    verify_mode: Mapped[int] = mapped_column(Integer, default=0)
    status_code: Mapped[int] = mapped_column(Integer, default=0)
    work_code: Mapped[int] = mapped_column(Integer, default=0)
    # True si es una repetición dentro de la ventana de doble marca de otra marca previa.
    is_double_tap: Mapped[bool] = mapped_column(Boolean, default=False)
    import_batch_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id"), index=True)
    # Hora que trajo el reloj, si RRHH la corrigió.
    original_punched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    edited_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    employee = relationship("Employee", lazy="joined")
