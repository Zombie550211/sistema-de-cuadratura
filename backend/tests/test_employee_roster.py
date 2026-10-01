from datetime import date

import pytest

from app.services.employee_roster import parse_roster, split_name


@pytest.mark.parametrize(
    "full, first, last",
    [
        ("IRANIA CECILIA SERRANO MEJIA", "Irania Cecilia", "Serrano Mejia"),
        ("MIGUEL EDUARDO NUÑEZ PEREZ", "Miguel Eduardo", "Nuñez Perez"),
        ("DANIEL ANTHONY DEL CID ORELLANA", "Daniel Anthony", "Del Cid Orellana"),
        ("KARLA GUADALUPE MEJIA DE MELENDEZ", "Karla Guadalupe", "Mejia de Melendez"),
        ("EMANUEL DE JESUS VELASQUEZ HERNANDEZ", "Emanuel de Jesus", "Velasquez Hernandez"),
        ("AMANDA JERKENIA ARAGON SANCHEZ ", "Amanda Jerkenia", "Aragon Sanchez"),
        ("ANA PEREZ", "Ana", "Perez"),
    ],
)
def test_split_name(full, first, last):
    assert split_name(full) == (first, last)


def test_parse_roster_reports_bad_lines():
    rows, errors = parse_roster(
        "4 CN\tIRANIA CECILIA SERRANO MEJIA\tSUPERVISORA DE VENTAS\t07/04/2021\n"
        "\n"
        "7 CN\tLUIS FERNANDO CHAVARRIA GIL\tAGENTE DE VENTAS \t31/02/2023\n"
        "4 cn\tOTRA PERSONA\tAGENTE\t01/01/2024\n"
        "sin columnas\n"
    )
    assert [(r.code, r.position, r.hire_date) for r in rows] == [("4 CN", "Supervisora de ventas", date(2021, 4, 7))]
    assert [e.line for e in errors] == [3, 4, 5]
    assert "Fecha de ingreso inválida" in errors[0].message
    assert "repetido" in errors[1].message


ROSTER = (
    "28 CN\tBRYAN STANLEY SEGOVIA PLEITEZ\tAGENTE DE VENTAS \t03/07/2025\n"
    "60 CN\tCRISTIAN ANTONIO NIETO RIVERA\tAGENTE DE VENTAS \t04/06/2026\n"
    "61 CN\tCRISTIAN JESUS HERNANDEZ ORELLANA\tAGENTE DE VENTAS \t09/06/2026\n"
)


def test_import_preview_then_apply_is_idempotent(login):
    client = login("rrhh")
    preview = client.post("/api/employees/import", json={"text": ROSTER}).json()
    assert (preview["created"], preview["applied"]) == (3, False)
    assert client.get("/api/employees").json()["total"] == 0

    applied = client.post("/api/employees/import", json={"text": ROSTER, "dry_run": False}).json()
    assert applied["applied"] is True
    emp = client.get("/api/employees", params={"q": "Pleitez"}).json()["items"][0]
    assert (emp["code"], emp["first_name"], emp["last_name"], emp["hire_date"]) == ("28 CN", "Bryan Stanley", "Segovia Pleitez", "2025-07-03")

    again = client.post("/api/employees/import", json={"text": ROSTER.replace("03/07/2025", "04/07/2025")}).json()
    assert (again["created"], again["updated"], again["unchanged"]) == (0, 1, 2)


def test_import_with_errors_saves_nothing(login):
    client = login("rrhh")
    r = client.post("/api/employees/import", json={"text": ROSTER + "99 CN\tSOLO\tAGENTE\t01/01/2026\n", "dry_run": False}).json()
    assert r["applied"] is False and len(r["errors"]) == 1
    assert client.get("/api/employees").json()["total"] == 0


def test_supervisor_cannot_import(login):
    assert login("supervisor").post("/api/employees/import", json={"text": ROSTER}).status_code == 403


def test_crm_agent_matched_to_roster_by_short_name(login):
    client = login("admin")
    client.post("/api/employees/import", json={"text": ROSTER, "dry_run": False})
    key = client.post("/api/integrations/clients", json={"name": "CRM"}).json()["api_key"]

    def agent(crm_id, first, last):
        return {"crm_agent_id": crm_id, "first_name": first, "last_name": last, "campaign": "TEAM IRANIA SERRANO", "shifts": []}

    body = client.post(
        "/api/integrations/crm/schedules",
        headers={"X-API-Key": key},
        json={
            "date_from": "2026-10-05",
            "date_to": "2026-10-11",
            "agents": [agent("123", "Bryan", "Pleitez"), agent("140", "Cristian", ""), agent("150", "Marvin", "Avalos")],
        },
    ).json()
    by_id = {a["crm_agent_id"]: a for a in body["agents"]}
    assert by_id["123"]["status"] == "ok" and not by_id["123"]["employee_created"]
    assert by_id["150"]["employee_created"]  # no está en la nómina: se crea
    assert by_id["140"]["status"] == "error"  # "Cristian" solo no alcanza para decidir
    bryan = client.get("/api/employees", params={"q": "Pleitez"}).json()["items"][0]
    assert (bryan["code"], bryan["crm_agent_id"], bryan["department"]["name"]) == ("28 CN", "123", "Team Irania Serrano")


@pytest.mark.parametrize(
    "raw, fixed",
    [("JONATHAN F", "Jonathan F"), ("TEAM LINEAS JONATHAN", "Team Lineas Jonathan"), ("EMANUEL DE JESUS", "Emanuel de Jesus"),
     ("Ventas USA", "Ventas USA"), ("Cesar Claros", "Cesar Claros"), ("nancy  lopez ", "Nancy Lopez")],
)
def test_fix_case(raw, fixed):
    from app.services.employee_roster import fix_case

    assert fix_case(raw) == fixed


def test_roster_links_employees_created_by_crm(login):
    client = login("admin")
    key = client.post("/api/integrations/clients", json={"name": "CRM"}).json()["api_key"]

    def agent(crm_id, first, last):
        return {"crm_agent_id": crm_id, "first_name": first, "last_name": last, "campaign": "TEAM LINEAS VICTOR", "shifts": []}

    client.post(
        "/api/integrations/crm/schedules",
        headers={"X-API-Key": key},
        json={"date_from": "2026-10-05", "date_to": "2026-10-11",
              "agents": [agent("150", "EDUARDO", "NUÑEZ"), agent("152", "ANDREA", "FLORES"), agent("178", "Andrea", "Serrano")]},
    )
    roster = (
        "9 CN\tMIGUEL EDUARDO NUÑEZ PEREZ\tSUPERVISOR DE VENTAS\t01/06/2023\n"
        "69 CN\tANDREA PAOLA SERRANO FLORES\tAGENTE DE VENTAS \t06/07/2026\n"
    )
    preview = client.post("/api/employees/import", json={"text": roster}).json()
    status = {r["code"]: r["status"] for r in preview["rows"]}
    assert status == {"9 CN": "actualizar", "69 CN": "ambiguo"}

    client.post("/api/employees/import", json={"text": roster, "dry_run": False})
    items = client.get("/api/employees").json()["items"]
    assert len(items) == 3  # no se duplicó nadie
    miguel = next(e for e in items if e["crm_agent_id"] == "150")
    assert (miguel["code"], miguel["full_name"], miguel["hire_date"]) == ("9 CN", "Miguel Eduardo Nuñez Perez", "2023-06-01")
    assert {e["full_name"] for e in items if e["crm_agent_id"] in ("152", "178")} == {"Andrea Flores", "Andrea Serrano"}


LISTADO = (
    "EMPLEADO\tCARGO\tINGRESOS A HONORARIOS\tINGRESO A PLANILLA\tLOCKER\tHUELLA LA24 COMEDOR\tDUI\tHUELLA LA17\tHUELLA LB8\n"
    "BRYAN STANLEY SEGOVIA PLEITEZ\tAGENTE DE VENTAS \t03/07/2025\t01/08/2025\t18\t118\t00000000-0\tN/A\t27\n"
    "ANA SOFIA LOPEZ PEREZ\tAGENTE DE VENTAS \t10/09/2026\t-\t32\t450\t00000000-1\t37\t18\n"
)


def test_parse_listado_uses_the_fingerprint_without_na():
    rows, errors = parse_roster(LISTADO)
    assert errors == []
    assert [(r.code, r.badge, r.first_name, r.last_name, r.position, r.hire_date) for r in rows] == [
        (None, "27", "Bryan Stanley", "Segovia Pleitez", "Agente de ventas", date(2025, 7, 3)),
        (None, "18", "Ana Sofia", "Lopez Perez", "Agente de ventas", date(2026, 9, 10)),
    ]


def test_parse_listado_rejects_repeated_fingerprint():
    rows, errors = parse_roster(LISTADO.replace("\t18\n", "\t27\n"))
    assert len(rows) == 1 and "Huella repetida" in errors[0].message


def test_listado_sets_badge_on_existing_and_creates_new(login):
    client = login("rrhh")
    client.post("/api/employees/import", json={"text": ROSTER, "dry_run": False})

    preview = client.post("/api/employees/import", json={"text": LISTADO}).json()
    assert {r["badge"]: r["status"] for r in preview["rows"]} == {"27": "actualizar", "18": "nuevo"}

    client.post("/api/employees/import", json={"text": LISTADO, "dry_run": False})
    bryan = client.get("/api/employees", params={"q": "Pleitez"}).json()["items"][0]
    assert (bryan["code"], bryan["badge_number"], bryan["hire_date"]) == ("28 CN", "27", "2025-07-03")
    ana = client.get("/api/employees", params={"q": "Sofia"}).json()["items"][0]
    assert (ana["code"], ana["badge_number"]) == ("18", "18")

    # Ya enlazados por huella: volver a importar no cambia nada.
    again = client.post("/api/employees/import", json={"text": LISTADO}).json()
    assert (again["created"], again["updated"], again["unchanged"]) == (0, 0, 2)
