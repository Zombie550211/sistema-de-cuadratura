"""Llegadas tarde.

Cada día con turno, la llegada tarde es la hora de entrada (primera marca válida del día) menos
la hora de inicio del turno asignado en Horarios. Por regla de RRHH, en cada quincena (del 1 al
15 y del 16 a fin de mes) se perdonan los primeros 15 minutos acumulados: solo lo que pase de
ahí cuenta como llegada tarde.

Un día de descanso (libre, vacación, incapacidad…) nunca cuenta, aunque por error tenga turno.

Fin de semana: se trabaja un día (sábado o domingo) y se descansa el otro, alternando cada
semana. Si el agente no marcó el día que el horario le pone turno pero sí el otro día del mismo
fin de semana (sin turno, o con día libre), se toma como intercambio: el día que vino toma el
turno del fin de semana (misma hora de inicio) y el día del horario no queda como falta.

Nocturnidad: lo que el turno trabajado pasa de las 19:00 (NIGHT_START_HOUR) hasta su fin. Los
turnos de 13:00–21:00 y 17:00–21:00 dan 2 h por día. Solo cuenta si el agente marcó ese día.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Employee, Punch, ShiftAssignment, ShiftDayOff


@dataclass
class DayLateness:
    employee_id: int
    date: date
    shift_start: datetime
    check_in: datetime | None
    late_minutes: int
    # Segundos exactos de llegada tarde (para el total en horas, minutos y segundos).
    late_seconds: int
    # Minutos tarde acumulados en la quincena hasta este día, incluido.
    quincena_minutes: int
    # De los minutos de este día, cuántos cuentan (ya se pasó de lo que se perdona).
    counted_minutes: int
    # Intercambio de fin de semana: fecha del turno que el agente trabajó este día.
    swapped_from: date | None = None
    shift_end: datetime | None = None
    # Segundos del turno después de la hora nocturna (0 si no marcó ese día).
    night_seconds: int = 0


def quincena_start(day: date) -> date:
    return day.replace(day=1 if day.day <= 15 else 16)


def lateness(
    db: Session, date_from: date, date_to: date, area: str | None = None, employee_id: int | None = None
) -> list[DayLateness]:
    settings = get_settings()
    tz, allowance = settings.tz, settings.late_allowance_minutes
    # Se empieza desde el inicio de la quincena para acumular bien los días previos al rango, y se
    # lee un día de más a cada lado para ver el fin de semana completo.
    start = quincena_start(date_from)
    lo, hi = start - timedelta(days=1), date_to + timedelta(days=1)

    shift_stmt = select(ShiftAssignment).where(ShiftAssignment.work_date.between(lo, hi))
    off_stmt = select(ShiftDayOff.employee_id, ShiftDayOff.work_date, ShiftDayOff.kind).where(ShiftDayOff.work_date.between(lo, hi))
    punch_stmt = select(Punch.employee_id, Punch.punched_at).where(
        Punch.employee_id.is_not(None),
        Punch.deleted_at.is_(None),
        Punch.is_double_tap.is_(False),
        Punch.punched_at >= datetime.combine(lo, time.min, tz),
        Punch.punched_at < datetime.combine(hi + timedelta(days=1), time.min, tz),
    )
    if area:
        shift_stmt = shift_stmt.join(Employee, ShiftAssignment.employee_id == Employee.id).where(Employee.area == area)
        off_stmt = off_stmt.join(Employee, ShiftDayOff.employee_id == Employee.id).where(Employee.area == area)
        punch_stmt = punch_stmt.join(Employee, Punch.employee_id == Employee.id).where(Employee.area == area)
    if employee_id:
        shift_stmt = shift_stmt.where(ShiftAssignment.employee_id == employee_id)
        off_stmt = off_stmt.where(ShiftDayOff.employee_id == employee_id)
        punch_stmt = punch_stmt.where(Punch.employee_id == employee_id)

    first_punch: dict[tuple[int, date], datetime] = {}
    for emp_id, at in db.execute(punch_stmt):
        key = (emp_id, at.astimezone(tz).date())
        if key not in first_punch or at < first_punch[key]:
            first_punch[key] = at
    off_kind = {(emp_id, day): kind for emp_id, day, kind in db.execute(off_stmt)}
    shifts = {(s.employee_id, s.work_date): s for s in db.scalars(shift_stmt) if (s.employee_id, s.work_date) not in off_kind}

    # (empleado, día trabajado, inicio y fin del turno, fecha del turno si fue intercambio)
    days: list[tuple[int, date, datetime, datetime, date | None]] = []
    for (emp_id, day), shift in shifts.items():
        if day.weekday() >= 5 and (emp_id, day) not in first_punch:
            other = day + timedelta(days=1 if day.weekday() == 5 else -1)
            if (emp_id, other) in first_punch and (emp_id, other) not in shifts and off_kind.get((emp_id, other), "libre") == "libre":
                moved = other - day
                days.append((emp_id, other, shift.start_at + moved, shift.end_at + moved, day))
                continue
        days.append((emp_id, day, shift.start_at, shift.end_at, None))

    result: list[DayLateness] = []
    used: dict[tuple[int, date], int] = {}
    for emp_id, day, begin, end, swapped in sorted(days, key=lambda d: (d[0], d[1])):
        if not start <= day <= date_to:
            continue
        check_in = first_punch.get((emp_id, day))
        late_seconds = max(int((check_in - begin).total_seconds()), 0) if check_in else 0
        late = late_seconds // 60
        bucket = (emp_id, quincena_start(day))
        before = used.get(bucket, 0)
        after = before + late
        used[bucket] = after
        night_from = max(begin, datetime.combine(day, time(settings.night_start_hour), tz))
        night = max(int((end - night_from).total_seconds()), 0) if check_in else 0
        if day >= date_from:
            result.append(
                DayLateness(
                    employee_id=emp_id,
                    date=day,
                    shift_start=begin,
                    check_in=check_in,
                    late_minutes=late,
                    late_seconds=late_seconds,
                    quincena_minutes=after,
                    counted_minutes=max(after - allowance, 0) - max(before - allowance, 0),
                    swapped_from=swapped,
                    shift_end=end,
                    night_seconds=night,
                )
            )
    return result
