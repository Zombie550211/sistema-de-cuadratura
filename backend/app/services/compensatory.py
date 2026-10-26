"""Compensatorios por asueto: los asuetos se trabajan, y quien marca ese día gana un día
compensatorio; quien no marca, lo pierde.

El cálculo sale de las marcaciones, así que al importar el archivo del reloj los compensatorios
quedan ganados solos. Un asueto del que no se ha importado ninguna marca (de nadie) no cuenta
como perdido: aún faltan los datos del reloj de ese día.

Los asuetos anteriores al 15/09/2026 no tienen marcaciones del reloj: RRHH anota a mano quién los
trabajó (HolidayWorker). Esos compensatorios SÍ cuentan y quedan disponibles para gastarse igual
que los demás; en la página de Compensatorios salen en gris para distinguir que son previos al corte.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Employee, Holiday, HolidayWorker, ManualCompensatory, Punch, ShiftDayOff

# Las marcaciones del sistema empiezan con el asueto del 15 de septiembre de 2026. Los asuetos
# anteriores del mismo año cuentan solo para quien RRHH anote que los trabajó; los de años
# anteriores y los días compensatorio previos a esa fecha no cuentan para el saldo.
START = date(2026, 9, 15)
FIRST_HOLIDAY = date(START.year, 1, 1)


def easter(year: int) -> date:
    """Domingo de Pascua (algoritmo gregoriano anónimo)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = divmod(b, 4)
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 19 * l) // 433
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def default_holidays(year: int) -> list[tuple[date, str]]:
    """Asuetos nacionales de El Salvador (Código de Trabajo, art. 190)."""
    sunday = easter(year)
    return sorted(
        [
            (date(year, 1, 1), "Año Nuevo"),
            (sunday - timedelta(days=3), "Jueves Santo"),
            (sunday - timedelta(days=2), "Viernes Santo"),
            (sunday - timedelta(days=1), "Sábado Santo"),
            (date(year, 5, 1), "Día del Trabajo"),
            (date(year, 5, 10), "Día de la Madre"),
            (date(year, 6, 17), "Día del Padre"),
            (date(year, 8, 6), "Fiestas Agostinas"),
            (date(year, 9, 15), "Día de la Independencia"),
            (date(year, 11, 2), "Día de los Difuntos"),
            (date(year, 12, 25), "Navidad"),
        ]
    )


def ensure_years(db: Session, years: range) -> None:
    """Carga los asuetos nacionales de cada año que aún no tenga ninguno; luego RRHH los ajusta."""
    for year in years:
        has = db.scalar(select(func.count()).where(Holiday.day >= date(year, 1, 1), Holiday.day <= date(year, 12, 31)))
        if not has:
            db.add_all(Holiday(day=d, name=n) for d, n in default_holidays(year))
    db.flush()


def data_years(db: Session, today: date) -> range:
    """Años con marcaciones (o el actual) hasta el siguiente, para tener sus asuetos cargados."""
    first = db.scalar(select(func.min(Punch.punched_at)))
    start = min(first.astimezone(get_settings().tz).year, today.year) if first else today.year
    return range(start, today.year + 2)


@dataclass
class CompensatoryStatus:
    employee_id: int
    earned: list[Holiday] = field(default_factory=list)
    lost: list[Holiday] = field(default_factory=list)
    taken: int = 0
    # Ganados que aún no se han usado en un día compensatorio.
    available: list[Holiday] = field(default_factory=list)

    @property
    def balance(self) -> int:
        # Todos los asuetos trabajados cuentan y están disponibles, también los anteriores al
        # 15/09/2026 (en la UI esos salen en gris). Saldo = ganados menos tomados.
        return len(self.earned) - self.taken


TAG = re.compile(r"Compensatorio (\d{2}/\d{2}/\d{4})")


def tags(note: str | None) -> list[str]:
    """Fechas de los asuetos que usa un día compensatorio ('Compensatorio dd/mm/aaaa (…)'); un
    mismo día puede usar dos o más."""
    return TAG.findall(note or "")


def used(note: str | None) -> int:
    """Asuetos que gasta un día compensatorio: los que nombra la nota, o uno si no dice cuál."""
    return max(1, len(set(tags(note))))


def unused(earned: list[Holiday], notes: list[str | None]) -> list[Holiday]:
    """Asuetos ganados sin usar. Un día compensatorio usa los asuetos cuya fecha (dd/mm/aaaa) trae
    en la nota; los que no dicen cuál usan el más antiguo que quede."""
    left = sorted(earned, key=lambda h: h.day)
    untagged = 0
    for note in notes:
        dates = set(tags(note)) or {
            h.day.strftime("%d/%m/%Y") for h in left if h.day.strftime("%d/%m/%Y") in (note or "")
        }
        if not dates:
            untagged += 1
        for d in sorted(dates):
            match = next((h for h in left if h.day.strftime("%d/%m/%Y") == d), None)
            if match is None:
                untagged += 1
            else:
                left.remove(match)
    return left[untagged:]


def compensatory_status(db: Session, employees: list[Employee], today: date) -> list[CompensatoryStatus]:
    tz = get_settings().tz
    every = db.scalars(select(Holiday).where(Holiday.day >= FIRST_HOLIDAY, Holiday.day <= today).order_by(Holiday.day)).all()
    holidays = [h for h in every if h.day >= START]
    ids = [e.id for e in employees]
    marked: set[tuple[int, date]] = set()
    days_with_data: set[date] = set()
    worked_before = set(
        db.execute(select(HolidayWorker.employee_id, HolidayWorker.holiday_id).where(HolidayWorker.employee_id.in_(ids))).tuples()
    ) if ids else set()
    if holidays and ids:
        def bounds(d: date):
            return and_(Punch.punched_at >= datetime.combine(d, time.min, tz), Punch.punched_at < datetime.combine(d + timedelta(days=1), time.min, tz))

        rows = db.execute(
            select(Punch.employee_id, Punch.punched_at).where(
                Punch.deleted_at.is_(None), Punch.is_double_tap.is_(False), or_(*(bounds(h.day) for h in holidays))
            )
        )
        for emp_id, at in rows:
            day = at.astimezone(tz).date()
            days_with_data.add(day)
            if emp_id is not None:
                marked.add((emp_id, day))

    notes: dict[int, list[str | None]] = {}
    if ids:
        for emp_id, note in db.execute(
            select(ShiftDayOff.employee_id, ShiftDayOff.notes).where(
                ShiftDayOff.kind == "compensatorio", ShiftDayOff.employee_id.in_(ids), ShiftDayOff.work_date >= START
            )
        ):
            notes.setdefault(emp_id, []).append(note)

    # Compensatorios manuales («Otro»): concedidos a mano por RRHH, cuentan como ganados.
    manual: dict[int, list[ManualCompensatory]] = {}
    if ids:
        for m in db.scalars(select(ManualCompensatory).where(ManualCompensatory.employee_id.in_(ids))):
            manual.setdefault(m.employee_id, []).append(m)

    out = []
    for e in employees:
        s = CompensatoryStatus(e.id, taken=sum(used(n) for n in notes.get(e.id, [])))
        for h in every:
            if h.day < START:
                # Antes del 15-09-2026 no hay marcaciones: si RRHH anotó que lo trabajó, cuenta como
                # ganado (en la UI sale en gris por ser previo al corte).
                if (e.id, h.id) in worked_before:
                    s.earned.append(h)
                continue
            if e.hire_date and h.day < e.hire_date:
                continue
            if (e.id, h.day) in marked:
                s.earned.append(h)
            elif h.day in days_with_data:
                s.lost.append(h)
        # «Otro»: cada compensatorio manual se representa como un ganado más (id negativo para no
        # chocar con los asuetos reales; la fecha es su día de origen y el nombre, su nota).
        for m in manual.get(e.id, []):
            h = Holiday(day=m.earned_date, name=m.note or "Otro")
            h.id = -m.id
            s.earned.append(h)
        # Disponibles = ganados sin usar, incluidos los anteriores al 15/09 (salen en gris en la UI).
        s.available = unused(s.earned, notes.get(e.id, []))
        out.append(s)
    return out
