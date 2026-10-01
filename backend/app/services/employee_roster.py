"""Importa la nómina de personal que lleva RRHH (una fila por empleado, separada por tabulaciones):

    4 CN<TAB>IRANIA CECILIA SERRANO MEJIA<TAB>SUPERVISORA DE VENTAS<TAB>07/04/2021

código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa). Se pega tal cual desde Excel.
El empleado se busca por su código y, si no, por nombre (el CRM pudo crearlo antes con código
CRM-…; a ese se le pone el código de la nómina). Si existe se actualizan código, nombre, cargo y
fecha de ingreso; si no, se crea. Si el nombre coincide con varias fichas no se toca nada y se
avisa. Nunca se tocan el ID de reloj, el ID de CRM ni el team.
"""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee

# Partículas que forman parte del apellido: "DEL CID ORELLANA", "MEJIA DE MELENDEZ".
PARTICLES = {"DE", "DEL", "LA", "LAS", "LOS", "Y"}


@dataclass
class RosterRow:
    line: int
    code: str
    first_name: str
    last_name: str
    position: str
    hire_date: date


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


def parse_roster(text: str) -> tuple[list[RosterRow], list[RosterError]]:
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
    return dict(code=r.code, first_name=r.first_name, last_name=r.last_name, position=r.position, hire_date=r.hire_date)


def match_roster(db: Session, rows: list[RosterRow]) -> list[RosterMatch]:
    """A qué ficha corresponde cada fila: por código y, si no, por nombre."""
    employees = db.scalars(select(Employee)).all()
    by_code = {e.code: e for e in employees}
    taken = {by_code[r.code].id for r in rows if r.code in by_code}
    keys = {e.id: name_key(e.full_name) for e in employees}
    result = []
    for r in rows:
        employee, note = by_code.get(r.code), None
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
            db.add(Employee(**_values(m.row)))
            counts["created"] += 1
        elif m.status == "actualizar":
            for k, v in _values(m.row).items():
                setattr(m.employee, k, v)
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
