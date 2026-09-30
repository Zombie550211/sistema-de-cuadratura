"""Utilidades de administración.

    python -m app.cli crear-admin <usuario> "<Nombre completo>"
    python -m app.cli importar-empleados <archivo.tsv>   (código, nombre, cargo, fecha de ingreso)
"""

import getpass
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import Role, User
from app.services import audit
from app.services.employee_roster import apply_roster, parse_roster


def crear_admin(username: str, full_name: str) -> None:
    password = getpass.getpass("Contraseña (mín. 8 caracteres): ")
    if len(password) < 8 or password != getpass.getpass("Repita la contraseña: "):
        sys.exit("Las contraseñas no coinciden o son muy cortas")
    with SessionLocal() as db:
        if db.scalar(select(User).where(User.username == username.lower())):
            sys.exit(f"El usuario '{username}' ya existe")
        db.add(
            User(
                username=username.lower(),
                full_name=full_name,
                password_hash=hash_password(password),
                role=Role.admin,
            )
        )
        db.commit()
    print(f"Administrador '{username}' creado")


def importar_empleados(path: str) -> None:
    with open(path, encoding="utf-8-sig") as fh:
        rows, errors = parse_roster(fh.read())
    for e in errors:
        print(f"Línea {e.line}: {e.message}\n    {e.text}")
    if errors:
        sys.exit(f"{len(errors)} líneas con errores: no se importó nada")
    with SessionLocal() as db:
        result = apply_roster(db, rows)
        audit.record(db, None, "importar", "employee", None, {"archivo": path.rsplit("/", 1)[-1], **result})
        db.commit()
    print(f"{len(rows)} empleados: {result['created']} creados, {result['updated']} actualizados, {result['unchanged']} sin cambios")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "crear-admin":
        crear_admin(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == "importar-empleados":
        importar_empleados(sys.argv[2])
    else:
        sys.exit(__doc__)
