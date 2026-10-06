"""Llegadas tarde.

Cada día con turno, la llegada tarde es la hora de entrada (primera marca válida del día) menos
la hora de inicio del turno asignado en Horarios. Por regla de RRHH, en cada quincena (del 1 al
15 y del 16 a fin de mes) se perdonan los primeros 15 minutos acumulados: solo lo que pase de
ahí cuenta como llegada tarde.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Employee, Punch, ShiftAssignment


@dataclass
class DayLateness:
    employee_id: int
    date: date
    shift_start: datetime
    check_in: datetime | None
    late_minutes: int
    # Minutos tarde acumulados en la quincena hasta este día, incluido.
    quincena_minutes: int
    # De los minutos de este día, cuántos cuentan (ya se pasó de lo que se perdona).
    counted_minutes: int


def quincena_start(day: date) -> date:
    return day.replace(day=1 if day.day <= 15 else 16)


def lateness(
    db: Session, date_from: date, date_to: date, area: str | None = None, employee_id: int | None = None
) -> list[DayLateness]:
    settings = get_settings()
    tz, allowance = settings.tz, settings.late_allowance_minutes
    # Se empieza desde el inicio de la quincena para acumular bien los días previos al rango.
    start = quincena_start(date_from)

    shift_stmt = select(ShiftAssignment).where(ShiftAssignment.work_date.between(start, date_to))
    punch_stmt = select(Punch.employee_id, Punch.punched_at).where(
        Punch.employee_id.is_not(None),
        Punch.deleted_at.is_(None),
        Punch.is_double_tap.is_(False),
        Punch.punched_at >= datetime.combine(start, time.min, tz),
        Punch.punched_at < datetime.combine(date_to + timedelta(days=1), time.min, tz),
    )
    if area:
        shift_stmt = shift_stmt.join(Employee, ShiftAssignment.employee_id == Employee.id).where(Employee.area == area)
        punch_stmt = punch_stmt.join(Employee, Punch.employee_id == Employee.id).where(Employee.area == area)
    if employee_id:
        shift_stmt = shift_stmt.where(ShiftAssignment.employee_id == employee_id)
        punch_stmt = punch_stmt.where(Punch.employee_id == employee_id)

    first_punch: dict[tuple[int, date], datetime] = {}
    for emp_id, at in db.execute(punch_stmt):
        key = (emp_id, at.astimezone(tz).date())
        if key not in first_punch or at < first_punch[key]:
            first_punch[key] = at

    result: list[DayLateness] = []
    used: dict[tuple[int, date], int] = {}
    for shift in sorted(db.scalars(shift_stmt), key=lambda s: (s.employee_id, s.work_date)):
        check_in = first_punch.get((shift.employee_id, shift.work_date))
        late = max(int((check_in - shift.start_at).total_seconds() // 60), 0) if check_in else 0
        bucket = (shift.employee_id, quincena_start(shift.work_date))
        before = used.get(bucket, 0)
        after = before + late
        used[bucket] = after
        if shift.work_date >= date_from:
            result.append(
                DayLateness(
                    employee_id=shift.employee_id,
                    date=shift.work_date,
                    shift_start=shift.start_at,
                    check_in=check_in,
                    late_minutes=late,
                    quincena_minutes=after,
                    counted_minutes=max(after - allowance, 0) - max(before - allowance, 0),
                )
            )
    return result
