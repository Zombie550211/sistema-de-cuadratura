from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, Staff
from app.core.config import get_settings
from app.models import Employee, ShiftAssignment, ShiftDayOff, ShiftTemplate
from app.schemas import (
    BulkAssignIn,
    BulkAssignOut,
    ShiftAssignmentOut,
    ShiftDayOffIn,
    ShiftDayOffOut,
    ShiftTemplateIn,
    ShiftTemplateOut,
    ShiftUpdateIn,
)
from app.services import audit

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
def bulk_assign(data: BulkAssignIn, db: DB, user: HR):
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
    db.commit()
    return BulkAssignOut(created=created, updated=updated, skipped=skipped)


def _day_off(db: DB, employee_id: int, day: date, user, notes: str | None = None) -> ShiftDayOff:
    off = db.scalar(select(ShiftDayOff).where(ShiftDayOff.employee_id == employee_id, ShiftDayOff.work_date == day))
    if off is None:
        off = ShiftDayOff(employee_id=employee_id, work_date=day, notes=notes, created_by_id=user.id)
        db.add(off)
    elif notes is not None:
        off.notes = notes
    return off


@router.put("/assignments/{assignment_id}", response_model=ShiftAssignmentOut)
def reschedule(assignment_id: int, data: ShiftUpdateIn, db: DB, user: HR):
    """Cambia la fecha y/o las horas de un turno. Queda como horario manual: el CRM ya no lo pisa."""
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
    db.commit()
    db.refresh(assignment)
    return assignment


@router.get("/days-off", response_model=list[ShiftDayOffOut])
def list_days_off(db: DB, _: Staff, date_from: date, date_to: date):
    if date_to < date_from or (date_to - date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    return db.scalars(
        select(ShiftDayOff).where(ShiftDayOff.work_date >= date_from, ShiftDayOff.work_date <= date_to).order_by(ShiftDayOff.work_date)
    ).all()


@router.post("/days-off", response_model=ShiftDayOffOut, status_code=status.HTTP_201_CREATED)
def set_day_off(data: ShiftDayOffIn, db: DB, user: HR):
    """Da el día libre: quita el turno de ese día (si hay) y el CRM ya no lo vuelve a poner."""
    if db.get(Employee, data.employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    removed = db.scalar(
        select(ShiftAssignment).where(ShiftAssignment.employee_id == data.employee_id, ShiftAssignment.work_date == data.work_date)
    )
    if removed is not None:
        db.delete(removed)
    off = _day_off(db, data.employee_id, data.work_date, user, data.notes)
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
            "turno_quitado": f"{removed.start_at.isoformat()} – {removed.end_at.isoformat()}" if removed else None,
        },
    )
    db.commit()
    return off


@router.delete("/days-off/{day_off_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_day_off(day_off_id: int, db: DB, user: HR):
    """Quita el día libre: el día queda sin turno y el próximo envío del CRM puede volver a llenarlo."""
    off = db.get(ShiftDayOff, day_off_id)
    if off is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Día libre no encontrado")
    audit.record(db, user, "eliminar", "shift_day_off", off.id, {"empleado": off.employee_id, "fecha": off.work_date.isoformat()})
    db.delete(off)
    db.commit()


@router.delete("/assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assignment(assignment_id: int, db: DB, user: HR):
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
    db.delete(assignment)
    db.commit()
