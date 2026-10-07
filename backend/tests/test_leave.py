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


def test_vacation_periods_accumulate_and_take_rested_days_oldest_first():
    from datetime import date, timedelta

    from app.services.vacations import PeriodRecord, vacation_status

    new = vacation_status(date(2026, 1, 5), date(2026, 10, 7), [])
    assert (new.years, new.periods, new.pending, new.next_date) == (0, [], 0, date(2027, 1, 5))

    hire = date(2023, 3, 10)
    rested = [date(2025, 4, 1) + timedelta(days=i) for i in range(12)]
    records = {date(2024, 3, 10): PeriodRecord(worked_days=5), date(2026, 3, 10): PeriodRecord(worked_days=3)}
    s = vacation_status(hire, date(2026, 10, 7), rested, records)
    assert [p.start for p in s.periods] == [date(2024, 3, 10), date(2025, 3, 10), date(2026, 3, 10)]
    # 2024: 5 trabajados + 10 descansados = completo; 2025: los otros 2 descansados; 2026: 3 trabajados.
    assert [(len(p.rested), p.worked, p.pending) for p in s.periods] == [(10, 5, 0), (2, 0, 13), (0, 3, 12)]
    assert s.pending == 25

    closed = vacation_status(hire, date(2026, 10, 7), [], {date(2024, 3, 10): PeriodRecord(settled=True)})
    assert [p.pending for p in closed.periods] == [0, 15, 15]

    leap = vacation_status(date(2024, 2, 29), date(2025, 3, 1), [])
    assert leap.periods[0].start == date(2025, 2, 28)


def test_vacation_period_worked_days_and_settled(login):
    client = login("rrhh")
    emp = _employee(client, hire_date="2023-01-15")
    v = next(x for x in client.get("/api/schedules/vacations").json() if x["employee_id"] == emp["id"])
    first, second = v["periods"][0]["start"], v["periods"][1]["start"]
    assert first == "2024-01-15" and v["pending"] == 15 * len(v["periods"])

    assert client.put(f"/api/schedules/vacations/{emp['id']}/periods/{first}", json={"settled": True}).status_code == 204
    assert client.put(f"/api/schedules/vacations/{emp['id']}/periods/{second}", json={"worked_days": 15}).status_code == 204
    assert client.put(f"/api/schedules/vacations/{emp['id']}/periods/2024-02-01", json={"worked_days": 1}).status_code == 400
    v = next(x for x in client.get("/api/schedules/vacations").json() if x["employee_id"] == emp["id"])
    assert [p["pending"] for p in v["periods"][:2]] == [0, 0]
    assert v["periods"][1]["worked"] == 15


def test_holy_week_and_default_holidays():
    from datetime import date

    from app.services.compensatory import default_holidays, easter

    assert easter(2026) == date(2026, 4, 5) and easter(2027) == date(2027, 3, 28)
    days = dict(default_holidays(2026))
    assert days[date(2026, 4, 2)] == "Jueves Santo" and days[date(2026, 9, 15)] == "Día de la Independencia"
    assert len(days) == 11


def test_holiday_with_punch_earns_compensatory_and_without_is_lost(client, login, db):
    from datetime import datetime

    from app.models import Device, ImportBatch, Punch

    hr = login("rrhh")
    worked = _employee(hr, code="E-010", first_name="Ana", hire_date="2020-01-01")
    absent = _employee(hr, code="E-011", first_name="Luis", hire_date="2020-01-01")
    assert any(h["day"] == "2026-09-15" for h in hr.get("/api/schedules/holidays", params={"year": 2026}).json())

    device = Device(serial_number="TEST-1", name="Test")
    db.add(device)
    db.flush()
    batch = ImportBatch(device_id=device.id, original_filename="a.dat", sha256="x" * 64, storage_key="a.dat")
    db.add(batch)
    db.flush()
    db.add(Punch(device_id=device.id, badge="10", employee_id=worked["id"], punched_at=datetime.fromisoformat("2026-09-15T07:05:00-06:00"), import_batch_id=batch.id))
    db.commit()

    hr.post("/api/schedules/days-off/bulk", json={
        "employee_ids": [worked["id"]], "date_from": "2026-10-01", "date_to": "2026-10-01", "weekdays": [3], "kind": "compensatorio",
    })
    status = {s["employee_id"]: s for s in hr.get("/api/schedules/compensatory").json()}
    assert [h["day"] for h in status[worked["id"]]["earned"]] == ["2026-09-15"]
    assert (status[worked["id"]]["taken"], status[worked["id"]]["balance"]) == (1, 0)
    assert status[absent["id"]]["earned"] == [] and [h["day"] for h in status[absent["id"]]["lost"]] == ["2026-09-15"]
