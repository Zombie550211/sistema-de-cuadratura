from datetime import date, datetime, time, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, Admin, ApiClientDep
from app.core.config import get_settings
from app.core.security import generate_api_key, hash_api_key
from app.models.schedule import DAY_OFF_KINDS
from app.models import (
    ApiClient,
    Department,
    Employee,
    EmployeeStatus,
    IntegrationSync,
    ShiftAssignment,
    ShiftDayOff,
)
from app.schemas import Page
from app.schemas.integration import (
    ApiClientCreate,
    ApiClientCreated,
    ApiClientOut,
    ApiClientUpdate,
    CrmSchedulePayload,
    SyncDetail,
    SyncOut,
    SyncResult,
)
from app.services import audit, crm_push
from app.services.crm_sync import apply_schedules

router = APIRouter(prefix="/integrations", tags=["integraciones"])


# ---------- Endpoints que llama el CRM (clave API) ----------


@router.get("/crm/ping")
def crm_ping(client: ApiClientDep):
    """Para que el CRM verifique la conexión y su clave."""
    return {"ok": True, "cliente": client.name, "hora_servidor": datetime.now(get_settings().tz)}


@router.post("/crm/schedules", response_model=SyncResult)
def crm_schedules(
    payload: CrmSchedulePayload,
    db: DB,
    client: ApiClientDep,
    background: BackgroundTasks,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
):
    """Recibe los horarios de los agentes para un periodo (normalmente la semana siguiente)."""
    result = apply_schedules(db, payload, client, idempotency_key)
    background.add_task(crm_push.flush_in_background)  # vacaciones/compensatorios en conflicto
    return result


class CrmDayIn(BaseModel):
    """Un día de un empleado fijado desde el CRM (página Horarios)."""

    employee_id: int
    work_date: date
    # turno = start_time/end_time; un tipo de día sin turno; o «quitar» (dejarlo vacío).
    kind: Literal["turno", "quitar", *DAY_OFF_KINDS]
    start_time: time | None = None
    end_time: time | None = None
    break_minutes: int = Field(default=60, ge=0, le=480)
    notes: str | None = Field(default=None, max_length=500)
    # El supervisor solo puede asignar un día vacío: si ya tiene turno o día libre, 409.
    only_if_empty: bool = True
    by: str = Field(min_length=1, max_length=150)  # usuario del CRM, para la auditoría

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "turno" and (self.start_time is None or self.end_time is None or self.start_time == self.end_time):
            raise ValueError("Indique la hora de entrada y la de salida")
        return self


@router.post("/crm/schedule-day")
def crm_schedule_day(data: CrmDayIn, db: DB, client: ApiClientDep, background: BackgroundTasks):
    """Fija un día desde el CRM como lo haría RRHH aquí (turno «manual», día libre «rrhh»): el
    envío semanal del CRM no lo pisa, y la cola crm_outbox lo devuelve al horario del CRM."""
    emp = db.get(Employee, data.employee_id)
    if emp is None or emp.status != EmployeeStatus.activo:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    turno = db.scalar(
        select(ShiftAssignment).where(ShiftAssignment.employee_id == emp.id, ShiftAssignment.work_date == data.work_date)
    )
    libre = db.scalar(select(ShiftDayOff).where(ShiftDayOff.employee_id == emp.id, ShiftDayOff.work_date == data.work_date))
    if data.only_if_empty and (turno or libre):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Ese día ya tiene horario: solo administración (en el CRM) o RRHH (en Cuadratura) pueden cambiarlo",
        )

    tz = get_settings().tz
    if data.kind == "turno":
        start_at = datetime.combine(data.work_date, data.start_time, tz)
        end_at = datetime.combine(data.work_date, data.end_time, tz)
        if end_at <= start_at:  # turno nocturno: termina al día siguiente
            end_at += timedelta(days=1)
        # Shortday (4 h o menos): sin descanso, igual que en el CRM.
        brk = 0 if end_at - start_at <= timedelta(hours=4) else data.break_minutes
        values = dict(start_at=start_at, end_at=end_at, break_minutes=brk, template_id=None, notes=data.notes,
                      source="manual", sync_id=None, created_by_id=None)
        if turno is None:
            db.add(ShiftAssignment(employee_id=emp.id, work_date=data.work_date, **values))
        else:
            for k, v in values.items():
                setattr(turno, k, v)
        if libre is not None:
            db.delete(libre)
    else:
        if turno is not None:
            db.delete(turno)
        if data.kind == "quitar":
            if libre is not None:
                db.delete(libre)
        elif libre is None:
            db.add(ShiftDayOff(employee_id=emp.id, work_date=data.work_date, kind=data.kind, notes=data.notes, source="rrhh"))
        else:
            libre.kind, libre.notes, libre.source = data.kind, data.notes, "rrhh"

    audit.record(db, None, "horario_desde_crm", "shift_assignment", None,
                 {**data.model_dump(mode="json"), "cliente": client.name,
                  "antes": "turno" if turno else (libre.kind if libre else None)})
    crm_push.queue(db, [(emp.id, data.work_date)])
    db.commit()
    background.add_task(crm_push.flush_in_background)
    return {"ok": True}


@router.get("/crm/schedules-week")
def crm_schedules_week(db: DB, client: ApiClientDep, date_from: date):
    """Horarios de la semana tal como están aquí, para que el CRM los muestre (solo lectura).

    Devuelve todo el personal activo con su team y cargo, los turnos y los días sin turno de
    los 7 días desde `date_from` (se lleva al lunes). El CRM decide qué parte ve cada usuario.
    Las horas van en hora local, y `start_h`/`end_h` en horas desde la medianoche del día
    (un turno nocturno termina en más de 24)."""
    tz = get_settings().tz
    lunes = date_from - timedelta(days=date_from.weekday())
    domingo = lunes + timedelta(days=6)
    empleados = db.scalars(
        select(Employee)
        .outerjoin(Department, Employee.department_id == Department.id)
        .where(Employee.status == EmployeeStatus.activo)
        .order_by(*Employee.team_order())
    ).all()
    turnos = db.scalars(
        select(ShiftAssignment).where(ShiftAssignment.work_date.between(lunes, domingo))
    ).all()
    libres = db.scalars(select(ShiftDayOff).where(ShiftDayOff.work_date.between(lunes, domingo))).all()

    def horas(dia: date, instante: datetime) -> float:
        inicio = datetime.combine(dia, time.min, tzinfo=tz)
        return round((instante.astimezone(tz) - inicio).total_seconds() / 3600, 4)

    return {
        "date_from": lunes,
        "date_to": domingo,
        "today": datetime.now(tz).date(),
        "employees": [
            {
                "id": e.id,
                "full_name": e.full_name,
                "crm_agent_id": e.crm_agent_id,
                "team": e.department.name if e.department else None,
                "section": e.department.section if e.department else None,
                "is_supervisor": e.is_supervisor,
                "position": e.position,
                "area": e.area,
            }
            for e in empleados
        ],
        "assignments": [
            {
                "employee_id": a.employee_id,
                "work_date": a.work_date,
                "start": a.start_at.astimezone(tz).strftime("%H:%M"),
                "end": a.end_at.astimezone(tz).strftime("%H:%M"),
                "start_h": horas(a.work_date, a.start_at),
                "end_h": horas(a.work_date, a.end_at),
                "break_minutes": a.break_minutes,
                "template": a.template.name if a.template else None,
                "source": a.source,
                "notes": a.notes,
            }
            for a in turnos
        ],
        "days_off": [
            {"employee_id": d.employee_id, "work_date": d.work_date, "kind": d.kind, "notes": d.notes, "source": d.source}
            for d in libres
        ],
    }


# ---------- Administración (usuarios de la app) ----------


@router.get("/clients", response_model=list[ApiClientOut])
def list_clients(db: DB, _: Admin):
    return db.scalars(select(ApiClient).order_by(ApiClient.name)).all()


@router.post("/clients", response_model=ApiClientCreated, status_code=status.HTTP_201_CREATED)
def create_client(data: ApiClientCreate, db: DB, admin: Admin):
    key = generate_api_key()
    client = ApiClient(
        name=data.name.strip(),
        key_prefix=key[:10],
        key_hash=hash_api_key(key),
        created_by_id=admin.id,
    )
    db.add(client)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe una integración con ese nombre")
    audit.record(db, admin, "crear", "api_client", client.id, {"nombre": client.name})
    db.commit()
    return ApiClientCreated(client=ApiClientOut.model_validate(client), api_key=key)


@router.patch("/clients/{client_id}", response_model=ApiClientOut)
def update_client(client_id: int, data: ApiClientUpdate, db: DB, admin: Admin):
    client = db.get(ApiClient, client_id)
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Integración no encontrada")
    client.is_active = data.is_active
    audit.record(db, admin, "editar", "api_client", client.id, {"activo": data.is_active})
    db.commit()
    return client


@router.get("/syncs", response_model=Page[SyncOut])
def list_syncs(
    db: DB,
    _: HR,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    total = db.scalar(select(func.count()).select_from(IntegrationSync))
    items = db.scalars(
        select(IntegrationSync).order_by(IntegrationSync.received_at.desc()).limit(limit).offset(offset)
    ).all()
    return Page(items=items, total=total)


@router.get("/syncs/{sync_id}", response_model=SyncDetail)
def get_sync(sync_id: int, db: DB, _: HR):
    sync = db.get(IntegrationSync, sync_id)
    if sync is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Envío no encontrado")
    return sync
