import enum
import re
import unicodedata
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.models.base import Base, TimestampMixin


class EmployeeStatus(str, enum.Enum):
    activo = "activo"
    inactivo = "inactivo"


class PayFrequency(str, enum.Enum):
    quincenal = "quincenal"
    mensual = "mensual"


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode().lower().strip()


def team_section(name: str) -> str:
    """Misma regla que el CRM: si el equipo menciona 'linea(s)' es de Líneas; si no, Residencial."""
    return "lineas" if "linea" in _ascii(name) else "residencial"


def team_sort_key(name: str) -> str:
    """'TEAM Miguel Nuñez' → 'miguelnunez', como compara los equipos el CRM."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^team\s+", "", _ascii(name)))


class Department(TimestampMixin, Base):
    """Equipo (en el CRM, users.team). Se ordenan como en el CRM: Residencial y luego Líneas,
    y dentro de cada sección por nombre del equipo sin el prefijo 'TEAM'."""

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    section: Mapped[str] = mapped_column(String(16), default="residencial", server_default="residencial")
    sort_key: Mapped[str] = mapped_column(String(120), default="", server_default="", index=True)

    @validates("name")
    def _derive_order(self, _key, name: str) -> str:
        self.section = team_section(name)
        self.sort_key = team_sort_key(name)
        return name


class Employee(TimestampMixin, Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    # ID con el que el empleado está registrado en el reloj de marcación.
    badge_number: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    # ID del agente en el CRM (los horarios llegan desde el CRM con este identificador).
    crm_agent_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    # Posición del agente en el último envío del CRM, que ya llega ordenado por equipo con el
    # supervisor primero. Sirve para listar dentro de cada equipo en el mismo orden.
    crm_order: Mapped[int | None] = mapped_column(Integer)
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

    @classmethod
    def team_order(cls):
        """ORDER BY de empleados agrupados por equipo como en el CRM. Requiere
        outerjoin(Department, Employee.department_id == Department.id)."""
        return (
            (Department.section == "lineas").nulls_last(),
            Department.sort_key.nulls_last(),
            cls.crm_order.nulls_last(),
            cls.last_name,
            cls.first_name,
        )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"
