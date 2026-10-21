import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { IconChevronLeft, IconChevronRight, IconFile } from "../components/Icons";
import { type IssuedCertificate, printCertificate, SalaryCertificate, sanitizeCertificateHtml, TEMPLATES } from "../components/SalaryCertificate";
import { useNow } from "../components/LiveClock";
import { Modal } from "../components/Modal";
import { api, AREAS, areaPath, DAY_OFF_LABEL, DOCS, type CompensatoryStatus, type Department, type Employee, type EmployeeSchedule, type ShiftTemplate, type WorkDay } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtBirthday, fmtDate, fmtDateTime, fmtMoney, fmtShortDay, fmtTime, fmtTimeSec, hoursFrom, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EmployeeForm } from "./EmployeeForm";
import { AssignModal } from "./Schedules";

/** Ruta /empleados/:id (personal de RRHH). */
export function EmployeeProfilePage() {
  const { id } = useParams();
  return <EmployeeProfile employeeId={Number(id)} showBack />;
}

/** Perfil del empleado: datos, horario enviado por el CRM y marcaciones del reloj, día por día.
 *  Lo usa RRHH y también el propio empleado (portal). */
export function EmployeeProfile({ employeeId, showBack = false }: { employeeId: number; showBack?: boolean }) {
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [start, setStart] = useState(() => weekStart(today()));
  const [editing, setEditing] = useState(false);
  const [certificate, setCertificate] = useState(false);
  const [compensating, setCompensating] = useState(false);
  const [assigning, setAssigning] = useState<false | "turno" | "vacacion" | "compensatorio">(false);
  const end = addDays(start, 6);

  const employee = useAsync(() => api.get<Employee>(`/employees/${employeeId}`), [employeeId]);
  const schedule = useAsync(
    () => api.get<EmployeeSchedule>(`/employees/${employeeId}/schedule`, { date_from: start, date_to: end }),
    [employeeId, start, end],
  );
  const certificates = useAsync(
    () => (canEdit ? api.get<IssuedCertificate[]>(`/employees/${employeeId}/certificates`) : Promise.resolve([])),
    [employeeId, canEdit],
  );
  const departments = useAsync(() => (canEdit ? api.get<Department[]>("/departments") : Promise.resolve([])), [canEdit]);
  const templates = useAsync(() => (canEdit ? api.get<ShiftTemplate[]>("/schedules/templates") : Promise.resolve([])), [canEdit]);

  const e = employee.data;
  const days = schedule.data?.days ?? [];
  const totals = useMemo(() => weekTotals(days), [days]);
  // La escala va de 00:00 a 24:00, o hasta 30:00 si hay turnos o marcas que pasan la medianoche.
  const maxHour = useMemo(() => {
    const latest = days.flatMap((d) => [
      ...(d.shift ? [hoursFrom(d.date, d.shift.end_at)] : []),
      ...d.punches.map((p) => hoursFrom(d.date, p.punched_at)),
    ]);
    return Math.max(24, ...latest.map((h) => Math.ceil(h / 6) * 6)) > 24 ? 30 : 24;
  }, [days]);

  if (employee.error) return <div className="alert">{employee.error}</div>;
  if (!e) {
    return (
      <div className="center-screen" style={{ minHeight: 240 }}>
        <div className="spinner" />
      </div>
    );
  }

  const initials = `${e.first_name[0] ?? ""}${e.last_name[0] ?? ""}`.toUpperCase();

  return (
    <div className="page">
      {showBack && (
        <Link to={areaPath(e.area)} className="back-link">
          <IconChevronLeft width={16} height={16} /> {AREAS.find((a) => a.area === e.area)!.label}
        </Link>
      )}

      <div className="card">
        <div className="profile-head">
          <div className="avatar">{initials}</div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <h1>{e.full_name}</h1>
            <div className="muted">
              {[e.position, e.department?.name].filter(Boolean).join(" · ") || "Sin cargo ni campaña asignados"}
            </div>
            <div className="ids">
              {e.user_code ? <span className="badge accent" title="ID de usuario">{e.user_code}</span> : <span className="badge warn" title="Se genera al cargar el cumpleaños">Sin ID de usuario</span>}
              <span className="badge">{e.code}</span>
              {e.badge_number ? <span className="badge accent">Reloj {e.badge_number}</span> : <span className="badge warn">Sin ID de reloj</span>}
              {e.crm_agent_id ? <span className="badge accent">CRM {e.crm_agent_id}</span> : <span className="badge">Sin ID de CRM</span>}
              <span className={`badge${e.status === "activo" ? "" : " danger"}`}>{e.status}</span>
            </div>
          </div>
          {canEdit && (
            <div className="row">
              <button className="btn ghost" onClick={() => setAssigning("turno")} disabled={!templates.data || e.status !== "activo"}>
                Asignar horario
              </button>
              <button className="btn ghost" onClick={() => setCertificate(true)}>
                <IconFile /> Constancia salarial
              </button>
              <button className="btn ghost" onClick={() => setEditing(true)}>
                Editar datos
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Planilla</h3>
          {e.termination_note && <span className="badge danger">{e.termination_note}</span>}
        </div>
        <dl className="facts">
          <Fact label="Área" value={AREAS.find((a) => a.area === e.area)!.label} />
          <Fact label="Sueldo" value={Number(e.base_salary) > 0 ? `${fmtMoney(e.base_salary)} · ${e.pay_frequency}` : null} />
          <Fact label="Ingreso (honorarios)" value={e.hire_date && fmtDate(e.hire_date)} />
          <Fact label="Ingreso a planilla" value={e.payroll_date && fmtDate(e.payroll_date)} />
          <Fact label="DUI" value={e.dui} />
          <Fact label="NIT" value={e.nit} />
          <Fact label="ISSS" value={e.isss_number} />
          <Fact label="AFP" value={[e.afp, e.nup].filter(Boolean).join(" · ") || null} />
          <Fact label="Cuenta bancaria" value={e.bank_account} />
          <Fact label="Cumpleaños" value={e.birthday && fmtBirthday(e.birthday)} />
          <Fact label="Género" value={e.gender} />
          <Fact label="Correo" value={e.email} />
          <Fact label="Emergencia" value={e.emergency_contact} />
          <Fact label="Locker" value={e.locker} />
          <Fact
            label="Huellas"
            value={Object.entries(e.fingerprints).map(([clock, n]) => `${clock}: ${n}`).join(" · ") || null}
          />
          <Fact label="Expediente" value={DOCS.map(([key, label]) => `${e[key] ? "✓" : "✗"} ${label}`).join("  ")} />
        </dl>
      </div>

      {canEdit && <Certificates items={certificates.data ?? []} error={certificates.error} name={e.full_name} />}

      <div className="stats six">
        <Stat label="Horas programadas" value={fmtHours(totals.scheduled)} />
        <Stat label="Días con turno" value={String(totals.shiftDays)} />
        <Stat label="Días con marcas" value={String(totals.punchDays)} />
        <Stat label="Días libres" value={String(7 - totals.shiftDays - totals.vacation - totals.compensatory)} />
        <Stat
          label="Días de vacación"
          value={String(totals.vacation)}
          hint={schedule.data ? `${schedule.data.leave.vacacion} en ${schedule.data.leave.year}` : undefined}
          onAdd={canEdit ? () => setAssigning("vacacion") : undefined}
        />
        <Stat
          label="Días compensatorio"
          value={String(totals.compensatory)}
          hint={schedule.data ? `${schedule.data.leave.compensatorio} en ${schedule.data.leave.year}` : undefined}
          onAdd={canEdit ? () => setAssigning("compensatorio") : undefined}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="row">
            <button className="icon-btn" onClick={() => setStart(addDays(start, -7))} aria-label="Semana anterior">
              <IconChevronLeft width={20} height={20} />
            </button>
            <h3 className="mono">
              {start} → {end}
            </h3>
            <button className="icon-btn" onClick={() => setStart(addDays(start, 7))} aria-label="Semana siguiente">
              <IconChevronRight width={20} height={20} />
            </button>
            <button className="btn ghost sm" onClick={() => setStart(weekStart(today()))}>
              Esta semana
            </button>
            {canEdit && e.status === "activo" && (
              <button className="btn sm" onClick={() => setCompensating(true)}>
                Compensatorio
              </button>
            )}
          </div>
          <span className="caption">
            {schedule.data?.last_crm_sync_at
              ? `Horario recibido del CRM: ${fmtDateTime(schedule.data.last_crm_sync_at)}`
              : "Aún no hay horarios recibidos del CRM"}
          </span>
        </div>

        <div className="legend" style={{ marginBottom: 8 }}>
          <span>
            <i style={{ background: "var(--accent-deep)", border: "1px solid var(--accent)" }} />
            Turno asignado
          </span>
          <span>
            <i style={{ background: "var(--text)" }} />
            Marca del reloj
          </span>
          <span>
            <i style={{ background: "var(--muted-2)" }} />
            Doble marca (no cuenta)
          </span>
        </div>

        {schedule.error && <div className="alert">{schedule.error}</div>}
        <div className="days-list">
          {days.map((d) => (
            <DayRow key={d.date} day={d} maxHour={maxHour} />
          ))}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={[e]}
          templates={templates.data ?? []}
          defaultFrom={start}
          defaultTo={end}
          initialSelected={[e.id]}
          initialMode={assigning}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            schedule.reload();
          }}
        />
      )}
      {compensating && (
        <CompensatoryModal
          employee={e}
          initialMonth={start.slice(0, 7)}
          onClose={() => setCompensating(false)}
          onDone={(day) => {
            setCompensating(false);
            setStart(weekStart(day));
            schedule.reload();
          }}
        />
      )}
      {certificate && <SalaryCertificate employee={e} onClose={() => setCertificate(false)} onIssued={certificates.reload} />}
      {editing && (
        <EmployeeForm
          employee={e}
          departments={departments.data ?? []}
          readOnly={false}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            employee.reload();
            schedule.reload();
          }}
          onDepartmentCreated={(d) => departments.setData([...(departments.data ?? []), d])}
        />
      )}
    </div>
  );
}

function DayRow({ day, maxHour }: { day: WorkDay; maxHour: number }) {
  const now = useNow(60_000);
  const isToday = day.date === today();
  const pct = (h: number) => `${Math.min(Math.max(h / maxHour, 0), 1) * 100}%`;
  const shift = day.shift;
  const nowH = hoursFrom(day.date, now.toISOString());

  return (
    <>
      <div className={`day-row${isToday ? " today" : ""}`}>
        <div>
          <div className="day-name" style={{ textTransform: "capitalize" }}>
            {fmtShortDay(day.date)}
          </div>
          <div className="caption mono">{day.date}</div>
        </div>
        <div className="shift-info">
          {shift ? (
            <>
              <b>
                {fmtTime(shift.start_at)} – {fmtTime(shift.end_at)}
              </b>
              <span className="caption">
                {shift.source === "crm" ? "Enviado por el CRM" : "Ajustado por RRHH"} · {shift.break_minutes} min descanso
              </span>
            </>
          ) : day.day_off && day.day_off.kind !== "libre" ? (
            <>
              <b>{DAY_OFF_LABEL[day.day_off.kind]}</b>
              {day.day_off.notes && <span className="caption">{day.day_off.notes}</span>}
            </>
          ) : (
            <span className="muted">Libre</span>
          )}
        </div>
        <div className="track" aria-label={`Línea de tiempo del ${day.date}`}>
          {Array.from({ length: maxHour / 6 + 1 }, (_, i) => i * 6).map((h) => (
            <div key={h} className="tick" style={{ left: pct(h) }}>
              {h < maxHour && <span>{String(h % 24).padStart(2, "0")}</span>}
            </div>
          ))}
          {shift && (
            <div
              className="block"
              title={`${fmtTime(shift.start_at)} – ${fmtTime(shift.end_at)}`}
              style={{ left: pct(hoursFrom(day.date, shift.start_at)), right: `calc(100% - ${pct(hoursFrom(day.date, shift.end_at))})` }}
            />
          )}
          {isToday && nowH >= 0 && nowH <= maxHour && <div className="now" style={{ left: pct(nowH) }} title="Ahora" />}
          {day.punches.map((p, i) => (
            <div
              key={p.id}
              className={`dot${p.is_double_tap ? " double" : ""}`}
              title={`${fmtTimeSec(p.punched_at)}${p.is_double_tap ? " (doble marca)" : ""}`}
              style={{ left: pct(hoursFrom(day.date, p.punched_at)), animationDelay: `${i * 40}ms` }}
            />
          ))}
        </div>
      </div>
      {day.punches.length > 0 && (
        <div className="day-row" style={{ paddingTop: 0, borderBottom: 0 }}>
          <div className="day-punches">
            {day.punches.map((p) => {
              const role = p.is_double_tap ? " double" : p.id === day.check_in?.id ? " in" : " middle";
              return (
                <span key={p.id} className={`punch${role}`} title={role === " middle" ? "No cuenta: solo vale la primera marca del día" : undefined}>
                  {fmtTimeSec(p.punched_at)}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

const monthFmt = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", month: "long", year: "numeric" });

/** Primer día del mes `ym` (aaaa-mm) movido `n` meses. */
function shiftMonth(ym: string, n: number): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Asigna un compensatorio: se elige cuál de los asuetos ganados (y sin usar) se da y luego, en
 *  el calendario, qué día lo descansa. La nota lleva la fecha del asueto, así queda usado. */
export function CompensatoryModal({
  employee,
  initialMonth,
  onClose,
  onDone,
}: {
  employee: Employee;
  initialMonth: string;
  onClose: () => void;
  onDone: (day: string) => void;
}) {
  const status = useAsync(() => api.get<CompensatoryStatus[]>("/schedules/compensatory", { area: employee.area }), [employee.area]);
  const available = status.data?.find((s) => s.employee_id === employee.id)?.available ?? [];
  const [holidayId, setHolidayId] = useState("");
  const [month, setMonth] = useState(initialMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const first = `${month}-01`;
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const monthDays = useAsync(
    () => (holidayId ? api.get<EmployeeSchedule>(`/employees/${employee.id}/schedule`, { date_from: first, date_to: last }) : Promise.resolve(null)),
    [holidayId, employee.id, first, last],
  );
  const offOf = new Map((monthDays.data?.days ?? []).filter((d) => d.day_off && d.day_off.kind !== "libre").map((d) => [d.date, d.day_off!]));
  const holiday = available.find((h) => String(h.id) === holidayId);
  // Lunes primero: cuántas casillas vacías van antes del día 1.
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const count = Number(last.slice(8));

  async function pick(day: string) {
    if (!holiday) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/schedules/days-off", {
        employee_id: employee.id,
        work_date: day,
        kind: "compensatorio",
        notes: `Compensatorio ${fmtDate(holiday.day)} (${holiday.name})`,
      });
      onDone(day);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Compensatorio de ${employee.full_name}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {status.error && <div className="alert">{status.error}</div>}
        {status.data && !available.length ? (
          <div className="alert info">No tiene compensatorios disponibles: no ha marcado en ningún asueto o ya los usó todos.</div>
        ) : (
          <label className="field">
            <span>Compensatorio disponible</span>
            <select className="input" value={holidayId} onChange={(ev) => setHolidayId(ev.target.value)} disabled={!status.data}>
              <option value="">{status.data ? "Elija el asueto que se compensa…" : "Cargando…"}</option>
              {available.map((h) => (
                <option key={h.id} value={h.id}>
                  {fmtDate(h.day)} · {h.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {holiday && (
          <div className="month-cal">
            <span className="caption">Elija el día del mes en que lo descansa. Si ese día tenía turno, se quita (también en el CRM).</span>
            <div className="month-cal-head">
              <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mes anterior">
                <IconChevronLeft width={20} height={20} />
              </button>
              <b>{monthFmt.format(new Date(`${first}T00:00:00Z`))}</b>
              <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Mes siguiente">
                <IconChevronRight width={20} height={20} />
              </button>
            </div>
            <div className="month-cal-grid">
              {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
                <span key={i} className="month-cal-dow">
                  {d}
                </span>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <span key={`e${i}`} />
              ))}
              {Array.from({ length: count }, (_, i) => {
                const day = `${month}-${String(i + 1).padStart(2, "0")}`;
                const off = offOf.get(day);
                return (
                  <button
                    key={day}
                    className={`month-cal-day${day === today() ? " today" : ""}${off ? " taken" : ""}`}
                    disabled={busy || !!off || monthDays.loading}
                    title={off ? `${DAY_OFF_LABEL[off.kind]}${off.notes ? ` · ${off.notes}` : ""}` : `Dar el compensatorio el ${fmtDate(day)}`}
                    onClick={() => pick(day)}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error && <div className="alert">{error}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
      </div>
    </Modal>
  );
}

/** Constancias emitidas: folio, quién y cuándo; se pueden volver a descargar tal como salieron. */
function Certificates({ items, error, name }: { items: IssuedCertificate[]; error: string | null; name: string }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function reprint(id: number) {
    setBusy(id);
    setFailed(null);
    try {
      const cert = await api.get<{ html: string }>(`/certificates/${id}`);
      printCertificate(sanitizeCertificateHtml(cert.html), `Constancia laboral ${id} - ${name}`);
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Constancias emitidas</h3>
        <span className="caption">{items.length ? `${items.length} en total` : "Aún no se ha emitido ninguna"}</span>
      </div>
      {(error || failed) && <div className="alert">{error ?? failed}</div>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table dense">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Emitida</th>
                <th>Emitida por</th>
                <th>Plantilla</th>
                <th className="num">Salario</th>
                <th className="num">Bono / comisiones</th>
                <th>Fecha en la constancia</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td className="nowrap">{fmtDateTime(c.issued_at)}</td>
                  <td>{c.issued_by_name}</td>
                  <td>{TEMPLATES.find((t) => t.id === c.template)?.label ?? c.template}</td>
                  <td className="num">{fmtMoney(c.salary)}</td>
                  <td className="num">{c.template === "salario" ? "—" : fmtMoney(c.extra)}</td>
                  <td className="mono">{fmtDate(c.issue_date)}</td>
                  <td className="num">
                    <button className="btn ghost sm" disabled={busy === c.id} onClick={() => reprint(c.id)}>
                      {busy === c.id ? "Abriendo…" : "Descargar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value ? undefined : "muted"}>{value ?? "—"}</dd>
    </div>
  );
}

function Stat({ label, value, hint, onAdd }: { label: string; value: string; hint?: string; onAdd?: () => void }) {
  return (
    <div className="stat">
      <div className="bar" />
      <span className="label">{label}</span>
      <span className="value mono">{value}</span>
      {(hint || onAdd) && (
        <span className="stat-foot">
          {hint && <span className="caption">{hint}</span>}
          {onAdd && (
            <button className="btn ghost sm" onClick={onAdd}>
              Asignar
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function weekTotals(days: WorkDay[]) {
  let scheduled = 0;
  for (const d of days) {
    if (!d.shift) continue;
    const hours = (new Date(d.shift.end_at).getTime() - new Date(d.shift.start_at).getTime()) / 3_600_000;
    scheduled += Math.max(hours - d.shift.break_minutes / 60, 0);
  }
  return {
    scheduled,
    shiftDays: days.filter((d) => d.shift).length,
    punchDays: days.filter((d) => d.punches.some((p) => !p.is_double_tap)).length,
    vacation: days.filter((d) => d.day_off?.kind === "vacacion").length,
    compensatory: days.filter((d) => d.day_off?.kind === "compensatorio").length,
  };
}

function fmtHours(h: number) {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min ? `${whole}h ${min}m` : `${whole}h`;
}
