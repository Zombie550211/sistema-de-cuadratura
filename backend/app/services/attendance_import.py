import hashlib
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Device, Employee, ImportBatch, Punch, User
from app.services import audit
from app.services.storage import Storage
from app.services.zk_attlog import flag_double_taps, parse_attlog, serial_from_filename


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
) -> ImportBatch:
    settings = get_settings()
    sha = hashlib.sha256(content).hexdigest()

    previous = db.scalar(select(ImportBatch).where(ImportBatch.sha256 == sha))
    if previous is not None:
        raise AttendanceImportError("Este archivo ya fue importado", previous)

    serial = (device_serial or serial_from_filename(filename) or "").strip().upper()
    if not serial:
        raise AttendanceImportError(
            "No se pudo identificar el reloj. Indique el número de serie del equipo."
        )

    parsed = parse_attlog(content, settings.tz)
    if not parsed.records:
        raise AttendanceImportError("El archivo no contiene marcaciones válidas")

    device = _get_or_create_device(db, serial)
    first = min(r.punched_at for r in parsed.records)
    last = max(r.punched_at for r in parsed.records)

    existing = set(
        db.execute(
            select(Punch.badge, Punch.punched_at).where(
                Punch.device_id == device.id,
                Punch.punched_at >= first,
                Punch.punched_at <= last,
            )
        ).tuples().all()
    )
    new_records = [r for r in parsed.records if (r.badge, r.punched_at) not in existing]

    employees_by_badge = dict(
        db.execute(
            select(Employee.badge_number, Employee.id).where(Employee.badge_number.is_not(None))
        ).tuples().all()
    )

    storage_key = storage.save(
        f"{serial}/{datetime.now(settings.tz):%Y/%m}/{sha}.dat", content
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
        unknown_badges=len({r.badge for r in parsed.records} - employees_by_badge.keys()),
        date_from=first.astimezone(settings.tz).date(),
        date_to=last.astimezone(settings.tz).date(),
    )
    db.add(batch)
    db.flush()

    db.add_all(
        Punch(
            device_id=device.id,
            badge=r.badge,
            employee_id=employees_by_badge.get(r.badge),
            punched_at=r.punched_at,
            verify_mode=r.verify_mode,
            status_code=r.status_code,
            work_code=r.work_code,
            import_batch_id=batch.id,
        )
        for r in new_records
    )
    db.flush()

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
        {"archivo": filename, "reloj": serial, "insertadas": batch.inserted},
    )
    db.commit()
    db.refresh(batch)
    return batch


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
