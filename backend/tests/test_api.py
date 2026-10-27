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


def test_baja_clears_badge_and_fingerprints(login):
    """Dar de baja (inactivo) elimina el ID de marcación y las huellas; queda solo el código."""
    client = login("rrhh")
    emp = _employee(client, code="E-050", first_name="Eva", badge_number="77", fingerprints={"LA17": "77"})
    assert emp["badge_number"] == "77" and emp["fingerprints"] == {"LA17": "77"}

    r = client.put(f"/api/employees/{emp['id']}", json={**emp, "status": "inactivo"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "inactivo"
    assert out["badge_number"] is None and out["fingerprints"] == {}
    assert out["code"] == emp["code"]  # conserva el código del sistema

    # el ID del reloj queda libre para otra persona
    r2 = client.post("/api/employees", json={"code": "E-051", "first_name": "Otro", "last_name": "Nuevo", "badge_number": "77"})
    assert r2.status_code == 201, r2.text

    # aparece en el listado de inactivos (empleados pasivos)
    passive = client.get("/api/employees", params={"status": "inactivo"}).json()
    assert emp["id"] in [e["id"] for e in passive["items"]]


def test_payroll_mark_per_period(login):
    """«Ya agregado a planilla»: marca por empleado y periodo, independiente de otros periodos."""
    client = login("rrhh")
    emp = _employee(client, code="E-060", first_name="Rosa", badge_number="90")
    p1, p2 = {"period_start": "2026-09-16"}, {"period_start": "2026-10-01"}

    assert client.get("/api/attendance/payroll-marks", params=p1).json() == []
    r = client.put("/api/attendance/payroll-marks", json={"employee_id": emp["id"], **p1, "done": True})
    assert r.status_code == 200 and r.json() == {"employee_id": emp["id"], "period_start": "2026-09-16", "done": True}
    assert client.get("/api/attendance/payroll-marks", params=p1).json() == [emp["id"]]
    assert client.get("/api/attendance/payroll-marks", params=p2).json() == []  # otro periodo no lo hereda

    assert client.put("/api/attendance/payroll-marks", json={"employee_id": emp["id"], **p1, "done": False}).status_code == 200
    assert client.get("/api/attendance/payroll-marks", params=p1).json() == []


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


def test_rrhh_can_reschedule_a_shift(login):
    client = login("rrhh")
    emp = client.post("/api/employees", json={"code": "R-1", "first_name": "Rosa", "last_name": "Mena"}).json()
    client.post("/api/schedules/assignments/bulk", json={"employee_ids": [emp["id"]], "date_from": "2026-10-05", "date_to": "2026-10-06",
                                                         "weekdays": [0, 1], "start_time": "08:00", "end_time": "17:00"})
    monday, tuesday = client.get("/api/schedules/assignments", params={"date_from": "2026-10-05", "date_to": "2026-10-06"}).json()

    # solo cambiar las horas, mismo día: no deja día libre
    r = client.put(f"/api/schedules/assignments/{monday['id']}", json={"work_date": "2026-10-05", "start_time": "13:00", "end_time": "21:00"})
    assert r.status_code == 200, r.text
    assert client.get("/api/schedules/days-off", params={"date_from": "2026-10-05", "date_to": "2026-10-06"}).json() == []

    # moverlo a un día que ya tiene turno se rechaza
    r = client.put(f"/api/schedules/assignments/{monday['id']}", json={"work_date": "2026-10-06", "start_time": "08:00", "end_time": "17:00"})
    assert r.status_code == 409


def test_search_by_full_name(login):
    client = login("rrhh")
    _employee(client, code="S-1", first_name="Cristhian Alexander", last_name="Sanchez Aparicio")
    for q in ["CRISTHIAN ALEXANDER SANCHEZ APARICIO", "cristhian sanchez", "Aparicio Cristhian"]:
        assert client.get("/api/employees", params={"q": q}).json()["total"] == 1, q
    assert client.get("/api/employees", params={"q": "Cristhian Lopez"}).json()["total"] == 0
    # El código ya no se usa: no sirve para buscar.
    assert client.get("/api/employees", params={"q": "S-1"}).json()["total"] == 0


def _xlsx_punches(rows, sheet="ASISTENCIA LA18", headers=("N ", "EMPLEADOS", "FECHA", "HORA")):
    """Excel de marcaciones como el del reloj: número, nombre, fecha, hora. `rows` son tuplas
    (numero, nombre, 'YYYY-MM-DD', 'HH:MM:SS')."""
    import io
    from datetime import datetime
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(list(headers))
    for num, nombre, d, t in rows:
        ws.append([num, nombre, datetime.strptime(d, "%Y-%m-%d"), datetime.strptime(t, "%H:%M:%S").time()])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_import_links_by_name_over_fingerprint_collision(login):
    """El nombre manda: aunque el número choque entre locales, cada marca va a la persona cuyo
    nombre coincide; y la huella de ese local se aprende en la ficha."""
    client = login("rrhh")
    # Dos personas comparten el número 16 en locales distintos.
    stephanie = _employee(
        client, code="A", first_name="Stephanie Yamileth", last_name="Ortiz Fuentes",
        fingerprints={"LA18": "16"},
    )
    jose = _employee(
        client, code="B", first_name="Jose Carmen", last_name="Rodriguez",
        fingerprints={"LA17": "16"},
    )
    # Archivo de LA18: el 16 es Stephanie; el 9, Karla, que aún no tiene huella (se aprende por nombre).
    karla = _employee(client, code="C", first_name="Karla Guadalupe", last_name="Rodriguez Perez")
    content = _xlsx_punches([
        (16, "STEPHANIE YAMILETH ORTIZ FUENTES", "2026-10-14", "07:57:16"),
        (16, "STEPHANIE YAMILETH ORTIZ FUENTES", "2026-10-14", "17:05:00"),
        (9, "KARLA GUADALUPE RODRIGUEZ PEREZ", "2026-10-14", "07:39:41"),
    ])
    r = client.post("/api/attendance/imports",
                    files={"file": ("ASISTENCIA LA18.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    data={"local": "LA18"})
    assert r.status_code == 201, r.text

    def count(emp):
        return client.get("/api/attendance/punches",
                          params={"date_from": "2026-10-14", "date_to": "2026-10-14", "employee_id": emp["id"]}).json()["total"]

    assert count(stephanie) == 2   # el 16 de LA18 es Stephanie, no Jose (que tiene el 16 en LA17)
    assert count(jose) == 0
    assert count(karla) == 1       # ligada por nombre aunque no tenía huella
    # se aprendió la huella de LA18 para Karla
    assert client.get(f"/api/employees/{karla['id']}").json()["fingerprints"].get("LA18") == "9"


def test_import_name_not_found_stays_unmapped(login):
    """Si el número trae nombre en el archivo pero ese nombre no existe en la base, la marca se deja
    suelta: no se cuelga de la huella de otra persona que tenga ese mismo número."""
    client = login("rrhh")
    otro = _employee(client, code="A", first_name="Otra", last_name="Persona", fingerprints={"LA18": "20"})
    content = _xlsx_punches([
        (20, "XAVIER ALEXIS BALTAZAR DIAZ", "2026-10-14", "08:00:00"),
    ])
    r = client.post("/api/attendance/imports",
                    files={"file": ("ASISTENCIA LA18.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    data={"local": "LA18"})
    assert r.status_code == 201, r.text
    # no se le colgó a "otro" (que tiene la huella 20 en LA18)
    assert client.get("/api/attendance/punches",
                      params={"date_from": "2026-10-14", "date_to": "2026-10-14", "employee_id": otro["id"]}).json()["total"] == 0
    # queda como huella desconocida
    assert "20" in {b["badge"] for b in client.get("/api/attendance/unmapped-badges").json()}


def test_import_ignores_broken_name_cells(login):
    """Una celda de nombre rota (#N/A) no debe tapar el nombre real del mismo número en otra fila."""
    client = login("rrhh")
    emp = _employee(client, code="A", first_name="Alcyr Steven", last_name="Zavala Molina")
    content = _xlsx_punches([
        (81, "#N/A", "2026-10-14", "07:00:00"),
        (81, "ALCYR STEVEN ZAVALA MOLINA", "2026-10-14", "17:00:00"),
    ], sheet="ASISTENCIA LA17")
    r = client.post("/api/attendance/imports",
                    files={"file": ("ASISTENCIA LA17.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    data={"local": "LA17"})
    assert r.status_code == 201, r.text
    assert client.get("/api/attendance/punches",
                      params={"date_from": "2026-10-14", "date_to": "2026-10-14", "employee_id": emp["id"]}).json()["total"] == 2
