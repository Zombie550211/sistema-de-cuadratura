"""Agrupa las marcaciones de un empleado por jornada laboral.

Una marca pertenece a la jornada cuyo turno la contiene con un margen de SHIFT_MARGIN antes y
después (así la salida 06:05 de un turno 22:00–06:00 cuenta para el día en que inició el turno).
Si ninguna jornada la contiene, se asigna a su fecha calendario local.
Es la base sobre la que se construirá el motor de cuadratura (tardanzas, horas extra, etc.).
"""

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Punch, ShiftAssignment

SHIFT_MARGIN = timedelta(hours=4)


@dataclass
class WorkDay:
    date: date
    shift: ShiftAssignment | None = None
    punches: list[Punch] = field(default_factory=list)


def employee_days(db: Session, employee_id: int, date_from: date, date_to: date) -> list[WorkDay]:
    tz = get_settings().tz
    days = {
        date_from + timedelta(days=i): WorkDay(date_from + timedelta(days=i))
        for i in range((date_to - date_from).days + 1)
    }

    # Se incluye el día anterior por si un turno nocturno se extiende dentro del rango.
    shifts = db.scalars(
        select(ShiftAssignment)
        .where(
            ShiftAssignment.employee_id == employee_id,
            ShiftAssignment.work_date >= date_from - timedelta(days=1),
            ShiftAssignment.work_date <= date_to,
        )
        .order_by(ShiftAssignment.start_at)
    ).all()
    for shift in shifts:
        if shift.work_date in days:
            days[shift.work_date].shift = shift

    window_start = datetime.combine(date_from, time.min, tz) - SHIFT_MARGIN
    window_end = datetime.combine(date_to + timedelta(days=1), time.min, tz) + timedelta(hours=12)
    punches = db.scalars(
        select(Punch)
        .where(
            Punch.employee_id == employee_id,
            Punch.punched_at >= window_start,
            Punch.punched_at < window_end,
        )
        .order_by(Punch.punched_at)
    ).all()

    for punch in punches:
        owner = _matching_shift(punch.punched_at, shifts)
        day = owner.work_date if owner else punch.punched_at.astimezone(tz).date()
        if day in days:
            days[day].punches.append(punch)

    return list(days.values())


def _matching_shift(at: datetime, shifts: list[ShiftAssignment]) -> ShiftAssignment | None:
    candidates = [s for s in shifts if s.start_at - SHIFT_MARGIN <= at <= s.end_at + SHIFT_MARGIN]
    if not candidates:
        return None
    # Si dos turnos se solapan con el margen, gana el más cercano a su inicio o fin.
    return min(candidates, key=lambda s: min(abs(at - s.start_at), abs(at - s.end_at)))
