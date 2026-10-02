"""Asigna el ID de usuario (KR1907) a los empleados que tienen cumpleaños y aún no lo tienen."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, user_code_base


def unique_code(base: str, taken: set[str]) -> str:
    """KR1907; si ya existe, KR1907-2, KR1907-3…"""
    code, n = base, 1
    while code in taken:
        n += 1
        code = f"{base}-{n}"
    return code


def assign_user_codes(db: Session, employees: list[Employee]) -> None:
    """No hace commit. Las fichas se procesan en orden de código para que el sufijo sea estable."""
    pending = [e for e in employees if not e.user_code and user_code_base(e.first_name, e.last_name, e.birthday)]
    if not pending:
        return
    taken = set(db.scalars(select(Employee.user_code).where(Employee.user_code.is_not(None))))
    for e in sorted(pending, key=lambda e: e.id or 0):
        e.user_code = unique_code(user_code_base(e.first_name, e.last_name, e.birthday), taken)
        taken.add(e.user_code)
    db.flush()
