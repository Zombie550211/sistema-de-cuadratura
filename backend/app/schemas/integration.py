from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.zk_attlog import normalize_badge

MAX_RANGE_DAYS = 31


class CrmShift(BaseModel):
    """Un día del horario de un agente. Si end < start el turno termina al día siguiente."""

    model_config = ConfigDict(extra="forbid")

    date: date
    start: time | None = None
    end: time | None = None
    break_minutes: int = Field(default=60, ge=0, le=480)
    rest_day: bool = False
    notes: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _check(self):
        if self.rest_day:
            return self
        if self.start is None or self.end is None:
            raise ValueError(f"{self.date}: indique start y end, o rest_day=true")
        if self.start == self.end:
            raise ValueError(f"{self.date}: start y end no pueden ser iguales")
        return self


class CrmAgent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    crm_agent_id: str = Field(min_length=1, max_length=64)
    badge_number: str | None = Field(default=None, max_length=32)
    # Solo para encontrar al agente en Empleados por nombre; no cambian la ficha.
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    campaign: str | None = Field(default=None, max_length=120)
    supervisor: str | None = Field(default=None, max_length=160)
    # Rol del usuario en el CRM ("Supervisor", "Agente"…): marca quién es el supervisor del team.
    role: str | None = Field(default=None, max_length=80)
    hire_date: date | None = None  # informativo: la fecha de ingreso la lleva Empleados
    shifts: list[CrmShift] = Field(default_factory=list, max_length=62)

    @field_validator("crm_agent_id")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("badge_number")
    @classmethod
    def _badge(cls, v):
        return normalize_badge(v) if v and v.strip() else None

    @model_validator(mode="after")
    def _unique_dates(self):
        dates = [s.date for s in self.shifts]
        if len(dates) != len(set(dates)):
            raise ValueError(f"Agente {self.crm_agent_id}: hay fechas repetidas")
        return self


class CrmSchedulePayload(BaseModel):
    """Horarios de un periodo (normalmente la semana siguiente). Para cada agente enviado,
    sus horarios del CRM dentro de [date_from, date_to] se reemplazan por los de este envío."""

    model_config = ConfigDict(extra="forbid")

    date_from: date
    date_to: date
    agents: list[CrmAgent] = Field(min_length=1, max_length=3000)
    # True = "agents" es la nómina COMPLETA del periodo: a quien ya estaba en Cuadratura con
    # ID de CRM y no viene, se le quitan sus turnos de origen CRM del periodo (los manuales
    # de RRHH se respetan). La ficha del empleado NO se da de baja: eso lo decide RRHH.
    roster_complete: bool = False

    @model_validator(mode="after")
    def _check(self):
        if self.date_to < self.date_from:
            raise ValueError("date_to es anterior a date_from")
        if (self.date_to - self.date_from).days >= MAX_RANGE_DAYS:
            raise ValueError(f"El periodo máximo es de {MAX_RANGE_DAYS} días")
        ids = [a.crm_agent_id for a in self.agents]
        if len(ids) != len(set(ids)):
            raise ValueError("Hay crm_agent_id repetidos")
        for agent in self.agents:
            for shift in agent.shifts:
                if not self.date_from <= shift.date <= self.date_to:
                    raise ValueError(
                        f"Agente {agent.crm_agent_id}: la fecha {shift.date} está fuera del periodo"
                    )
        return self


class AgentResult(BaseModel):
    crm_agent_id: str
    status: str  # ok | conflicto | error
    employee_id: int | None = None
    employee_created: bool = False  # siempre false: el CRM ya no crea empleados
    message: str | None = None
    conflict_dates: list[date] = []


class SyncResult(BaseModel):
    sync_id: int
    status: str
    date_from: date
    date_to: date
    agents_received: int
    employees_created: int
    shifts_created: int
    shifts_updated: int
    shifts_removed: int
    conflicts: int
    errors: int
    agents_released: int = 0  # agentes ausentes del envío cuyos turnos CRM se liberaron
    agents: list[AgentResult]


class ApiClientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    key_prefix: str
    is_active: bool
    last_used_at: datetime | None
    created_at: datetime


class ApiClientCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)


class ApiClientCreated(BaseModel):
    client: ApiClientOut
    api_key: str


class ApiClientUpdate(BaseModel):
    is_active: bool


class SyncOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    received_at: datetime
    date_from: date | None
    date_to: date | None
    status: str
    agents_received: int
    employees_created: int
    shifts_created: int
    shifts_updated: int
    shifts_removed: int
    conflicts: int
    errors: int
    client: ApiClientOut | None


class SyncDetail(SyncOut):
    details: dict | None
