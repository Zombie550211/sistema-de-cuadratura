from functools import cached_property, lru_cache
from zoneinfo import ZoneInfo

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEFAULT_SECRET = "cambia-esta-clave-en-produccion"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Connecting Asistencia"
    environment: str = "development"  # development | production

    database_url: str = "postgresql+psycopg://asistencia:asistencia@localhost:5432/asistencia"

    secret_key: str = INSECURE_DEFAULT_SECRET
    access_token_minutes: int = 480
    cookie_secure: bool = False

    # Hora local de la empresa. El reloj guarda fechas sin zona horaria.
    timezone: str = "America/El_Salvador"
    # Marcas del mismo empleado dentro de esta ventana se consideran doble marca.
    double_tap_seconds: int = 120
    # Minutos de llegada tarde que se perdonan por quincena; lo que pase de ahí cuenta.
    late_allowance_minutes: int = 15

    storage_backend: str = "local"  # local | s3
    storage_local_dir: str = "./storage"
    s3_bucket: str | None = None
    s3_prefix: str = "attlogs/"
    aws_region: str | None = None

    max_upload_mb: int = 20
    cors_origins: list[str] = []

    first_admin_username: str | None = None
    first_admin_password: str | None = None

    @model_validator(mode="after")
    def _check_production(self):
        if self.environment == "production":
            if self.secret_key == INSECURE_DEFAULT_SECRET or len(self.secret_key) < 32:
                raise ValueError("SECRET_KEY debe definirse (32+ caracteres) en producción")
            if self.storage_backend == "s3" and not self.s3_bucket:
                raise ValueError("S3_BUCKET es obligatorio con STORAGE_BACKEND=s3")
        return self

    @cached_property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@lru_cache
def get_settings() -> Settings:
    return Settings()
