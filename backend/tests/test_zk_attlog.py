from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.zk_attlog import (
    flag_double_taps,
    normalize_badge,
    parse_attlog,
    serial_from_filename,
)

TZ = ZoneInfo("America/El_Salvador")


def test_parses_zkteco_line_with_padding_and_crlf():
    content = b"            83\t2026-09-25 06:21:58\t1\t4\t1\t0\r\n"
    result = parse_attlog(content, TZ)
    assert result.errors == []
    [rec] = result.records
    assert rec.badge == "83"
    assert rec.punched_at == datetime(2026, 9, 25, 6, 21, 58, tzinfo=TZ)
    assert rec.punched_at.utcoffset().total_seconds() == -6 * 3600
    assert (rec.verify_mode, rec.status_code, rec.work_code) == (1, 4, 1)


def test_accepts_space_separated_and_short_lines():
    content = b"7 2026-09-25 08:09:07\n00016 2026/09/25 13:29\n"
    result = parse_attlog(content, TZ)
    assert [r.badge for r in result.records] == ["16", "7"]
    assert result.records[0].punched_at.second == 0


def test_reports_invalid_lines_and_skips_blank():
    content = b"83\t2026-09-25 06:21:58\t1\t4\t1\t0\n\nbasura\n9\t2026-13-45 10:00:00\n"
    result = parse_attlog(content, TZ)
    assert result.total_lines == 3
    assert len(result.records) == 1
    assert [line for line, _ in result.errors] == [3, 4]


def test_identical_lines_in_file_are_counted_once():
    line = b"36\t2026-09-25 07:11:34\t1\t4\t1\t0\r\n"
    result = parse_attlog(line * 3, TZ)
    assert len(result.records) == 1
    assert result.duplicate_lines == 2


def test_double_tap_burst_collapses_to_first_punch():
    base = datetime(2026, 9, 25, 12, 59, 19, tzinfo=TZ)
    times = [base.replace(second=s) for s in (19, 21, 22, 24)]
    assert flag_double_taps(times, 120) == [False, True, True, True]


def test_double_tap_window_measures_from_last_kept_punch():
    t = lambda h, m: datetime(2026, 9, 25, h, m, tzinfo=TZ)  # noqa: E731
    # 12:00 válida, 12:01 doble, 12:03 ya está a 3 min de la válida → nueva válida
    assert flag_double_taps([t(12, 0), t(12, 1), t(12, 3)], 120) == [False, True, False]


def test_serial_and_badge_helpers():
    assert serial_from_filename("BINH221860214_attlog(1).dat") == "BINH221860214"
    assert serial_from_filename("marcas.dat") is None
    assert normalize_badge(" 0083 ") == "83"
    assert normalize_badge("000") == "0"
