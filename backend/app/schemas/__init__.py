from datetime import date, datetime, time
from decimal import Decimal
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import EmployeeStatus, PayFrequency, Role
from app.services.zk_attlog import normalize_badge

T = TypeVar("T")


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int


# ---------- Auth / usuarios ----------


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class UserOut(ORM):
    id: int
    username: str
    full_name: str
    role: Role
    is_active: bool
    employee_id: int | None


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9._-]+$")
    full_name: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=8, max_length=128)
    role: Role = Role.empleado
    employee_id: int | None = None


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=160)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: Role | None = None
    is_active: bool | None = None
    employee_id: int | None = None


# ---------- Empleados ----------


class DepartmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class DepartmentOut(ORM):
    id: int
    name: str
    section: str  # residencial | lineas


class EmployeeBase(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    badge_number: str | None = Field(default=None, max_length=32)
    crm_agent_id: str | None = Field(default=None, max_length=64)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    dui: str | None = Field(default=None, pattern=r"^\d{8}-\d$")
    nit: str | None = Field(default=None, max_length=17)
    isss_number: str | None = Field(default=None, max_length=20)
    nup: str | None = Field(default=None, max_length=20)
    afp: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=20)
    position: str | None = Field(default=None, max_length=120)
    department_id: int | None = None
    hire_date: date | None = None
    termination_date: date | None = None
    base_salary: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    pay_frequency: PayFrequency = PayFrequency.quincenal
    status: EmployeeStatus = EmployeeStatus.activo

    @field_validator("badge_number", "crm_agent_id", "dui", "nit", "isss_number", "nup", "afp", "email",
                     "phone", "position", mode="before")
    @classmethod
    def _blank_to_none(cls, v):
        if isinstance(v, str) and not v.strip():
            return None
        return v.strip() if isinstance(v, str) else v

    @field_validator("badge_number")
    @classmethod
    def _normalize_badge(cls, v):
        return normalize_badge(v) if v else None


class EmployeeCreate(EmployeeBase):
    pass


class EmployeeUpdate(EmployeeBase):
    pass


class EmployeeOut(ORM, EmployeeBase):
    id: int
    full_name: str
    crm_order: int | None = None
    department: DepartmentOut | None


class EmployeeBrief(ORM):
    id: int
    code: str
    full_name: str
    badge_number: str | None


class RosterImportIn(BaseModel):
    text: str = Field(min_length=1, max_length=500_000)
    dry_run: bool = True


class RosterRowOut(BaseModel):
    line: int
    code: str | None
    first_name: str
    last_name: str
    position: str
    hire_date: date | None
    badge: str | None = None
    status: str  # nuevo | actualizar | sin_cambios | ambiguo
    note: str | None = None


class RosterErrorOut(BaseModel):
    line: int
    text: str
    message: str


class RosterImportOut(BaseModel):
    rows: list[RosterRowOut]
    errors: list[RosterErrorOut]
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    applied: bool = False


# ---------- Horarios ----------


class ShiftTemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    start_time: time
    end_time: time
    break_minutes: int = Field(default=60, ge=0, le=480)
    tolerance_minutes: int = Field(default=5, ge=0, le=120)
    color: str = Field(default="#06b6d4", pattern=r"^#[0-9a-fA-F]{6}$")
    is_active: bool = True

    @model_validator(mode="after")
    def _not_zero_length(self):
        if self.start_time == self.end_time:
            raise ValueError("La hora de inicio y fin no pueden ser iguales")
        return self


class ShiftTemplateOut(ORM, ShiftTemplateIn):
    id: int
    crosses_midnight: bool = False

    @model_validator(mode="after")
    def _crosses(self):
        self.crosses_midnight = self.end_time < self.start_time
        return self


class ShiftAssignmentOut(ORM):
    id: int
    employee_id: int
    work_date: date
    start_at: datetime
    end_at: datetime
    break_minutes: int
    tolerance_minutes: int
    template_id: int | None
    notes: str | None
    source: str


class BulkAssignIn(BaseModel):
    """Asigna un turno a varios empleados en un rango de fechas y días de la semana."""

    employee_ids: list[int] = Field(min_length=1, max_length=500)
    date_from: date
    date_to: date
    weekdays: list[int] = Field(default=[0, 1, 2, 3, 4, 5], description="0=lunes … 6=domingo")
    template_id: int | None = None
    start_time: time | None = None
    end_time: time | None = None
    break_minutes: int | None = Field(default=None, ge=0, le=480)
    tolerance_minutes: int | None = Field(default=None, ge=0, le=120)
    overwrite: bool = False
    notes: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _check(self):
        if self.date_to < self.date_from:
            raise ValueError("La fecha final es anterior a la inicial")
        if (self.date_to - self.date_from).days > 92:
            raise ValueError("El rango máximo es de 3 meses")
        if any(d < 0 or d > 6 for d in self.weekdays):
            raise ValueError("Días de semana inválidos")
        if self.template_id is None and (self.start_time is None or self.end_time is None):
            raise ValueError("Indique una plantilla de turno o la hora de inicio y fin")
        if self.template_id is None and self.start_time == self.end_time:
            raise ValueError("La hora de inicio y fin no pueden ser iguales")
        return self


class BulkAssignOut(BaseModel):
    created: int
    updated: int
    skipped: int


# ---------- Marcaciones ----------


class DeviceOut(ORM):
    id: int
    serial_number: str
    name: str
    location: str | None


class ImportBatchOut(ORM):
    id: int
    original_filename: str
    uploaded_at: datetime
    total_lines: int
    inserted: int
    already_present: int
    double_taps: int
    invalid_lines: int
    unknown_badges: int
    date_from: date | None
    date_to: date | None
    device: DeviceOut
    uploaded_by: UserOut | None


class PunchOut(ORM):
    id: int
    badge: str
    punched_at: datetime
    verify_mode: int
    work_code: int
    is_double_tap: bool
    employee: EmployeeBrief | None


class PunchLite(ORM):
    id: int
    punched_at: datetime
    is_double_tap: bool


class WorkDayOut(ORM):
    date: date
    shift: ShiftAssignmentOut | None
    punches: list[PunchLite]


class EmployeeScheduleOut(BaseModel):
    employee_id: int
    date_from: date
    date_to: date
    last_crm_sync_at: datetime | None
    days: list[WorkDayOut]


class UnmappedBadge(BaseModel):
    badge: str
    punches: int
    first_seen: datetime
    last_seen: datetime


class DashboardSummary(BaseModel):
    employees_active: int
    employees_without_badge: int
    unmapped_badges: int
    punches_today: int
    last_import: ImportBatchOut | None
    shifts_today: int
