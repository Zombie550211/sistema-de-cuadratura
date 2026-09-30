"""Utilidades de administración.

    python -m app.cli crear-admin <usuario> "<Nombre completo>"
"""

import getpass
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import Role, User


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


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "crear-admin":
        crear_admin(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
