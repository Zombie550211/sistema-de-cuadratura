import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { IconCake, IconChevronLeft, IconChevronRight, IconUpload, IconUserPlus, IconUsers } from "../components/Icons";
import { AttendanceChart, EntryTimes, entriesFrom, Headcount, LateRanking, Paperwork } from "../components/HomeCharts";
import { useNow } from "../components/LiveClock";
import {
  api,
  areaPath,
  DAY_OFF_LABEL,
  localName,
  type DashboardSummary,
  type DayOffKind,
  type Employee,
  type Lateness,
  type Page,
  type Punch,
  type ShiftDayOff,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtBirthday, fmtDate, fmtLongDate, fmtRange, TZ, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const AVATAR_COLORS = ["#0e7490", "#334155", "#1d4ed8", "#0f766e", "#475569", "#155e75"];
/** Días libres que se muestran en Inicio (no los libres de cada semana). */
const LEAVE_KINDS: DayOffKind[] = ["vacacion", "compensatorio", "incapacidad"];
const clockFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const hourFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "numeric", hour12: false });

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const shortDate = (ymd: string) => `${Number(ymd.slice(8))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
const areaLabel = (e: Employee) => ({ administrativo: "Administrativo", operativo: "Operativo", ventas: "Ventas" })[e.area] ?? e.area;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Próxima fecha AAAA-MM-DD en que cae un día del año MM-DD, desde hoy. */
function nextOccurrence(mmdd: string, from: string) {
  const thisYear = `${from.slice(0, 4)}-${mmdd}`;
  return thisYear >= from ? thisYear : `${Number(from.slice(0, 4)) + 1}-${mmdd}`;
}

function agoLabel(days: number) {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 31) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  return months < 12 ? `hace ${plural(months, "mes", "meses")}` : `hace ${plural(Math.floor(months / 12), "año", "años")}`;
}

interface HomeEvent {
  key: string;
  date: string;
  title: string;
  detail: string;
  birthday: boolean;
}

interface LeaveRange {
  key: string;
  employee: Employee | undefined;
  employeeId: number;
  kind: DayOffKind;
  from: string;
  to: string;
}

/** Junta los días seguidos de una misma persona y tipo en un solo rango. */
function leaveRanges(days: ShiftDayOff[], byId: Map<number, Employee>): LeaveRange[] {
  const sorted = days
    .filter((d) => LEAVE_KINDS.includes(d.kind))
    .sort((a, b) => a.employee_id - b.employee_id || a.kind.localeCompare(b.kind) || a.work_date.localeCompare(b.work_date));
  const out: LeaveRange[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && last.employeeId === d.employee_id && last.kind === d.kind && addDays(last.to, 1) === d.work_date) last.to = d.work_date;
    else out.push({ key: `${d.employee_id}|${d.kind}|${d.work_date}`, employee: byId.get(d.employee_id), employeeId: d.employee_id, kind: d.kind, from: d.work_date, to: d.work_date });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

interface Task {
  key: string;
  count?: number;
  text: string;
  action: string;
  to: string;
  tone: "danger" | "warn" | "info";
}

/** Inicio: lo que RRHH necesita atender hoy. Arriba la asistencia del día y hasta qué fecha llegan
 *  las marcas del reloj; luego los indicadores, los pendientes con su acción y el calendario. */
export function Dashboard() {
  const { user, can } = useAuth();
  const now = today();
  const clock = useNow(15_000);
  const canEdit = can("admin", "rrhh");
  const firstName = user!.full_name.split(" ")[0];
  const hour = Number(hourFmt.format(clock));
  const greeting = hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";

  const summary = useAsync(() => api.get<DashboardSummary>("/dashboard/summary"), []);
  const employees = useAsync(async () => {
    const list: Employee[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.get<Page<Employee>>("/employees", { status: "activo", limit: 500, offset });
      list.push(...page.items);
      if (list.length >= page.total || !page.items.length) break;
    }
    return list;
  }, []);
  const leave = useAsync(() => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: now, date_to: addDays(now, 30) }), [now]);
  // Turnos de hoy con su entrada: quién ya marcó, quién llegó tarde y quién falta.
  const attendance = useAsync(() => api.get<Lateness[]>("/attendance/lateness", { date_from: now, date_to: now }), [now]);

  const data = summary.data;
  const list = employees.data ?? [];
  const byId = useMemo(() => new Map(list.map((e) => [e.id, e])), [list]);
  const last = data?.last_import;
  // Periodo de las gráficas: el del último archivo del reloj (hasta 31 días), o las dos últimas semanas.
  const periodTo = last?.date_to ?? now;
  const periodFrom = last?.date_from && daysBetween(last.date_from, periodTo) <= 30 ? last.date_from : addDays(periodTo, last?.date_from ? -30 : -13);
  const period = useAsync(
    () => (summary.data ? api.get<Lateness[]>("/attendance/lateness", { date_from: periodFrom, date_to: periodTo }) : Promise.resolve(null)),
    [summary.data, periodFrom, periodTo],
  );
  const periodRows = period.data ?? [];
  const periodPunches = useAsync(
    () =>
      summary.data
        ? api.get<Page<Punch>>("/attendance/punches", { date_from: periodFrom, date_to: periodTo, include_double_taps: false, limit: 10000 })
        : Promise.resolve(null),
    [summary.data, periodFrom, periodTo],
  );
  const entries = useMemo(() => entriesFrom(periodPunches.data?.items ?? []), [periodPunches.data]);
  const hasLate = periodRows.some((l) => l.check_in && l.late_minutes > 0);

  const shiftsToday = attendance.data ?? [];
  const shifts = shiftsToday.length;
  const present = shiftsToday.filter((l) => l.check_in).length;
  const late = shiftsToday.filter((l) => l.check_in && l.late_minutes > 0).length;
  const coverageDays = last?.date_to ? daysBetween(last.date_to, now) : null;

  const newest = useMemo(
    () => list.filter((e) => e.hire_date && e.hire_date <= now).sort((a, b) => b.hire_date!.localeCompare(a.hire_date!))[0],
    [list, now],
  );
  const hiredThisMonth = list.filter((e) => e.hire_date?.slice(0, 7) === now.slice(0, 7)).length;
  const birthdays = useMemo(
    () => list.filter((e) => e.birthday?.slice(0, 2) === now.slice(5, 7)).sort((a, b) => a.birthday!.localeCompare(b.birthday!)),
    [list, now],
  );
  const events = useMemo(() => {
    const out: HomeEvent[] = [];
    const limit = addDays(now, 30);
    for (const e of list) {
      if (e.birthday) {
        const date = nextOccurrence(e.birthday, now);
        if (date <= limit) out.push({ key: `c${e.id}`, date, title: `Cumpleaños de ${e.full_name}`, detail: e.position ?? areaLabel(e), birthday: true });
      }
      if (e.hire_date && e.hire_date < now) {
        const date = nextOccurrence(e.hire_date.slice(5), now);
        const years = Number(date.slice(0, 4)) - Number(e.hire_date.slice(0, 4));
        if (years > 0 && date <= limit) out.push({ key: `a${e.id}`, date, title: `${plural(years, "año", "años")} en Connecting`, detail: e.full_name, birthday: false });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [list, now]);
  const ranges = useMemo(() => leaveRanges(leave.data ?? [], byId), [leave.data, byId]);
  const onLeaveToday = new Set((leave.data ?? []).filter((d) => d.work_date === now && LEAVE_KINDS.includes(d.kind)).map((d) => d.employee_id)).size;

  // Pendientes reales, cada uno con lo que hay que hacer.
  const tasks: Task[] = [];
  if (coverageDays !== null && coverageDays > 1 && canEdit)
    tasks.push({ key: "import", text: `Las marcas llegan hasta el ${shortDate(last!.date_to!)}. Suba el archivo del reloj para ponerlas al día.`, action: "Importar archivo", to: "/marcaciones?importar=1", tone: "warn" });
  if (data?.unmapped_badges)
    tasks.push({ key: "badges", count: data.unmapped_badges, text: "IDs del reloj sin empleado: sus marcas no se cuentan a nadie.", action: "Vincular", to: `${areaPath("ventas")}?vincular=1`, tone: "danger" });
  if (data?.employees_without_badge)
    tasks.push({ key: "nobadge", count: data.employees_without_badge, text: "empleados activos sin número de huella.", action: "Revisar", to: "/empleados", tone: "warn" });
  const noHire = list.filter((e) => !e.hire_date).length;
  if (noHire) tasks.push({ key: "hire", count: noHire, text: "sin fecha de ingreso: no se pueden calcular sus vacaciones.", action: "Completar fichas", to: "/empleados", tone: "info" });
  const loadingTasks = summary.loading || employees.loading;

  return (
    <div className="page home">
      <section className="home-hero" aria-label="Hoy">
        <img className="home-hero-photo" src="/inicio-banda.png" alt="" aria-hidden />
        <div className="home-hero-main">
          <p className="home-date">{fmtLongDate(now)}</p>
          <h1>
            {greeting}, {firstName}
          </h1>
          <p className="home-lead">
            {loadingTasks ? "Revisando pendientes…" : tasks.length ? `Hay ${plural(tasks.length, "asunto", "asuntos")} por atender.` : "Todo en orden: no hay pendientes."}
          </p>
          <div className="home-hero-actions">
            {canEdit && (
              <Link to="/marcaciones?importar=1" className="btn">
                <IconUpload /> Importar archivo
              </Link>
            )}
            <Link to="/marcaciones" className="btn home-btn-quiet">
              Ver marcaciones
            </Link>
          </div>
        </div>

        <div className="home-today">
          <div className="home-today-head">
            <span>Asistencia de hoy</span>
            <b className="mono">{clockFmt.format(clock)}</b>
          </div>
          {shifts > 0 && present > 0 ? (
            <>
              <div className="home-today-figure">
                <b className="mono">{present}</b>
                <span>de {plural(shifts, "turno", "turnos")} ya marcaron</span>
              </div>
              <div className="home-meter" role="img" aria-label={`${present} de ${shifts} turnos con marca`}>
                <i style={{ transform: `scaleX(${Math.min(1, present / shifts)})` }} />
              </div>
              <dl className="home-today-split">
                <div>
                  <dt>A tiempo</dt>
                  <dd className="mono">{present - late}</dd>
                </div>
                <div>
                  <dt>Tarde</dt>
                  <dd className="mono">{late}</dd>
                </div>
                <div>
                  <dt>Sin marca</dt>
                  <dd className="mono">{shifts - present}</dd>
                </div>
              </dl>
            </>
          ) : (
            <>
              <div className="home-today-figure">
                <b className="mono">{attendance.loading ? "—" : shifts}</b>
                <span>{shifts === 1 ? "turno asignado" : "turnos asignados"} hoy</span>
              </div>
              <p className="home-today-note">
                {last?.date_to
                  ? `Todavía no hay marcas de hoy. El último archivo del reloj (local ${localName(last.device)}) llega hasta el ${shortDate(last.date_to)}, ${agoLabel(coverageDays ?? 0)}.`
                  : "Todavía no se ha subido ningún archivo del reloj."}
              </p>
            </>
          )}
        </div>
      </section>

      {(summary.error || employees.error) && <div className="alert">{summary.error ?? employees.error}</div>}

      <dl className="home-kpis">
        <Kpi label="Empleados activos" value={data?.employees_active} note={hiredThisMonth ? `${plural(hiredThisMonth, "ingresó", "ingresaron")} este mes` : "Sin ingresos este mes"} />
        <Kpi label="Marcas registradas hoy" value={data?.punches_today} note={`${plural(data?.shifts_today ?? 0, "turno", "turnos")} en el horario`} />
        <Kpi label="De vacación o incapacidad hoy" value={leave.data ? onLeaveToday : undefined} note={`${plural(ranges.length, "ausencia programada", "ausencias programadas")} en 30 días`} />
        <Kpi
          label="Último archivo del reloj"
          value={last?.date_from && last.date_to ? fmtRange([last.date_from, last.date_to]) : "—"}
          note={last ? `Local ${localName(last.device)}, ${plural(last.inserted, "marca nueva", "marcas nuevas")}` : "Sin archivos"}
          to={last ? `/marcaciones?desde=${last.date_from}&hasta=${last.date_to}&local=${last.device.id}` : undefined}
          text
        />
      </dl>

      <div className="home-grid">
        <div className="home-side" style={{ gridArea: "side" }}>
          <section className="card home-cal">
          <MonthCalendar employees={list} events={events} />
        </section>
          <section className="card">
          <div className="card-head">
            <h2>Última incorporación</h2>
          </div>
          {newest ? (
            <Link to={`/empleados/${newest.id}`} className="home-hire">
              <div className="home-person">
                <Avatar id={newest.id} name={newest.full_name} size={40} />
                <div className="home-grow">
                  <b className="home-ellipsis">{newest.full_name}</b>
                  <div className="caption">{newest.position ?? "Sin cargo"}</div>
                </div>
              </div>
              <dl className="home-facts">
                <div>
                  <dt>Ingreso</dt>
                  <dd>
                    {fmtDate(newest.hire_date!)}, {agoLabel(daysBetween(newest.hire_date!, now))}
                  </dd>
                </div>
                <div>
                  <dt>Área</dt>
                  <dd>{newest.department?.name ?? areaLabel(newest)}</dd>
                </div>
              </dl>
            </Link>
          ) : (
            <div className="home-empty">
              <IconUserPlus width={20} height={20} />
              <p>{employees.loading ? "Cargando…" : "Ningún empleado tiene fecha de ingreso. Agréguela en la ficha para ver aquí al más reciente."}</p>
            </div>
          )}
        </section>
          <section className="card">
          <div className="card-head">
            <h2>Cumpleaños de {MONTH_NAMES[Number(now.slice(5, 7)) - 1].toLowerCase()}</h2>
            {birthdays.length > 0 && <span className="caption">{birthdays.length}</span>}
          </div>
          <div className="home-list qscroll">
            {birthdays.map((e) => {
              const isToday = e.birthday === now.slice(5);
              return (
                <Link key={e.id} to={`/empleados/${e.id}`} className={`home-list-row${isToday ? " today" : ""}`}>
                  <Avatar id={e.id} name={e.full_name} />
                  <div className="home-grow">
                    <div className="home-ellipsis">{e.full_name}</div>
                    <div className="caption">{e.position ?? areaLabel(e)}</div>
                  </div>
                  <span className="caption nowrap">{isToday ? "Hoy" : fmtBirthday(e.birthday!)}</span>
                </Link>
              );
            })}
            {!birthdays.length && <p className="muted">{employees.loading ? "Cargando…" : "Nadie cumple años este mes, o falta la fecha de cumpleaños en las fichas."}</p>}
          </div>
        </section>
          <section className="card home-side-fill">
            <div className="card-head">
              <h2>Ausencias próximas</h2>
              <Link to="/vacaciones" className="caption home-more">
                Ver vacaciones
              </Link>
            </div>
            {ranges.length ? (
              <ul className="home-leave qscroll">
                {ranges.map((r) => (
                  <li key={r.key}>
                    <Avatar id={r.employeeId} name={r.employee?.full_name ?? "?"} />
                    <div className="home-grow">
                      <div className="home-ellipsis">{r.employee?.full_name ?? `Empleado ${r.employeeId}`}</div>
                      <div className="caption">
                        {DAY_OFF_LABEL[r.kind]}, {r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`}
                      </div>
                    </div>
                    {r.from <= now ? <span className="badge home-ok">En curso</span> : <span className="badge">En {plural(daysBetween(now, r.from), "día", "días")}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{leave.loading ? "Cargando…" : "Nadie tiene vacaciones, compensatorio ni incapacidad en los próximos 30 días."}</p>
            )}
          </section>
        </div>
        <section className="card" style={{ gridArea: "chart" }}>
          <div className="card-head">
            <h2>Asistencia del periodo</h2>
            <Link to={`/marcaciones?desde=${periodFrom}&hasta=${periodTo}`} className="caption home-more">
              {fmtRange([periodFrom, periodTo])}
            </Link>
          </div>
          <AttendanceChart entries={entries} lateness={periodRows} range={[periodFrom, periodTo]} loading={periodPunches.loading || summary.loading} />
        </section>

        <section className="card" style={{ gridArea: "late" }}>
          <div className="card-head">
            <h2>{hasLate ? "Más tiempo de llegada tarde" : "Hora de entrada"}</h2>
            <span className="caption">{fmtRange([periodFrom, periodTo])}</span>
          </div>
          {periodPunches.loading && !periodPunches.data ? (
            <p className="muted">Cargando…</p>
          ) : hasLate ? (
            <LateRanking rows={periodRows} byId={byId} />
          ) : (
            <EntryTimes entries={entries} />
          )}
        </section>

        <section className="card" style={{ gridArea: "area" }}>
          <div className="card-head">
            <h2>Plantilla activa</h2>
            <span className="caption">{list.length ? `${list.length} personas` : ""}</span>
          </div>
          {employees.loading && !employees.data ? <p className="muted">Cargando…</p> : <Headcount employees={list} />}
        </section>

        <section className="card" style={{ gridArea: "docs" }}>
          <div className="card-head">
            <h2>Expedientes</h2>
            <Link to="/empleados" className="caption home-more">
              Ver empleados
            </Link>
          </div>
          {employees.loading && !employees.data ? <p className="muted">Cargando…</p> : <Paperwork employees={list} />}
        </section>

        <section className="card" style={{ gridArea: "tasks" }}>
          <div className="card-head">
            <h2>Pendientes</h2>
            <span className="caption">{loadingTasks ? "" : plural(tasks.length, "asunto", "asuntos")}</span>
          </div>
          {tasks.length ? (
            <ul className="home-task-list qscroll">
              {tasks.map((t) => (
                <li key={t.key} className={`home-task ${t.tone}`}>
                  <p>
                    {t.count !== undefined && <b className="mono">{t.count}</b>} {t.text}
                  </p>
                  <Link to={t.to} className="btn ghost sm">
                    {t.action}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{loadingTasks ? "Cargando…" : "No hay pendientes. Las marcas están al día y cada huella tiene su empleado."}</p>
          )}
        </section>




      </div>
    </div>
  );
}

function Kpi({ label, value, note, to, text }: { label: string; value?: number | string; note: string; to?: string; text?: boolean }) {
  const body = (
    <>
      <dt>{label}</dt>
      <dd className={`home-kpi-value mono${text ? " text" : ""}`}>{value ?? "—"}</dd>
      <dd className="home-kpi-note">{note}</dd>
    </>
  );
  return to ? (
    <Link to={to} className="home-kpi">
      {body}
    </Link>
  ) : (
    <div className="home-kpi">{body}</div>
  );
}

function Avatar({ id, name, size = 32 }: { id: number; name: string; size?: number }) {
  return (
    <span className="home-avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size / 2.8), background: AVATAR_COLORS[id % AVATAR_COLORS.length] }}>
      {initials(name)}
    </span>
  );
}

/** Calendario del mes con hoy marcado y un punto en los días con cumpleaños o aniversario de
 *  ingreso; debajo, los próximos eventos. */
function MonthCalendar({ employees, events }: { employees: Employee[]; events: HomeEvent[] }) {
  const now = today();
  const [month, setMonth] = useState(now.slice(0, 7));
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const daysInMonth = Number(addDays(`${addDays(`${month}-28`, 4).slice(0, 8)}01`, -1).slice(8));
  const marked = useMemo(() => {
    const set = new Set<string>();
    for (const e of employees) {
      if (e.birthday?.slice(0, 2) === month.slice(5)) set.add(`${month}-${e.birthday.slice(3)}`);
      if (e.hire_date && e.hire_date.slice(5, 7) === month.slice(5) && e.hire_date.slice(0, 7) < month) set.add(`${month}-${e.hire_date.slice(8)}`);
    }
    return set;
  }, [employees, month]);
  const shift = (n: number) => setMonth(addDays(`${month}-15`, n * 30).slice(0, 7));
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];

  return (
    <>
      <div className="home-cal-head">
        <h2>
          {MONTH_NAMES[Number(month.slice(5)) - 1]} {month.slice(0, 4)}
        </h2>
        <span className="row" style={{ gap: 2 }}>
          {month !== now.slice(0, 7) && (
            <button className="btn ghost sm" onClick={() => setMonth(now.slice(0, 7))}>
              Hoy
            </button>
          )}
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="Mes anterior">
            <IconChevronLeft width={16} height={16} />
          </button>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="Mes siguiente">
            <IconChevronRight width={16} height={16} />
          </button>
        </span>
      </div>
      <div className="home-cal-grid">
        {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
          <span key={i} className="home-cal-dow" aria-hidden>
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <span
              key={d}
              className={`home-cal-day${d === now ? " today" : ""}${marked.has(d) ? " marked" : ""}${d < now ? " past" : ""}`}
              title={marked.has(d) ? "Cumpleaños o aniversario de ingreso" : undefined}
            >
              {Number(d.slice(8))}
            </span>
          ) : (
            <span key={`x${i}`} />
          ),
        )}
      </div>
      <h2 className="home-events-title">Próximos eventos</h2>
      <div className="home-events qscroll">
        {events.map((ev) => (
          <div key={ev.key} className="home-event">
            <span className="home-event-date">
              <b>{Number(ev.date.slice(8))}</b>
              {MONTHS[Number(ev.date.slice(5, 7)) - 1]}
            </span>
            <div className="home-grow">
              <div className="home-ellipsis">{ev.title}</div>
              <div className="caption home-ellipsis">{ev.detail}</div>
            </div>
            {ev.birthday ? <IconCake width={16} height={16} className="muted" /> : <IconUsers width={16} height={16} className="muted" />}
          </div>
        ))}
        {!events.length && <p className="muted">Sin cumpleaños ni aniversarios en los próximos 30 días.</p>}
      </div>
    </>
  );
}
