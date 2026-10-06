from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ShiftTemplate(TimestampMixin, Base):
    """Turno reutilizable (p. ej. 'Mañana 7:00–16:00'). Si end_time < start_time cruza la medianoche."""

    __tablename__ = "shift_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)
    break_minutes: Mapped[int] = mapped_column(Integer, default=60)
    tolerance_minutes: Mapped[int] = mapped_column(Integer, default=5)
    color: Mapped[str] = mapped_column(String(7), default="#06b6d4")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class ShiftAssignment(TimestampMixin, Base):
    """Horario asignado a un empleado en una fecha. start_at/end_at son instantes completos,
    así un turno nocturno 22:00–06:00 pertenece a la fecha en que inicia."""

    __tablename__ = "shift_assignments"
    __table_args__ = (
        UniqueConstraint("employee_id", "work_date", name="uq_shift_assignments_employee_date"),
        CheckConstraint("end_at > start_at", name="end_after_start"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    work_date: Mapped[date] = mapped_column(Date, index=True)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    break_minutes: Mapped[int] = mapped_column(Integer, default=60)
    tolerance_minutes: Mapped[int] = mapped_column(Integer, default=5)
    template_id: Mapped[int | None] = mapped_column(
        ForeignKey("shift_templates.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(Text)
    # 'manual' (RRHH en la app) o 'crm' (enviado por el CRM). El CRM nunca pisa lo manual.
    source: Mapped[str] = mapped_column(String(16), default="manual", server_default="manual")
    sync_id: Mapped[int | None] = mapped_column(ForeignKey("integration_syncs.id", ondelete="SET NULL"))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    template = relationship(ShiftTemplate, lazy="joined")


DAY_OFF_KINDS = ("libre", "vacacion", "compensatorio")


class ShiftDayOff(TimestampMixin, Base):
    """Día sin turno fijado por RRHH: libre (al reagendar o quitar un turno), de vacación o
    compensatorio. El CRM no pone turno en esos días, igual que no pisa un horario manual."""

    __tablename__ = "shift_days_off"
    __table_args__ = (UniqueConstraint("employee_id", "work_date", name="uq_shift_days_off_employee_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="libre", server_default="libre")
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
