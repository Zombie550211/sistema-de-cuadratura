from datetime import date
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, CurrentUser, Staff
from app.core.config import get_settings
from app.models import (
    AREAS,
    SalaryCertificate,
    Department,
    Employee,
    EmployeeStatus,
    IntegrationSync,
    Role,
    ShiftAssignment,
    ShiftDayOff,
    User,
    area_for,
)
from app.schemas import (
    CertificateDetail,
    CertificateIn,
    CertificateOut,
    DepartmentIn,
    DepartmentOut,
    EmployeeCreate,
    EmployeeOut,
    EmployeeScheduleOut,
    EmployeeUpdate,
    ExcelTextOut,
    LeaveTotals,
    Page,
    RosterImportIn,
    RosterImportOut,
    RosterRowOut,
)
from app.services import audit
from app.services.attendance_day import employee_days
from app.services.attendance_import import link_unmapped_punches, relink_badge
from app.services.excel import ExcelError, sheet_as_text
from app.services.user_code import assign_user_codes
from app.services.employee_roster import apply_roster, match_roster, parse_roster

router = APIRouter(tags=["empleados"])


def _integrity_message(exc: IntegrityError) -> str:
    text = str(exc.orig)
    if "badge_number" in text:
        return "Ese ID de reloj ya está asignado a otro empleado"
    if "user_code" in text:
        return "Ese ID de usuario ya está asignado a otro empleado"
    if "crm_agent_id" in text:
        return "Ese ID de CRM ya está asignado a otro empleado"
    if "dui" in text:
        return "Ese DUI ya está registrado"
    if "code" in text:
        return "Ese código de empleado ya existe"
    return "Datos duplicados"


@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(db: DB, _: Staff):
    return db.scalars(select(Department).order_by(Department.section == "lineas", Department.sort_key)).all()


@router.post("/departments", response_model=DepartmentOut, status_code=status.HTTP_201_CREATED)
def create_department(data: DepartmentIn, db: DB, user: HR):
    dept = Department(name=data.name.strip())
    db.add(dept)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese departamento ya existe")
    audit.record(db, user, "crear", "department", dept.id, {"nombre": dept.name})
    db.commit()
    return dept


@router.get("/employees", response_model=Page[EmployeeOut])
def list_employees(
    db: DB,
    _: Staff,
    q: str | None = None,
    status_: Annotated[EmployeeStatus | None, Query(alias="status")] = None,
    department_id: int | None = None,
    area: Annotated[str | None, Query(pattern="^(" + "|".join(AREAS) + ")$")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    stmt = select(Employee).outerjoin(Department, Employee.department_id == Department.id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        # Por nombre, cada palabra debe aparecer en nombres + apellidos (en cualquier orden), así
        # se encuentra al pegar el nombre completo o al buscar "Cristhian Sanchez".
        full_name = func.concat_ws(" ", Employee.first_name, Employee.last_name)
        stmt = stmt.where(
            or_(
                and_(*(full_name.ilike(f"%{word}%") for word in q.split())),
                Employee.badge_number == q.strip(),
                Employee.dui.ilike(like),
                Employee.user_code.ilike(like),
            )
        )
    if status_:
        stmt = stmt.where(Employee.status == status_)
    if department_id:
        stmt = stmt.where(Employee.department_id == department_id)
    if area:
        stmt = stmt.where(Employee.area == area)

    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = db.scalars(
        stmt.order_by(*Employee.team_order()).limit(limit).offset(offset)
    ).all()
    return Page(items=items, total=total)


def _get_visible_employee(db, user: User, employee_id: int) -> Employee:
    """El personal ve a todos; un empleado solo puede ver su propio perfil."""
    if user.role == Role.empleado and user.employee_id != employee_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No tiene permiso para ver este perfil")
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    return employee


@router.get("/employees/{employee_id}", response_model=EmployeeOut)
def get_employee(employee_id: int, db: DB, user: CurrentUser):
    return _get_visible_employee(db, user, employee_id)


@router.get("/employees/{employee_id}/schedule", response_model=EmployeeScheduleOut)
def employee_schedule(employee_id: int, date_from: date, date_to: date, db: DB, user: CurrentUser):
    """Horario (el que llegó del CRM o el ajustado por RRHH) y marcaciones del empleado, por día."""
    _get_visible_employee(db, user, employee_id)
    if date_to < date_from or (date_to - date_from).days > 62:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rango de fechas inválido (máx. 2 meses)")
    last_sync = db.scalar(
        select(func.max(IntegrationSync.received_at))
        .join(ShiftAssignment, ShiftAssignment.sync_id == IntegrationSync.id)
        .where(ShiftAssignment.employee_id == employee_id)
    )
    year = date_from.year
    leave = dict(
        db.execute(
            select(ShiftDayOff.kind, func.count())
            .where(
                ShiftDayOff.employee_id == employee_id,
                ShiftDayOff.work_date >= date(year, 1, 1),
                ShiftDayOff.work_date <= date(year, 12, 31),
            )
            .group_by(ShiftDayOff.kind)
        ).tuples().all()
    )
    return EmployeeScheduleOut(
        employee_id=employee_id,
        date_from=date_from,
        date_to=date_to,
        last_crm_sync_at=last_sync,
        days=employee_days(db, employee_id, date_from, date_to),
        leave=LeaveTotals(year=year, vacacion=leave.get("vacacion", 0), compensatorio=leave.get("compensatorio", 0)),
    )


@router.post("/employees/import", response_model=RosterImportOut)
def import_roster(data: RosterImportIn, db: DB, user: HR):
    """Nómina pegada desde Excel. Con dry_run devuelve la vista previa; si hay errores no se guarda nada."""
    rows, errors = parse_roster(data.text)
    matches = match_roster(db, rows)
    out = RosterImportOut(
        rows=[RosterRowOut(**vars(m.row), area=area_for(m.row.position) if m.row.extra else None, status=m.status, note=m.note) for m in matches],
        errors=[vars(e) for e in errors],
        created=sum(m.status == "nuevo" for m in matches),
        updated=sum(m.status == "actualizar" for m in matches),
        unchanged=sum(m.status == "sin_cambios" for m in matches),
        skipped=sum(m.status == "ambiguo" for m in matches),
    )
    if data.dry_run or errors or not rows:
        return out
    result = apply_roster(db, matches)
    db.flush()
    link_unmapped_punches(db)
    audit.record(db, user, "importar", "employee", None, result)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _integrity_message(exc))
    out.applied = True
    return out


@router.post("/employees", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(data: EmployeeCreate, db: DB, user: HR):
    values = data.model_dump()
    values.pop("code", None)  # el código ya no se usa: el sistema genera uno interno
    values["area"] = values["area"] or area_for(data.position, data.crm_agent_id)
    employee = Employee(**values)
    db.add(employee)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _integrity_message(exc))
    relink_badge(db, employee.id, None, employee.badge_number)
    link_unmapped_punches(db)
    assign_user_codes(db, [employee])
    audit.record(db, user, "crear", "employee", employee.id, {"nombre": employee.full_name})
    db.commit()
    db.refresh(employee)
    return employee


@router.put("/employees/{employee_id}", response_model=EmployeeOut)
def update_employee(employee_id: int, data: EmployeeUpdate, db: DB, user: HR):
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")

    old_badge = employee.badge_number
    changes = {}
    values = data.model_dump()
    values.pop("code", None)  # el código ya no se usa: no se cambia
    if values["area"] is None:
        values["area"] = area_for(data.position, data.crm_agent_id) if data.position != employee.position else employee.area
    for field, value in values.items():
        current = getattr(employee, field)
        if current != value:
            changes[field] = {"antes": str(current), "despues": str(value)}
            setattr(employee, field, value)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _integrity_message(exc))
    relink_badge(db, employee.id, old_badge, employee.badge_number)
    link_unmapped_punches(db)
    assign_user_codes(db, [employee])
    if changes:
        audit.record(db, user, "editar", "employee", employee.id, changes)
    db.commit()
    db.refresh(employee)
    return employee


@router.delete("/employees/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_employee(employee_id: int, db: DB, user: HR):
    """Borra la ficha con sus turnos y constancias. Sus marcas del reloj se conservan sin nombre."""
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    audit.record(
        db, user, "eliminar", "employee", employee.id,
        {"nombre": employee.full_name, "dui": employee.dui, "id_reloj": employee.badge_number},
    )
    db.execute(sa_delete(Employee).where(Employee.id == employee.id))
    db.commit()


@router.post("/employees/import/excel", response_model=ExcelTextOut)
async def roster_excel_to_text(db: DB, _: HR, file: Annotated[UploadFile, File()]):
    """Convierte la nómina en Excel a texto con tabulaciones, como si se copiara de Excel."""
    content = await file.read(get_settings().max_upload_mb * 1024 * 1024 + 1)
    try:
        return ExcelTextOut(text=sheet_as_text(content))
    except ExcelError as exc:
        raise HTTPException(422, str(exc))


@router.get("/employees/{employee_id}/certificates", response_model=list[CertificateOut])
def list_certificates(employee_id: int, db: DB, _: HR):
    return db.scalars(
        select(SalaryCertificate)
        .where(SalaryCertificate.employee_id == employee_id)
        .order_by(SalaryCertificate.issued_at.desc(), SalaryCertificate.id.desc())
    ).all()


@router.post("/employees/{employee_id}/certificates", response_model=CertificateOut, status_code=status.HTTP_201_CREATED)
def issue_certificate(employee_id: int, data: CertificateIn, db: DB, user: HR):
    """Se llama al descargar la constancia: guarda la hoja tal como salió y quién la emitió."""
    if db.get(Employee, employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Empleado no encontrado")
    cert = SalaryCertificate(employee_id=employee_id, issued_by_id=user.id, issued_by_name=user.full_name, **data.model_dump())
    db.add(cert)
    db.flush()
    audit.record(db, user, "emitir", "salary_certificate", cert.id,
                 {"empleado": employee_id, "plantilla": cert.template, "salario": str(cert.salary), "extra": str(cert.extra)})
    db.commit()
    db.refresh(cert)
    return cert


@router.get("/certificates/{certificate_id}", response_model=CertificateDetail)
def get_certificate(certificate_id: int, db: DB, _: HR):
    cert = db.get(SalaryCertificate, certificate_id)
    if cert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Constancia no encontrada")
    return cert
