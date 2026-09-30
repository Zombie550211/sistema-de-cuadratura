import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.api.routes import attendance, auth, employees, integrations, schedules, users
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import Role, User

log = logging.getLogger("asistencia")


def ensure_first_admin() -> None:
    """Crea el administrador inicial desde FIRST_ADMIN_* si la base no tiene usuarios."""
    settings = get_settings()
    if not (settings.first_admin_username and settings.first_admin_password):
        return
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)) is not None:
            return
        db.add(
            User(
                username=settings.first_admin_username.lower(),
                full_name="Administrador",
                password_hash=hash_password(settings.first_admin_password),
                role=Role.admin,
            )
        )
        db.commit()
        log.warning("Administrador inicial '%s' creado", settings.first_admin_username)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_first_admin()
    yield


settings = get_settings()
app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
    docs_url="/api/docs" if settings.environment != "production" else None,
    openapi_url="/api/openapi.json" if settings.environment != "production" else None,
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

for module in (auth, users, employees, schedules, attendance, integrations):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["sistema"])
def health():
    return {"status": "ok"}
