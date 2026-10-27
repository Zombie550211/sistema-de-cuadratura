import hashlib
import re
from datetime import datetime, timedelta

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Device, Employee, ImportBatch, Punch, User
from app.services import audit
from app.services.excel import ExcelError, is_excel, parse_excel_punches
from app.services.storage import Storage
from app.services.zk_attlog import flag_double_taps, parse_attlog, serial_from_filename

# Para reconocer el local de un archivo, al menos esta fracción de sus IDs debe coincidir con
# las huellas de ese local en la planilla.
LOCAL_MIN_MATCH = 0.6
# …y sacarle esta ventaja al segundo local; si no, se pregunta a RRHH.
LOCAL_MIN_MARGIN = 0.2


class AttendanceImportError(Exception):
    def __init__(self, message: str, batch: ImportBatch | None = None):
        super().__init__(message)
        self.batch = batch


def _get_or_create_device(db: Session, serial: str) -> Device:
    device = db.scalar(select(Device).where(Device.serial_number == serial))
    if device is None:
        device = Device(serial_number=serial, name=f"Reloj {serial}")
        db.add(device)
        db.flush()
    return device


def known_locals(db: Session) -> list[str]:
    """Locales conocidos: las columnas HUELLA de la planilla y los ya asignados a un reloj."""
    keys = {k for fp in db.scalars(select(Employee.fingerprints)) for k in (fp or {})}
    keys |= set(db.scalars(select(Device.fingerprint_key).where(Device.fingerprint_key.is_not(None))))
    return sorted(keys)


def _local_code(key: str) -> tuple[str, str] | None:
    """'LA24 comedor' -> ('LA', '24'): letras y número del local."""
    match = re.match(r"\s*([A-Za-z]+)[\s._-]*(\d+)", key)
    return (match.group(1).upper(), match.group(2).lstrip("0") or "0") if match else None


def local_from_filename(db: Session, filename: str) -> str | None:
    """El local escrito en el nombre del archivo ('… LA-18.xlsx', '… LB8 …'), si es uno solo."""
    found = set()
    for key in known_locals(db):
        code = _local_code(key)
        if code and re.search(
            rf"(?<![A-Z0-9]){code[0]}[\s._-]*0*{code[1]}(?!\d)", filename.rsplit("/", 1)[-1].upper()
        ):
            found.add(key)
    return found.pop() if len(found) == 1 else None


def detect_local(db: Session, badges: set[str], names: dict[str, str] | None = None) -> str | None:
    """El local cuyas huellas (planilla) coinciden con más IDs del archivo, si son mayoría clara.
    Los IDs se repiten entre relojes (1, 2, 3…): si el archivo trae nombres, solo cuenta un ID
    cuyo nombre coincide con el del empleado, y si otro local queda casi igual no se adivina."""
    from app.services.employee_roster import name_key

    if not badges:
        return None
    names = names or {}
    counts: dict[str, int] = {}
    for first, last, fp in db.execute(select(Employee.first_name, Employee.last_name, Employee.fingerprints)):
        for key, value in (fp or {}).items():
            badge = str(value).strip()
            if badge not in badges:
                continue
            if badge in names:
                wanted, have = name_key(names[badge]), name_key(f"{first} {last}")
                if len(wanted & have) < min(2, len(wanted)):
                    continue
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return None
    ranked = sorted(counts.values(), reverse=True)
    best = max(counts, key=counts.get)
    if ranked[0] / len(badges) < LOCAL_MIN_MATCH:
        return None
    if len(ranked) > 1 and (ranked[0] - ranked[1]) / len(badges) < LOCAL_MIN_MARGIN:
        return None
    return best


def link_unmapped_punches(db: Session, skip: set[tuple[int, str]] | None = None) -> int:
    """Pone nombre a las marcas sin empleado: por la huella del local del reloj (planilla) y, si
    no, por el ID de reloj del empleado. Se llama tras importar y al crear o editar empleados.

    `skip` son pares (reloj, número) que NO se enganchan por huella: se usa para las marcas cuyo
    número en el archivo venía con nombre pero el nombre no cuadró con ninguna ficha, para no
    colgarlas de la huella de otra persona (misma regla: el nombre manda)."""
    skip = skip or set()
    local_of = dict(db.execute(select(Device.id, Device.fingerprint_key)).tuples().all())
    by_badge: dict[str, int] = {}
    by_local: dict[str, dict[str, int]] = {}
    for emp_id, badge, fingerprints in db.execute(select(Employee.id, Employee.badge_number, Employee.fingerprints)):
        if badge:
            by_badge[badge] = emp_id
        for key, value in (fingerprints or {}).items():
            by_local.setdefault(key, {})[str(value).strip()] = emp_id

    targets: dict[int, list[int]] = {}
    rows = db.execute(select(Punch.id, Punch.device_id, Punch.badge).where(Punch.employee_id.is_(None))).all()
    for punch_id, device_id, badge in rows:
        if (device_id, badge) in skip:
            continue
        emp_id = by_local.get(local_of.get(device_id) or "", {}).get(badge) or by_badge.get(badge)
        if emp_id:
            targets.setdefault(emp_id, []).append(punch_id)
    for emp_id, ids in targets.items():
        db.execute(update(Punch).where(Punch.id.in_(ids)).values(employee_id=emp_id))
    return sum(len(ids) for ids in targets.values())


def _match_by_name(employees: list[Employee], keys: dict[int, set[str]], wanted: set[str]) -> Employee | None:
    """Busca la ficha cuyo nombre completo coincide con `wanted` (conjunto de palabras del nombre
    que trae el archivo). Primero exige las mismas palabras; si no, acepta que a uno le falten o
    le sobren nombres intermedios (uno es subconjunto del otro) siempre que compartan al menos dos
    palabras y el resultado sea único. Si hay empate, no se arriesga y devuelve None."""
    if not wanted:
        return None
    exact = [e for e in employees if keys[e.id] == wanted]
    if exact:
        return exact[0] if len(exact) == 1 else None
    partial = [
        e for e in employees
        if keys[e.id] and (wanted <= keys[e.id] or keys[e.id] <= wanted) and len(wanted & keys[e.id]) >= 2
    ]
    return partial[0] if len(partial) == 1 else None


def link_by_name(db: Session, device, names: dict[str, str]) -> set[str]:
    """Empareja por NOMBRE contra la base de empleados (método principal cuando el archivo trae
    nombres, robusto al formato). Para cada número con nombre válido: lo vincula a la ficha cuyo
    nombre coincide y, de paso, aprende la huella de ese local en la ficha (si está libre) para la
    próxima importación. Devuelve los números cuyo nombre NO cuadró con nadie: esas marcas se
    dejan sueltas en vez de colgarlas de la huella de otra persona."""
    from app.services.employee_roster import name_key

    unresolved: set[str] = set()
    unmapped = set(
        db.scalars(
            select(Punch.badge).where(Punch.device_id == device.id, Punch.employee_id.is_(None)).distinct()
        )
    )
    if not unmapped:
        return unresolved
    local = device.fingerprint_key
    employees = db.scalars(select(Employee)).all()
    keys = {e.id: name_key(e.full_name) for e in employees}
    # (local, número) ya en uso por otra ficha: no se pisa al aprender la huella.
    taken: set[tuple[str, str]] = set()
    for e in employees:
        for key, value in (e.fingerprints or {}).items():
            taken.add((key, str(value).strip()))

    for badge in unmapped & names.keys():
        employee = _match_by_name(employees, keys, name_key(names[badge]))
        if employee is None:
            unresolved.add(badge)
            continue
        if local and str((employee.fingerprints or {}).get(local, "")).strip() != badge and (local, badge) not in taken:
            fps = dict(employee.fingerprints or {})
            fps[local] = badge
            employee.fingerprints = fps
            taken.add((local, badge))
        db.execute(
            update(Punch)
            .where(Punch.device_id == device.id, Punch.badge == badge, Punch.employee_id.is_(None))
            .values(employee_id=employee.id)
        )
    return unresolved


def recompute_double_taps(
    db: Session, device_id: int, badges: set[str], start: datetime, end: datetime
) -> None:
    """Recalcula la bandera de doble marca en el rango afectado. Se incluye un día de margen
    para que una importación nueva se evalúe junto a las marcas que ya estaban en la base."""
    window = get_settings().double_tap_seconds
    rows = db.execute(
        select(Punch.id, Punch.badge, Punch.punched_at, Punch.is_double_tap)
        .where(
            Punch.device_id == device_id,
            Punch.badge.in_(badges),
            Punch.deleted_at.is_(None),
            Punch.punched_at >= start - timedelta(days=1),
            Punch.punched_at <= end + timedelta(days=1),
        )
        .order_by(Punch.badge, Punch.punched_at)
    ).all()

    by_badge: dict[str, list] = {}
    for row in rows:
        by_badge.setdefault(row.badge, []).append(row)

    to_true, to_false = [], []
    for badge_rows in by_badge.values():
        flags = flag_double_taps([r.punched_at for r in badge_rows], window)
        for row, flag in zip(badge_rows, flags, strict=True):
            if flag != row.is_double_tap:
                (to_true if flag else to_false).append(row.id)

    if to_true:
        db.execute(update(Punch).where(Punch.id.in_(to_true)).values(is_double_tap=True))
    if to_false:
        db.execute(update(Punch).where(Punch.id.in_(to_false)).values(is_double_tap=False))


def import_attlog(
    db: Session,
    *,
    content: bytes,
    filename: str,
    storage: Storage,
    user: User,
    device_serial: str | None = None,
    local: str | None = None,
) -> ImportBatch:
    """Importa el attlog del reloj (.dat) o una exportación de marcaciones en Excel.
    El local se toma del reloj ya conocido, del indicado por RRHH o se detecta por las huellas."""
    settings = get_settings()
    sha = hashlib.sha256(content).hexdigest()

    previous = db.scalar(select(ImportBatch).where(ImportBatch.sha256 == sha))
    if previous is not None:
        raise AttendanceImportError("Este archivo ya fue importado", previous)

    names: dict[str, str] = {}
    excel = is_excel(content)
    if excel:
        try:
            parsed, names = parse_excel_punches(content, settings.tz)
        except ExcelError as exc:
            raise AttendanceImportError(str(exc)) from exc
    else:
        parsed = parse_attlog(content, settings.tz)
    if not parsed.records:
        raise AttendanceImportError("El archivo no contiene marcaciones válidas")

    local = (local or "").strip() or None
    serial = (device_serial or serial_from_filename(filename) or "").strip().upper()
    device = db.scalar(select(Device).where(Device.serial_number == serial)) if serial else None
    if device is None and not serial:
        # Sin número de serie (p. ej. un Excel): el reloj es el del local indicado, el escrito en
        # el nombre del archivo o el detectado por las huellas.
        local = (
            local
            or local_from_filename(db, filename)
            or detect_local(db, {r.badge for r in parsed.records}, names)
        )
        if not local:
            raise AttendanceImportError(
                "No se pudo identificar el local de este archivo. Indique de qué local es."
            )
        device = db.scalar(select(Device).where(Device.fingerprint_key == local).order_by(Device.id))
        serial = device.serial_number if device else f"LOCAL-{local}".upper().replace(" ", "-")[:64]
    device = device or _get_or_create_device(db, serial)
    if local and device.fingerprint_key != local:
        device.fingerprint_key = local
    elif not device.fingerprint_key:
        device.fingerprint_key = local_from_filename(db, filename) or detect_local(
            db, {r.badge for r in parsed.records}, names
        )
    if device.fingerprint_key and device.name.startswith("Reloj "):
        device.name = device.fingerprint_key

    first = min(r.punched_at for r in parsed.records)
    last = max(r.punched_at for r in parsed.records)

    # Se compara contra la hora original del reloj (también de marcas corregidas o eliminadas
    # por RRHH), para que una descarga nueva no las vuelva a meter.
    existing: set = set()
    for badge, at, original in db.execute(
        select(Punch.badge, Punch.punched_at, Punch.original_punched_at).where(
            Punch.device_id == device.id,
            or_(
                Punch.punched_at.between(first, last),
                Punch.original_punched_at.between(first, last),
            ),
        )
    ):
        existing.add((badge, original or at))
    new_records = [r for r in parsed.records if (r.badge, r.punched_at) not in existing]

    ext = "xlsx" if content.startswith(b"PK") else "xls" if excel else "dat"
    storage_key = storage.save(
        f"{serial}/{datetime.now(settings.tz):%Y/%m}/{sha}.{ext}", content
    )
    batch = ImportBatch(
        device_id=device.id,
        original_filename=filename[:255],
        sha256=sha,
        storage_key=storage_key,
        uploaded_by_id=user.id,
        total_lines=parsed.total_lines,
        inserted=len(new_records),
        already_present=len(parsed.records) - len(new_records) + parsed.duplicate_lines,
        invalid_lines=len(parsed.errors),
        date_from=first.astimezone(settings.tz).date(),
        date_to=last.astimezone(settings.tz).date(),
    )
    db.add(batch)
    db.flush()

    db.add_all(
        Punch(
            device_id=device.id,
            badge=r.badge,
            punched_at=r.punched_at,
            verify_mode=r.verify_mode,
            status_code=r.status_code,
            work_code=r.work_code,
            import_batch_id=batch.id,
        )
        for r in new_records
    )
    db.flush()
    # El nombre manda: primero se empareja por nombre contra la base de empleados. Los números
    # que traían nombre pero no cuadraron con nadie se dejan sueltos (no se cuelgan de la huella
    # de otra persona). El resto (números sin nombre en el archivo) se engancha por huella/ID.
    skip = {(device.id, badge) for badge in link_by_name(db, device, names)} if names else set()
    link_unmapped_punches(db, skip=skip)
    db.flush()

    batch.unknown_badges = db.scalar(
        select(func.count(func.distinct(Punch.badge))).where(
            Punch.device_id == device.id,
            Punch.employee_id.is_(None),
            Punch.badge.in_({r.badge for r in parsed.records}),
        )
    )
    if new_records:
        recompute_double_taps(db, device.id, {r.badge for r in new_records}, first, last)
        batch.double_taps = db.scalar(
            select(func.count())
            .select_from(Punch)
            .where(Punch.import_batch_id == batch.id, Punch.is_double_tap.is_(True))
        )

    audit.record(
        db,
        user,
        "importar",
        "import_batch",
        batch.id,
        {"archivo": filename, "reloj": serial, "local": device.fingerprint_key, "insertadas": batch.inserted},
    )
    db.commit()
    db.refresh(batch)
    return batch


def delete_import(db: Session, batch: ImportBatch, storage: Storage, user: User) -> int:
    """Borra un archivo importado y las marcas que entraron con él (las que ya existían por un
    archivo anterior se quedan). Así el mismo archivo se puede volver a subir."""
    rows = db.execute(
        select(Punch.badge, Punch.punched_at).where(Punch.import_batch_id == batch.id)
    ).all()
    db.execute(delete(Punch).where(Punch.import_batch_id == batch.id))
    if rows:
        times = [r.punched_at for r in rows]
        recompute_double_taps(db, batch.device_id, {r.badge for r in rows}, min(times), max(times))
    audit.record(
        db,
        user,
        "eliminar",
        "import_batch",
        batch.id,
        {"archivo": batch.original_filename, "marcas_borradas": len(rows)},
    )
    key = batch.storage_key
    db.delete(batch)
    db.commit()
    try:
        storage.delete(key)
    except Exception:  # el registro ya se borró; un archivo huérfano no es grave
        pass
    return len(rows)


def relink_badge(db: Session, employee_id: int, old_badge: str | None, new_badge: str | None):
    """Cuando cambia el ID de reloj de un empleado, re-asocia sus marcaciones."""
    if old_badge == new_badge:
        return
    if old_badge:
        db.execute(
            update(Punch)
            .where(Punch.badge == old_badge, Punch.employee_id == employee_id)
            .values(employee_id=None)
        )
    if new_badge:
        db.execute(update(Punch).where(Punch.badge == new_badge).values(employee_id=employee_id))
