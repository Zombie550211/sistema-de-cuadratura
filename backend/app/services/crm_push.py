"""Cambios de horario de RRHH que vuelven al CRM (sincronización en los dos sentidos).

Horarios del CRM y de Cuadratura deben ser iguales. El CRM manda sus horarios (crm_sync.py) y
Cuadratura le devuelve cada día que RRHH cambia aquí: un turno asignado, reagendado o quitado,
un día libre, una vacación o un compensatorio.

- Cada cambio deja el día (empleado, fecha) en la cola crm_outbox, en la misma transacción.
- Después de cada cambio, y cada 5 minutos por si el CRM no respondía, se envía la cola a
  POST {CRM_URL}/api/horarios/desde-cuadratura con el estado ACTUAL de cada día: turno, día de
  descanso (con el motivo) o vacío. Lo que el CRM acepta sale de la cola.
- Mientras un día está en la cola, el envío del CRM no lo pisa (crm_sync lo salta): el CRM aún
  no conoce el cambio y lo devolverá igual en su próximo envío.
- Los empleados sin ID de CRM no se envían (no existen allá).
"""

import logging
from collections.abc import Iterable
from datetime import date

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import CrmOutbox, Employee, ShiftAssignment, ShiftDayOff

log = logging.getLogger("asistencia.crm_push")

# Así los reconoce /horarios.html del CRM: descanso con nota "Vacaciones" o "Incapacidad" (exacta);
# cualquier otro descanso es "Libre" (con su nota, si tiene).
CRM_NOTE = {
    "vacacion": "Vacaciones",
    "incapacidad": "Incapacidad",
    "compensatorio": "Compensatorio",
    "suspendido": "Suspendido",
    "baja": "De baja",
}
BATCH = 500


def configured() -> bool:
    s = get_settings()
    return bool(s.crm_url and s.crm_api_key)


def queue(db: Session, days: Iterable[tuple[int, date]]) -> None:
    """Deja en la cola los días cambiados (se envían después del commit)."""
    rows = [{"employee_id": e, "work_date": d} for e, d in set(days)]
    if rows:
        db.execute(
            insert(CrmOutbox)
            .values(rows)
            .on_conflict_do_update(constraint="uq_crm_outbox_employee_date", set_={"attempts": 0, "last_error": None})
        )


def pending(db: Session, employee_id: int, date_from: date, date_to: date) -> set[date]:
    return set(
        db.scalars(
            select(CrmOutbox.work_date).where(
                CrmOutbox.employee_id == employee_id, CrmOutbox.work_date >= date_from, CrmOutbox.work_date <= date_to
            )
        )
    )


def _change(db: Session, crm_id: str, employee_id: int, day: date) -> dict:
    tz = get_settings().tz
    base = {"crm_agent_id": crm_id, "date": day.isoformat()}
    shift = db.scalar(select(ShiftAssignment).where(ShiftAssignment.employee_id == employee_id, ShiftAssignment.work_date == day))
    if shift is not None:
        return {
            **base,
            "start": shift.start_at.astimezone(tz).strftime("%H:%M"),
            "end": shift.end_at.astimezone(tz).strftime("%H:%M"),
            "break_minutes": shift.break_minutes,
            "notes": shift.notes,
        }
    off = db.scalar(select(ShiftDayOff).where(ShiftDayOff.employee_id == employee_id, ShiftDayOff.work_date == day))
    if off is not None:
        note = CRM_NOTE.get(off.kind, off.notes)
        return {**base, "rest_day": True, "notes": note[:500] if note else None}
    return {**base, "clear": True}


def flush(db: Session) -> int:
    """Envía la cola al CRM. Devuelve cuántos días quedaron enviados."""
    if not configured():
        return 0
    settings = get_settings()
    rows = db.execute(
        select(CrmOutbox, Employee.crm_agent_id).join(Employee, Employee.id == CrmOutbox.employee_id).order_by(CrmOutbox.id)
    ).all()
    # Sin ID de CRM no hay a quién mandarlo: salen de la cola.
    for item, crm_id in rows:
        if not crm_id:
            db.delete(item)
    rows = [(item, crm_id) for item, crm_id in rows if crm_id]
    sent = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        changes = [_change(db, crm_id, item.employee_id, item.work_date) for item, crm_id in chunk]
        try:
            r = httpx.post(
                f"{settings.crm_url.rstrip('/')}/api/horarios/desde-cuadratura",
                json={"changes": changes},
                headers={"X-API-Key": settings.crm_api_key},
                timeout=20,
            )
            r.raise_for_status()
            rejected = {(e["crm_agent_id"], e["date"]) for e in r.json().get("errores", [])}
        except (httpx.HTTPError, ValueError) as exc:
            for item, _ in chunk:
                item.attempts += 1
                item.last_error = str(exc)[:500]
            log.warning("No se pudieron enviar %d cambios de horario al CRM: %s", len(chunk), exc)
            break
        for item, crm_id in chunk:
            if (crm_id, item.work_date.isoformat()) in rejected:
                item.attempts += 1
                item.last_error = "El CRM no conoce a este agente"
            else:
                db.delete(item)
                sent += 1
    db.commit()
    return sent


def flush_in_background() -> None:
    """Para BackgroundTasks y el bucle periódico: sesión propia, nunca lanza."""
    if not configured():
        return
    try:
        with SessionLocal() as db:
            flush(db)
    except Exception:  # noqa: BLE001 - un fallo aquí no debe tumbar la API
        log.exception("Error enviando horarios al CRM")
