"""Lector de archivos attlog de relojes ZKTeco (p. ej. BINH221860214_attlog.dat).

Formato por línea (separado por tabulaciones, con espacios a la izquierda del ID):
    <id_reloj>  <AAAA-MM-DD HH:MM:SS>  <verificación>  <estado>  <código_trabajo>  <reservado>

El reloj guarda la hora local sin zona horaria. El campo "estado" no es confiable
(en este equipo siempre vale 4), así que entrada/salida se deduce luego con el horario.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LINE_RE = re.compile(
    r"^\s*(?P<badge>[0-9A-Za-z]+)\s+"
    r"(?P<date>\d{4}[-/]\d{2}[-/]\d{2})\s+(?P<time>\d{1,2}:\d{2}(?::\d{2})?)"
    r"(?P<rest>(?:\s+-?\d+)*)\s*$"
)
SERIAL_RE = re.compile(r"^([A-Za-z0-9]+)_attlog", re.IGNORECASE)


@dataclass(frozen=True)
class AttlogRecord:
    line_no: int
    badge: str
    punched_at: datetime
    verify_mode: int
    status_code: int
    work_code: int


@dataclass
class ParseResult:
    records: list[AttlogRecord] = field(default_factory=list)
    errors: list[tuple[int, str]] = field(default_factory=list)
    duplicate_lines: int = 0
    total_lines: int = 0


def serial_from_filename(filename: str) -> str | None:
    match = SERIAL_RE.match(filename.rsplit("/", 1)[-1])
    return match.group(1).upper() if match else None


def normalize_badge(badge: str) -> str:
    """El reloj a veces rellena con ceros ('00083'); se guarda siempre como '83'."""
    return badge.strip().lstrip("0") or "0"


def _decode(content: bytes) -> str:
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("No se pudo leer el archivo")


def _parse_datetime(date_part: str, time_part: str, tz: ZoneInfo) -> datetime:
    date_part = date_part.replace("/", "-")
    fmt = "%Y-%m-%d %H:%M:%S" if time_part.count(":") == 2 else "%Y-%m-%d %H:%M"
    return datetime.strptime(f"{date_part} {time_part}", fmt).replace(tzinfo=tz)


def parse_attlog(content: bytes, tz: ZoneInfo) -> ParseResult:
    result = ParseResult()
    seen: set[tuple[str, datetime]] = set()

    for line_no, raw in enumerate(_decode(content).splitlines(), start=1):
        if not raw.strip():
            continue
        result.total_lines += 1
        match = LINE_RE.match(raw)
        if not match:
            result.errors.append((line_no, "Formato no reconocido"))
            continue
        try:
            punched_at = _parse_datetime(match["date"], match["time"], tz)
        except ValueError:
            result.errors.append((line_no, "Fecha u hora inválida"))
            continue

        badge = normalize_badge(match["badge"])
        key = (badge, punched_at)
        if key in seen:
            result.duplicate_lines += 1
            continue
        seen.add(key)

        extras = [int(x) for x in match["rest"].split()] + [0, 0, 0]
        result.records.append(
            AttlogRecord(
                line_no=line_no,
                badge=badge,
                punched_at=punched_at,
                verify_mode=extras[0],
                status_code=extras[1],
                work_code=extras[2],
            )
        )

    result.records.sort(key=lambda r: (r.badge, r.punched_at))
    return result


def flag_double_taps(times: list[datetime], window_seconds: int) -> list[bool]:
    """Recibe las marcas de UN empleado ordenadas. Marca como doble toda marca que cae
    dentro de la ventana de la última marca válida (no de la anterior), para que una
    ráfaga 12:59:19, :21, :22, :24 quede como una sola marca a las 12:59:19."""
    window = timedelta(seconds=window_seconds)
    flags: list[bool] = []
    last_kept: datetime | None = None
    for t in times:
        if last_kept is not None and t - last_kept <= window:
            flags.append(True)
        else:
            flags.append(False)
            last_kept = t
    return flags
