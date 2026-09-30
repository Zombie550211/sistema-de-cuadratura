import enum
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class EmployeeStatus(str, enum.Enum):
    activo = "activo"
    inactivo = "inactivo"


class PayFrequency(str, enum.Enum):
    quincenal = "quincenal"
    mensual = "mensual"


class Department(TimestampMixin, Base):
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)


class Employee(TimestampMixin, Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    # ID con el que el empleado está registrado en el reloj de marcación.
    badge_number: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    # ID del agente en el CRM (los horarios llegan desde el CRM con este identificador).
    crm_agent_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    dui: Mapped[str | None] = mapped_column(String(10), unique=True)
    nit: Mapped[str | None] = mapped_column(String(17))
    isss_number: Mapped[str | None] = mapped_column(String(20))
    nup: Mapped[str | None] = mapped_column(String(20))  # Número Único Previsional (AFP)
    afp: Mapped[str | None] = mapped_column(String(40))
    email: Mapped[str | None] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(20))
    position: Mapped[str | None] = mapped_column(String(120))
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), index=True
    )
    hire_date: Mapped[date | None] = mapped_column(Date)
    termination_date: Mapped[date | None] = mapped_column(Date)
    base_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    pay_frequency: Mapped[PayFrequency] = mapped_column(
        Enum(PayFrequency, name="pay_frequency"), default=PayFrequency.quincenal
    )
    status: Mapped[EmployeeStatus] = mapped_column(
        Enum(EmployeeStatus, name="employee_status"), default=EmployeeStatus.activo, index=True
    )

    department = relationship(Department, lazy="joined")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"
