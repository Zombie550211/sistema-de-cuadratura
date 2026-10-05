from datetime import date

import pytest

from app.services.employee_roster import parse_roster, split_name


@pytest.mark.parametrize(
    "full, first, last",
    [
        ("IRANIA CECILIA SERRANO MEJIA", "IRANIA CECILIA", "SERRANO MEJIA"),
        ("MIGUEL EDUARDO NUÑEZ PEREZ", "MIGUEL EDUARDO", "NUÑEZ PEREZ"),
        ("DANIEL ANTHONY DEL CID ORELLANA", "DANIEL ANTHONY", "DEL CID ORELLANA"),
        ("KARLA GUADALUPE MEJIA DE MELENDEZ", "KARLA GUADALUPE", "MEJIA DE MELENDEZ"),
        ("EMANUEL DE JESUS VELASQUEZ HERNANDEZ", "EMANUEL DE JESUS", "VELASQUEZ HERNANDEZ"),
        ("AMANDA JERKENIA ARAGON SANCHEZ ", "AMANDA JERKENIA", "ARAGON SANCHEZ"),
        ("ANA PEREZ", "ANA", "PEREZ"),
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
    assert (emp["code"], emp["first_name"], emp["last_name"], emp["hire_date"]) == ("28 CN", "BRYAN STANLEY", "SEGOVIA PLEITEZ", "2025-07-03")

    again = client.post("/api/employees/import", json={"text": ROSTER.replace("03/07/2025", "04/07/2025")}).json()
    assert (again["created"], again["updated"], again["unchanged"]) == (0, 1, 2)


def test_import_with_errors_saves_nothing(login):
    client = login("rrhh")
    r = client.post("/api/employees/import", json={"text": ROSTER + "99 CN\tSOLO\tAGENTE\t01/01/2026\n", "dry_run": False}).json()
    assert r["applied"] is False and len(r["errors"]) == 1
    assert client.get("/api/employees").json()["total"] == 0


def test_employee_role_cannot_import(login):
    assert login("empleado").post("/api/employees/import", json={"text": ROSTER}).status_code == 403


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
    assert by_id["150"]["status"] == "error" and not by_id["150"]["employee_created"]  # no está en la planilla
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
    # Fichas que el CRM creó antes de que Empleados fuera la fuente oficial (código CRM-…, nombre corto).
    client = login("admin")
    for crm_id, first, last in [("150", "Eduardo", "Nuñez"), ("152", "Andrea", "Flores"), ("178", "Andrea", "Serrano")]:
        client.post("/api/employees", json={"code": f"CRM-{crm_id}", "crm_agent_id": crm_id, "first_name": first, "last_name": last})
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
    assert (miguel["code"], miguel["full_name"], miguel["hire_date"]) == ("9 CN", "MIGUEL EDUARDO NUÑEZ PEREZ", "2023-06-01")
    assert {e["full_name"] for e in items if e["crm_agent_id"] in ("152", "178")} == {"ANDREA FLORES", "ANDREA SERRANO"}


LISTADO = (
    "EMPLEADO\tCARGO\tINGRESOS A HONORARIOS\tINGRESO A PLANILLA\tLOCKER\tHUELLA LA24 COMEDOR\tDUI\tHUELLA LA17\tHUELLA LB8\n"
    "BRYAN STANLEY SEGOVIA PLEITEZ\tAGENTE DE VENTAS \t03/07/2025\t01/08/2025\t18\t118\t00000000-0\tN/A\t27\n"
    "ANA SOFIA LOPEZ PEREZ\tAGENTE DE VENTAS \t10/09/2026\t-\t32\t450\t00000000-1\t37\t18\n"
)


def test_parse_listado_uses_the_fingerprint_without_na():
    rows, errors = parse_roster(LISTADO)
    assert errors == []
    assert [(r.code, r.badge, r.first_name, r.last_name, r.position, r.hire_date) for r in rows] == [
        (None, "27", "BRYAN STANLEY", "SEGOVIA PLEITEZ", "Agente de ventas", date(2025, 7, 3)),
        (None, "18", "ANA SOFIA", "LOPEZ PEREZ", "Agente de ventas", date(2026, 9, 10)),
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


@pytest.mark.parametrize(
    "position, crm_id, area",
    [("Gerente general", None, "administrativo"), ("GERENTE DE VENTAS", None, "administrativo"),
     ("Asistente de operarciones", None, "administrativo"), ("Asistente de RRHH", None, "administrativo"),
     ("Servicios varios", None, "administrativo"), ("Asistente administrativa", None, "administrativo"),
     ("IT", None, "operativo"), ("Publicidad", None, "operativo"),
     ("Supervisora de ventas", None, "supervisor"), ("AGENTE DE VENTAS", None, "ventas"), ("BO", None, "ventas"),
     ("Control de calidad", None, "ventas"), (None, "150", "ventas"), (None, None, "ventas")],
)
def test_area_for(position, crm_id, area):
    from app.models import area_for

    assert area_for(position, crm_id) == area


def test_employees_filtered_by_area(login):
    client = login("rrhh")
    roster = ROSTER + "4 CN\tIRANIA CECILIA SERRANO MEJIA\tSUPERVISORA DE VENTAS\t07/04/2021\n"
    client.post("/api/employees/import", json={"text": roster, "dry_run": False})
    areas = {e["code"]: e["area"] for e in client.get("/api/employees").json()["items"]}
    assert areas == {"28 CN": "ventas", "60 CN": "ventas", "61 CN": "ventas", "4 CN": "supervisor"}
    assert [e["code"] for e in client.get("/api/employees", params={"area": "supervisor"}).json()["items"]] == ["4 CN"]

    # RRHH la cambia a mano; se respeta mientras el cargo no cambie.
    emp = client.get("/api/employees", params={"q": "Pleitez"}).json()["items"][0]
    body = {k: v for k, v in emp.items() if k not in ("id", "full_name", "crm_order", "department")}
    assert client.put(f"/api/employees/{emp['id']}", json={**body, "area": "operativo"}).json()["area"] == "operativo"
    assert client.put(f"/api/employees/{emp['id']}", json={**body, "area": None}).json()["area"] == "operativo"
    assert client.put(f"/api/employees/{emp['id']}", json={**body, "area": None, "position": "Gerente general"}).json()["area"] == "administrativo"
    assert client.get("/api/employees", params={"area": "otra"}).status_code == 422


PLANILLA = "\t".join([
    "N°", "EMPLEADO", "CARGO", "SUELDO ", "INGRESOS A HONORARIOS", "INGRESO A PLANILLA", "LOCKER",
    "HUELLA LA24 COMEDOR", "DUI", "FECHA DE NACIMIENTO M/D/A", "NIT", "CUENTA BANCARIA", "ISSS", "AFP", "EMPRESA",
    "HUELLA LA17", "HUELLA LB8", "HUELLA LA18", "CV", "CONTRATO", "ACUERDO DE CONFIDENCIALIDAD", "MEMORANDUM",
    "GÉNERO", "NUMERO DE EMERGENCIA", "FINALIZACION", "CORREOS", "CONTRASEÑA",
]) + "\n" + "\n".join("\t".join(r) for r in [
    ["1 CN", "ANA SOFIA LOPEZ PEREZ", "GERENTE GENERAL", " $ 3,000.00 ", "01/02/2019", "01/02/2019", "N/A", "-",
     "00000001-1", "19/July", "0614-010101-101-1", "3220000001", "100000001", "00000001-1", "CONFIA",
     "1", "N/A", "15", "SI", "SI", "", "", "FEMENINO", "", "", "ana@ejemplo.com", "secreta1"],
    ["2 CN", "BRYAN STANLEY SEGOVIA PLEITEZ", "IT", " $ 850.00 ", "26/05/2023", "26/05/2023", "12", "89",
     "00000002-2", "05/June", "VICTOR LINEAS", "3220000002", "100000002", "-", "CRECER",
     "N/A", "27", "N/A", "SI", "SI", "SI", "", "MASCULINO", "7000-0000 madre", "RENUNCIA 27/09/2026 TRABAJO HASTA 26/09/2026",
     "bryan@ejemplo.com", "secreta2"],
    ["", "SIN NUMERO PEREZ", "", "", "", "01/01/2019", "", "", "00000003-3"],
    ["", "", "", "FECH INICIO", "FECH FINALI"],
])


def test_payroll_import_fills_the_whole_record(login):
    client = login("rrhh")
    client.post("/api/employees/import", json={"text": ROSTER, "dry_run": False})  # Bryan ya existe como 28 CN
    preview = client.post("/api/employees/import", json={"text": PLANILLA}).json()
    assert preview["errors"] == []
    assert [(r["code"], r["status"], r["area"]) for r in preview["rows"]] == [
        ("1 CN", "nuevo", "administrativo"), ("2 CN", "actualizar", "operativo"), (None, "ambiguo", None)]

    client.post("/api/employees/import", json={"text": PLANILLA, "dry_run": False})
    bryan = client.get("/api/employees", params={"q": "Pleitez"}).json()["items"][0]
    assert (bryan["code"], bryan["area"], bryan["base_salary"], bryan["badge_number"]) == ("2 CN", "operativo", "850.00", None)
    assert (bryan["status"], bryan["termination_date"], bryan["nit"], bryan["afp"]) == ("inactivo", "2026-09-27", None, "AFP Crecer")
    assert bryan["fingerprints"] == {"LA24 comedor": "89", "LB8": "27"}
    assert (bryan["has_cv"], bryan["has_nda"], bryan["has_memo"], bryan["birthday"]) == (True, True, False, "06-05")
    ana = client.get("/api/employees", params={"q": "Sofia"}).json()["items"][0]
    assert (ana["dui"], ana["nup"], ana["bank_account"], ana["email"], ana["payroll_date"]) == (
        "00000001-1", "00000001-1", "3220000001", "ana@ejemplo.com", "2019-02-01")
    assert "secreta1" not in str(ana)

    again = client.post("/api/employees/import", json={"text": PLANILLA}).json()
    assert (again["created"], again["updated"], again["unchanged"]) == (0, 0, 2)


def test_payroll_codes_can_swap_between_people(login):
    client = login("rrhh")
    client.post("/api/employees/import", json={"text": ROSTER, "dry_run": False})  # 28 CN Bryan, 60 CN Cristian…
    swapped = PLANILLA.replace("1 CN\tANA SOFIA LOPEZ PEREZ", "60 CN\tCRISTIAN ANTONIO NIETO RIVERA").replace("2 CN\t", "28X\t")
    swapped = swapped.replace("60 CN\tCRISTIAN", "28 CN\tCRISTIAN").replace("28X\t", "60 CN\t")
    r = client.post("/api/employees/import", json={"text": swapped, "dry_run": False}).json()
    assert r["applied"] is True
    codes = {e["full_name"]: e["code"] for e in client.get("/api/employees", params={"limit": 50}).json()["items"]}
    assert codes["CRISTIAN ANTONIO NIETO RIVERA"] == "28 CN" and codes["BRYAN STANLEY SEGOVIA PLEITEZ"] == "60 CN"


@pytest.mark.parametrize(
    "first, last, birthday, code",
    [("Kelvin Ivan", "Rodriguez Zelada", "07-19", "KR1907"), ("Ángel", "Ñuñez", "12-03", "AN0312"),
     ("Daniel Anthony", "Del Cid Orellana", "04-05", "DD0504"), ("Ana", "Perez", None, None)],
)
def test_user_code_base(first, last, birthday, code):
    from app.models import user_code_base

    assert user_code_base(first, last, birthday) == code


def test_user_code_assigned_unique_and_stable(login):
    client = login("rrhh")
    client.post("/api/employees/import", json={"text": PLANILLA, "dry_run": False})
    ana = client.get("/api/employees", params={"q": "Sofia"}).json()["items"][0]
    assert ana["user_code"] == "AL1907"
    assert client.get("/api/employees", params={"q": "al1907"}).json()["total"] == 1

    # Otra persona con las mismas iniciales y cumpleaños recibe el sufijo -2.
    other = client.post("/api/employees", json={"code": "X1", "first_name": "Alma", "last_name": "Luna", "birthday": "07-19"}).json()
    assert other["user_code"] == "AL1907-2"
    # Corregir el nombre no cambia el ID; sin cumpleaños no hay ID.
    body = {k: v for k, v in other.items() if k not in ("id", "full_name", "crm_order", "department")}
    assert client.put(f"/api/employees/{other['id']}", json={**body, "first_name": "Berta"}).json()["user_code"] == "AL1907-2"
    assert client.post("/api/employees", json={"code": "X2", "first_name": "Sin", "last_name": "Fecha"}).json()["user_code"] is None
    # Asignarlo a mano a uno que ya existe se rechaza.
    r = client.put(f"/api/employees/{other['id']}", json={**body, "user_code": "al1907"})
    assert r.status_code == 409 and "ID de usuario" in r.json()["detail"]


def test_certificates_record_who_issued_them(login):
    client = login("rrhh")
    emp = client.post("/api/employees", json={"code": "C1", "first_name": "Ana", "last_name": "Lopez"}).json()
    body = {"template": "bono", "issue_date": "2026-10-02", "salary": "408.80", "extra": "50", "html": "<div class=\"cert-page\">Hoja</div>"}
    r = client.post(f"/api/employees/{emp['id']}/certificates", json=body)
    assert r.status_code == 201, r.text
    cert = r.json()
    assert (cert["issued_by_name"], cert["template"], cert["salary"], cert["extra"]) == ("U_Rrhh", "bono", "408.80", "50.00")
    listed = client.get(f"/api/employees/{emp['id']}/certificates").json()
    assert [c["id"] for c in listed] == [cert["id"]] and "html" not in listed[0]
    assert client.get(f"/api/certificates/{cert['id']}").json()["html"] == body["html"]
    assert client.post("/api/employees/9999/certificates", json=body).status_code == 404

    sup = login("empleado")
    assert sup.get(f"/api/employees/{emp['id']}/certificates").status_code == 403
    assert sup.post(f"/api/employees/{emp['id']}/certificates", json=body).status_code == 403
