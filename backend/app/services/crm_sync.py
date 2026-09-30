"""Aplica los horarios que envía el CRM.

Reglas:
- El agente se identifica por crm_agent_id. Si no existe se busca por ID de reloj; después por
  nombre entre los empleados de la nómina sin ID de CRM (el CRM usa nombres cortos, p.ej.
  "Bryan Pleitez" para "Bryan Stanley Segovia Pleitez"); si tampoco, se crea el empleado.
- El ID de reloj que manda el CRM es el que vale: se actualiza en el empleado y sus marcas se re-vinculan.
- El nombre también: si llegan first_name y last_name y son distintos, se actualizan en el empleado
  (el CRM guarda el nombre legal completo de cada agente). Igual la fecha de ingreso (hire_date).
- Dentro del periodo enviado, los horarios con origen 'crm' del agente se reemplazan por los del envío
  (una fecha sin turno o con rest_day=true queda libre).
- Un horario cargado a mano por RRHH ('manual') nunca se pisa: se reporta como conflicto.
- El CRM manda los agentes ordenados por equipo (supervisor primero): esa posición se guarda en
  crm_order para listarlos igual aquí.
- Cada agente se aplica en su propio savepoint: un error en uno no bloquea a los demás.
"""

from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import ApiClient, Department, Employee, IntegrationSync, ShiftAssignment
from app.schemas.integration import AgentResult, CrmAgent, CrmSchedulePayload, SyncResult
from app.services import audit
from app.services.attendance_import import relink_badge
from app.services.employee_roster import name_key


class AgentError(Exception):
    pass


class _Counters:
    def __init__(self):
        self.created = self.updated = self.removed = self.employees_created = 0


def _department(db: Session, cache: dict[str, Department], name: str) -> Department:
    key = name.strip().lower()
    if key not in cache:
        dept = db.scalar(select(Department).where(Department.name.ilike(name.strip())))
        if dept is None:
            dept = Department(name=name.strip())
            db.add(dept)
            db.flush()
        cache[key] = dept
    return cache[key]


def _resolve_employee(db: Session, agent: CrmAgent) -> tuple[Employee, bool]:
    employee = db.scalar(select(Employee).where(Employee.crm_agent_id == agent.crm_agent_id))
    if employee is not None:
        return employee, False

    if agent.badge_number:
        employee = db.scalar(select(Employee).where(Employee.badge_number == agent.badge_number))
        if employee is not None:
            if employee.crm_agent_id:
                raise AgentError(
                    f"El ID de reloj {agent.badge_number} ya pertenece al agente del CRM "
                    f"{employee.crm_agent_id}"
                )
            employee.crm_agent_id = agent.crm_agent_id
            return employee, False

    wanted = name_key(f"{agent.first_name or ''} {agent.last_name or ''}")
    if len(wanted) >= 2:
        # Todas las palabras del nombre del CRM deben estar en el nombre completo de la nómina.
        matches = [
            e
            for e in db.scalars(select(Employee).where(Employee.crm_agent_id.is_(None)))
            if wanted <= name_key(e.full_name)
        ]
        if len(matches) == 1:
            matches[0].crm_agent_id = agent.crm_agent_id
            return matches[0], False
        if len(matches) > 1:
            raise AgentError(
                f"El nombre coincide con varios empleados ({', '.join(f'{e.code} {e.full_name}' for e in matches)}): "
                "ponga el ID de CRM en la ficha del empleado correcto"
            )

    if not (agent.first_name and agent.last_name):
        raise AgentError("Agente nuevo: se requieren first_name y last_name para crearlo")
    code = f"CRM-{agent.crm_agent_id}"[:32]
    if db.scalar(select(Employee.id).where(Employee.code == code)):
        raise AgentError(f"Ya existe un empleado con código {code}")
    employee = Employee(
        code=code,
        crm_agent_id=agent.crm_agent_id,
        first_name=agent.first_name.strip(),
        last_name=agent.last_name.strip(),
    )
    db.add(employee)
    db.flush()
    return employee, True


def _apply_agent(
    db: Session,
    agent: CrmAgent,
    payload: CrmSchedulePayload,
    sync: IntegrationSync,
    counters: _Counters,
    departments: dict[str, Department],
    position: int,
) -> AgentResult:
    tz = get_settings().tz
    employee, created = _resolve_employee(db, agent)

    if not created and agent.first_name and agent.last_name:
        nombre, apellido = agent.first_name.strip(), agent.last_name.strip()
        if (employee.first_name, employee.last_name) != (nombre, apellido):
            employee.first_name, employee.last_name = nombre, apellido
    if agent.hire_date and employee.hire_date != agent.hire_date:
        employee.hire_date = agent.hire_date

    if agent.badge_number and agent.badge_number != employee.badge_number:
        owner = db.scalar(select(Employee).where(Employee.badge_number == agent.badge_number))
        if owner is not None and owner.id != employee.id:
            raise AgentError(
                f"El ID de reloj {agent.badge_number} ya está asignado a {owner.full_name} ({owner.code})"
            )
        old = employee.badge_number
        employee.badge_number = agent.badge_number
        db.flush()
        relink_badge(db, employee.id, old, agent.badge_number)

    if agent.campaign:
        employee.department_id = _department(db, departments, agent.campaign).id
    employee.crm_order = position

    existing = {
        a.work_date: a
        for a in db.scalars(
            select(ShiftAssignment).where(
                ShiftAssignment.employee_id == employee.id,
                ShiftAssignment.work_date >= payload.date_from,
                ShiftAssignment.work_date <= payload.date_to,
            )
        )
    }
    wanted = {s.date: s for s in agent.shifts if not s.rest_day}
    conflicts = []

    for day, shift in sorted(wanted.items()):
        start_at = datetime.combine(day, shift.start, tz)
        end_at = datetime.combine(day, shift.end, tz)
        if end_at <= start_at:
            end_at += timedelta(days=1)
        values = dict(
            start_at=start_at,
            end_at=end_at,
            break_minutes=shift.break_minutes,
            notes=shift.notes,
            source="crm",
            sync_id=sync.id,
            template_id=None,
        )
        current = existing.get(day)
        if current is None:
            db.add(ShiftAssignment(employee_id=employee.id, work_date=day, **values))
            counters.created += 1
        elif current.source != "crm":
            conflicts.append(day)
        elif (current.start_at, current.end_at, current.break_minutes, current.notes) != (
            start_at,
            end_at,
            shift.break_minutes,
            shift.notes,
        ):
            for k, v in values.items():
                setattr(current, k, v)
            counters.updated += 1

    # Lo que el CRM ya no manda (o marcó como libre) se quita, solo si vino del CRM.
    for day, current in existing.items():
        if day not in wanted and current.source == "crm":
            db.delete(current)
            counters.removed += 1

    db.flush()
    if created:
        counters.employees_created += 1
    return AgentResult(
        crm_agent_id=agent.crm_agent_id,
        status="conflicto" if conflicts else "ok",
        employee_id=employee.id,
        employee_created=created,
        message=(
            "Estas fechas tienen un horario cargado manualmente por RRHH y no se modificaron"
            if conflicts
            else None
        ),
        conflict_dates=conflicts,
    )


def _release_absent(db: Session, payload: CrmSchedulePayload) -> tuple[int, int]:
    """Con roster_complete: quita los turnos de origen CRM del periodo a los empleados con
    ID de CRM que no vinieron en el envío (p.ej. salieron de un equipo de venta)."""
    sent = {a.crm_agent_id for a in payload.agents}
    rows = db.execute(
        select(ShiftAssignment.id, ShiftAssignment.employee_id)
        .join(Employee, Employee.id == ShiftAssignment.employee_id)
        .where(
            Employee.crm_agent_id.is_not(None),
            Employee.crm_agent_id.not_in(sent),
            ShiftAssignment.source == "crm",
            ShiftAssignment.work_date >= payload.date_from,
            ShiftAssignment.work_date <= payload.date_to,
        )
    ).all()
    if rows:
        db.execute(delete(ShiftAssignment).where(ShiftAssignment.id.in_([r.id for r in rows])))
    return len({r.employee_id for r in rows}), len(rows)


def apply_schedules(
    db: Session,
    payload: CrmSchedulePayload,
    client: ApiClient,
    idempotency_key: str | None = None,
) -> SyncResult:
    if idempotency_key:
        previous = db.scalar(
            select(IntegrationSync).where(IntegrationSync.idempotency_key == idempotency_key)
        )
        if previous is not None and previous.details and "result" in previous.details:
            return SyncResult.model_validate(previous.details["result"])

    sync = IntegrationSync(
        client_id=client.id,
        kind="schedules",
        idempotency_key=idempotency_key,
        date_from=payload.date_from,
        date_to=payload.date_to,
        status="procesando",
        agents_received=len(payload.agents),
    )
    db.add(sync)
    db.flush()

    counters = _Counters()
    departments: dict[str, Department] = {}
    results: list[AgentResult] = []
    for position, agent in enumerate(payload.agents):
        savepoint = db.begin_nested()
        snapshot = (counters.created, counters.updated, counters.removed, counters.employees_created)
        try:
            results.append(_apply_agent(db, agent, payload, sync, counters, departments, position))
            savepoint.commit()
        except AgentError as exc:
            savepoint.rollback()
            (counters.created, counters.updated, counters.removed, counters.employees_created) = snapshot
            departments.clear()  # pudo quedar un departamento revertido en caché
            results.append(AgentResult(crm_agent_id=agent.crm_agent_id, status="error", message=str(exc)))

    agents_released = 0
    if payload.roster_complete:
        agents_released, removed = _release_absent(db, payload)
        counters.removed += removed

    errors = sum(r.status == "error" for r in results)
    conflicts = sum(len(r.conflict_dates) for r in results)
    status = "error" if errors == len(results) else "parcial" if errors or conflicts else "ok"

    result = SyncResult(
        sync_id=sync.id,
        status=status,
        date_from=payload.date_from,
        date_to=payload.date_to,
        agents_received=len(payload.agents),
        employees_created=counters.employees_created,
        shifts_created=counters.created,
        shifts_updated=counters.updated,
        shifts_removed=counters.removed,
        conflicts=conflicts,
        errors=errors,
        agents_released=agents_released,
        agents=results,
    )
    sync.status = status
    sync.employees_created = counters.employees_created
    sync.shifts_created = counters.created
    sync.shifts_updated = counters.updated
    sync.shifts_removed = counters.removed
    sync.conflicts = conflicts
    sync.errors = errors
    sync.details = {"result": result.model_dump(mode="json")}
    audit.record(
        db,
        None,
        "sincronizar",
        "integration_sync",
        sync.id,
        {"cliente": client.name, "estado": status, "agentes": len(payload.agents)},
    )
    db.commit()
    return result
