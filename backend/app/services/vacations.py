"""Vacaciones por antigüedad: 15 días al cumplir cada año en la empresa (Código de Trabajo, art. 177).

Cada año cumplido abre un período (de un aniversario de ingreso al siguiente) con 15 días. Se
entregan por partes: unos días el empleado los descansa (días de vacación del calendario) y otros
los trabaja (RRHH anota cuántos). Lo que falta queda pendiente y se acumula. Los días descansados
se aplican al período más antiguo que aún tenga días; un período que RRHH cerró como completo
(historia anterior al sistema) ya no tiene pendientes.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta

VACATION_DAYS = 15


def anniversary(hire: date, years: int) -> date:
    """Aniversario número `years`; quien entró un 29 de febrero cumple el 28 en años no bisiestos."""
    try:
        return hire.replace(year=hire.year + years)
    except ValueError:
        return hire.replace(year=hire.year + years, day=28)


def completed_years(hire: date, today: date) -> int:
    years = today.year - hire.year
    return years - 1 if anniversary(hire, years) > today else years


@dataclass
class PeriodRecord:
    """Lo que RRHH anotó de un período (VacationPeriod)."""

    worked_days: int = 0
    settled: bool = False
    notes: str | None = None


@dataclass
class Period:
    start: date
    end: date
    worked: int
    settled: bool
    notes: str | None
    rested: list[date] = field(default_factory=list)

    @property
    def pending(self) -> int:
        return 0 if self.settled else max(VACATION_DAYS - self.worked - len(self.rested), 0)


@dataclass
class VacationStatus:
    hire_date: date | None
    years: int
    # Siguiente aniversario: cuando le tocan los próximos 15 días.
    next_date: date | None
    periods: list[Period]
    # Días descansados que no caben en ningún período (vacaciones adelantadas de más).
    extra: list[date]

    @property
    def pending(self) -> int:
        return sum(p.pending for p in self.periods)


def vacation_status(hire: date | None, today: date, rested: list[date], records: dict[date, PeriodRecord] | None = None) -> VacationStatus:
    records = records or {}
    if hire is None:
        return VacationStatus(None, 0, None, [], [])
    years = completed_years(hire, today) if hire <= today else 0
    periods = []
    for n in range(1, years + 1):
        start = anniversary(hire, n)
        rec = records.get(start, PeriodRecord())
        periods.append(Period(start, anniversary(hire, n + 1) - timedelta(days=1), rec.worked_days, rec.settled, rec.notes))
    extra = []
    for day in sorted(rested):
        target = next((p for p in periods if p.pending > 0), None)
        if target is None:
            extra.append(day)
        else:
            target.rested.append(day)
    return VacationStatus(hire, years, anniversary(hire, years + 1), periods, extra)
