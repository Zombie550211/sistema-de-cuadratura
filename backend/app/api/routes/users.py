from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, Admin
from app.core.security import hash_password
from app.models import User
from app.schemas import UserCreate, UserOut, UserUpdate
from app.services import audit

router = APIRouter(prefix="/users", tags=["usuarios"])


@router.get("", response_model=list[UserOut])
def list_users(db: DB, _: Admin):
    return db.scalars(select(User).order_by(User.username)).all()


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(data: UserCreate, db: DB, admin: Admin):
    user = User(
        username=data.username.lower(),
        full_name=data.full_name,
        password_hash=hash_password(data.password),
        role=data.role,
        employee_id=data.employee_id,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "El usuario o el empleado ya está en uso")
    audit.record(db, admin, "crear", "user", user.id, {"username": user.username, "rol": user.role})
    db.commit()
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, data: UserUpdate, db: DB, admin: Admin):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuario no encontrado")
    changes = data.model_dump(exclude_unset=True)
    if user.id == admin.id and (changes.get("is_active") is False or changes.get("role", user.role) != user.role):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No puede desactivarse ni cambiar su propio rol")

    if "password" in changes:
        user.password_hash = hash_password(changes.pop("password"))
        changes["password"] = "(cambiada)"
    for field, value in changes.items():
        if field != "password":
            setattr(user, field, value)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "El empleado ya tiene otro usuario")
    audit.record(db, admin, "editar", "user", user.id, {k: str(v) for k, v in changes.items()})
    db.commit()
    return user
