from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, Staff
from app.core.config import get_settings
from app.models import Employee, ShiftAssignment, ShiftTemplate
from app.schemas import (
    BulkAssignIn,
    BulkAssignOut,
    ShiftAssignmentOut,
    ShiftTemplateIn,
    ShiftTemplateOut,
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
