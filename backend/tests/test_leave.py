"""Días de vacación y compensatorios: quitan el turno y se cuentan en la ficha."""

from tests.test_api import _employee


def test_vacation_and_compensatory_days_are_counted(login):
    client = login("rrhh")
    emp = _employee(client)
    client.post("/api/schedules/assignments/bulk", json={
        "employee_ids": [emp["id"]], "date_from": "2026-10-05", "date_to": "2026-10-10",
        "start_time": "08:00", "end_time": "17:00",
    })

    r = client.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [emp["id"]], "date_from": "2026-10-05", "date_to": "2026-10-07",
        "weekdays": [0, 1, 2], "kind": "vacacion",
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"days": 3, "shifts_removed": 3}
    r = client.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [emp["id"]], "date_from": "2026-10-08", "date_to": "2026-10-08", "kind": "compensatorio",
    })
    assert r.status_code == 200, r.text

    sched = client.get(f"/api/employees/{emp['id']}/schedule", params={"date_from": "2026-10-05", "date_to": "2026-10-11"}).json()
    assert sched["leave"] == {"year": 2026, "vacacion": 3, "compensatorio": 1}
    kinds = {d["date"]: (d["day_off"] or {}).get("kind") for d in sched["days"]}
    assert kinds["2026-10-05"] == "vacacion" and kinds["2026-10-08"] == "compensatorio"
    assert [d["date"] for d in sched["days"] if d["shift"]] == ["2026-10-09", "2026-10-10"]


def test_list_days_off_by_kind_for_a_year(login):
    client = login("rrhh")
    emp = _employee(client)
    for kind, day in (("vacacion", "2026-01-05"), ("vacacion", "2026-11-30"), ("compensatorio", "2026-06-01")):
        client.post("/api/schedules/days-off/bulk", json={
            "employee_ids": [emp["id"]], "date_from": day, "date_to": day, "weekdays": [0, 1, 2, 3, 4, 5, 6], "kind": kind,
        })
    year = {"date_from": "2026-01-01", "date_to": "2026-12-31"}
    r = client.get("/api/schedules/days-off", params={**year, "kind": "vacacion"})
    assert r.status_code == 200 and [d["work_date"] for d in r.json()] == ["2026-01-05", "2026-11-30"]
    assert client.get("/api/schedules/days-off", params=year).status_code == 400
