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
    assert (bryan["code"], bryan["crm_agent_id"], bryan["department"]["name"]) == ("28 CN", "123", "TEAM IRANIA SERRANO")
