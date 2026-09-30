import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { IconChevronLeft, IconChevronRight } from "../components/Icons";
import { useNow } from "../components/LiveClock";
import { api, type Department, type Employee, type EmployeeSchedule, type WorkDay } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtDateTime, fmtShortDay, fmtTime, fmtTimeSec, hoursFrom, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EmployeeForm } from "./EmployeeForm";

/** Ruta /empleados/:id (personal de RRHH y supervisores). */
export function EmployeeProfilePage() {
  const { id } = useParams();
  return <EmployeeProfile employeeId={Number(id)} showBack />;
}

/** Perfil del empleado: datos, horario enviado por el CRM y marcaciones del reloj, día por día.
 *  Lo usan RRHH/supervisores y también el propio empleado (portal). */
export function EmployeeProfile({ employeeId, showBack = false }: { employeeId: number; showBack?: boolean }) {
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [start, setStart] = useState(() => weekStart(today()));
  const [editing, setEditing] = useState(false);
  const end = addDays(start, 6);

  const employee = useAsync(() => api.get<Employee>(`/employees/${employeeId}`), [employeeId]);
  const schedule = useAsync(
    () => api.get<EmployeeSchedule>(`/employees/${employeeId}/schedule`, { date_from: start, date_to: end }),
    [employeeId, start, end],
  );
  const departments = useAsync(() => (canEdit ? api.get<Department[]>("/departments") : Promise.resolve([])), [canEdit]);

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
        <Link to="/empleados" className="back-link">
          <IconChevronLeft width={16} height={16} /> Empleados
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
              <span className="badge">{e.code}</span>
              {e.badge_number ? <span className="badge accent">Reloj {e.badge_number}</span> : <span className="badge warn">Sin ID de reloj</span>}
              {e.crm_agent_id ? <span className="badge accent">CRM {e.crm_agent_id}</span> : <span className="badge">Sin ID de CRM</span>}
              <span className={`badge${e.status === "activo" ? "" : " danger"}`}>{e.status}</span>
            </div>
          </div>
          {canEdit && (
            <button className="btn ghost" onClick={() => setEditing(true)}>
              Editar datos
            </button>
          )}
        </div>
      </div>

      <div className="stats">
        <Stat label="Horas programadas" value={fmtHours(totals.scheduled)} />
        <Stat label="Días con turno" value={String(totals.shiftDays)} />
        <Stat label="Días con marcas" value={String(totals.punchDays)} />
        <Stat label="Días libres" value={String(7 - totals.shiftDays)} />
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
            {day.punches.map((p) => (
              <span key={p.id} className={`punch${p.is_double_tap ? " double" : ""}`}>
                {fmtTimeSec(p.punched_at)}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="bar" />
      <span className="label">{label}</span>
      <span className="value mono">{value}</span>
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
  };
}

function fmtHours(h: number) {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min ? `${whole}h ${min}m` : `${whole}h`;
}
