from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core.config import get_settings
from app.core.security import COOKIE_NAME, create_access_token, verify_password
from app.models import Role, User
from app.schemas import LoginIn, UserOut
from app.services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=UserOut)
def login(data: LoginIn, response: Response, db: DB):
    user = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    if user is None or not user.is_active or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario o contraseña incorrectos")
    if user.role == Role.supervisor:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Esta aplicación es solo para Recursos Humanos")

    settings = get_settings()
    response.set_cookie(
        COOKIE_NAME,
        create_access_token(user.id),
        max_age=settings.access_token_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    audit.record(db, user, "login", "user", user.id)
    db.commit()
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser):
    return user
