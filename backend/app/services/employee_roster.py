"""Importa la nómina de personal que lleva RRHH (una fila por empleado, separada por tabulaciones):

    4 CN<TAB>IRANIA CECILIA SERRANO MEJIA<TAB>SUPERVISORA DE VENTAS<TAB>07/04/2021

código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa). Se pega tal cual desde Excel.
El empleado se identifica por su código: si ya existe se actualizan nombre, cargo y fecha de
ingreso; si no, se crea. Nunca se tocan el ID de reloj, el ID de CRM ni el team.
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


def _title(text: str) -> str:
    words = [w.capitalize() for w in text.lower().split()]
    return " ".join(w.lower() if w.upper() in PARTICLES and i else w for i, w in enumerate(words))


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


def apply_roster(db: Session, rows: list[RosterRow]) -> dict[str, int]:
    """Crea o actualiza por código. No hace commit: lo decide quien llama."""
    existing = {e.code: e for e in db.scalars(select(Employee).where(Employee.code.in_([r.code for r in rows])))}
    created = updated = unchanged = 0
    for r in rows:
        values = dict(first_name=r.first_name, last_name=r.last_name, position=r.position, hire_date=r.hire_date)
        employee = existing.get(r.code)
        if employee is None:
            db.add(Employee(code=r.code, **values))
            created += 1
        elif any(getattr(employee, k) != v for k, v in values.items()):
            for k, v in values.items():
                setattr(employee, k, v)
            updated += 1
        else:
            unchanged += 1
    db.flush()
    return {"created": created, "updated": updated, "unchanged": unchanged}


def name_key(text: str) -> set[str]:
    """Palabras de un nombre sin tildes ni mayúsculas, para comparar nombres del CRM con la nómina."""
    plain = unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z]+", plain) if w.upper() not in PARTICLES}
