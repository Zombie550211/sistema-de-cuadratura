"""Importa la nómina de personal que lleva RRHH (una fila por empleado, separada por tabulaciones):

    4 CN<TAB>IRANIA CECILIA SERRANO MEJIA<TAB>SUPERVISORA DE VENTAS<TAB>07/04/2021

código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa). Se pega tal cual desde Excel.

También acepta el listado de personal con encabezados (EMPLEADO, CARGO, INGRESOS A HONORARIOS,
HUELLA …): no trae código, pero sí el número de huella, que es el ID del empleado en el reloj. De
las columnas HUELLA (sin contar la del comedor) se usa la que está llena para todos, la que no
dice N/A.

El empleado se busca por su código, luego por su huella y, si no, por nombre (el CRM pudo crearlo
antes con código CRM-…; a ese se le pone el código de la nómina). Si existe se actualizan código,
nombre, cargo, fecha de ingreso y huella (lo que traiga la fila), y si el cargo cambió también el
área (administrativo, operativo, supervisor o ventas, según el cargo); si no, se crea (sin código en la
nómina, su código es la huella). Si el nombre coincide con varias fichas no se toca nada y se
avisa. Nunca se tocan el ID de CRM ni el team.

La planilla completa de RRHH (encabezados N°, EMPLEADO, CARGO, SUELDO, …) trae además sueldo,
ingreso a planilla, DUI, NIT, ISSS, AFP, cuenta bancaria, huellas de cada reloj, documentos,
emergencia y finalización. Ahí el N° es el código, pero la numeración cambia entre versiones de la
planilla: el empleado se busca por su nombre completo y después se le pone el N° de esta versión.
No cambia el ID de reloj (cada reloj tiene su número de huella; se guardan todos en la ficha).
La columna CONTRASEÑA nunca se lee.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, EmployeeStatus, area_for
from app.services.attendance_import import relink_badge
from app.services.user_code import assign_user_codes

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
    # Planilla completa: el resto de campos de la ficha y, si la fila no se puede usar, por qué.
    extra: dict = field(default_factory=dict)
    skip: str | None = None


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
    if "SUELDO" in col:
        return _parse_payroll(hn, header, headers, data)
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
            hire_date = _date(hired)
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


def _date(text: str, what: str = "Fecha de ingreso") -> date | None:
    if text.upper() in _EMPTY:
        return None
    try:
        return datetime.strptime(text, "%d/%m/%Y").date()
    except ValueError:
        raise ValueError(f"{what} inválida: {text!r} (use dd/mm/aaaa)") from None


_MONTHS = {m: i for i, m in enumerate(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
                                       "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"], start=1)}
_MESES = {m: i for i, m in enumerate(["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO",
                                      "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"], start=1)}
_AFP = {"CONFIA": "AFP Confía", "CRECER": "AFP Crecer", "UPISSS": "UPISSS", "IPSFA": "IPSFA"}


def _birthday(text: str) -> str | None:
    """'19/July' → '07-19' (la planilla no trae el año)."""
    m = re.fullmatch(r"(\d{1,2})\s*/\s*([A-Za-z]+)", text.strip())
    month = m and (_MONTHS.get(m[2].upper()) or _MESES.get(m[2].upper()))
    if not month or not 1 <= int(m[1]) <= 31:
        return None
    return f"{month:02d}-{int(m[1]):02d}"


def _money(text: str) -> Decimal | None:
    try:
        return Decimal(re.sub(r"[$,\s]", "", text)) if text.strip() else None
    except InvalidOperation:
        raise ValueError(f"Sueldo inválido: {text!r}") from None


def _match(pattern: str, text: str) -> str | None:
    return text if re.fullmatch(pattern, text) else None


def _parse_payroll(hn: int, header: str, headers: list[str], data) -> tuple[list[RosterRow], list[RosterError]]:
    """Planilla completa de RRHH: una fila por empleado con todos sus datos."""
    col = {h: i for i, h in enumerate(headers)}
    missing = [h for h in ("N", "EMPLEADO", "CARGO") if h not in col]
    if missing:
        return [], [RosterError(hn, header.strip(), f"Faltan las columnas: {', '.join(missing)}")]
    fingers = {i: h.removeprefix("HUELLA").strip() for i, h in enumerate(headers) if h.startswith("HUELLA")}

    def get(cols: list[str], name: str) -> str:
        i = col.get(name)
        value = cols[i].strip() if i is not None and i < len(cols) else ""
        return "" if value.upper() in _EMPTY else value

    rows: list[RosterRow] = []
    errors: list[RosterError] = []
    seen: dict[str, int] = {}
    for n, cols in data:
        raw = "\t".join(cols)
        name, code = " ".join(get(cols, "EMPLEADO").split()), _code(get(cols, "N"))
        if not name:
            continue  # filas vacías o notas al pie de la hoja
        try:
            first_name, last = split_name(name)
        except ValueError as exc:
            errors.append(RosterError(n, raw, str(exc)))
            continue
        position = _title(get(cols, "CARGO")).capitalize()
        if not code or not position:
            rows.append(RosterRow(n, code or None, first_name, last, position, None,
                                  skip="La fila no trae N° o cargo (¿columnas corridas?): no se importa."))
            continue
        if code in seen:
            errors.append(RosterError(n, raw, f"N° repetido (ya aparece en la línea {seen[code]})"))
            continue
        seen[code] = n
        try:
            hire_date = _date(get(cols, "INGRESOS A HONORARIOS"))
            payroll_date = _date(get(cols, "INGRESO A PLANILLA"), "Fecha de ingreso a planilla")
            salary = _money(get(cols, "SUELDO"))
        except ValueError as exc:
            errors.append(RosterError(n, raw, str(exc)))
            continue
        ending = get(cols, "FINALIZACION")
        ended = re.search(r"\d{2}/\d{2}/\d{4}", ending)
        afp = get(cols, "EMPRESA").upper()
        extra = {
            "base_salary": salary,
            "payroll_date": payroll_date,
            "locker": get(cols, "LOCKER") or None,
            "dui": _match(r"\d{8}-\d", get(cols, "DUI")),
            "birthday": _birthday(get(cols, "FECHA DE NACIMIENTO M/D/A")),
            "nit": _match(r"\d{4}-\d{6}-\d{3}-\d", get(cols, "NIT")),
            "bank_account": _match(r"\d{6,30}", get(cols, "CUENTA BANCARIA")),
            "isss_number": _match(r"\d{6,20}", get(cols, "ISSS")),
            "nup": _match(r"[\d-]{6,20}", get(cols, "AFP")),
            "afp": _AFP.get(afp, afp.title() or None),
            "fingerprints": {
                label.replace("COMEDOR", "comedor"): cols[i].strip()
                for i, label in fingers.items()
                if i < len(cols) and cols[i].strip().isdigit()
            },
            "has_cv": get(cols, "CV").upper() == "SI",
            "has_contract": get(cols, "CONTRATO").upper() == "SI",
            "has_nda": get(cols, "ACUERDO DE CONFIDENCIALIDAD").upper() == "SI",
            "has_memo": get(cols, "MEMORANDUM").upper() == "SI",
            "gender": get(cols, "GENERO").capitalize() or None,
            "emergency_contact": " ".join(get(cols, "NUMERO DE EMERGENCIA").split())[:200] or None,
            "email": next((w for w in get(cols, "CORREOS").split() if "@" in w), None),
            "termination_note": ending[:200] or None,
            "termination_date": datetime.strptime(ended[0], "%d/%m/%Y").date() if ended else None,
            "status": EmployeeStatus.inactivo if ending else EmployeeStatus.activo,
        }
        rows.append(RosterRow(n, code, first_name, last, position, hire_date, extra=extra))
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
    keep_code: bool = False


def _values(r: RosterRow) -> dict:
    """Lo que la fila fija en la ficha; lo que la fila no trae (código, huella, fecha) no se toca.
    En la planilla completa los campos vacíos sí se guardan vacíos (la planilla manda)."""
    values = dict(code=r.code, first_name=r.first_name, last_name=r.last_name, position=r.position,
                  hire_date=r.hire_date, badge_number=r.badge)
    values = {k: v for k, v in values.items() if v is not None}
    if r.extra:
        values.update({k: v for k, v in r.extra.items() if v is not None or k not in ("base_salary",)})
        values["area"] = area_for(r.position)
    return values


def _same(employee: Employee, values: dict) -> bool:
    return all(getattr(employee, k) == v for k, v in values.items())


def match_roster(db: Session, rows: list[RosterRow]) -> list[RosterMatch]:
    """A qué ficha corresponde cada fila: por código, luego por huella y, si no, por nombre.
    En la planilla completa, primero por nombre (su N° cambia entre versiones)."""
    employees = db.scalars(select(Employee)).all()
    by_code = {e.code: e for e in employees}
    by_badge = {e.badge_number: e for e in employees if e.badge_number}
    keys = {e.id: name_key(e.full_name) for e in employees}

    def known(r: RosterRow) -> Employee | None:
        if r.extra or r.skip:
            return None
        return by_code.get(r.code) or by_badge.get(r.badge)

    taken = {known(r).id for r in rows if known(r)}
    # Nombre exacto primero, para que un nombre corto del CRM no se lleve a otra persona.
    exact: dict[int, Employee] = {}
    for r in rows:
        if r.extra and not r.skip:
            k = name_key(f"{r.first_name} {r.last_name}")
            found = [e for e in employees if keys[e.id] == k and e.id not in taken]
            if len(found) == 1:
                exact[r.line] = found[0]
                taken.add(found[0].id)

    result = []
    for r in rows:
        if r.skip:
            result.append(RosterMatch(r, None, "ambiguo", r.skip))
            continue
        employee, note = known(r) or exact.get(r.line), None
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
            else:
                result.append(RosterMatch(r, None, "nuevo"))
        elif _same(employee, _values(r)):
            result.append(RosterMatch(r, employee, "sin_cambios"))
        else:
            result.append(RosterMatch(r, employee, "actualizar", note))

    # Un código que pasa a otra persona debe quedar libre: si lo tiene alguien que no viene en esta
    # importación (o que no se actualiza), esa fila conserva su código o, si es nueva, no se crea.
    # Se repite hasta que no cambie: quien conserva su código bloquea a su vez a quien lo quería.
    changed = True
    while changed:
        changed = False
        recoded = {m.employee.id for m in result if m.employee and m.status == "actualizar" and not m.keep_code}
        for m in result:
            holder = by_code.get(m.row.code) if m.row.code else None
            if holder is None or (m.employee and holder.id == m.employee.id) or holder.id in recoded:
                continue
            if m.status == "nuevo":
                m.status, m.note, changed = "ambiguo", f"El código {m.row.code} ya es de {holder.full_name}.", True
            elif m.status == "actualizar" and not m.keep_code:
                m.keep_code, changed = True, True
                m.note = f"Conserva el código {m.employee.code}: {m.row.code} es de {holder.full_name}."
    for m in result:
        if m.keep_code and _same(m.employee, {k: v for k, v in _values(m.row).items() if k != "code"}):
            m.status = "sin_cambios"
    return result


def apply_roster(db: Session, matches: list[RosterMatch]) -> dict[str, int]:
    """Crea o actualiza según match_roster; las filas ambiguas no se tocan. No hace commit."""
    counts = {"created": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    created: list[Employee] = []
    updates = [m for m in matches if m.status == "actualizar"]
    # Los códigos se pueden intercambiar entre personas: primero se liberan con uno temporal.
    for m in updates:
        if not m.keep_code and m.row.code and m.employee.code != m.row.code:
            m.employee.code = f"~{m.employee.id}"
    db.flush()
    for m in matches:
        if m.status == "nuevo":
            employee = Employee(**{"code": m.row.badge, "area": area_for(m.row.position), **_values(m.row)})
            db.add(employee)
            created.append(employee)
            db.flush()
            relink_badge(db, employee.id, None, employee.badge_number)
            counts["created"] += 1
        elif m.status == "actualizar":
            old_badge = m.employee.badge_number
            values = _values(m.row)
            if m.keep_code:
                values.pop("code", None)
            if m.row.position != m.employee.position:
                m.employee.area = area_for(m.row.position, m.employee.crm_agent_id)
            for k, v in values.items():
                setattr(m.employee, k, v)
            db.flush()
            relink_badge(db, m.employee.id, old_badge, m.employee.badge_number)
            counts["updated"] += 1
        elif m.status == "sin_cambios":
            counts["unchanged"] += 1
        else:
            counts["skipped"] += 1
    db.flush()
    assign_user_codes(db, [m.employee for m in matches if m.employee] + list(created))
    return counts


def name_key(text: str) -> set[str]:
    """Palabras de un nombre sin tildes ni mayúsculas, para comparar nombres del CRM con la nómina."""
    plain = unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z]+", plain) if w.upper() not in PARTICLES}
