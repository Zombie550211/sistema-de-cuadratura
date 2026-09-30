# Connecting · Asistencia y planillas

Sistema de marcación, horarios y (próximamente) boletas de pago para Connecting, El Salvador.

- **Backend:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL (`backend/`)
- **Frontend:** React + Vite + TypeScript (`frontend/`)
- **Zona horaria:** todo se interpreta y muestra en `America/El_Salvador` (UTC-6).

## Cómo funciona la marcación

1. El reloj ZKTeco (serie `BINH221860214`) exporta por USB un archivo `*_attlog.dat`.
2. En **Importar reloj** se sube el archivo. El sistema:
   - lee cada línea (`ID  fecha hora  verificación  estado  código  reservado`);
   - guarda el original (disco local o S3) y su huella SHA-256: el mismo archivo no se importa dos veces;
   - ignora marcas que ya estaban en la base, así que las exportaciones que se solapan no duplican nada;
   - marca como **doble marca** las repeticiones que caen a menos de `DOUBLE_TAP_SECONDS` (120 s) de la marca válida anterior. No se borran, solo dejan de contar.
3. El campo "estado" del reloj no sirve (siempre vale 4), así que entrada, salida y pausas se deducen del **horario asignado** a cada agente ese día.
4. Los IDs del reloj se vinculan a empleados en **Empleados → IDs sin vincular**. Al vincular un ID, sus marcas pasadas quedan asociadas al empleado.

## Integración con el CRM (horarios)

Los supervisores cargan los horarios de cada agente en el CRM. El CRM los envía cada fin de semana
a `POST /api/integrations/crm/schedules` con una clave API (`X-API-Key`) generada en
**Integración CRM**. Cada agente trae su `crm_agent_id` y su `badge_number` (ID del reloj), así que el
enlace entre agente, horario y marcaciones es automático. Los ajustes manuales de RRHH nunca se
sobrescriben. Contrato completo para el equipo del CRM: [docs/integracion-crm.md](docs/integracion-crm.md).

## Desarrollo local (Docker, recomendado)

```bash
cp .env.example .env          # edite claves y contraseña del admin inicial
docker compose up -d --build
# http://localhost:8080  (usuario: FIRST_ADMIN_USERNAME / FIRST_ADMIN_PASSWORD)
```

> **Aviso:** la USB `USB_DATOS` está en FAT32, que no admite enlaces simbólicos. `npm install` y
> `python -m venv` fallan ahí. Use Docker o mueva el proyecto a un disco ext4 para desarrollar
> sin contenedores.

### Sin Docker (en disco ext4)

```bash
# Backend
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://usuario:clave@localhost:5432/asistencia
alembic upgrade head
python -m app.cli crear-admin admin "Administrador"
uvicorn app.main:app --reload            # API en :8000, docs en /api/docs

# Frontend
cd frontend && npm install && npm run dev  # http://localhost:5173 (proxy /api → :8000)
```

### Pruebas

```bash
cd backend
TEST_DATABASE_URL=postgresql+psycopg://usuario:clave@localhost:5432/asistencia_test pytest
```

Sin `TEST_DATABASE_URL` solo corren las pruebas del lector attlog.

### Migraciones

```bash
alembic revision --autogenerate -m "descripcion"   # después de cambiar app/models
alembic upgrade head
```

## Roles

| Rol | Puede |
|---|---|
| Administrador | Todo, incluida la gestión de usuarios |
| RRHH | Empleados, horarios, importar el reloj |
| Supervisor | Consultar marcaciones, horarios y empleados (los horarios se cargan en el CRM) |
| Empleado | Portal propio (en construcción) |

Toda creación o edición queda en `audit_logs` con el usuario y el detalle del cambio.

## Despliegue en AWS (propuesta)

| Pieza | Servicio |
|---|---|
| Base de datos | **RDS PostgreSQL** (Multi-AZ opcional, backups automáticos) |
| API + web | **EC2** con `docker compose` (lo más simple) o **ECS Fargate** detrás de un **ALB** |
| Archivos attlog | **S3** (`STORAGE_BACKEND=s3`, `S3_BUCKET=…`) con cifrado y versionado |
| HTTPS | Certificado de **ACM** en el ALB, o Caddy/Certbot en la EC2 |
| Secretos | **SSM Parameter Store** / Secrets Manager → variables de entorno |

Variables obligatorias en producción: `ENVIRONMENT=production`, `SECRET_KEY` (32+ caracteres),
`COOKIE_SECURE=true`, `DATABASE_URL` apuntando a RDS. En producción se desactiva `/api/docs`.
La instancia necesita un rol IAM con `s3:PutObject` y `s3:GetObject` sobre el bucket.

## Próximos pasos

1. **Motor de cuadratura:** cruzar las marcas con el horario asignado → entrada, salida, pausas,
   tardanzas, salidas anticipadas, horas extra y ausencias, con una bandeja de anomalías para RRHH.
2. **Correcciones auditadas:** RRHH agrega o anula marcas con motivo (la marca cruda nunca se modifica).
3. **Planilla y boletas de pago (El Salvador):** ISSS, AFP, renta, horas extra, recargo nocturno,
   vacaciones y aguinaldo, con tasas configurables. La boleta sale en PDF con QR de verificación.
4. **Portal del empleado.**
