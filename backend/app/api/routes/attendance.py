from datetime import date, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, Staff
from app.core.config import get_settings
from app.models import AREAS, AppSetting, Device, Employee, ImportBatch, Punch, ShiftAssignment
from app.schemas import (
    BadgeLinkIn,
    CutDate,
    DashboardSummary,
    DeviceOut,
    ImportBatchOut,
    LatenessOut,
    LocalesOut,
    LocalOut,
    Page,
    PunchEdit,
    PunchOut,
    UnmappedBadge,
)
from app.services import audit
from app.services.attendance_import import (
    AttendanceImportError,
    delete_import,
    import_attlog,
    known_locals,
    recompute_double_taps,
)
from app.services.lateness import lateness
from app.services.storage import get_storage
from app.services.zk_attlog import normalize_badge

router = APIRouter(tags=["marcaciones"])

# Las marcas eliminadas por RRHH se conservan para la auditoría, pero no se muestran ni cuentan.
ACTIVE = Punch.deleted_at.is_(None)


def _day_bounds(day_from: date, day_to: date) -> tuple[datetime, datetime]:
    tz = get_settings().tz
    return (
        datetime.combine(day_from, time.min, tz),
        datetime.combine(day_to + timedelta(days=1), time.min, tz),
    )


@router.post("/attendance/imports", response_model=ImportBatchOut, status_code=201)
async def upload_attlog(
    db: DB,
    user: HR,
    file: Annotated[UploadFile, File()],
    device_serial: Annotated[str | None, Form(max_length=64)] = None,
    local: Annotated[str | None, Form(max_length=40)] = None,
):
    max_bytes = get_settings().max_upload_mb * 1024 * 1024
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Archivo demasiado grande")
    try:
        return import_attlog(
            db,
            content=content,
            filename=file.filename or "attlog.dat",
            storage=get_storage(),
            user=user,
            device_serial=device_serial,
            local=local,
        )
    except AttendanceImportError as exc:
        db.rollback()
        body = {"detail": str(exc)}
        if exc.batch is not None:
            body["batch"] = ImportBatchOut.model_validate(exc.batch).model_dump(mode="json")
            return JSONResponse(body, status_code=status.HTTP_409_CONFLICT)
        return JSONResponse(body, status_code=422)


@router.get("/attendance/imports", response_model=Page[ImportBatchOut])
def list_imports(
    db: DB,
    _: Staff,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    total = db.scalar(select(func.count()).select_from(ImportBatch))
    items = db.scalars(
        select(ImportBatch).order_by(ImportBatch.uploaded_at.desc()).limit(limit).offset(offset)
    ).all()
    return Page(items=items, total=total)


@router.delete("/attendance/imports/{batch_id}", status_code=204)
def remove_import(batch_id: int, db: DB, user: HR):
    batch = db.get(ImportBatch, batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Importación no encontrada")
    delete_import(db, batch, get_storage(), user)


AreaParam = Annotated[str | None, Query(pattern="^(" + "|".join(AREAS) + ")$")]


def _by_section(stmt, area: str | None, only_unmapped: bool):
    """Marcaciones se separa por sección (área del empleado) como Empleados; las marcas sin
    empleado van aparte."""
    if only_unmapped:
        return stmt.where(Punch.employee_id.is_(None))
    if area:
        return stmt.join(Employee, Punch.employee_id == Employee.id).where(Employee.area == area)
    return stmt


@router.get("/attendance/locales", response_model=LocalesOut)
def list_locales(db: DB, _: Staff, area: AreaParam = None, only_unmapped: bool = False):
    """Un local por reloj, con cuántas marcas tiene (de la sección pedida): son las pestañas."""
    counts = dict(
        db.execute(
            _by_section(select(Punch.device_id, func.count()).where(ACTIVE), area, only_unmapped).group_by(Punch.device_id)
        ).tuples().all()
    )
    devices = [
        LocalOut(**DeviceOut.model_validate(d).model_dump(), punches=counts.get(d.id, 0))
        for d in db.scalars(select(Device))
    ]
    devices.sort(key=lambda d: ((d.fingerprint_key or d.name).upper(), d.id))
    return LocalesOut(devices=devices, known=known_locals(db))


@router.get("/attendance/punches", response_model=Page[PunchOut])
def list_punches(
    db: DB,
    _: Staff,
    date_from: date,
    date_to: date,
    employee_id: int | None = None,
    device_id: int | None = None,
    area: AreaParam = None,
    badge: str | None = None,
    include_double_taps: bool = True,
    only_unmapped: bool = False,
    limit: Annotated[int, Query(ge=1, le=10000)] = 500,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    if date_to < date_from or (date_to - date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    start, end = _day_bounds(date_from, date_to)
    stmt = select(Punch).where(ACTIVE, Punch.punched_at >= start, Punch.punched_at < end)
    if device_id:
        stmt = stmt.where(Punch.device_id == device_id)
    if employee_id:
        stmt = stmt.where(Punch.employee_id == employee_id)
    if badge:
        stmt = stmt.where(Punch.badge == normalize_badge(badge))
    if not include_double_taps:
        stmt = stmt.where(Punch.is_double_tap.is_(False))
    stmt = _by_section(stmt, area, only_unmapped)

    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = db.scalars(
        stmt.order_by(Punch.punched_at.desc(), Punch.badge).limit(limit).offset(offset)
    ).all()
    return Page(items=items, total=total)


CUT_DATE = "marcaciones.fecha_corte"


@router.get("/attendance/cut-date", response_model=CutDate | None)
def get_cut_date(db: DB, _: Staff):
    """Fecha de corte guardada (la misma para todos), o null si se ve por quincena."""
    setting = db.get(AppSetting, CUT_DATE)
    return CutDate(**setting.value) if setting else None


@router.put("/attendance/cut-date", response_model=CutDate)
def set_cut_date(data: CutDate, db: DB, user: HR):
    """Guarda la fecha de corte; queda así hasta que se cambie o se quite."""
    if data.date_to < data.date_from or (data.date_to - data.date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    value = data.model_dump(mode="json")
    setting = db.get(AppSetting, CUT_DATE)
    if setting is None:
        db.add(AppSetting(key=CUT_DATE, value=value, updated_by_id=user.id))
    else:
        setting.value, setting.updated_by_id = value, user.id
    audit.record(db, user, "fecha_corte", "app_setting", CUT_DATE, value)
    db.commit()
    return data


@router.delete("/attendance/cut-date", status_code=204)
def clear_cut_date(db: DB, user: HR):
    setting = db.get(AppSetting, CUT_DATE)
    if setting is not None:
        audit.record(db, user, "quitar_fecha_corte", "app_setting", CUT_DATE, setting.value)
        db.delete(setting)
        db.commit()


@router.get("/attendance/lateness", response_model=list[LatenessOut])
def list_lateness(db: DB, _: Staff, date_from: date, date_to: date, area: AreaParam = None, employee_id: int | None = None):
    """Llegadas tarde por día con turno (entrada vs. inicio del turno), acumuladas por quincena:
    los primeros minutos que se perdonan no cuentan."""
    if date_to < date_from or (date_to - date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    return [LatenessOut(**vars(d)) for d in lateness(db, date_from, date_to, area, employee_id)]


def _active_punch(db: DB, punch_id: int) -> Punch:
    punch = db.get(Punch, punch_id)
    if punch is None or punch.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Marca no encontrada")
    return punch


@router.patch("/attendance/punches/{punch_id}", response_model=PunchOut)
def edit_punch(punch_id: int, data: PunchEdit, db: DB, user: HR):
    """RRHH corrige la hora de una marca. La hora del reloj queda guardada como original."""
    punch = _active_punch(db, punch_id)
    new_at = data.punched_at if data.punched_at.tzinfo else data.punched_at.replace(tzinfo=get_settings().tz)
    before = punch.punched_at
    if new_at == before:
        return punch
    if punch.original_punched_at is None:
        punch.original_punched_at = before
    punch.punched_at = new_at
    punch.edited_by_id = user.id
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe otra marca de esa persona a esa hora")
    recompute_double_taps(db, punch.device_id, {punch.badge}, min(before, new_at), max(before, new_at))
    audit.record(
        db, user, "editar", "punch", punch.id,
        {"id_reloj": punch.badge, "antes": before.isoformat(), "despues": new_at.isoformat()},
    )
    db.commit()
    db.refresh(punch)
    return punch


@router.delete("/attendance/punches/{punch_id}", status_code=204)
def delete_punch(punch_id: int, db: DB, user: HR):
    punch = _active_punch(db, punch_id)
    punch.deleted_at = datetime.now(get_settings().tz)
    punch.deleted_by_id = user.id
    punch.is_double_tap = False
    db.flush()
    recompute_double_taps(db, punch.device_id, {punch.badge}, punch.punched_at, punch.punched_at)
    audit.record(
        db, user, "eliminar", "punch", punch.id,
        {"id_reloj": punch.badge, "hora": punch.punched_at.isoformat(), "empleado_id": punch.employee_id},
    )
    db.commit()


@router.post("/attendance/badges/link", status_code=204)
def link_badge(data: BadgeLinkIn, db: DB, user: HR):
    """Asigna un ID de reloj sin empleado a una persona: queda como su huella en ese local
    (o como su ID de reloj si el reloj no tiene local) y sus marcas toman su nombre."""
    device = db.get(Device, data.device_id)
    employee = db.get(Employee, data.employee_id)
    if device is None or employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reloj o empleado no encontrado")
    badge = normalize_badge(data.badge)
    if device.fingerprint_key:
        employee.fingerprints = {**(employee.fingerprints or {}), device.fingerprint_key: badge}
    elif not employee.badge_number:
        employee.badge_number = badge
    db.execute(
        update(Punch)
        .where(Punch.device_id == device.id, Punch.badge == badge, Punch.employee_id.is_(None))
        .values(employee_id=employee.id)
    )
    audit.record(db, user, "vincular", "employee", employee.id, {"id_reloj": badge, "local": device.fingerprint_key})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese ID de reloj ya está asignado a otro empleado")


@router.get("/attendance/unmapped-badges", response_model=list[UnmappedBadge])
def unmapped_badges(db: DB, _: Staff):
    """IDs del reloj que todavía no están vinculados a ningún empleado."""
    rows = db.execute(
        select(
            Punch.badge,
            func.count().label("punches"),
            func.min(Punch.punched_at).label("first_seen"),
            func.max(Punch.punched_at).label("last_seen"),
        )
        .where(ACTIVE, Punch.employee_id.is_(None))
        .group_by(Punch.badge)
    ).all()
    result = [UnmappedBadge.model_validate(r, from_attributes=True) for r in rows]
    return sorted(result, key=lambda b: (len(b.badge), b.badge))


@router.get("/dashboard/summary", response_model=DashboardSummary)
def dashboard_summary(db: DB, _: Staff):
    today = datetime.now(get_settings().tz).date()
    start, end = _day_bounds(today, today)
    active = Employee.status == "activo"
    return DashboardSummary(
        employees_active=db.scalar(select(func.count()).select_from(Employee).where(active)),
        employees_without_badge=db.scalar(
            select(func.count()).select_from(Employee).where(active, Employee.badge_number.is_(None))
        ),
        unmapped_badges=db.scalar(
            select(func.count(func.distinct(Punch.badge))).where(ACTIVE, Punch.employee_id.is_(None))
        ),
        punches_today=db.scalar(
            select(func.count())
            .select_from(Punch)
            .where(ACTIVE, Punch.punched_at >= start, Punch.punched_at < end, Punch.is_double_tap.is_(False))
        ),
        last_import=db.scalar(select(ImportBatch).order_by(ImportBatch.uploaded_at.desc()).limit(1)),
        shifts_today=db.scalar(
            select(func.count()).select_from(ShiftAssignment).where(ShiftAssignment.work_date == today)
        ),
    )
