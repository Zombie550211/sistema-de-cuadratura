from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, CurrentUser, Staff
from app.models import (
    Department,
    Employee,
    EmployeeStatus,
    IntegrationSync,
    Role,
    ShiftAssignment,
    User,
)
from app.schemas import (
    DepartmentIn,
    DepartmentOut,
    EmployeeCreate,
    EmployeeOut,
    EmployeeScheduleOut,
    EmployeeUpdate,
    Page,
    RosterImportIn,
    RosterImportOut,
    RosterRowOut,
)
from app.services import audit
from app.services.attendance_day import employee_days
from app.services.attendance_import import relink_badge
from app.services.employee_roster import apply_roster, parse_roster

router = APIRouter(tags=["empleados"])


def _integrity_message(exc: IntegrityError) -> str:
    text = str(exc.orig)
    if "badge_number" in text:
        return "Ese ID de reloj ya está asignado a otro empleado"
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
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    stmt = select(Employee).outerjoin(Department, Employee.department_id == Department.id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Employee.first_name.ilike(like),
                Employee.last_name.ilike(like),
                Employee.code.ilike(like),
                Employee.badge_number == q.strip(),
                Employee.dui.ilike(like),
            )
        )
    if status_:
        stmt = stmt.where(Employee.status == status_)
    if department_id:
        stmt = stmt.where(Employee.department_id == department_id)

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
    return EmployeeScheduleOut(
        employee_id=employee_id,
        date_from=date_from,
        date_to=date_to,
        last_crm_sync_at=last_sync,
        days=employee_days(db, employee_id, date_from, date_to),
    )


@router.post("/employees/import", response_model=RosterImportOut)
def import_roster(data: RosterImportIn, db: DB, user: HR):
    """Nómina pegada desde Excel. Con dry_run devuelve la vista previa; si hay errores no se guarda nada."""
    rows, errors = parse_roster(data.text)
    existing = {
        e.code: e for e in db.scalars(select(Employee).where(Employee.code.in_([r.code for r in rows])))
    }

    def status_of(r):
        e = existing.get(r.code)
        if e is None:
            return "nuevo"
        same = (e.first_name, e.last_name, e.position, e.hire_date) == (r.first_name, r.last_name, r.position, r.hire_date)
        return "sin_cambios" if same else "actualizar"

    out = RosterImportOut(
        rows=[RosterRowOut(**vars(r), status=status_of(r)) for r in rows],
        errors=[vars(e) for e in errors],
    )
    out.created = sum(r.status == "nuevo" for r in out.rows)
    out.updated = sum(r.status == "actualizar" for r in out.rows)
    out.unchanged = sum(r.status == "sin_cambios" for r in out.rows)
    if data.dry_run or errors or not rows:
        return out
    result = apply_roster(db, rows)
    audit.record(db, user, "importar", "employee", None, result)
    db.commit()
    out.applied = True
    return out


@router.post("/employees", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(data: EmployeeCreate, db: DB, user: HR):
    employee = Employee(**data.model_dump())
    db.add(employee)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _integrity_message(exc))
    relink_badge(db, employee.id, None, employee.badge_number)
    audit.record(db, user, "crear", "employee", employee.id, {"codigo": employee.code})
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
    for field, value in data.model_dump().items():
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
    if changes:
        audit.record(db, user, "editar", "employee", employee.id, changes)
    db.commit()
    db.refresh(employee)
    return employee
