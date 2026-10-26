from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core import login_guard
from app.core.config import get_settings
from app.core.security import (
    COOKIE_NAME,
    DUMMY_PASSWORD_HASH,
    create_access_token,
    verify_password,
)
from app.models import Role, User
from app.schemas import LoginIn, UserOut
from app.services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=UserOut)
def login(data: LoginIn, request: Request, response: Response, db: DB):
    ip = request.client.host if request.client else "unknown"

    # Freno de fuerza bruta por cuenta (independiente de la IP): si esta cuenta
    # acumuló demasiados fallos seguidos, se rechaza sin comprobar la contraseña.
    bloqueo = login_guard.cuenta_bloqueada(data.username)
    if bloqueo:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Demasiados intentos fallidos. Intenta de nuevo en {bloqueo // 60 + 1} min.",
        )
    # Freno por IP: limita el ritmo de intentos desde un mismo origen.
    if login_guard.ip_bloqueada(ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
        )
    login_guard.registra_ip(ip)

    user = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    # Comprobar SIEMPRE la contraseña (contra un hash ficticio si el usuario no existe)
    # para que el tiempo de respuesta no delate qué usuarios existen.
    pw_ok = verify_password(data.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
    if user is None or not user.is_active or not pw_ok:
        login_guard.registra_fallo_cuenta(data.username)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario o contraseña incorrectos")
    if user.role == Role.supervisor:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Esta aplicación es solo para Recursos Humanos")

    login_guard.limpia_cuenta(data.username)  # login correcto: se reinicia el contador
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
