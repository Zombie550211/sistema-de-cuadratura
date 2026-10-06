from datetime import date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from app.services.attendance_day import WorkDay

TZ = ZoneInfo("America/El_Salvador")


def punch(hhmm: str, double: bool = False):
    h, m = map(int, hhmm.split(":"))
    return SimpleNamespace(punched_at=datetime(2026, 9, 28, h, m, tzinfo=TZ), is_double_tap=double)


def test_solo_la_primera_marca_cuenta_como_entrada():
    day = WorkDay(date(2026, 9, 28), punches=[punch("12:00"), punch("08:00"), punch("17:05"), punch("13:00")])
    assert day.check_in.punched_at.hour == 8
    assert not hasattr(day, "check_out")


def test_dobles_marcas_no_cuentan():
    day = WorkDay(date(2026, 9, 28), punches=[punch("07:59", double=True), punch("08:00")])
    assert day.check_in.punched_at.hour == 8
    assert WorkDay(date(2026, 9, 28)).check_in is None
