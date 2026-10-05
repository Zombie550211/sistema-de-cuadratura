ATTLOG = (
    b"            83\t2026-09-25 06:21:58\t1\t4\t1\t0\r\n"
    b"            83\t2026-09-25 12:59:19\t1\t4\t1\t0\r\n"
    b"            83\t2026-09-25 12:59:21\t1\t4\t1\t0\r\n"
    b"            83\t2026-09-25 12:59:24\t1\t4\t1\t0\r\n"
    b"            36\t2026-09-25 07:11:34\t1\t4\t1\t0\r\n"
    b"            36\t2026-09-25 16:02:10\t1\t4\t1\t0\r\n"
    b"linea rota\r\n"
)


def _upload(client, content=ATTLOG, name="BINH221860214_attlog.dat"):
    return client.post("/api/attendance/imports", files={"file": (name, content, "text/plain")})


def _employee(client, **extra):
    data = {"code": "E-001", "first_name": "Ana", "last_name": "López", **extra}
    r = client.post("/api/employees", json=data)
    assert r.status_code == 201, r.text
    return r.json()


def test_requires_login(client):
    assert client.get("/api/employees").status_code == 401


def test_login_rejects_bad_password(client, db, login):
    login("admin")
    r = client.post("/api/auth/login", json={"username": "u_admin", "password": "mala"})
    assert r.status_code == 401


def test_supervisor_cannot_log_in_or_be_created(client, db, login):
    from app.core.security import hash_password
    from app.models import Role, User

    db.add(User(username="sup", full_name="Sup", password_hash=hash_password("secreto123"), role=Role.supervisor))
    db.commit()
    r = client.post("/api/auth/login", json={"username": "sup", "password": "secreto123"})
    assert r.status_code == 403 and "Recursos Humanos" in r.json()["detail"]
    admin = login("admin")
    r = admin.post("/api/users", json={"username": "nuevo", "full_name": "N", "password": "secreto123", "role": "supervisor"})
    assert r.status_code == 422


def test_employee_role_cannot_create_employee(login):
    client = login("empleado")
    r = client.post("/api/employees", json={"code": "X", "first_name": "A", "last_name": "B"})
    assert r.status_code == 403


def test_import_attlog_flags_double_taps_and_is_idempotent(login):
    client = login("rrhh")
    r = _upload(client)
    assert r.status_code == 201, r.text
    batch = r.json()
    assert batch["device"]["serial_number"] == "BINH221860214"
    assert batch["inserted"] == 6
    assert batch["double_taps"] == 2
    assert batch["invalid_lines"] == 1
    assert batch["unknown_badges"] == 2
    assert batch["date_from"] == "2026-09-25"

    # mismo archivo otra vez → rechazado
    again = _upload(client)
    assert again.status_code == 409
    assert again.json()["batch"]["id"] == batch["id"]

    # exportación que se solapa (contiene lo anterior + una marca nueva) → solo entra la nueva
    overlap = ATTLOG + b"            36\t2026-09-26 07:05:00\t1\t4\t1\t0\r\n"
    r = _upload(client, overlap, "BINH221860214_attlog(1).dat")
    assert r.status_code == 201
    assert r.json()["inserted"] == 1
    assert r.json()["already_present"] == 6


def test_assigning_badge_links_existing_punches(login):
    client = login("rrhh")
    _upload(client)
    unmapped = client.get("/api/attendance/unmapped-badges").json()
    assert {b["badge"] for b in unmapped} == {"36", "83"}

    emp = _employee(client, badge_number="083")
    assert emp["badge_number"] == "83"

    punches = client.get(
        "/api/attendance/punches",
        params={"date_from": "2026-09-25", "date_to": "2026-09-25", "employee_id": emp["id"]},
    ).json()
    assert punches["total"] == 4
    assert {p["employee"]["full_name"] for p in punches["items"]} == {"ANA LÓPEZ"}

    no_taps = client.get(
        "/api/attendance/punches",
        params={
            "date_from": "2026-09-25",
            "date_to": "2026-09-25",
            "employee_id": emp["id"],
            "include_double_taps": False,
        },
    ).json()
    assert no_taps["total"] == 2

    # quitar el ID de reloj desvincula las marcas
    r = client.put(f"/api/employees/{emp['id']}", json={**emp, "badge_number": None})
    assert r.status_code == 200
    assert len(client.get("/api/attendance/unmapped-badges").json()) == 2


def test_duplicate_badge_is_rejected(login):
    client = login("rrhh")
    _employee(client, badge_number="5")
    r = client.post(
        "/api/employees",
        json={"code": "E-002", "first_name": "B", "last_name": "C", "badge_number": "5"},
    )
    assert r.status_code == 409
    assert "reloj" in r.json()["detail"]


def test_bulk_assign_night_shift_crosses_midnight(login):
    client = login("rrhh")
    emp = _employee(client)
    tpl = client.post(
        "/api/schedules/templates",
        json={"name": "Noche", "start_time": "22:00", "end_time": "06:00", "break_minutes": 30},
    ).json()
    assert tpl["crosses_midnight"] is True

    r = client.post(
        "/api/schedules/assignments/bulk",
        json={
            "employee_ids": [emp["id"]],
            "date_from": "2026-09-28",
            "date_to": "2026-10-04",
            "weekdays": [0, 2, 4],
            "template_id": tpl["id"],
        },
    )
    assert r.json() == {"created": 3, "updated": 0, "skipped": 0}

    rows = client.get(
        "/api/schedules/assignments", params={"date_from": "2026-09-28", "date_to": "2026-10-04"}
    ).json()
    assert [a["work_date"] for a in rows] == ["2026-09-28", "2026-09-30", "2026-10-02"]
    assert rows[0]["start_at"].startswith("2026-09-29T04:00:00")  # 22:00 local = 04:00 UTC
    assert rows[0]["end_at"].startswith("2026-09-29T12:00:00")  # 06:00 local del día siguiente

    # repetir sin overwrite no toca nada; con overwrite actualiza
    body = {"employee_ids": [emp["id"]], "date_from": "2026-09-28", "date_to": "2026-09-28",
            "start_time": "08:00", "end_time": "17:00"}
    assert client.post("/api/schedules/assignments/bulk", json=body).json()["skipped"] == 1
    body["overwrite"] = True
    assert client.post("/api/schedules/assignments/bulk", json=body).json()["updated"] == 1


def test_dashboard_summary(login):
    client = login("rrhh")
    r = client.get("/api/dashboard/summary")
    assert r.status_code == 200
    assert r.json()["employees_active"] == 0
