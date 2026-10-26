"""Llegadas tarde: entrada vs. inicio del turno, con 15 min perdonados por quincena."""

from tests.test_api import _employee


def _shift(client, emp_id, day, start="08:00", end="17:00"):
    r = client.post("/api/schedules/assignments/bulk", json={
        "employee_ids": [emp_id], "date_from": day, "date_to": day,
        "weekdays": [0, 1, 2, 3, 4, 5, 6], "start_time": start, "end_time": end,
    })
    assert r.status_code == 200, r.text


def test_lateness_accumulates_per_quincena(login):
    client = login("rrhh")
    emp = _employee(client, badge_number="83")
    for day in ("2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"):
        _shift(client, emp["id"], day)
    attlog = (
        b"83\t2026-09-14 08:10:00\t1\t4\t1\t0\n"   # 10 min, 1.a quincena
        b"83\t2026-09-14 12:00:00\t1\t4\t1\t0\n"   # otra marca del día: no cuenta
        b"83\t2026-09-15 08:09:30\t1\t4\t1\t0\n"   # 9 min: acumula 19, cuentan 4
        b"83\t2026-09-16 08:12:00\t1\t4\t1\t0\n"   # 12 min, 2.a quincena: se reinicia
        b"83\t2026-09-17 07:55:00\t1\t4\t1\t0\n"   # llegó antes: 0
        b"83\t2026-09-18 08:05:00\t1\t4\t1\t0\n"   # 5 min: acumula 17, cuentan 2
    )
    r = client.post("/api/attendance/imports", files={"file": ("BINH221860214_attlog.dat", attlog, "text/plain")})
    assert r.status_code == 201, r.text

    rows = client.get("/api/attendance/lateness", params={"date_from": "2026-09-15", "date_to": "2026-09-18"}).json()
    got = {r["date"]: (r["late_minutes"], r["quincena_minutes"], r["counted_minutes"]) for r in rows}
    assert got == {
        "2026-09-15": (9, 19, 4),   # el 14 se cuenta aunque está fuera del rango pedido
        "2026-09-16": (12, 12, 0),
        "2026-09-17": (0, 12, 0),
        "2026-09-18": (5, 17, 2),
    }


def test_night_hours_from_seven_pm(login):
    """Nocturnidad: lo que el turno pasa de las 19:00; solo los días que marcó."""
    client = login("rrhh")
    emp = _employee(client, badge_number="84")
    _shift(client, emp["id"], "2026-09-14", "13:00", "21:00")  # 2 h
    _shift(client, emp["id"], "2026-09-15", "17:00", "21:00")  # 2 h
    _shift(client, emp["id"], "2026-09-16", "10:00", "19:00")  # termina a las 7: 0
    _shift(client, emp["id"], "2026-09-17", "13:00", "21:00")  # no marcó: 0
    attlog = (
        b"84\t2026-09-14 13:05:00\t1\t4\t1\t0\n"
        b"84\t2026-09-15 16:58:00\t1\t4\t1\t0\n"
        b"84\t2026-09-16 10:00:00\t1\t4\t1\t0\n"
    )
    r = client.post("/api/attendance/imports", files={"file": ("BINH221860214_attlog.dat", attlog, "text/plain")})
    assert r.status_code == 201, r.text

    rows = client.get("/api/attendance/lateness", params={"date_from": "2026-09-14", "date_to": "2026-09-17", "employee_id": emp["id"]}).json()
    assert {r["date"]: r["night_seconds"] for r in rows} == {
        "2026-09-14": 7200,
        "2026-09-15": 7200,
        "2026-09-16": 0,
        "2026-09-17": 0,
    }


def test_lateness_waiver_per_quincena(login):
    """RRHH puede decidir que a un empleado no se le apliquen las llegadas tarde de una quincena."""
    client = login("rrhh")
    emp = _employee(client, badge_number="85")
    _shift(client, emp["id"], "2026-09-16")
    attlog = b"85\t2026-09-16 08:20:00\t1\t4\t1\t0\n"  # 20 min tarde, 2.a quincena de septiembre
    assert client.post("/api/attendance/imports", files={"file": ("BINH221860214_attlog.dat", attlog, "text/plain")}).status_code == 201

    params = {"date_from": "2026-09-16", "date_to": "2026-09-16", "employee_id": emp["id"]}
    base = client.get("/api/attendance/lateness", params=params).json()
    assert base[0]["late_minutes"] == 20 and base[0]["counted_minutes"] == 5  # 20 - 15 perdonados

    # No aplicar las llegadas tarde de esa quincena: la tardanza del día pasa a 0.
    r = client.put("/api/attendance/lateness-waivers", json={"employee_id": emp["id"], "work_date": "2026-09-16", "apply": False})
    assert r.status_code == 200 and r.json() == {"employee_id": emp["id"], "quincena_start": "2026-09-16", "applied": False}
    assert client.get("/api/attendance/lateness-waivers", params=params).json() == [
        {"employee_id": emp["id"], "quincena_start": "2026-09-16", "applied": False}
    ]
    off = client.get("/api/attendance/lateness", params=params).json()
    assert off[0]["late_minutes"] == 0 and off[0]["late_seconds"] == 0 and off[0]["counted_minutes"] == 0

    # Volver a aplicar: la tardanza regresa.
    assert client.put("/api/attendance/lateness-waivers", json={"employee_id": emp["id"], "work_date": "2026-09-16", "apply": True}).status_code == 200
    assert client.get("/api/attendance/lateness-waivers", params=params).json() == []
    assert client.get("/api/attendance/lateness", params=params).json()[0]["late_minutes"] == 20
