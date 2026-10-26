from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, Staff
from app.core.config import get_settings
from app.models import Employee, EmployeeStatus, Holiday, HolidayWorker, ShiftAssignment, ShiftDayOff, ShiftTemplate, VacationPeriod
from app.schemas import (
    BulkAssignIn,
    BulkAssignOut,
    CompensatoryStatusOut,
    HolidayIn,
    HolidayWorkersIn,
    HolidayOut,
    ShiftAssignmentOut,
    LeaveBulkIn,
    LeaveBulkOut,
    ShiftDayOffIn,
    ShiftDayOffOut,
    ShiftDayOffUpdateIn,
    ShiftTemplateIn,
    ShiftTemplateOut,
    ShiftUpdateIn,
    VacationPeriodIn,
    VacationPeriodOut,
    VacationStatusOut,
)
from app.services import audit, compensatory, crm_push
from app.services.compensatory import START as COMP_START
from app.services.compensatory import compensatory_status, data_years, ensure_years
from app.services.vacations import PeriodRecord, anniversary, completed_years, vacation_status

router = APIRouter(prefix="/schedules", tags=["horarios"])


@router.get("/templates", response_model=list[ShiftTemplateOut])
def list_templates(db: DB, _: Staff, include_inactive: bool = False):
    stmt = select(ShiftTemplate).order_by(ShiftTemplate.start_time)
    if not include_inactive:
        stmt = stmt.where(ShiftTemplate.is_active.is_(True))
    return db.scalars(stmt).all()


@router.post("/templates", response_model=ShiftTemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(data: ShiftTemplateIn, db: DB, user: HR):
    template = ShiftTemplate(**data.model_dump())
    db.add(template)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe un turno con ese nombre")
    audit.record(db, user, "crear", "shift_template", template.id, {"nombre": template.name})
    db.commit()
    return template


@router.put("/templates/{template_id}", response_model=ShiftTemplateOut)
def update_template(template_id: int, data: ShiftTemplateIn, db: DB, user: HR):
    template = db.get(ShiftTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Turno no encontrado")
    for field, value in data.model_dump().items():
        setattr(template, field, value)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe un turno con ese nombre")
    # Los horarios ya asignados no cambian: se copiaron al asignar.
    audit.record(db, user, "editar", "shift_template", template.id, data.model_dump(mode="json"))
    db.commit()
    return template


@router.get("/assignments", response_model=list[ShiftAssignmentOut])
def list_assignments(
    db: DB,
    _: Staff,
    date_from: date,
    date_to: date,
    employee_id: Annotated[list[int] | None, Query()] = None,
):
    if date_to < date_from or (date_to - date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    stmt = select(ShiftAssignment).where(
        ShiftAssignment.work_date >= date_from, ShiftAssignment.work_date <= date_to
    )
    if employee_id:
        stmt = stmt.where(ShiftAssignment.employee_id.in_(employee_id))
    return db.scalars(stmt.order_by(ShiftAssignment.work_date)).all()


@router.post("/assignments/bulk", response_model=BulkAssignOut)
def bulk_assign(data: BulkAssignIn, db: DB, user: HR, background: BackgroundTasks):
    tz = get_settings().tz
    start_time, end_time = data.start_time, data.end_time
    break_minutes, tolerance = data.break_minutes, data.tolerance_minutes
    if data.template_id is not None:
        template = db.get(ShiftTemplate, data.template_id)
        if template is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Turno no encontrado")
        start_time = start_time or template.start_time
        end_time = end_time or template.end_time
        break_minutes = template.break_minutes if break_minutes is None else break_minutes
        tolerance = template.tolerance_minutes if tolerance is None else tolerance
    break_minutes = 60 if break_minutes is None else break_minutes
    tolerance = 5 if tolerance is None else tolerance

    employee_ids = set(data.employee_ids)
    found = set(db.scalars(select(Employee.id).where(Employee.id.in_(employee_ids))).all())
    if missing := employee_ids - found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Empleados no encontrados: {sorted(missing)}")

    existing = {
        (a.employee_id, a.work_date): a
        for a in db.scalars(
            select(ShiftAssignment).where(
                ShiftAssignment.employee_id.in_(employee_ids),
                ShiftAssignment.work_date >= data.date_from,
                ShiftAssignment.work_date <= data.date_to,
            )
        )
    }

    days_off = {
        (d.employee_id, d.work_date): d
        for d in db.scalars(
            select(ShiftDayOff).where(
                ShiftDayOff.employee_id.in_(employee_ids),
                ShiftDayOff.work_date >= data.date_from,
                ShiftDayOff.work_date <= data.date_to,
            )
        )
    }

    created = updated = skipped = 0
    touched: list[tuple[int, date]] = []
    day = data.date_from
    while day <= data.date_to:
        if day.weekday() in data.weekdays:
            start_at = datetime.combine(day, start_time, tz)
            end_at = datetime.combine(day, end_time, tz)
            if end_at <= start_at:  # turno nocturno: termina al día siguiente
                end_at += timedelta(days=1)
            values = dict(
                start_at=start_at,
                end_at=end_at,
                break_minutes=break_minutes,
                tolerance_minutes=tolerance,
                template_id=data.template_id,
                notes=data.notes,
                source="manual",
                sync_id=None,
                created_by_id=user.id,
            )
            for emp_id in employee_ids:
                current = existing.get((emp_id, day))
                if current is None:
                    db.add(ShiftAssignment(employee_id=emp_id, work_date=day, **values))
                    created += 1
                elif data.overwrite:
                    for k, v in values.items():
                        setattr(current, k, v)
                    updated += 1
                else:
                    skipped += 1
                    continue
                touched.append((emp_id, day))
                if off := days_off.get((emp_id, day)):  # asignar turno quita el día libre
                    db.delete(off)
        day += timedelta(days=1)

    audit.record(
        db,
        user,
        "asignar",
        "shift_assignment",
        None,
        {**data.model_dump(mode="json"), "creados": created, "actualizados": updated},
    )
    crm_push.queue(db, touched)
    db.commit()
    background.add_task(crm_push.flush_in_background)
    return BulkAssignOut(created=created, updated=updated, skipped=skipped)


def _day_off(db: DB, employee_id: int, day: date, user, notes: str | None = None, kind: str = "libre") -> ShiftDayOff:
    off = db.scalar(select(ShiftDayOff).where(ShiftDayOff.employee_id == employee_id, ShiftDayOff.work_date == day))
    if off is None:
        off = ShiftDayOff(employee_id=employee_id, work_date=day, kind=kind, notes=notes, created_by_id=user.id)
        db.add(off)
    else:
        # Otro compensatorio el mismo día: se suma a los asuetos que ya usaba (un día puede usar dos).
        if kind == off.kind == "compensatorio" and notes and compensatory.tags(off.notes):
            notes = " · ".join([off.notes, *(n for n in notes.split(" · ") if n not in off.notes)])
        off.kind, off.source = kind, "rrhh"
        if notes is not None:
            off.notes = notes
    return off


@router.put("/assignments/{assignment_id}", response_model=ShiftAssignmentOut)
def reschedule(assignment_id: int, data: ShiftUpdateIn, db: DB, user: HR, background: BackgroundTasks):
    """Cambia la fecha y/o las horas de un turno; el cambio se devuelve al CRM."""
    assignment = db.get(ShiftAssignment, assignment_id)
    if assignment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Horario no encontrado")
    old_date, old_start, old_end = assignment.work_date, assignment.start_at, assignment.end_at
    if data.work_date != old_date and db.scalar(
        select(ShiftAssignment.id).where(
            ShiftAssignment.employee_id == assignment.employee_id, ShiftAssignment.work_date == data.work_date
        )
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "El empleado ya tiene turno ese día; quítelo o reagéndelo primero")

    tz = get_settings().tz
    start_at = datetime.combine(data.work_date, data.start_time, tz)
    end_at = datetime.combine(data.work_date, data.end_time, tz)
    if end_at <= start_at:  # turno nocturno: termina al día siguiente
        end_at += timedelta(days=1)
    assignment.work_date, assignment.start_at, assignment.end_at = data.work_date, start_at, end_at
    assignment.break_minutes, assignment.tolerance_minutes = data.break_minutes, data.tolerance_minutes
    assignment.notes = data.notes
    assignment.source, assignment.sync_id, assignment.created_by_id = "manual", None, user.id
    tpl = assignment.template
    if tpl is None or (tpl.start_time, tpl.end_time) != (data.start_time, data.end_time):
        assignment.template_id = None  # con otras horas ya no es ese turno base

    db.execute(delete(ShiftDayOff).where(ShiftDayOff.employee_id == assignment.employee_id, ShiftDayOff.work_date == data.work_date))
    if data.work_date != old_date:
        _day_off(db, assignment.employee_id, old_date, user, f"Turno reagendado al {data.work_date:%d/%m/%Y}")

    audit.record(
        db,
        user,
        "reagendar",
        "shift_assignment",
        assignment.id,
        {
            "empleado": assignment.employee_id,
            "antes": {"fecha": old_date.isoformat(), "inicio": old_start.isoformat(), "fin": old_end.isoformat()},
            "despues": {"fecha": data.work_date.isoformat(), "inicio": start_at.isoformat(), "fin": end_at.isoformat()},
        },
    )
    crm_push.queue(db, [(assignment.employee_id, old_date), (assignment.employee_id, data.work_date)])
    db.commit()
    background.add_task(crm_push.flush_in_background)
    db.refresh(assignment)
    return assignment


@router.get("/days-off", response_model=list[ShiftDayOffOut])
def list_days_off(
    db: DB,
    _: Staff,
    date_from: date,
    date_to: date,
    kind: Annotated[str | None, Query(pattern="^(libre|vacacion|compensatorio|incapacidad|suspendido|baja)$")] = None,
):
    """Días sin turno fijados por RRHH. Filtrando por tipo (vacación o compensatorio) se puede
    pedir hasta un año completo, para las secciones de Vacaciones y Compensatorios."""
    max_days = 366 if kind else 93
    if date_to < date_from or (date_to - date_from).days > max_days:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido")
    stmt = select(ShiftDayOff).where(ShiftDayOff.work_date >= date_from, ShiftDayOff.work_date <= date_to)
    if kind:
        stmt = stmt.where(ShiftDayOff.kind == kind)
    return db.scalars(stmt.order_by(ShiftDayOff.work_date)).all()


def _active_employees(db: DB, area: str | None) -> list[Employee]:
    stmt = select(Employee).where(Employee.status == EmployeeStatus.activo)
    if area:
        stmt = stmt.where(Employee.area == area)
    return list(db.scalars(stmt).all())


def _vacation_out(status) -> dict:
    return dict(
        hire_date=status.hire_date,
        years=status.years,
        next_date=status.next_date,
        periods=[VacationPeriodOut(start=p.start, end=p.end, rested=p.rested, worked=p.worked, settled=p.settled, notes=p.notes, pending=p.pending) for p in status.periods],
        extra=status.extra,
        pending=status.pending,
    )


@router.get("/vacations", response_model=list[VacationStatusOut])
def list_vacations(db: DB, _: Staff, area: Annotated[str | None, Query(max_length=16)] = None):
    """Vacaciones de los empleados activos, calculadas desde la fecha de ingreso: un período de
    15 días por año cumplido, con los días descansados, los trabajados y los pendientes."""
    today = datetime.now(get_settings().tz).date()
    employees = _active_employees(db, area)
    ids = [e.id for e in employees]
    rested: dict[int, list[date]] = {}
    for emp_id, day in db.execute(
        select(ShiftDayOff.employee_id, ShiftDayOff.work_date).where(ShiftDayOff.kind == "vacacion", ShiftDayOff.employee_id.in_(ids))
    ):
        rested.setdefault(emp_id, []).append(day)
    records: dict[int, dict[date, PeriodRecord]] = {}
    for r in db.scalars(select(VacationPeriod).where(VacationPeriod.employee_id.in_(ids))):
        records.setdefault(r.employee_id, {})[r.period_start] = PeriodRecord(r.worked_days, r.settled, r.notes)
    return [
        VacationStatusOut(employee_id=e.id, **_vacation_out(vacation_status(e.hire_date, today, rested.get(e.id, []), records.get(e.id))))
        for e in employees
    ]


@router.put("/vacations/{employee_id}/periods/{period_start}", status_code=status.HTTP_204_NO_CONTENT)
def save_vacation_period(employee_id: int, period_start: date, data: VacationPeriodIn, db: DB, user: HR):
    """Anota cuántos días del período trabajó el empleado, o lo cierra como completo."""
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    today = datetime.now(get_settings().tz).date()
    if employee.hire_date is None or period_start not in {
        anniversary(employee.hire_date, n) for n in range(1, completed_years(employee.hire_date, today) + 1)
    }:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ese período de vacaciones no existe para el empleado")
    record = db.scalar(select(VacationPeriod).where(VacationPeriod.employee_id == employee_id, VacationPeriod.period_start == period_start))
    if record is None:
        record = VacationPeriod(employee_id=employee_id, period_start=period_start)
        db.add(record)
    record.worked_days, record.settled, record.notes = data.worked_days, data.settled, data.notes
    db.flush()
    audit.record(db, user, "vacaciones", "vacation_period", record.id, {"empleado": employee_id, "periodo": period_start.isoformat(), **data.model_dump()})
    db.commit()


@router.get("/holidays", response_model=list[HolidayOut])
def list_holidays(db: DB, _: Staff, year: Annotated[int, Query(ge=2000, le=2100)]):
    """Asuetos del año. La primera vez se cargan los nacionales; RRHH agrega o quita los demás."""
    ensure_years(db, range(year, year + 1))
    db.commit()
    return db.scalars(select(Holiday).where(Holiday.day >= date(year, 1, 1), Holiday.day <= date(year, 12, 31)).order_by(Holiday.day)).all()


@router.post("/holidays", response_model=HolidayOut, status_code=status.HTTP_201_CREATED)
def create_holiday(data: HolidayIn, db: DB, user: HR):
    ensure_years(db, range(data.day.year, data.day.year + 1))
    if db.scalar(select(Holiday).where(Holiday.day == data.day)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese día ya es asueto")
    holiday = Holiday(day=data.day, name=data.name.strip())
    db.add(holiday)
    db.flush()
    audit.record(db, user, "crear", "holiday", holiday.id, {"fecha": data.day.isoformat(), "nombre": holiday.name})
    db.commit()
    return holiday


@router.get("/holidays/{holiday_id}/workers", response_model=list[int])
def holiday_workers(holiday_id: int, db: DB, _: Staff):
    """Quiénes anotó RRHH que trabajaron un asueto anterior a las marcaciones."""
    return db.scalars(select(HolidayWorker.employee_id).where(HolidayWorker.holiday_id == holiday_id)).all()


@router.put("/holidays/{holiday_id}/workers", response_model=list[int])
def set_holiday_workers(holiday_id: int, data: HolidayWorkersIn, db: DB, user: HR):
    """Anota quién trabajó el asueto: a esas personas les cuenta como compensatorio ganado."""
    holiday = db.get(Holiday, holiday_id)
    if holiday is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asueto no encontrado")
    if holiday.day >= COMP_START:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Este asueto se cuenta con las marcaciones del reloj, no a mano."
        )
    ids = set(data.employee_ids)
    if missing := ids - set(db.scalars(select(Employee.id).where(Employee.id.in_(ids)))):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Empleados no encontrados: {sorted(missing)}")
    db.execute(delete(HolidayWorker).where(HolidayWorker.holiday_id == holiday_id))
    db.add_all(HolidayWorker(holiday_id=holiday_id, employee_id=i) for i in ids)
    audit.record(db, user, "trabajaron_asueto", "holiday", holiday_id, {"fecha": holiday.day.isoformat(), "empleados": len(ids)})
    db.commit()
    return sorted(ids)


@router.delete("/holidays/{holiday_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_holiday(holiday_id: int, db: DB, user: HR):
    holiday = db.get(Holiday, holiday_id)
    if holiday is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asueto no encontrado")
    audit.record(db, user, "eliminar", "holiday", holiday.id, {"fecha": holiday.day.isoformat(), "nombre": holiday.name})
    db.delete(holiday)
    db.commit()


@router.get("/compensatory", response_model=list[CompensatoryStatusOut])
def list_compensatory(db: DB, _: Staff, area: Annotated[str | None, Query(max_length=16)] = None):
    """Compensatorios de los empleados activos, calculados de las marcaciones en los asuetos."""
    today = datetime.now(get_settings().tz).date()
    ensure_years(db, data_years(db, today))
    db.commit()
    return [
        CompensatoryStatusOut(employee_id=s.employee_id, earned=s.earned, lost=s.lost, taken=s.taken, available=s.available, balance=s.balance)
        for s in compensatory_status(db, _active_employees(db, area), today)
    ]


@router.post("/days-off", response_model=ShiftDayOffOut, status_code=status.HTTP_201_CREATED)
def set_day_off(data: ShiftDayOffIn, db: DB, user: HR, background: BackgroundTasks):
    """Da el día libre: quita el turno de ese día (si hay) y el CRM ya no lo vuelve a poner."""
    if db.get(Employee, data.employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    removed = db.scalar(
        select(ShiftAssignment).where(ShiftAssignment.employee_id == data.employee_id, ShiftAssignment.work_date == data.work_date)
    )
    if removed is not None:
        db.delete(removed)
    off = _day_off(db, data.employee_id, data.work_date, user, data.notes, data.kind)
    db.flush()
    audit.record(
        db,
        user,
        "dia_libre",
        "shift_day_off",
        off.id,
        {
            "empleado": data.employee_id,
            "fecha": data.work_date.isoformat(),
            "tipo": data.kind,
            "turno_quitado": f"{removed.start_at.isoformat()} – {removed.end_at.isoformat()}" if removed else None,
        },
    )
    crm_push.queue(db, [(data.employee_id, data.work_date)])
    db.commit()
    background.add_task(crm_push.flush_in_background)
    return off


@router.post("/days-off/bulk", response_model=LeaveBulkOut)
def assign_leave(data: LeaveBulkIn, db: DB, user: HR, background: BackgroundTasks):
    """Vacación o compensatorio en un rango: quita el turno de esos días y el CRM ya no lo pone."""
    employee_ids = set(data.employee_ids)
    found = set(db.scalars(select(Employee.id).where(Employee.id.in_(employee_ids))).all())
    if missing := employee_ids - found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Empleados no encontrados: {sorted(missing)}")

    dates = [
        data.date_from + timedelta(days=i)
        for i in range((data.date_to - data.date_from).days + 1)
        if (data.date_from + timedelta(days=i)).weekday() in data.weekdays
    ]
    removed = db.execute(
        delete(ShiftAssignment).where(ShiftAssignment.employee_id.in_(employee_ids), ShiftAssignment.work_date.in_(dates))
    ).rowcount
    for emp_id in employee_ids:
        for day in dates:
            _day_off(db, emp_id, day, user, data.notes, data.kind)
    audit.record(
        db, user, data.kind, "shift_day_off", None,
        {**data.model_dump(mode="json"), "dias": len(dates), "turnos_quitados": removed},
    )
    crm_push.queue(db, [(e, d) for e in employee_ids for d in dates])
    db.commit()
    background.add_task(crm_push.flush_in_background)
    return LeaveBulkOut(days=len(dates) * len(employee_ids), shifts_removed=removed)


@router.put("/days-off/{day_off_id}", response_model=ShiftDayOffOut)
def update_day_off(day_off_id: int, data: ShiftDayOffUpdateIn, db: DB, user: HR, background: BackgroundTasks):
    """Edita un día libre/compensatorio ya existente: cambia la fecha y/o la nota (p. ej. el asueto
    que compensa). Si cambia la fecha, quita el turno de la nueva fecha y avisa al CRM de ambas."""
    off = db.get(ShiftDayOff, day_off_id)
    if off is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Día libre no encontrado")
    old_date = off.work_date
    if data.work_date != old_date:
        clash = db.scalar(
            select(ShiftDayOff.id).where(
                ShiftDayOff.employee_id == off.employee_id, ShiftDayOff.work_date == data.work_date, ShiftDayOff.id != off.id
            )
        )
        if clash is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Ya hay un día marcado en esa fecha")
        removed = db.scalar(
            select(ShiftAssignment).where(ShiftAssignment.employee_id == off.employee_id, ShiftAssignment.work_date == data.work_date)
        )
        if removed is not None:
            db.delete(removed)
    off.work_date = data.work_date
    if data.notes is not None:
        off.notes = data.notes
    off.source = "rrhh"
    db.flush()
    audit.record(
        db, user, "editar", "shift_day_off", off.id,
        {"empleado": off.employee_id, "fecha_antes": old_date.isoformat(), "fecha": data.work_date.isoformat(), "tipo": off.kind},
    )
    crm_push.queue(db, [(off.employee_id, old_date), (off.employee_id, data.work_date)])
    db.commit()
    background.add_task(crm_push.flush_in_background)
    return off


@router.delete("/days-off/{day_off_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_day_off(day_off_id: int, db: DB, user: HR, background: BackgroundTasks):
    """Quita el día libre: el día queda sin turno (también en el CRM)."""
    off = db.get(ShiftDayOff, day_off_id)
    if off is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Día libre no encontrado")
    audit.record(db, user, "eliminar", "shift_day_off", off.id, {"empleado": off.employee_id, "fecha": off.work_date.isoformat()})
    crm_push.queue(db, [(off.employee_id, off.work_date)])
    db.delete(off)
    db.commit()
    background.add_task(crm_push.flush_in_background)


@router.delete("/assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assignment(assignment_id: int, db: DB, user: HR, background: BackgroundTasks):
    assignment = db.get(ShiftAssignment, assignment_id)
    if assignment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Horario no encontrado")
    audit.record(
        db,
        user,
        "eliminar",
        "shift_assignment",
        assignment.id,
        {
            "empleado": assignment.employee_id,
            "fecha": assignment.work_date.isoformat(),
            "inicio": assignment.start_at.isoformat(),
            "fin": assignment.end_at.isoformat(),
        },
    )
    crm_push.queue(db, [(assignment.employee_id, assignment.work_date)])
    db.delete(assignment)
    db.commit()
    background.add_task(crm_push.flush_in_background)
