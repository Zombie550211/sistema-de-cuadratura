import enum
import re
import unicodedata
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, Enum, ForeignKey, Integer, Numeric, String
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


AREAS = ("administrativo", "operativo", "ventas")

_ADMINISTRATIVO = ("gerente", "operacion", "operarcion", "rrhh", "recursos humanos", "servicios varios",
                   "administrativ")
_OPERATIVO = ("publicidad",)


def area_for(position: str | None, crm_agent_id: str | None = None) -> str:
    """Área del empleado según su cargo en la planilla:
    - Administrativo: gerentes, asistente de operaciones, RRHH y servicios varios.
    - Operativo: IT y publicidad.
    - Agentes de ventas: el resto (agentes, supervisores, BO, control de calidad) y quien llega del
      CRM sin cargo. Los supervisores van con su team y se etiquetan (Employee.is_supervisor)."""
    cargo = _ascii(position or "")
    if any(w in cargo for w in _ADMINISTRATIVO):
        return "administrativo"
    if any(w in cargo for w in _OPERATIVO) or re.search(r"\bit\b", cargo):
        return "operativo"
    return "ventas"


def user_code_base(first_name: str, last_name: str, birthday: str | None) -> str | None:
    """ID de usuario: inicial del primer nombre + inicial del primer apellido + día y mes de
    nacimiento. 'Kelvin Ivan' 'Rodriguez Zelada' '07-19' → 'KR1907'. Sin cumpleaños no hay ID."""
    first, last = _ascii(first_name).upper(), _ascii(last_name).upper()
    if not (first and last and birthday):
        return None
    month, day = birthday.split("-")
    return f"{first[0]}{last[0]}{day}{month}"


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
    # Código interno: ya no se usa ni se muestra (el de la planilla, «22 CN», se ignora); el
    # sistema lo genera solo porque la columna es obligatoria y única.
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, default=lambda: f"E-{uuid.uuid4().hex[:10].upper()}")
    # ID de usuario (ver user_code_base); se asigna una vez y no cambia si se corrige el nombre.
    user_code: Mapped[str | None] = mapped_column(String(16), unique=True, index=True)
    # ID con el que el empleado está registrado en el reloj de marcación.
    badge_number: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    # ID del agente en el CRM (los horarios llegan desde el CRM con este identificador).
    crm_agent_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    # Posición del agente en el último envío del CRM, que ya llega ordenado por equipo con el
    # supervisor primero. Sirve para listar dentro de cada equipo en el mismo orden.
    crm_order: Mapped[int | None] = mapped_column(Integer)
    # El rol del agente en el CRM es de supervisor (lo manda el CRM en cada envío).
    crm_supervisor: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
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
    # administrativo | operativo | ventas (ver area_for); RRHH puede cambiarla a mano.
    area: Mapped[str] = mapped_column(String(16), default="administrativo", server_default="administrativo", index=True)
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), index=True
    )
    hire_date: Mapped[date | None] = mapped_column(Date)
    termination_date: Mapped[date | None] = mapped_column(Date)
    base_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    pay_frequency: Mapped[PayFrequency] = mapped_column(
        Enum(PayFrequency, name="pay_frequency"), default=PayFrequency.quincenal
    )
    # Planilla de RRHH
    payroll_date: Mapped[date | None] = mapped_column(Date)  # ingreso a planilla
    birthday: Mapped[str | None] = mapped_column(String(5))  # MM-DD (la planilla no trae el año)
    gender: Mapped[str | None] = mapped_column(String(10))
    bank_account: Mapped[str | None] = mapped_column(String(30))
    locker: Mapped[str | None] = mapped_column(String(10))
    # Número de huella en cada reloj, p.ej. {"LA17": "26", "LA24 comedor": "89"}
    fingerprints: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    emergency_contact: Mapped[str | None] = mapped_column(String(200))
    termination_note: Mapped[str | None] = mapped_column(String(200))  # renuncia, despido…
    has_cv: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    has_contract: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    has_nda: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    has_memo: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
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

    @validates("first_name", "last_name")
    def _upper_name(self, _key, name: str) -> str:
        # RRHH maneja los nombres en mayúsculas, vengan del CRM, de la nómina o de la pantalla.
        return " ".join((name or "").split()).upper()

    @property
    def is_supervisor(self) -> bool:
        """Supervisor de su team: lo dice el rol del CRM o, si el CRM no lo marca, el cargo."""
        return self.crm_supervisor or "supervis" in _ascii(self.position or "")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"
