"""Aplica los horarios que envía el CRM.

Empleados (la planilla) es la fuente oficial del personal: se registra a mano o con la nómina, y el
CRM solo manda horarios. Reglas:
- El agente se identifica por crm_agent_id. Si no existe se busca por ID de reloj; después por
  nombre entre los empleados sin ID de CRM (el CRM usa nombres cortos, p.ej. "Bryan Pleitez" para
  "Bryan Stanley Segovia Pleitez"). Si ninguno coincide exacto se tolera un error de escritura por
  palabra ("Robert" ~ "Roberto"), siempre que quede un solo empleado. Al encontrarlo se le guarda
  el ID de CRM.
- Si no está en Empleados, el agente se rechaza (error): el CRM no crea fichas. RRHH lo registra y
  el CRM lo reenvía.
- El CRM no cambia los datos de la ficha (nombre, fecha de ingreso, ID de reloj). El ID de reloj
  que manda solo se usa para encontrar al empleado, o se guarda si la ficha aún no tiene uno.
- El team sí lo manda el CRM ("MIGUEL NUÑEZ" → "Miguel Nuñez"), y el rol: si es de supervisor, el
  empleado se etiqueta como supervisor de su team.
- Sincronización en los dos sentidos: Horarios del CRM y de Cuadratura son iguales. Dentro del
  periodo enviado, el horario del agente queda como lo manda el CRM (una fecha sin turno o con
  rest_day=true queda libre), también si RRHH lo había cambiado aquí: esos cambios ya se le
  devolvieron al CRM (crm_push.py), así que si el CRM manda otra cosa es porque cambió después.
- Un descanso del CRM (rest_day) queda aquí como día libre con su tipo, igual que en /horarios.html:
  nota "Vacaciones" → vacación, "Incapacidad" → incapacidad, "Compensatorio" → compensatorio y
  cualquier otro → libre. Si el CRM lo quita, se quita aquí.
- Excepciones: un día que RRHH cambió y aún no llegó al CRM (está en la cola crm_outbox) no se
  toca; y una vacación, compensatorio o incapacidad que fijó RRHH no se pisa: se reporta como
  conflicto (si el CRM puso turno) y se le vuelve a enviar al CRM.
- El CRM manda los agentes ordenados por equipo (supervisor primero): esa posición se guarda en
  crm_order para listarlos igual aquí.
- Cada agente se aplica en su propio savepoint: un error en uno no bloquea a los demás.
"""

import unicodedata
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import ApiClient, Department, Employee, IntegrationSync, ShiftAssignment, ShiftDayOff
from app.models.schedule import PROTECTED_KINDS
from app.schemas.integration import AgentResult, CrmAgent, CrmSchedulePayload, SyncResult
from app.services import audit, crm_push
from app.services.attendance_import import relink_badge
from app.services.employee_roster import fix_case, name_key


def rest_kind(notes: str | None) -> str:
    """Tipo de día libre según la nota con la que el CRM marca el descanso."""
    n = (notes or "").strip().lower()
    if n in ("vacaciones", "vacación", "vacacion"):
        return "vacacion"
    if n in ("incapacidad", "compensatorio"):
        return n
    return "libre"


def is_supervisor_role(role: str) -> bool:
    """Misma regla que el CRM: un rol con 'supervisor' que no sea de administración ni backoffice."""
    r = unicodedata.normalize("NFD", role).encode("ascii", "ignore").decode().lower()
    return "supervisor" in r and not any(x in r for x in ("admin", "backoffice", "back office"))


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
            dept = Department(name=fix_case(name))
            db.add(dept)
            db.flush()
        cache[key] = dept
    return cache[key]


def _same_word(a: str, b: str) -> bool:
    """Misma palabra salvo un error de escritura (una letra de más, de menos o cambiada):
    "robert" ~ "roberto", "claros" ~ "claro", "abigal" ~ "abigail". Solo palabras de 4+ letras."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    short, long_ = sorted((a, b), key=len)
    return any(long_[:i] + long_[i + 1 :] == short for i in range(len(long_)))


def _name_matches(wanted: set[str], employees) -> list[Employee]:
    """Empleados cuyo nombre contiene todas las palabras del nombre del CRM. Si ninguno coincide
    exacto, se busca de nuevo tolerando un error de escritura por palabra."""
    keys = [(e, name_key(e.full_name)) for e in employees]
    exact = [e for e, key in keys if wanted <= key]
    if exact:
        return exact
    return [e for e, key in keys if all(any(_same_word(w, k) for k in key) for w in wanted)]


def _resolve_employee(db: Session, agent: CrmAgent) -> Employee:
    employee = db.scalar(select(Employee).where(Employee.crm_agent_id == agent.crm_agent_id))
    if employee is not None:
        return employee

    if agent.badge_number:
        employee = db.scalar(select(Employee).where(Employee.badge_number == agent.badge_number))
        if employee is not None:
            if employee.crm_agent_id:
                raise AgentError(
                    f"El ID de reloj {agent.badge_number} ya pertenece al agente del CRM "
                    f"{employee.crm_agent_id}"
                )
            employee.crm_agent_id = agent.crm_agent_id
            return employee

    nombre = " ".join(filter(None, [agent.first_name, agent.last_name])) or "sin nombre"
    wanted = name_key(nombre)
    if len(wanted) >= 2:
        # Todas las palabras del nombre del CRM deben estar en el nombre completo de la nómina;
        # si ninguno coincide exacto, se toleran diferencias de escritura (_same_word).
        free = db.scalars(select(Employee).where(Employee.crm_agent_id.is_(None))).all()
        matches = _name_matches(wanted, free)
        if len(matches) == 1:
            matches[0].crm_agent_id = agent.crm_agent_id
            return matches[0]
        if len(matches) > 1:
            raise AgentError(
                f"El nombre {nombre} coincide con varios empleados ({', '.join(f'{e.code} {e.full_name}' for e in matches)}): "
                "ponga el ID de CRM en la ficha del empleado correcto"
            )
        linked = _name_matches(wanted, db.scalars(select(Employee).where(Employee.crm_agent_id.is_not(None))).all())
        if linked:
            raise AgentError(
                f"El agente {nombre} coincide con "
                f"{', '.join(f'{e.code} {e.full_name} (ID de CRM {e.crm_agent_id})' for e in linked)}, "
                f"que ya está enlazado a otro agente del CRM: si es la misma persona, cambie el ID de CRM "
                f"de la ficha a {agent.crm_agent_id}"
            )

    raise AgentError(
        f"El agente {nombre} no está en Empleados: regístrelo en la planilla (con su ID de reloj o "
        "su nombre completo) y vuelva a enviar el horario"
    )


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
    employee = _resolve_employee(db, agent)

    # La ficha manda: el ID de reloj del CRM solo se guarda si el empleado aún no tiene uno.
    if agent.badge_number and not employee.badge_number:
        owner = db.scalar(select(Employee).where(Employee.badge_number == agent.badge_number))
        if owner is not None and owner.id != employee.id:
            raise AgentError(
                f"El ID de reloj {agent.badge_number} ya está asignado a {owner.full_name} ({owner.code})"
            )
        employee.badge_number = agent.badge_number
        db.flush()
        relink_badge(db, employee.id, None, agent.badge_number)

    if agent.campaign:
        employee.department_id = _department(db, departments, agent.campaign).id
    employee.crm_order = position
    if agent.role is not None:
        employee.crm_supervisor = is_supervisor_role(agent.role)

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
    days_off = {
        d.work_date: d
        for d in db.scalars(
            select(ShiftDayOff).where(
                ShiftDayOff.employee_id == employee.id,
                ShiftDayOff.work_date >= payload.date_from,
                ShiftDayOff.work_date <= payload.date_to,
            )
        )
    }
    pending = crm_push.pending(db, employee.id, payload.date_from, payload.date_to)
    wanted = {s.date: s for s in agent.shifts if not s.rest_day}
    rest = {s.date: s for s in agent.shifts if s.rest_day}
    conflicts = []

    def protected(off: ShiftDayOff | None) -> bool:
        return off is not None and off.source == "rrhh" and off.kind in PROTECTED_KINDS

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
        off = days_off.get(day)
        if day in pending:
            continue
        if protected(off):
            conflicts.append(day)
            crm_push.queue(db, [(employee.id, day)])
            continue
        if off is not None:  # día libre (del CRM o de RRHH ya entregado): ahora el CRM pone turno
            db.delete(off)
        if current is None:
            db.add(ShiftAssignment(employee_id=employee.id, work_date=day, **values))
            counters.created += 1
        elif current.source != "crm" or (current.start_at, current.end_at, current.break_minutes, current.notes) != (
            start_at,
            end_at,
            shift.break_minutes,
            shift.notes,
        ):
            for k, v in values.items():
                setattr(current, k, v)
            counters.updated += 1

    # Descansos del CRM: día libre, vacación o incapacidad, igual que en el CRM.
    for day, shift in rest.items():
        if day in pending:
            continue
        kind = rest_kind(shift.notes)
        notes = shift.notes if kind == "libre" else None
        off = days_off.get(day)
        if protected(off):
            if off.kind != kind:
                crm_push.queue(db, [(employee.id, day)])
        elif off is None:
            db.add(ShiftDayOff(employee_id=employee.id, work_date=day, kind=kind, notes=notes, source="crm"))
        elif (off.kind, off.notes, off.source) != (kind, notes, "crm"):
            off.kind, off.notes, off.source = kind, notes, "crm"

    # Días libres que vinieron del CRM y el CRM ya no manda: se quitan.
    for day, off in days_off.items():
        if off.source == "crm" and day not in rest and day not in wanted and day not in pending:
            db.delete(off)

    # Lo que el CRM ya no manda (o marcó como libre) se quita, salvo lo que aún va hacia el CRM.
    for day, current in existing.items():
        if day not in wanted and day not in pending:
            db.delete(current)
            counters.removed += 1

    db.flush()
    return AgentResult(
        crm_agent_id=agent.crm_agent_id,
        status="conflicto" if conflicts else "ok",
        employee_id=employee.id,
        employee_created=False,
        message=(
            "Estas fechas son vacación, compensatorio o incapacidad fijados por RRHH: no se puso turno y se le reenviaron al CRM"
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
