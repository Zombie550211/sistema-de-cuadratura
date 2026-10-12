from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import COOKIE_NAME, decode_access_token, hash_api_key
from app.models import ApiClient, Role, User

DB = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: DB, token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None
) -> User:
    user_id = decode_access_token(token) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sesión no válida")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: Role) -> Callable[[User], User]:
    def checker(user: CurrentUser) -> User:
        # El administrador tiene acceso a todo, aunque el atajo no lo nombre.
        if user.role != Role.admin and user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No tiene permiso para esta acción")
        return user

    return checker


# Atajos por nivel de acceso
Admin = Annotated[User, Depends(require_roles(Role.admin))]
HR = Annotated[User, Depends(require_roles(Role.admin, Role.rrhh))]
# La app es solo para Recursos Humanos: el personal es admin y RRHH (el rol supervisor ya no se usa).
Staff = Annotated[User, Depends(require_roles(Role.admin, Role.rrhh))]


def get_api_client(
    db: DB, api_key: Annotated[str | None, Header(alias="X-API-Key")] = None
) -> ApiClient:
    """Autenticación de sistemas externos (CRM) por clave API."""
    client = None
    if api_key:
        client = db.scalar(
            select(ApiClient).where(ApiClient.key_hash == hash_api_key(api_key.strip()))
        )
    if client is None or not client.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Clave API no válida")
    client.last_used_at = datetime.now(UTC)
    db.commit()
    return client


ApiClientDep = Annotated[ApiClient, Depends(get_api_client)]
