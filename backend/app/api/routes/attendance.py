from datetime import date, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from app.api.deps import DB, HR, Staff
from app.core.config import get_settings
from app.models import Employee, ImportBatch, Punch, ShiftAssignment
from app.schemas import (
    DashboardSummary,
    ImportBatchOut,
    Page,
    PunchOut,
    UnmappedBadge,
)
from app.services.attendance_import import AttendanceImportError, import_attlog
from app.services.storage import get_storage
from app.services.zk_attlog import normalize_badge

router = APIRouter(tags=["marcaciones"])


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


@router.get("/attendance/punches", response_model=Page[PunchOut])
def list_punches(
    db: DB,
    _: Staff,
    date_from: date,
    date_to: date,
    employee_id: int | None = None,
    badge: str | None = None,
    include_double_taps: bool = True,
    only_unmapped: bool = False,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    if date_to < date_from or (date_to - date_from).days > 93:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 3 meses)")
    start, end = _day_bounds(date_from, date_to)
    stmt = select(Punch).where(Punch.punched_at >= start, Punch.punched_at < end)
    if employee_id:
        stmt = stmt.where(Punch.employee_id == employee_id)
    if badge:
        stmt = stmt.where(Punch.badge == normalize_badge(badge))
    if not include_double_taps:
        stmt = stmt.where(Punch.is_double_tap.is_(False))
    if only_unmapped:
        stmt = stmt.where(Punch.employee_id.is_(None))

    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = db.scalars(
        stmt.order_by(Punch.punched_at.desc(), Punch.badge).limit(limit).offset(offset)
    ).all()
    return Page(items=items, total=total)


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
        .where(Punch.employee_id.is_(None))
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
            select(func.count(func.distinct(Punch.badge))).where(Punch.employee_id.is_(None))
        ),
        punches_today=db.scalar(
            select(func.count())
            .select_from(Punch)
            .where(Punch.punched_at >= start, Punch.punched_at < end, Punch.is_double_tap.is_(False))
        ),
        last_import=db.scalar(select(ImportBatch).order_by(ImportBatch.uploaded_at.desc()).limit(1)),
        shifts_today=db.scalar(
            select(func.count()).select_from(ShiftAssignment).where(ShiftAssignment.work_date == today)
        ),
    )
