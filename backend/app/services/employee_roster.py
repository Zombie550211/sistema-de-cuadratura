"""Importa la nómina de personal que lleva RRHH (una fila por empleado, separada por tabulaciones):

    4 CN<TAB>IRANIA CECILIA SERRANO MEJIA<TAB>SUPERVISORA DE VENTAS<TAB>07/04/2021

código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa). Se pega tal cual desde Excel.

También acepta el listado de personal con encabezados (EMPLEADO, CARGO, INGRESOS A HONORARIOS,
HUELLA …): no trae código, pero sí el número de huella, que es el ID del empleado en el reloj. De
las columnas HUELLA (sin contar la del comedor) se usa la que está llena para todos, la que no
dice N/A.

El empleado se busca por su código, luego por su huella y, si no, por nombre (el CRM pudo crearlo
antes con código CRM-…; a ese se le pone el código de la nómina). Si existe se actualizan código,
nombre, cargo, fecha de ingreso y huella (lo que traiga la fila); si no, se crea (sin código en la
nómina, su código es la huella). Si el nombre coincide con varias fichas no se toca nada y se
avisa. Nunca se tocan el ID de CRM ni el team.
"""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee
from app.services.attendance_import import relink_badge

# Partículas que forman parte del apellido: "DEL CID ORELLANA", "MEJIA DE MELENDEZ".
PARTICLES = {"DE", "DEL", "LA", "LAS", "LOS", "Y"}


@dataclass
class RosterRow:
    line: int
    code: str | None
    first_name: str
    last_name: str
    position: str
    hire_date: date | None
    badge: str | None = None


@dataclass
class RosterError:
    line: int
    text: str
    message: str


def title_name(text: str) -> str:
    """'EMANUEL DE JESUS' → 'Emanuel de Jesus': mayúscula inicial y partículas en minúscula."""
    words = [w.capitalize() for w in text.lower().split()]
    return " ".join(w.lower() if w.upper() in PARTICLES and i else w for i, w in enumerate(words))


_title = title_name


def fix_case(text: str) -> str:
    """Corrige solo lo que viene todo en mayúsculas o todo en minúsculas ('JONATHAN F' → 'Jonathan F');
    lo que ya trae mayúsculas y minúsculas se respeta ('Ventas USA')."""
    text = " ".join((text or "").split())
    return title_name(text) if text.isupper() or text.islower() else text


def split_name(full: str) -> tuple[str, str]:
    """Nombres y apellidos de un nombre completo salvadoreño: los dos últimos apellidos
    (con sus partículas) son el apellido; el resto, los nombres."""
    words = full.split()
    if len(words) < 2:
        raise ValueError("El nombre debe traer al menos un nombre y un apellido")
    i = len(words)
    for _ in range(2):  # dos apellidos
        if i <= 1:
            break
        i -= 1
        while i > 1 and words[i - 1].upper() in PARTICLES:
            i -= 1
    if len(words) >= 4 and i < 2:
        i = 2
    return _title(" ".join(words[:i])), _title(" ".join(words[i:]))


def _code(text: str) -> str:
    # "4 CN" → "4 CN" (se conserva el formato de RRHH, sin espacios repetidos)
    return re.sub(r"\s+", " ", text.strip()).upper()


def _plain(text: str) -> str:
    return " ".join(unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().upper().split())


def _is_table(line: str) -> bool:
    headers = [_plain(c) for c in line.split("\t")]
    return "EMPLEADO" in headers and any(h.startswith("HUELLA") for h in headers)


def parse_roster(text: str) -> tuple[list[RosterRow], list[RosterError]]:
    first = next((line for line in text.splitlines() if line.strip()), "")
    return _parse_table(text) if _is_table(first) else _parse_simple(text)


_EMPTY = {"", "N/A", "NA", "-"}


def _parse_table(text: str) -> tuple[list[RosterRow], list[RosterError]]:
    """Listado de personal con encabezados; las columnas se ubican por su nombre."""
    lines = [(n, raw) for n, raw in enumerate(text.splitlines(), start=1) if raw.strip()]
    (hn, header), data = lines[0], [(n, [c.strip() for c in raw.split("\t")]) for n, raw in lines[1:]]
    headers = [_plain(c) for c in header.split("\t")]
    col = {h: i for i, h in enumerate(headers)}
    missing = [h for h in ("EMPLEADO", "CARGO", "INGRESOS A HONORARIOS") if h not in col]
    if missing:
        return [], [RosterError(hn, header.strip(), f"Faltan las columnas: {', '.join(missing)}")]

    def cell(cols: list[str], i: int) -> str:
        return cols[i] if i < len(cols) else ""

    # La huella del reloj de marcación: la columna HUELLA (no la del comedor) con más números.
    fingers = [i for i, h in enumerate(headers) if h.startswith("HUELLA") and "COMEDOR" not in h]
    filled = {i: sum(cell(c, i).upper() not in _EMPTY for _, c in data) for i in fingers}
    best = max(filled.values(), default=0)
    if not best or list(filled.values()).count(best) > 1:
        return [], [RosterError(hn, header.strip(), "No se pudo decidir qué columna HUELLA es la del reloj")]
    finger = next(i for i in fingers if filled[i] == best)

    rows: list[RosterRow] = []
    errors: list[RosterError] = []
    seen: dict[str, int] = {}
    for n, cols in data:
        raw = "\t".join(cols)
        name, hired, badge = cell(cols, col["EMPLEADO"]), cell(cols, col["INGRESOS A HONORARIOS"]), cell(cols, finger)
        try:
            first_name, last = split_name(name)
            badge = None if badge.upper() in _EMPTY else badge
            if badge is not None and not badge.isdigit():
                raise ValueError(f"Huella inválida: {badge!r}")
            try:
                hire_date = None if hired in _EMPTY else datetime.strptime(hired, "%d/%m/%Y").date()
            except ValueError:
                raise ValueError(f"Fecha de ingreso inválida: {hired!r} (use dd/mm/aaaa)") from None
        except ValueError as exc:
            errors.append(RosterError(n, raw, str(exc)))
            continue
        if badge and badge in seen:
            errors.append(RosterError(n, raw, f"Huella repetida (ya aparece en la línea {seen[badge]})"))
            continue
        if badge:
            seen[badge] = n
        rows.append(RosterRow(n, None, first_name, last, _title(cell(cols, col["CARGO"])).capitalize(), hire_date, badge))
    return rows, errors


def _parse_simple(text: str) -> tuple[list[RosterRow], list[RosterError]]:
    rows: list[RosterRow] = []
    errors: list[RosterError] = []
    seen: dict[str, int] = {}
    for n, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        cols = [c.strip() for c in raw.split("\t")]
        if len(cols) < 4:
            errors.append(RosterError(n, raw.strip(), "Se esperan 4 columnas separadas por tabulación: código, nombre, cargo, fecha de ingreso"))
            continue
        code, name, position, hired = cols[:4]
        try:
            if not code:
                raise ValueError("Falta el código")
            first, last = split_name(name)
            hire_date = datetime.strptime(hired, "%d/%m/%Y").date()
        except ValueError as exc:
            msg = str(exc)
            if "does not match format" in msg or "unconverted data" in msg or "out of range" in msg:
                msg = f"Fecha de ingreso inválida: {hired!r} (use dd/mm/aaaa)"
            errors.append(RosterError(n, raw.strip(), msg))
            continue
        code = _code(code)
        if code in seen:
            errors.append(RosterError(n, raw.strip(), f"Código repetido (ya aparece en la línea {seen[code]})"))
            continue
        seen[code] = n
        rows.append(RosterRow(n, code, first, last, _title(position).capitalize(), hire_date))
    return rows, errors


@dataclass
class RosterMatch:
    row: RosterRow
    employee: Employee | None
    status: str  # nuevo | actualizar | sin_cambios | ambiguo
    note: str | None = None


def _values(r: RosterRow) -> dict:
    """Lo que la fila fija en la ficha; lo que la fila no trae (código, huella, fecha) no se toca."""
    values = dict(code=r.code, first_name=r.first_name, last_name=r.last_name, position=r.position,
                  hire_date=r.hire_date, badge_number=r.badge)
    return {k: v for k, v in values.items() if v is not None}


def match_roster(db: Session, rows: list[RosterRow]) -> list[RosterMatch]:
    """A qué ficha corresponde cada fila: por código, luego por huella y, si no, por nombre."""
    employees = db.scalars(select(Employee)).all()
    by_code = {e.code: e for e in employees}
    by_badge = {e.badge_number: e for e in employees if e.badge_number}

    def known(r: RosterRow) -> Employee | None:
        return by_code.get(r.code) or by_badge.get(r.badge)

    taken = {known(r).id for r in rows if known(r)}
    keys = {e.id: name_key(e.full_name) for e in employees}
    result = []
    for r in rows:
        employee, note = known(r), None
        if employee is None:
            k = name_key(f"{r.first_name} {r.last_name}")
            free = [e for e in employees if e.id not in taken]
            # Mismo nombre; si no, el nombre corto del CRM contenido en el de la nómina (o al revés).
            found = [e for e in free if keys[e.id] == k] or [
                e for e in free if min(len(keys[e.id]), len(k)) >= 2 and (keys[e.id] <= k or k <= keys[e.id])
            ]
            if len(found) > 1:
                names = ", ".join(f"{e.code} {e.full_name}" for e in found)
                result.append(RosterMatch(r, None, "ambiguo", f"El nombre coincide con varias fichas: {names}. Corrija el nombre en una o use su código."))
                continue
            if found:
                employee = found[0]
                taken.add(employee.id)
                note = f"Se enlaza con {employee.code} {employee.full_name}"
        if employee is None:
            code = r.code or r.badge
            if code is None:
                result.append(RosterMatch(r, None, "ambiguo", "No está en el sistema y la fila no trae código ni huella para crearlo."))
            elif code in by_code:
                result.append(RosterMatch(r, None, "ambiguo", f"El código {code} ya es de {by_code[code].full_name}."))
            else:
                result.append(RosterMatch(r, None, "nuevo"))
        elif all(getattr(employee, k) == v for k, v in _values(r).items()):
            result.append(RosterMatch(r, employee, "sin_cambios"))
        else:
            result.append(RosterMatch(r, employee, "actualizar", note))
    return result


def apply_roster(db: Session, matches: list[RosterMatch]) -> dict[str, int]:
    """Crea o actualiza según match_roster; las filas ambiguas no se tocan. No hace commit."""
    counts = {"created": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for m in matches:
        if m.status == "nuevo":
            employee = Employee(**{"code": m.row.badge, **_values(m.row)})
            db.add(employee)
            db.flush()
            relink_badge(db, employee.id, None, employee.badge_number)
            counts["created"] += 1
        elif m.status == "actualizar":
            old_badge = m.employee.badge_number
            for k, v in _values(m.row).items():
                setattr(m.employee, k, v)
            db.flush()
            relink_badge(db, m.employee.id, old_badge, m.employee.badge_number)
            counts["updated"] += 1
        elif m.status == "sin_cambios":
            counts["unchanged"] += 1
        else:
            counts["skipped"] += 1
    db.flush()
    return counts


def name_key(text: str) -> set[str]:
    """Palabras de un nombre sin tildes ni mayúsculas, para comparar nombres del CRM con la nómina."""
    plain = unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z]+", plain) if w.upper() not in PARTICLES}
