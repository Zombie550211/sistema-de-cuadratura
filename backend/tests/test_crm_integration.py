import pytest

WEEK = {"date_from": "2026-10-05", "date_to": "2026-10-11"}


@pytest.fixture
def crm(login):
    """Devuelve (cliente_http_admin, headers_del_crm)."""
    client = login("admin")
    r = client.post("/api/integrations/clients", json={"name": "CRM Connecting"})
    assert r.status_code == 201, r.text
    key = r.json()["api_key"]
    assert key.startswith("cnx_")
    return client, {"X-API-Key": key}


def _agent(crm_id="A-100", badge="83", **extra):
    return {
        "crm_agent_id": crm_id,
        "badge_number": badge,
        "first_name": "Carlos",
        "last_name": "Pérez",
        "campaign": "Ventas USA",
        "shifts": [
            {"date": "2026-10-05", "start": "08:00", "end": "17:00"},
            {"date": "2026-10-06", "start": "22:00", "end": "06:00", "break_minutes": 30},
            {"date": "2026-10-07", "rest_day": True},
        ],
        **extra,
    }


def _hire(client, code="E-083", badge="83", first="Carlos", last="Pérez"):
    """Registra al empleado en la planilla: el CRM solo manda horarios de quien ya está en Empleados."""
    r = client.post("/api/employees", json={"code": code, "first_name": first, "last_name": last, "badge_number": badge})
    assert r.status_code == 201, r.text
    return r.json()


def _send(client, headers, agents, **kw):
    return client.post("/api/integrations/crm/schedules", json={**WEEK, "agents": agents}, headers=headers, **kw)


def test_rejects_missing_or_bad_key(client, db):
    assert client.get("/api/integrations/crm/ping").status_code == 401
    assert client.get("/api/integrations/crm/ping", headers={"X-API-Key": "cnx_mala"}).status_code == 401


def test_ping_and_revoked_key(crm):
    client, headers = crm
    assert client.get("/api/integrations/crm/ping", headers=headers).json()["ok"] is True
    client_id = client.get("/api/integrations/clients").json()[0]["id"]
    client.patch(f"/api/integrations/clients/{client_id}", json={"is_active": False})
    assert client.get("/api/integrations/crm/ping", headers=headers).status_code == 401


def test_links_employee_and_assigns_week(crm):
    client, headers = crm
    _hire(client)
    # marcas previas del reloj con el ID 83, aún sin empleado
    client.post(
        "/api/attendance/imports",
        files={"file": ("BINH221860214_attlog.dat", b"83\t2026-10-05 07:58:00\t1\t4\t1\t0\n", "text/plain")},
    )

    r = _send(client, headers, [_agent()])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["employees_created"] == 0
    assert body["shifts_created"] == 2
    emp_id = body["agents"][0]["employee_id"]

    emp = client.get(f"/api/employees/{emp_id}").json()
    assert (emp["crm_agent_id"], emp["badge_number"], emp["code"]) == ("A-100", "83", "E-083")
    assert emp["department"]["name"] == "Ventas USA"
    assert client.get("/api/attendance/unmapped-badges").json() == []

    shifts = client.get("/api/schedules/assignments", params={**WEEK}).json()
    assert [s["work_date"] for s in shifts] == ["2026-10-05", "2026-10-06"]
    assert all(s["source"] == "crm" for s in shifts)
    night = shifts[1]
    assert night["start_at"].startswith("2026-10-07T04:00") and night["end_at"].startswith("2026-10-07T12:00")


def test_resend_replaces_week_without_duplicates(crm):
    client, headers = crm
    _hire(client)
    _send(client, headers, [_agent()])
    changed = _agent(shifts=[{"date": "2026-10-05", "start": "09:00", "end": "18:00"}])
    body = _send(client, headers, [changed]).json()
    assert (body["employees_created"], body["shifts_created"], body["shifts_updated"], body["shifts_removed"]) == (0, 0, 1, 1)

    shifts = client.get("/api/schedules/assignments", params={**WEEK}).json()
    assert len(shifts) == 1 and shifts[0]["start_at"].startswith("2026-10-05T15:00")

    # reenviar idéntico no cambia nada
    body = _send(client, headers, [changed]).json()
    assert (body["shifts_created"], body["shifts_updated"], body["shifts_removed"]) == (0, 0, 0)


def _hours(client, day):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    rows = client.get("/api/schedules/assignments", params={"date_from": day, "date_to": day}).json()
    return [(r["source"], datetime.fromisoformat(r["start_at"]).astimezone(ZoneInfo("America/El_Salvador")).strftime("%H:%M")) for r in rows]


def test_rrhh_change_waits_for_crm_then_crm_wins(crm, db):
    from app.models import CrmOutbox

    client, headers = crm
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]
    client.post(
        "/api/schedules/assignments/bulk",
        json={"employee_ids": [emp_id], "date_from": "2026-10-05", "date_to": "2026-10-05",
              "start_time": "10:00", "end_time": "19:00", "overwrite": True},
    )
    # Sin CRM_URL el cambio queda en la cola: el envío del CRM no lo pisa.
    assert _send(client, headers, [_agent()]).json()["status"] == "ok"
    assert _hours(client, "2026-10-05") == [("manual", "10:00")]

    # Ya entregado al CRM: si el CRM manda otra cosa, gana el CRM (cambió después).
    db.query(CrmOutbox).delete()
    db.commit()
    _send(client, headers, [_agent()])
    assert _hours(client, "2026-10-05") == [("crm", "08:00")]


def test_vacation_is_not_overwritten_by_crm(crm, db):
    from app.models import CrmOutbox

    client, headers = crm
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]
    client.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [emp_id], "date_from": "2026-10-05", "date_to": "2026-10-05", "weekdays": [0], "kind": "vacacion",
    })
    db.query(CrmOutbox).delete()  # ya entregada al CRM, pero el CRM volvió a poner turno
    db.commit()
    body = _send(client, headers, [_agent()]).json()
    assert body["agents"][0]["conflict_dates"] == ["2026-10-05"]
    assert _hours(client, "2026-10-05") == []
    assert db.query(CrmOutbox).count() == 1  # se le vuelve a mandar la vacación al CRM


def test_rrhh_changes_are_pushed_to_crm(crm, db, monkeypatch):
    import httpx

    from app.core.config import get_settings
    from app.models import CrmOutbox

    client, headers = crm
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]
    sent = []

    def fake_post(url, json, headers, timeout):
        sent.append((url, headers["X-API-Key"], json["changes"]))
        return httpx.Response(200, json={"success": True, "aplicados": len(json["changes"]), "errores": []}, request=httpx.Request("POST", url))

    monkeypatch.setattr(get_settings(), "crm_url", "http://crm.local/")
    monkeypatch.setattr(get_settings(), "crm_api_key", "clave")
    monkeypatch.setattr(httpx, "post", fake_post)

    client.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [emp_id], "date_from": "2026-10-08", "date_to": "2026-10-08", "weekdays": [3], "kind": "compensatorio",
    })
    monday = client.get("/api/schedules/assignments", params={"date_from": "2026-10-05", "date_to": "2026-10-05"}).json()[0]
    client.put(f"/api/schedules/assignments/{monday['id']}", json={
        "work_date": "2026-10-05", "start_time": "09:00", "end_time": "18:00", "break_minutes": 60, "tolerance_minutes": 5,
    })
    client.delete(f"/api/schedules/assignments/{monday['id']}")

    changes = [c for _, _, batch in sent for c in batch]
    assert sent[0][0] == "http://crm.local/api/horarios/desde-cuadratura" and sent[0][1] == "clave"
    assert {"crm_agent_id": "A-100", "date": "2026-10-08", "rest_day": True, "notes": "Compensatorio"} in changes
    assert {"crm_agent_id": "A-100", "date": "2026-10-05", "start": "09:00", "end": "18:00", "break_minutes": 60, "notes": None} in changes
    assert changes[-1] == {"crm_agent_id": "A-100", "date": "2026-10-05", "clear": True}
    assert db.query(CrmOutbox).count() == 0


def test_failed_push_stays_queued(crm, db, monkeypatch):
    import httpx

    from app.core.config import get_settings
    from app.models import CrmOutbox

    client, headers = crm
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]

    def down(url, **kw):
        raise httpx.ConnectError("sin conexión")

    monkeypatch.setattr(get_settings(), "crm_url", "http://crm.local")
    monkeypatch.setattr(get_settings(), "crm_api_key", "clave")
    monkeypatch.setattr(httpx, "post", down)
    client.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [emp_id], "date_from": "2026-10-09", "date_to": "2026-10-09", "weekdays": [4], "kind": "vacacion",
    })
    db.expire_all()
    item = db.query(CrmOutbox).one()
    assert item.attempts == 1 and "sin conexión" in item.last_error


def test_existing_employee_matched_by_badge(crm):
    client, headers = crm
    existing = client.post("/api/employees", json={"code": "E-083", "first_name": "Carlos", "last_name": "Pérez", "badge_number": "83"}).json()
    body = _send(client, headers, [_agent(first_name=None, last_name=None)]).json()
    assert body["agents"][0]["employee_id"] == existing["id"]
    assert body["employees_created"] == 0
    assert client.get(f"/api/employees/{existing['id']}").json()["crm_agent_id"] == "A-100"


def test_unknown_agent_is_rejected_not_created(crm):
    client, headers = crm
    body = _send(client, headers, [_agent()]).json()
    assert body["status"] == "error" and body["employees_created"] == 0
    assert body["agents"][0]["status"] == "error"
    assert "no está en Empleados" in body["agents"][0]["message"]
    assert client.get("/api/employees").json()["total"] == 0
    assert client.get("/api/schedules/assignments", params={**WEEK}).json() == []

    # RRHH lo registra y el CRM reenvía: ahora sí se aplica.
    _hire(client)
    assert _send(client, headers, [_agent()]).json()["agents"][0]["status"] == "ok"


def test_crm_does_not_change_employee_data(crm):
    client, headers = crm
    emp = _hire(client, first="Edward Manuel", last="Ramirez Calderon")
    client.put(f"/api/employees/{emp['id']}", json={**{k: v for k, v in emp.items() if k not in ("id", "full_name", "crm_order", "department")}, "hire_date": "2025-01-06"})
    _send(client, headers, [_agent(first_name="EDWARD", last_name="RAMIREZ", hire_date="2026-09-16", badge_number="99")])
    after = client.get(f"/api/employees/{emp['id']}").json()
    assert (after["first_name"], after["last_name"], after["hire_date"], after["badge_number"]) == (
        "EDWARD MANUEL", "RAMIREZ CALDERON", "2025-01-06", "83")
    assert after["crm_agent_id"] == "A-100"


def test_crm_badge_fills_empty_one(crm):
    client, headers = crm
    emp = _hire(client, badge=None)
    _send(client, headers, [_agent()])  # se encuentra por nombre y se le guarda el ID de reloj
    assert client.get(f"/api/employees/{emp['id']}").json()["badge_number"] == "83"


def test_name_match_tolerates_typos(crm):
    client, headers = crm
    emp = _hire(client, badge=None, first="Roberto Antonio", last="Velásquez Claro")
    _hire(client, "E-084", None, "Abigail", "Bernal")
    _hire(client, "E-085", None, "Abigail", "Bernald")
    body = _send(client, headers, [
        _agent("A-1", None, first_name="Robert", last_name="Velasquez Claros."),
        _agent("A-2", None, first_name="Abigal", last_name="Bernal"),  # parecido a los dos: ambiguo
        _agent("A-3", None, first_name="Rob", last_name="Velasquez"),  # palabras cortas: sin tolerancia
    ]).json()
    assert [a["status"] for a in body["agents"]] == ["ok", "error", "error"]
    assert "varios empleados" in body["agents"][1]["message"]
    assert body["agents"][0]["employee_id"] == emp["id"]
    assert client.get(f"/api/employees/{emp['id']}").json()["crm_agent_id"] == "A-1"


def test_name_match_reports_employee_linked_to_other_agent(crm):
    client, headers = crm
    client.post("/api/employees", json={"code": "E-1", "first_name": "José Emilio", "last_name": "Valle Mendoza", "crm_agent_id": "179"})
    agent = _send(client, headers, [_agent("187", None, first_name="José Emilio", last_name="Valle Mendoza")]).json()["agents"][0]
    assert agent["status"] == "error"
    assert "ID de CRM 179" in agent["message"] and "a 187" in agent["message"]


def test_agent_errors_do_not_block_others(crm):
    client, headers = crm
    client.post("/api/employees", json={"code": "E-1", "first_name": "Otro", "last_name": "Agente", "badge_number": "50", "crm_agent_id": "Z-9"})
    _hire(client, "E-077", "77", "Luis", "Alas")
    agents = [
        _agent("A-1", "50"),  # el ID 50 ya pertenece a otro agente del CRM
        _agent("A-2", None, first_name="Nadie", last_name="Registrado"),  # no está en Empleados
        _agent("A-3", "77"),
    ]
    body = _send(client, headers, agents).json()
    assert body["status"] == "parcial"
    assert [a["status"] for a in body["agents"]] == ["error", "error", "ok"]
    assert body["errors"] == 2 and body["shifts_created"] == 2 and body["employees_created"] == 0


def test_validation_errors(crm):
    client, headers = crm
    bad_date = _agent(shifts=[{"date": "2026-10-20", "start": "08:00", "end": "17:00"}])
    assert _send(client, headers, [bad_date]).status_code == 422
    no_times = _agent(shifts=[{"date": "2026-10-05"}])
    assert _send(client, headers, [no_times]).status_code == 422
    assert _send(client, headers, [_agent(), _agent()]).status_code == 422


def test_idempotency_key_returns_same_result(crm):
    client, headers = crm
    h = {**headers, "Idempotency-Key": "crm-2026-W41"}
    first = _send(client, h, [_agent()]).json()
    second = _send(client, h, [_agent()]).json()
    assert first == second
    syncs = client.get("/api/integrations/syncs").json()
    assert syncs["total"] == 1 and syncs["items"][0]["client"]["name"] == "CRM Connecting"


def test_profile_shows_crm_schedule_with_punches(crm, db):
    client, headers = crm
    attlog = (
        b"83\t2026-10-05 07:58:00\t1\t4\t1\t0\n"
        b"83\t2026-10-05 17:03:00\t1\t4\t1\t0\n"
        b"83\t2026-10-06 21:55:00\t1\t4\t1\t0\n"
        b"83\t2026-10-07 06:04:00\t1\t4\t1\t0\n"  # salida del turno nocturno del día 6
    )
    client.post("/api/attendance/imports", files={"file": ("BINH221860214_attlog.dat", attlog, "text/plain")})
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]

    r = client.get(f"/api/employees/{emp_id}/schedule", params={"date_from": "2026-10-05", "date_to": "2026-10-07"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_crm_sync_at"] is not None
    mon, tue, wed = body["days"]
    assert mon["shift"]["source"] == "crm" and len(mon["punches"]) == 2
    assert tue["shift"]["start_at"].startswith("2026-10-07T04:00")
    assert [p["punched_at"][:16] for p in tue["punches"]] == ["2026-10-07T03:55", "2026-10-07T12:04"]
    assert wed["shift"] is None and wed["punches"] == []


def test_employee_can_only_see_own_profile(crm, db):
    client, headers = crm
    _hire(client, "E-1", "1", "Uno", "Agente")
    _hire(client, "E-2", "2", "Dos", "Agente")
    body = _send(client, headers, [_agent("A-1", "1"), _agent("A-2", "2")]).json()
    own, other = (a["employee_id"] for a in body["agents"])

    from app.core.security import hash_password
    from app.models import Role, User

    db.add(User(username="agente", full_name="Agente", password_hash=hash_password("secreto123"), role=Role.empleado, employee_id=own))
    db.commit()
    client.post("/api/auth/login", json={"username": "agente", "password": "secreto123"})

    params = {"date_from": "2026-10-05", "date_to": "2026-10-11"}
    assert client.get(f"/api/employees/{own}/schedule", params=params).status_code == 200
    assert client.get(f"/api/employees/{own}").status_code == 200
    assert client.get(f"/api/employees/{other}/schedule", params=params).status_code == 403
    assert client.get("/api/employees").status_code == 403


def test_roster_complete_releases_absent_agents_only(crm):
    client, headers = crm
    _hire(client, "E-1", "1", "Uno", "Agente")
    _hire(client, "E-2", "2", "Dos", "Agente")
    body = _send(client, headers, [_agent("A-1", "1"), _agent("A-2", "2")]).json()
    emp2 = body["agents"][1]["employee_id"]
    # RRHH ajusta a mano un día de A-2: eso nunca se toca
    client.post("/api/schedules/assignments/bulk", json={"employee_ids": [emp2], "date_from": "2026-10-05",
                "date_to": "2026-10-05", "start_time": "10:00", "end_time": "19:00", "overwrite": True})

    # sin roster_complete, A-2 ausente no se toca
    body = _send(client, headers, [_agent("A-1", "1")]).json()
    assert body["agents_released"] == 0

    # con roster_complete, A-2 ausente pierde sus turnos CRM del periodo, conserva el manual y su ficha
    r = client.post("/api/integrations/crm/schedules",
                    json={**WEEK, "roster_complete": True, "agents": [_agent("A-1", "1")]}, headers=headers)
    body = r.json()
    assert body["agents_released"] == 1 and body["shifts_removed"] == 1
    left = client.get("/api/schedules/assignments", params={**WEEK, "employee_id": emp2}).json()
    assert [(s["work_date"], s["source"]) for s in left] == [("2026-10-05", "manual")]
    assert client.get(f"/api/employees/{emp2}").json()["status"] == "activo"
    # A-1 intacto
    emp1 = body["agents"][0]["employee_id"]
    assert len(client.get("/api/schedules/assignments", params={**WEEK, "employee_id": emp1}).json()) == 2


def test_employees_listed_by_team_like_crm(crm):
    client, headers = crm
    client.post("/api/employees", json={"code": "E-1", "first_name": "Ana", "last_name": "Abarca"})

    def a(crm_id, first, last, team):
        _hire(client, f"E-{100 + int(crm_id)}", None, first, last)
        return _agent(crm_id, None, first_name=first, last_name=last, campaign=team, shifts=[])

    # Orden del CRM: Residencial y luego Líneas; equipo por equipo; supervisor primero.
    sent = [
        a("1", "Miguel", "Núñez", "TEAM MIGUEL NUÑEZ"),
        a("2", "Zoila", "Zelaya", "TEAM MIGUEL NUÑEZ"),
        a("3", "Bruno", "Arias", "TEAM MIGUEL NUÑEZ"),
        a("4", "Rosa", "Vides", "TEAM ROSA VIDES"),
        a("5", "Luis", "Alas", "TEAM ROSA VIDES"),
        a("6", "Carla", "Mejía", "TEAM LINEAS CARLA"),
        a("7", "Ana", "Bonilla", "TEAM LINEAS CARLA"),
    ]
    assert _send(client, headers, sent).status_code == 200

    items = client.get("/api/employees", params={"limit": 50}).json()["items"]
    crm_ids = [e["crm_agent_id"] for e in items]
    assert crm_ids == ["1", "2", "3", "4", "5", "6", "7", None]  # sin equipo, al final
    assert items[5]["department"]["section"] == "lineas"

    teams = [d["name"] for d in client.get("/api/departments").json()]
    assert teams == ["Team Miguel Nuñez", "Team Rosa Vides", "Team Lineas Carla"]


def test_crm_role_marks_team_supervisor(crm):
    client, headers = crm
    _hire(client, "E-1", None, "Victor", "Hurtado")
    _hire(client, "E-2", None, "Ana", "Bonilla")
    team = "TEAM LINEAS VICTOR"
    sent = [
        _agent("1", None, first_name="Victor", last_name="Hurtado", campaign=team, role="Supervisor Team Lineas", shifts=[]),
        _agent("2", None, first_name="Ana", last_name="Bonilla", campaign=team, role="Lineas-Agentes", shifts=[]),
    ]
    assert _send(client, headers, sent).status_code == 200
    sup = {e["crm_agent_id"]: e["is_supervisor"] for e in client.get("/api/employees").json()["items"]}
    assert sup == {"1": True, "2": False}

    # Si el CRM le quita el rol, deja de ser supervisor; si no manda rol, no se toca.
    sent[0]["role"] = "Agente"
    _send(client, headers, sent)
    assert not client.get("/api/employees").json()["items"][0]["is_supervisor"]
    sent[0].pop("role")
    sent[1]["role"] = "Supervisor"
    _send(client, headers, sent)
    assert [e["is_supervisor"] for e in client.get("/api/employees").json()["items"]] == [False, True]


def _local(iso):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.fromisoformat(iso).astimezone(ZoneInfo("America/El_Salvador")).strftime("%Y-%m-%d %H:%M")


def test_rescheduled_shift_waits_for_crm_then_crm_wins(crm, db):
    from app.models import CrmOutbox

    client, headers = crm
    _hire(client)
    _send(client, headers, [_agent()])
    monday = client.get("/api/schedules/assignments", params={"date_from": "2026-10-05", "date_to": "2026-10-05"}).json()[0]

    # RRHH lo pasa del lunes al miércoles (que el CRM mandó libre), de 09:00 a 18:00
    r = client.put(f"/api/schedules/assignments/{monday['id']}",
                   json={"work_date": "2026-10-07", "start_time": "09:00", "end_time": "18:00", "break_minutes": 60})
    assert r.status_code == 200, r.text
    moved = r.json()
    assert (moved["work_date"], moved["source"], _local(moved["start_at"])) == ("2026-10-07", "manual", "2026-10-07 09:00")
    days_off = client.get("/api/schedules/days-off", params=WEEK).json()
    assert [d["work_date"] for d in days_off] == ["2026-10-05"]

    # mientras el cambio no llega al CRM (está en la cola), su reenvío no lo pisa
    body = _send(client, headers, [_agent()]).json()
    assert body["agents"][0]["conflict_dates"] == []
    shifts = client.get("/api/schedules/assignments", params=WEEK).json()
    assert [(s["work_date"], s["source"]) for s in shifts] == [("2026-10-06", "crm"), ("2026-10-07", "manual")]

    # ya entregado, si el CRM manda la semana como antes es porque allá se cambió después: gana el CRM
    db.query(CrmOutbox).delete()
    db.commit()
    _send(client, headers, [_agent()])
    shifts = client.get("/api/schedules/assignments", params=WEEK).json()
    assert [(s["work_date"], s["source"]) for s in shifts] == [("2026-10-05", "crm"), ("2026-10-06", "crm")]
    assert [d["work_date"] for d in client.get("/api/schedules/days-off", params=WEEK).json()] == ["2026-10-07"]  # el libre del CRM


def test_day_off_removes_crm_shift_for_good(crm):
    client, headers = crm
    _hire(client)
    emp_id = _send(client, headers, [_agent()]).json()["agents"][0]["employee_id"]
    r = client.post("/api/schedules/days-off", json={"employee_id": emp_id, "work_date": "2026-10-06", "notes": "Permiso"})
    assert r.status_code == 201, r.text
    _send(client, headers, [_agent()])
    shifts = client.get("/api/schedules/assignments", params=WEEK).json()
    assert [s["work_date"] for s in shifts] == ["2026-10-05"]

    # asignar un turno a mano ese día quita el día libre
    client.post("/api/schedules/assignments/bulk", json={"employee_ids": [emp_id], "date_from": "2026-10-06", "date_to": "2026-10-06",
                                                         "weekdays": [1], "start_time": "08:00", "end_time": "12:00"})
    assert [d["work_date"] for d in client.get("/api/schedules/days-off", params=WEEK).json()] == ["2026-10-07"]  # solo el libre del CRM


def test_crm_rest_days_keep_their_type(crm):
    client, headers = crm
    _hire(client)
    agent = _agent(shifts=[
        {"date": "2026-10-05", "start": "08:00", "end": "17:00"},
        {"date": "2026-10-06", "rest_day": True},
        {"date": "2026-10-07", "rest_day": True, "notes": "Incapacidad"},
        {"date": "2026-10-08", "rest_day": True, "notes": "Vacaciones"},
    ])
    _send(client, headers, [agent])
    offs = {d["work_date"]: (d["kind"], d["source"]) for d in client.get("/api/schedules/days-off", params=WEEK).json()}
    assert offs == {"2026-10-06": ("libre", "crm"), "2026-10-07": ("incapacidad", "crm"), "2026-10-08": ("vacacion", "crm")}

    # el CRM cambia la incapacidad por un turno y quita el libre: aquí también
    agent["shifts"] = [
        {"date": "2026-10-05", "start": "08:00", "end": "17:00"},
        {"date": "2026-10-07", "start": "08:00", "end": "17:00"},
        {"date": "2026-10-08", "rest_day": True, "notes": "Vacaciones"},
    ]
    body = _send(client, headers, [agent]).json()
    assert body["agents"][0]["conflict_dates"] == []
    offs = {d["work_date"]: d["kind"] for d in client.get("/api/schedules/days-off", params=WEEK).json()}
    assert offs == {"2026-10-08": "vacacion"}
    assert [s["work_date"] for s in client.get("/api/schedules/assignments", params=WEEK).json()] == ["2026-10-05", "2026-10-07"]


def test_push_uses_crm_labels(db):
    from datetime import date

    from app.models import Employee, ShiftDayOff
    from app.services.crm_push import _change

    emp = Employee(code="E-1", first_name="A", last_name="B", crm_agent_id="9")
    db.add(emp)
    db.flush()
    for i, kind in enumerate(["vacacion", "incapacidad", "libre"]):
        db.add(ShiftDayOff(employee_id=emp.id, work_date=date(2026, 10, 5 + i), kind=kind, notes="Permiso" if kind == "libre" else None))
    db.flush()
    notes = [_change(db, "9", emp.id, date(2026, 10, 5 + i))["notes"] for i in range(3)]
    assert notes == ["Vacaciones", "Incapacidad", "Permiso"]
