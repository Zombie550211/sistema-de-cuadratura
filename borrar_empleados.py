"""Borra TODOS los empleados para recargar la nómina nueva desde Excel (Empleados → Importar nómina).

Se corre dentro del contenedor del API, en la carpeta del proyecto, DESPUÉS de un respaldo:

    docker compose exec -T db pg_dump -U asistencia asistencia > respaldo-$(date +%F-%H%M).sql
    docker compose exec -T api python - < borrar_empleados.py               # solo cuenta
    docker compose exec -T api python - --confirmar < borrar_empleados.py   # borra

Con las fichas se borran (en cascada) sus turnos, días libres, vacaciones, compensatorios,
períodos de vacaciones, constancias y la cola hacia el CRM. Las marcaciones del reloj NO se
borran: quedan sin empleado y se vuelven a enlazar por ID de reloj al cargar la nómina. Los
usuarios de la app quedan sin empleado vinculado. Los teams (departamentos) se conservan.
"""

import sys


def main(confirm: bool) -> int:
    from sqlalchemy import delete, func, select, update

    from app.core.database import SessionLocal
    from app.models import Employee, IntegrationSync
    from app.services import audit

    db = SessionLocal()
    try:
        tables = ["employees", "shift_assignments", "shift_days_off", "vacation_periods",
                  "salary_certificates", "crm_outbox"]
        from sqlalchemy import text

        counts = {t: db.scalar(text(f"SELECT count(*) FROM {t}")) for t in tables}
        counts["punches_enlazadas"] = db.scalar(text("SELECT count(*) FROM punches WHERE employee_id IS NOT NULL"))
        for k, v in counts.items():
            print(f"  {k:22} {v}")
        if not confirm:
            print("\nPRUEBA: no se borró nada. Para borrar, agregue --confirmar")
            return 0

        db.execute(delete(Employee))
        # Los envíos del CRM guardan su resultado para Idempotency-Key: si el CRM reenvía el mismo
        # paquete, se le devolvería el resultado viejo sin aplicarlo a las fichas nuevas.
        db.execute(update(IntegrationSync).values(idempotency_key=None))
        audit.record(db, None, "eliminar", "employee", None, {"todos": True, **counts,
                                                              "origen": "borrar_empleados.py"})
        db.commit()
        left = db.scalar(select(func.count()).select_from(Employee))
        print(f"\nBORRADO. Empleados restantes: {left}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main("--confirmar" in sys.argv))
