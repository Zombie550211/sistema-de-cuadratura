import { Fragment, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";

import { IconChevronDown, IconChevronLeft, IconChevronRight, IconHouse, IconPlus, IconRepeat, IconSearch, IconSim, IconTrash, IconX } from "../components/Icons";
import { ConfirmDelete } from "../components/RowMenu";
import { Modal } from "../components/Modal";
import { useCollapsedTeams } from "../components/TeamGroups";
import {
  api,
  AREAS,
  type CompensatoryStatus,
  type Holiday,
  DAY_OFF_LABEL,
  groupByPosition,
  groupByTeam,
  SECTION_LABEL,
  type Area,
  type DayOffKind,
  type Employee,
  type Page,
  type Punch,
  type ShiftAssignment,
  type ShiftDayOff,
  type ShiftTemplate,
  type Sync,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { ampm, DAY_OFF_COLOR, dayOffBand, dayOffColor, dayOffLabel, isNoShow, isWillRestore, NO_SHOW, OTHER_SHIFT, SHIFT_KINDS, shiftColor, shiftLabel, WILL_RESTORE } from "../lib/shiftColors";
import { addDays, fmtDate, fmtDateTime, fmtLongDate, fmtRange, fmtShortDay, fmtTime, hhmm, hoursFrom, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];
/** Tarjetas del día en el horario: lo que RRHH puede marcar en lugar de un turno. */
const POP_DAY_OFF: { key: DayOffKind | "no_show"; kind: DayOffKind; label: string; color: string }[] = [
  { key: "libre", kind: "libre", label: "Día libre", color: DAY_OFF_COLOR.libre },
  { key: "compensatorio", kind: "compensatorio", label: "Compensatorio", color: DAY_OFF_COLOR.compensatorio },
  { key: "suspendido", kind: "suspendido", label: "Suspendido", color: DAY_OFF_COLOR.suspendido },
  { key: "baja", kind: "baja", label: "De baja", color: DAY_OFF_COLOR.baja },
  { key: "incapacidad", kind: "incapacidad", label: "Incapacidad", color: DAY_OFF_COLOR.incapacidad },
  { key: "vacacion", kind: "vacacion", label: "Vacación", color: DAY_OFF_COLOR.vacacion },
  // Como en el CRM: «No se presentó» es un día libre con esa nota.
  { key: "no_show", kind: "libre", label: NO_SHOW.label, color: NO_SHOW.color },
];
const DOW = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MONTH_ABBR = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
/** Por debajo de este número de agentes en turno, la hora se marca como descubierta. */
const MIN_COVERAGE = 4;
/** Horas semanales a partir de las que se avisa (jornada ordinaria diurna en El Salvador). */
const WEEK_LIMIT_HOURS = 44;

type Pop = { employee: Employee; day: string; dayIndex: number; current?: ShiftAssignment; dayOff?: ShiftDayOff; top: number; left: number };

/** Horas de trabajo efectivo de un turno (sin el descanso). */
const workHours = (a: ShiftAssignment) => (new Date(a.end_at).getTime() - new Date(a.start_at).getTime()) / 3_600_000 - a.break_minutes / 60;
const fmtHours = (h: number) => `${Math.round(h * 10) / 10} h`.replace(".", ",");
const hourLabel = (h: number) => {
  const x = ((h % 24) + 24) % 24;
  return `${x === 0 ? 12 : x > 12 ? x - 12 : x}${x < 12 ? "a" : "p"}`;
};

/** El turno que más se repite (mismas horas y descanso) en una lista de turnos. */
function mostCommonShift(list: ShiftAssignment[]): ShiftAssignment | undefined {
  const counts = new Map<string, { a: ShiftAssignment; n: number }>();
  for (const a of list) {
    const k = `${fmtTime(a.start_at)}|${fmtTime(a.end_at)}|${a.break_minutes}`;
    counts.set(k, { a: counts.get(k)?.a ?? a, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((x, y) => y.n - x.n)[0]?.a;
}

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** Texto negro o blanco según qué se lea mejor sobre el color del turno. */
function readableOn(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "var(--on-accent)";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "var(--text)" : "var(--on-accent)";
}

/** Horarios de una sección (Administrativo, Operativo o Agentes de ventas), con el
 *  mismo desglose que Empleados y Marcaciones. */
export function Schedules({ area }: { area: Area }) {
  const section = AREAS.find((a) => a.area === area)!.label;
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [start, setStart] = useState(() => weekStart(today()));
  const [dayIndex, setDayIndex] = useState(() => (new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7);
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("all");
  const [pop, setPop] = useState<Pop | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [givingComp, setGivingComp] = useState(false);
  const [deleting, setDeleting] = useState<Employee | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teams = useCollapsedTeams(`horarios.${area}.teams-plegados`);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const day = days[dayIndex];
  const isToday = day === today();
  const isFuture = day > today();

  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", area, limit: 500 }), [area]);
  const templates = useAsync(() => api.get<ShiftTemplate[]>("/schedules/templates", { include_inactive: true }), []);
  const assignments = useAsync(() => api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: days[0], date_to: days[6] }), [days]);
  const daysOff = useAsync(() => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: days[0], date_to: days[6] }), [days]);
  const punches = useAsync(
    () =>
      isFuture
        ? Promise.resolve({ items: [], total: 0 } as Page<Punch>)
        : api.get<Page<Punch>>("/attendance/punches", { date_from: day, date_to: day, include_double_taps: false, limit: 2000 }),
    [day, isFuture],
  );
  const lastSync = useAsync(() => (canEdit ? api.get<Page<Sync>>("/integrations/syncs", { limit: 1 }) : Promise.resolve(null)), [canEdit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const byKey = useMemo(() => {
    const map = new Map<string, ShiftAssignment>();
    assignments.data?.forEach((a) => map.set(`${a.employee_id}|${a.work_date}`, a));
    return map;
  }, [assignments.data]);
  const offByKey = useMemo(() => new Map(daysOff.data?.map((d) => [`${d.employee_id}|${d.work_date}`, d])), [daysOff.data]);
  const templateById = useMemo(() => new Map(templates.data?.map((t) => [t.id, t])), [templates.data]);
  /** Turno base del horario: el asignado, o el que tiene las mismas horas (los del CRM no traen turno base). */
  const templateOf = (a: ShiftAssignment) =>
    (a.template_id ? templateById.get(a.template_id) : undefined) ??
    templates.data?.find((t) => t.is_active && hhmm(t.start_time) === fmtTime(a.start_at) && hhmm(t.end_time) === fmtTime(a.end_at));
  // Color por horas, igual que en el CRM (8–5, 10–7, 1–9, 9–6, shortdays y otro horario).
  const colorOf = (a: ShiftAssignment) => shiftColor(fmtTime(a.start_at), fmtTime(a.end_at));

  /** Primera marca válida del día por empleado (la API las devuelve de la más reciente a la más antigua). */
  const firstPunch = useMemo(() => {
    const map = new Map<number, Punch>();
    for (const p of punches.data?.items ?? []) if (p.employee) map.set(p.employee.id, p);
    return map;
  }, [punches.data]);

  // Por team, en el orden en que los manda el CRM (supervisor primero); quien no tiene team
  // (no viene del CRM: administrativos, operativos, agentes nuevos), al final por su cargo.
  const allGroups = useMemo(() => {
    const items = employees.data?.items ?? [];
    const teams = groupByTeam(items.filter((e) => e.department)).map((g) => ({ key: g.key, section: g.team!.section, label: g.team!.name, items: g.items }));
    const byPosition = groupByPosition(items.filter((e) => !e.department)).map((g) => ({
      key: `cargo:${g.key}`,
      section: null,
      label: g.position ?? "Sin cargo",
      items: g.items,
    }));
    return [...teams, ...byPosition];
  }, [employees.data]);
  const q = query.trim().toLowerCase();
  const groups = allGroups
    .filter((g) => team === "all" || g.key === team)
    .map((g) => ({ ...g, items: g.items.filter((e) => !q || e.full_name.toLowerCase().includes(q) || e.badge_number === q) }))
    .filter((g) => g.items.length);
  const visible = groups.flatMap((g) => g.items);

  // Ventana de horas del día: 8a–9p como mínimo, ampliada si hay turnos antes o nocturnos.
  const dayShifts = visible.map((e) => byKey.get(`${e.id}|${day}`)).filter((a): a is ShiftAssignment => !!a);
  const h0 = Math.min(8, ...dayShifts.map((a) => Math.floor(hoursFrom(day, a.start_at))));
  const h1 = Math.min(32, Math.max(21, ...dayShifts.map((a) => Math.ceil(hoursFrom(day, a.end_at)))));
  const span = h1 - h0;
  const hours = Array.from({ length: span }, (_, k) => h0 + k);
  const coverage = hours.map((h) => dayShifts.filter((a) => hoursFrom(day, a.start_at) <= h && hoursFrom(day, a.end_at) > h).length);
  const maxCoverage = Math.max(1, ...coverage);
  const thin = hours.filter((_, k) => coverage[k] < MIN_COVERAGE);

  const weekHours = (e: Employee) => days.reduce((sum, d) => {
    const a = byKey.get(`${e.id}|${d}`);
    return sum + (a ? workHours(a) : 0);
  }, 0);

  function mark(e: Employee, a: ShiftAssignment | undefined): { text: string; warn?: boolean } {
    if (isFuture) return { text: a ? `${fmtTime(a.start_at)}–${fmtTime(a.end_at)} · ${fmtHours(workHours(a))}` : "—" };
    const p = firstPunch.get(e.id);
    if (!a) return p ? { text: `Marcó ${fmtTime(p.punched_at)} · sin turno` } : { text: isToday ? "Sin turno hoy" : "Sin turno" };
    const limit = new Date(a.start_at).getTime() + a.tolerance_minutes * 60_000;
    if (p) {
      const late = new Date(p.punched_at).getTime() > limit;
      return { text: `Marcó ${fmtTime(p.punched_at)}${late ? " · tarde" : ""}`, warn: late };
    }
    if (!e.badge_number) return { text: "Sin ID de reloj", warn: true };
    return Date.now() < limit ? { text: "Aún no marca" } : { text: "Sin marcación", warn: true };
  }

  function openPop(ev: MouseEvent, e: Employee) {
    if (!canEdit) return;
    setRestoring(false);
    setGivingComp(false);
    // Junto al clic, pero subiendo lo necesario para que la ventana (~720 px) quepa en pantalla.
    const top = Math.max(8, Math.min(ev.clientY + 12, window.innerHeight - 728));
    setError(null);
    setPop({
      employee: e,
      day,
      dayIndex,
      current: byKey.get(`${e.id}|${day}`),
      dayOff: offByKey.get(`${e.id}|${day}`),
      top,
      left: Math.min(ev.clientX, window.innerWidth - 396),
    });
  }

  /** Corre una acción del popover y recarga la semana. */
  async function popAction(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      setPop(null);
      assignments.reload();
      daysOff.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Reagendar (otra fecha y/u horas) o, si el día no tiene turno, asignar uno con horas a mano. */
  function saveCustom(f: ShiftForm) {
    if (!pop) return;
    const body = { start_time: f.start, end_time: f.end, break_minutes: f.breakMinutes };
    return popAction(() =>
      pop.current
        ? api.put(`/schedules/assignments/${pop.current.id}`, { ...body, work_date: f.date, tolerance_minutes: pop.current.tolerance_minutes, notes: pop.current.notes })
        : api.post("/schedules/assignments/bulk", {
            ...body,
            employee_ids: [pop.employee.id],
            date_from: pop.day,
            date_to: pop.day,
            weekdays: [pop.dayIndex],
            overwrite: true,
          }),
    );
  }

  function applyTemplate(t: ShiftTemplate, weekdays: number[]) {
    if (!pop) return;
    return popAction(() =>
      api.post("/schedules/assignments/bulk", {
        employee_ids: [pop.employee.id],
        date_from: weekdays.length > 1 ? days[0] : pop.day,
        date_to: weekdays.length > 1 ? days[6] : pop.day,
        weekdays,
        template_id: t.id,
        overwrite: true,
      }),
    );
  }

  /** Turno de siempre de la persona: el que más se repite en la semana (mismas horas y descanso). */
  function usualShift(e: Employee): ShiftAssignment | undefined {
    return mostCommonShift(days.map((d) => byKey.get(`${e.id}|${d}`)).filter((a): a is ShiftAssignment => !!a));
  }

  /** Reponer horario: quita lo marcado en el día (libre, incapacidad…) y le vuelve a poner su
   *  turno de siempre; asignar el turno también quita el día libre en el CRM. */
  function restoreShift(r: RestoreForm) {
    if (!pop) return;
    return popAction(() =>
      api.post("/schedules/assignments/bulk", {
        employee_ids: [pop.employee.id],
        date_from: pop.day,
        date_to: pop.day,
        weekdays: [pop.dayIndex],
        ...(r.templateId ? { template_id: r.templateId } : { start_time: r.start, end_time: r.end, break_minutes: r.breakMinutes }),
        notes: ["Reposición de horario", r.note.trim()].filter(Boolean).join(": "),
        overwrite: true,
      }),
    );
  }

  function clearDay() {
    if (!pop?.current) return;
    return popAction(() => api.delete(`/schedules/assignments/${pop.current!.id}`));
  }

  /** Marca el día (libre, compensatorio, suspendido…): quita el turno y, si ya había otro tipo, lo cambia. */
  function giveDayOff(opt: (typeof POP_DAY_OFF)[number]) {
    if (!pop) return;
    // La nota «No se presentó» se pone o se quita (también «Repondrá horario»); las demás notas del día se conservan.
    const notes =
      opt.key === "no_show" ? NO_SHOW.label : pop.dayOff && (isNoShow(pop.dayOff) || isWillRestore(pop.dayOff)) ? "" : undefined;
    return popAction(() => api.post("/schedules/days-off", { employee_id: pop.employee.id, work_date: pop.day, kind: opt.kind, notes }));
  }

  /** Un día compensatorio por asueto elegido; la nota lleva la fecha del asueto y así queda usado. */
  function giveCompensatory(picked: { day: string; holiday: Holiday | null }[]) {
    if (!pop) return;
    return popAction(async () => {
      for (const p of picked) {
        await api.post("/schedules/days-off", {
          employee_id: pop.employee.id,
          work_date: p.day,
          kind: "compensatorio",
          notes: p.holiday ? `Compensatorio ${fmtDate(p.holiday.day)} (${p.holiday.name})` : undefined,
        });
      }
    });
  }

  function removeDayOff() {
    if (!pop?.dayOff) return;
    return popAction(() => api.delete(`/schedules/days-off/${pop.dayOff!.id}`));
  }

  const sync = lastSync.data?.items[0];
  const activeTemplates = (templates.data ?? []).filter((t) => t.is_active);
  const popTemplate = pop?.current ? templateOf(pop.current) : undefined;
  const popOffKey = pop?.dayOff && (isNoShow(pop.dayOff) ? "no_show" : pop.dayOff.kind);
  const popWeekUsual = pop && !pop.current ? usualShift(pop.employee) : undefined;
  // Si en la semana no tiene turnos (p. ej. incapacidad toda la semana), se busca en las 6 anteriores.
  const popHistory = useAsync(
    () =>
      pop && !pop.current && !popWeekUsual
        ? api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: addDays(days[0], -42), date_to: addDays(days[0], -1), employee_id: pop.employee.id })
        : Promise.resolve(null),
    [pop?.employee.id, pop?.day, !!popWeekUsual],
  );
  const popUsual = popWeekUsual ?? mostCommonShift(popHistory.data ?? []);
  let lastSection: string | null = null;

  // Resumen del día elegido para los indicadores de arriba.
  const onShift = visible.filter((e) => byKey.has(`${e.id}|${day}`));
  const dayOffs = visible.map((e) => offByKey.get(`${e.id}|${day}`)).filter((d): d is ShiftDayOff => !!d);
  const offCounts = dayOffs.reduce((m, d) => {
    const label = dayOffLabel(d);
    return m.set(label, (m.get(label) ?? 0) + 1);
  }, new Map<string, number>());
  const marks = onShift.map((e) => mark(e, byKey.get(`${e.id}|${day}`)));
  const punched = onShift.filter((e) => firstPunch.has(e.id)).length;
  const lateCount = marks.filter((m) => m.text.endsWith("· tarde")).length;
  const missing = marks.filter((m) => m.text === "Sin marcación").length;
  const weekTotal = visible.reduce((s, e) => s + weekHours(e), 0);
  const overLimit = visible.filter((e) => weekHours(e) > WEEK_LIMIT_HOURS).length;
  const todayIndex = (new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7;
  const onToday = start === weekStart(today()) && dayIndex === todayIndex;

  return (
    <div className="page wide sch">
      <h1 className="sr-only">Horarios · {section}</h1>

      {/* Semana, días e indicadores quedan fijos arriba al bajar por el tablero. */}
      <div className="sch-sticky">
      <section className="pn-bar" aria-label="Semana y filtros">
        <div className="pn-row">
          <div className="pn-group">
            <span className="pn-label">Semana</span>
            <div className="pn-period">
              <button className="icon-btn" onClick={() => setStart(addDays(start, -7))} aria-label="Semana anterior">
                <IconChevronLeft width={18} height={18} />
              </button>
              <b>{fmtRange([days[0], days[6]])}</b>
              <button className="icon-btn" onClick={() => setStart(addDays(start, 7))} aria-label="Semana siguiente">
                <IconChevronRight width={18} height={18} />
              </button>
            </div>
            <button
              className="btn ghost sm"
              disabled={onToday}
              onClick={() => {
                setStart(weekStart(today()));
                setDayIndex(todayIndex);
              }}
            >
              Hoy
            </button>
          </div>
          <div className="pn-group">
            <span className="pn-label">Team</span>
            <select className="input sch-team-select" value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Filtrar por team">
              <option value="all">Todos los teams</option>
              {allGroups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setTemplatesOpen(true)}>
            Turnos base
          </button>
          {canEdit && (
            <button className="btn" onClick={() => setAssigning(true)} disabled={!employees.data?.items.length}>
              <IconPlus /> Asignar horario
            </button>
          )}
        </div>

        {/* Los 7 días de la semana: cuántos tienen turno y una barra con la proporción. */}
        <div className="pn-row sch-dayrow">
          <div className="sch-days" role="tablist" aria-label="Día">
            {days.map((d, i) => {
              const on = visible.filter((e) => byKey.has(`${e.id}|${d}`)).length;
              return (
                <button key={d} role="tab" aria-selected={i === dayIndex} className={`sch-day${i === dayIndex ? " on" : ""}`} onClick={() => setDayIndex(i)}>
                  <span className="sch-day-top">
                    <span>
                      {DOW[i]} <b>{Number(d.slice(8))}</b> <span className="sch-day-month">{MONTH_ABBR[Number(d.slice(5, 7)) - 1].toLowerCase()}</span>
                    </span>
                    {d === today() && <span className="sch-day-today">Hoy</span>}
                  </span>
                  <span className="sch-day-meter" aria-hidden>
                    <i style={{ transform: `scaleX(${visible.length ? on / visible.length : 0})` }} />
                  </span>
                  <span className="sch-day-count">{on} en turno</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <dl className="home-kpis sch-kpis">
        <div className="home-kpi">
          <dt>En turno · {fmtShortDay(day)}</dt>
          <dd className="home-kpi-value mono">{onShift.length}</dd>
          <dd className="home-kpi-note">
            de {visible.length} personas · {visible.length - onShift.length - dayOffs.length} sin turno
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Marcaron</dt>
          <dd className="home-kpi-value mono">{isFuture ? "—" : punched}</dd>
          <dd className={`home-kpi-note${!isFuture && (lateCount || missing) ? " sch-note-warn" : ""}`}>
            {isFuture ? "El día todavía no llega" : `${lateCount} tarde · ${missing} sin marcación`}
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Libres y ausencias</dt>
          <dd className="home-kpi-value mono">{dayOffs.length}</dd>
          <dd className="home-kpi-note">
            {dayOffs.length
              ? [...offCounts]
                  .sort((a, b) => b[1] - a[1])
                  .map(([label, n]) => `${n} ${label.toLowerCase()}`)
                  .join(" · ")
              : "Nadie libre ni ausente"}
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Horas en la semana</dt>
          <dd className="home-kpi-value mono">{fmtHours(weekTotal)}</dd>
          <dd className={`home-kpi-note${overLimit ? " sch-note-warn" : ""}`}>
            {overLimit ? `${overLimit} ${overLimit === 1 ? "persona pasa" : "personas pasan"} de ${WEEK_LIMIT_HOURS} h` : `Nadie pasa de ${WEEK_LIMIT_HOURS} h`}
          </dd>
        </div>
      </dl>

      </div>

      {(assignments.error || punches.error) && <div className="alert">{assignments.error || punches.error}</div>}

      <div className="card sch-card">
        <div className="sch-card-head">
          <div className="sch-card-title">
            <h2 className="pn-h2">Turnos del {fmtLongDate(day).toLowerCase()}</h2>
            <span className="caption">
              {canEdit ? "Clic en la línea de una persona para asignar o cambiar el turno del día." : "Turnos del día por team."}
              {sync && (
                <span className={sync.status === "ok" ? undefined : "sch-note-warn"}>
                  {" "}
                  Última actualización del CRM: {fmtDateTime(sync.received_at)}
                  {sync.status !== "ok" && ` · ${sync.status}`}.
                </span>
              )}
            </span>
          </div>
          <label className="pn-search sch-search">
            <span className="sr-only">Buscar</span>
            <IconSearch width={16} height={16} aria-hidden />
            <input className="input" placeholder="Buscar persona o ID de reloj" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        <div className="sch-legend">
          <span className="sch-legend-title">Turnos</span>
          {[...SHIFT_KINDS.filter((k) => !k.short), OTHER_SHIFT].map((k) => (
            <span key={k.label}>
              <i style={{ background: k.color }} /> {k.label}
            </span>
          ))}
          <span className="sch-legend-title">Días</span>
          {(
            [
              ["Libre", DAY_OFF_COLOR.libre],
              ["Vacaciones", DAY_OFF_COLOR.vacacion],
              ["Incapacidad", DAY_OFF_COLOR.incapacidad],
              ["Suspendido", DAY_OFF_COLOR.suspendido],
              ["De baja", DAY_OFF_COLOR.baja],
              [NO_SHOW.label, NO_SHOW.color],
              [WILL_RESTORE.label, WILL_RESTORE.color],
            ] as const
          ).map(([label, color]) => (
            <span key={label}>
              <i style={{ background: color }} /> {label}
            </span>
          ))}
          <span>
            <i className="sch-hatch" /> Descanso
          </span>
        </div>

        <div className="sch-scroll">
          <div className={`sch-board${canEdit ? " can-delete" : ""}`}>
            {/* Personas en turno por hora, alineadas con la línea de tiempo de abajo. */}
            <div className="sch-grid sch-cov">
              <div className="sch-cov-label">
                <b>Personas en turno por hora</b>
                {thin.length > 0 && visible.length > 0 ? (
                  <span className="sch-note-warn">
                    Menos de {MIN_COVERAGE}: {thin.map(hourLabel).join(", ")}
                  </span>
                ) : (
                  <span className="caption">Todas las horas con {MIN_COVERAGE} o más</span>
                )}
              </div>
              <div className="sch-hist">
                {coverage.map((v, k) => (
                  <div key={k} className={`sch-hist-col${v < MIN_COVERAGE ? " thin" : ""}`} title={`${hourLabel(hours[k])}: ${v} en turno`}>
                    <span>{v}</span>
                    <div style={{ height: `${Math.max(4, (v / maxCoverage) * 100 - 24)}%` }} />
                  </div>
                ))}
              </div>
              <div />
              {canEdit && <div />}
            </div>

            <div className="sch-grid sch-colhead">
              <span>Persona</span>
              <div className="sch-hours">
                {hours.map((h) => (
                  <span key={h}>{hourLabel(h)}</span>
                ))}
              </div>
              <div className="sch-colhead-week">
                <span>Semana</span>
                <span>Horas</span>
              </div>
              {canEdit && <span />}
            </div>

            {groups.map((g) => {
              const section = g.section;
              const showSection = section !== null && section !== lastSection;
              lastSection = section;
              const open = teams.isOpen(g.key);
              const teamHours = g.items.reduce((s, e) => s + weekHours(e), 0);
              const noShift = g.items.filter((e) => !byKey.has(`${e.id}|${day}`) && !offByKey.has(`${e.id}|${day}`)).length;
              const SectionIcon = section === "lineas" ? IconSim : IconHouse;
              return (
                <Fragment key={g.key}>
                  {showSection && (
                    <div className="sch-section">
                      <SectionIcon width={14} height={14} /> {SECTION_LABEL[section]}
                    </div>
                  )}
                  <section className="sch-team">
                    <button className={`sch-team-head${open ? "" : " closed"}`} onClick={() => teams.toggle(g.key)} aria-expanded={open}>
                      <IconChevronDown width={16} height={16} className="sch-team-caret" />
                      <b>{g.label}</b>
                      <span className="caption">
                        {g.items.length} {g.items.length === 1 ? "persona" : "personas"} · {fmtHours(teamHours)} en la semana
                      </span>
                      {noShift > 0 && <span className="sch-chip">{noShift} sin turno</span>}
                    </button>
                    {open &&
                      g.items.map((e) => {
                        const a = byKey.get(`${e.id}|${day}`);
                        const off = offByKey.get(`${e.id}|${day}`);
                        const m = mark(e, a);
                        const total = weekHours(e);
                        return (
                          <div key={e.id} className="sch-grid sch-row">
                            <div className="sch-agent">
                              <span className="pn-avatar" aria-hidden>
                                {initials(e.full_name)}
                              </span>
                              <span className="sch-agent-text">
                                <Link to={`/empleados/${e.id}`} className="sch-name" title={e.full_name}>
                                  {e.full_name}
                                </Link>
                                <span className={`sch-mark${m.warn ? " warn" : ""}`}>
                                  {e.is_supervisor && <span className="sch-sup">Supervisor</span>}
                                  {m.text}
                                </span>
                              </span>
                            </div>
                            <div
                              className={`sch-track${canEdit ? " editable" : ""}`}
                              style={{ backgroundSize: `calc(100% / ${span}) 100%` }}
                              onClick={(ev) => openPop(ev, e)}
                              role={canEdit ? "button" : undefined}
                              aria-label={canEdit ? `Asignar turno a ${e.full_name}` : undefined}
                            >
                              {a ? (
                                <ShiftBar a={a} day={day} h0={h0} span={span} color={colorOf(a)} template={templateOf(a)} />
                              ) : off ? (
                                // Franja de color como en el CRM; el origen y la nota, en el title.
                                <span
                                  className="sch-empty sch-off"
                                  style={{ background: dayOffBand(off).bg, color: dayOffBand(off).fg, boxShadow: `inset 3px 0 0 ${dayOffColor(off)}` }}
                                  title={[off.source === "crm" ? "Marcado en el CRM" : "Fijado por RRHH", off.notes, canEdit ? "clic para cambiar" : null]
                                    .filter(Boolean)
                                    .join(" · ")}
                                >
                                  {dayOffLabel(off)}
                                </span>
                              ) : (
                                <span className="sch-empty">Sin turno</span>
                              )}
                            </div>
                            <div className="sch-weekcol">
                              <div className="sch-squares">
                                {days.map((d, i) => {
                                  const wa = byKey.get(`${e.id}|${d}`);
                                  const woff = offByKey.get(`${e.id}|${d}`);
                                  const offLabel = woff && (dayOffLabel(woff));
                                  return (
                                    <span
                                      key={d}
                                      title={`${DOW[i]}: ${wa ? `${fmtTime(wa.start_at)}–${fmtTime(wa.end_at)}` : woff ? `${offLabel} (${woff.source === "crm" ? "CRM" : "RRHH"})` : "Sin turno"}`}
                                      className={`${wa || woff ? "" : "none"}${i === dayIndex ? " sel" : ""}`}
                                      style={wa ? { background: colorOf(wa) } : woff ? { background: dayOffColor(woff) } : undefined}
                                    />
                                  );
                                })}
                              </div>
                              <b className={total > WEEK_LIMIT_HOURS ? "sch-note-warn" : total ? "" : "muted"}>{fmtHours(total)}</b>
                            </div>
                            {canEdit && (
                              <button className="icon-btn sch-del" onClick={() => setDeleting(e)} aria-label={`Eliminar a ${e.full_name}`} title="Eliminar empleado">
                                <IconTrash width={16} height={16} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                  </section>
                </Fragment>
              );
            })}
            {employees.data && visible.length === 0 && (
              <div className="empty">{employees.data.items.length ? "Nadie coincide con el filtro." : "Registre empleados para poder asignarles horarios."}</div>
            )}
          </div>
        </div>
      </div>

      {pop && (
        <>
          <div className="sch-pop-backdrop" onClick={() => setPop(null)} />
          <div className="sch-pop" style={{ top: pop.top, left: pop.left, maxHeight: `calc(100vh - ${pop.top + 8}px)` }} role="dialog" aria-label={`Turno de ${pop.employee.full_name}`}>
            <div className="sch-pop-head">
              <span className="pn-avatar" aria-hidden>
                {initials(pop.employee.full_name)}
              </span>
              <span className="sch-pop-who">
                <b>{pop.employee.full_name}</b>
                <span className="caption">
                  {fmtLongDate(pop.day)} ·{" "}
                  {pop.current
                    ? `${fmtTime(pop.current.start_at)}–${fmtTime(pop.current.end_at)}`
                    : pop.dayOff
                      ? dayOffLabel(pop.dayOff)
                      : "Sin turno"}
                </span>
              </span>
              <button className="icon-btn" onClick={() => setPop(null)} aria-label="Cerrar">
                <IconX width={16} height={16} />
              </button>
            </div>
            {error && <div className="alert">{error}</div>}

            {!restoring && !givingComp && (
            <div className="sch-pop-sec">
              <span className="sch-pop-label">Turno base</span>
              {activeTemplates.length ? (
                <div className="sch-pop-grid">
                  {activeTemplates.map((t) => (
                    <button key={t.id} className={`sch-pop-tpl${popTemplate?.id === t.id ? " on" : ""}`} disabled={busy} title={t.name} onClick={() => applyTemplate(t, [pop.dayIndex])}>
                      <i style={{ background: shiftColor(hhmm(t.start_time), hhmm(t.end_time)) }} />
                      <span>
                        <b>{t.name}</b>
                        <small>
                          {hhmm(t.start_time)}–{hhmm(t.end_time)}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <span className="caption">Cree un turno base para asignarlo con un clic.</span>
              )}
              {popTemplate && (
                <button className="btn ghost sm sch-pop-wide" disabled={busy} onClick={() => applyTemplate(popTemplate, [0, 1, 2, 3, 4, 5])}>
                  Aplicar {popTemplate.name} de lunes a sábado
                </button>
              )}
            </div>
            )}

            {givingComp ? (
              <CompPanel
                key={`${pop.employee.id}|${pop.day}`}
                employee={pop.employee}
                day={pop.day}
                busy={busy}
                onCancel={() => setGivingComp(false)}
                onSave={giveCompensatory}
              />
            ) : restoring && !pop.current ? (
              <RestorePanel
                key={`${pop.employee.id}|${pop.day}`}
                usual={popUsual}
                loadingUsual={popHistory.loading}
                templates={activeTemplates}
                templateOf={templateOf}
                busy={busy}
                onCancel={() => setRestoring(false)}
                onSave={restoreShift}
              />
            ) : (
              <>
            <ShiftEditor key={`${pop.employee.id}|${pop.day}`} current={pop.current} day={pop.day} busy={busy} onSave={saveCustom} />

            <div className="sch-pop-sec">
              <span className="sch-pop-label">Marcar el día como</span>
              <div className="sch-pop-chips">
                {!pop.current && (
                  <button
                    className="sch-pop-chip restore"
                    disabled={busy}
                    title="Quita lo marcado en el día y le asigna un horario: el de siempre, uno de los turnos base o uno nuevo"
                    onClick={() => setRestoring(true)}
                  >
                    <IconRepeat width={12} height={12} />
                    Reponer horario
                  </button>
                )}
                {POP_DAY_OFF.map((o) => {
                  const on = o.key === popOffKey;
                  return (
                    <button
                      key={o.key}
                      className={`sch-pop-chip${on ? " on" : ""}`}
                      aria-pressed={on}
                      disabled={busy}
                      title={on ? `Quitar ${o.label.toLowerCase()}` : undefined}
                      onClick={() => (on ? removeDayOff() : o.key === "compensatorio" ? setGivingComp(true) : giveDayOff(o))}
                    >
                      <i style={{ background: o.color }} />
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {pop.dayOff && (
                <span className="caption">
                  {pop.dayOff.source === "crm" ? "Marcado en el CRM" : "Fijado por RRHH"}
                  {pop.dayOff.notes ? ` · ${pop.dayOff.notes}` : ""}. Clic otra vez para quitarlo; asignar un turno también lo quita en los dos horarios.
                </span>
              )}
            </div>
              </>
            )}

            {pop.current?.source === "crm" && (
              <div className="sch-pop-note">Este turno vino del CRM. Lo que cambie aquí (horas, reagendar, quitar o dar el día libre) también se cambia en el horario del CRM.</div>
            )}
            {pop.current && (
              <div className="sch-pop-foot">
                <button className="btn ghost sm danger" disabled={busy} onClick={clearDay}>
                  <IconTrash width={14} height={14} /> Quitar turno del día
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {assigning && (
        <AssignModal
          employees={employees.data?.items ?? []}
          templates={activeTemplates}
          defaultFrom={days[0]}
          defaultTo={days[6]}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            assignments.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDelete
          title="Eliminar empleado"
          path={`/employees/${deleting.id}`}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            employees.reload();
            assignments.reload();
          }}
        >
          <p>
            Se eliminará la ficha de <b>{deleting.full_name}</b> en todo el sistema: Empleados, Horarios, Marcaciones,
            vacaciones y constancias. Esto no se puede deshacer.
          </p>
          <p className="caption">Sus marcas del reloj se conservan, pero quedan sin nombre. Si la persona solo dejó de trabajar, mejor edítela y márquela como inactiva.</p>
        </ConfirmDelete>
      )}
      {templatesOpen && (
        <TemplatesModal templates={templates.data ?? []} canEdit={canEdit} onClose={() => setTemplatesOpen(false)} onSaved={templates.reload} />
      )}
    </div>
  );
}

type ShiftForm = { date: string; start: string; end: string; breakMinutes: number };
type RestoreForm = { templateId: number | null; start: string; end: string; breakMinutes: number; note: string };

/** Reponer horario: elegir su horario de siempre, uno de los turnos base o uno nuevo, con nota. */
function RestorePanel({
  usual,
  loadingUsual,
  templates,
  templateOf,
  busy,
  onCancel,
  onSave,
}: {
  usual?: ShiftAssignment;
  loadingUsual: boolean;
  templates: ShiftTemplate[];
  templateOf: (a: ShiftAssignment) => ShiftTemplate | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (r: RestoreForm) => void;
}) {
  const usualTemplate = usual ? templateOf(usual) : undefined;
  const [choice, setChoice] = useState<string>(() => (usual ? "usual" : templates[0] ? `t:${templates[0].id}` : "nuevo"));
  const [start, setStart] = useState(usual ? fmtTime(usual.start_at) : "08:00");
  const [end, setEnd] = useState(usual ? fmtTime(usual.end_at) : "17:00");
  const [breakMinutes, setBreakMinutes] = useState(usual?.break_minutes ?? 60);
  const [note, setNote] = useState("");
  // Si el de siempre llega después (se busca en semanas anteriores), queda elegido.
  useEffect(() => {
    if (usual && choice !== "usual" && choice === (templates[0] ? `t:${templates[0].id}` : "nuevo")) setChoice("usual");
  }, [usual]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e: FormEvent) {
    e.preventDefault();
    if (choice === "usual" && usual) {
      onSave(
        usualTemplate?.is_active
          ? { templateId: usualTemplate.id, start: "", end: "", breakMinutes: 0, note }
          : { templateId: null, start: fmtTime(usual.start_at), end: fmtTime(usual.end_at), breakMinutes: usual.break_minutes, note },
      );
    } else if (choice.startsWith("t:")) {
      onSave({ templateId: Number(choice.slice(2)), start: "", end: "", breakMinutes: 0, note });
    } else {
      onSave({ templateId: null, start, end, breakMinutes, note });
    }
  }

  const option = (value: string, title: string, hours: string, color?: string) => (
    <label key={value} className={`sch-restore-opt${choice === value ? " on" : ""}`}>
      <input type="radio" name="reponer" value={value} checked={choice === value} onChange={() => setChoice(value)} />
      {color && <i style={{ background: color }} />}
      <span>
        <b>{title}</b>
        <small>{hours}</small>
      </span>
    </label>
  );

  return (
    <form className="sch-pop-sec sch-restore" onSubmit={submit}>
      <span className="sch-pop-label">Reponer horario: quita lo marcado en el día y le asigna</span>
      <div className="sch-restore-list">
        {usual
          ? option(
              "usual",
              "Su horario de siempre",
              `${fmtTime(usual.start_at)}–${fmtTime(usual.end_at)}${usualTemplate ? ` · ${usualTemplate.name}` : ""}`,
              shiftColor(fmtTime(usual.start_at), fmtTime(usual.end_at)),
            )
          : loadingUsual && <span className="caption">Buscando su horario de siempre…</span>}
        {templates.map((t) => option(`t:${t.id}`, t.name, `${hhmm(t.start_time)}–${hhmm(t.end_time)}${t.break_minutes ? ` · ${t.break_minutes} min desc.` : ""}`, shiftColor(hhmm(t.start_time), hhmm(t.end_time))))}
        {option("nuevo", "Nuevo horario", "Entrada, salida y descanso a mano")}
      </div>
      {choice === "nuevo" && (
        <div className="sch-pop-times">
          <label>
            <span className="caption">Entrada</span>
            <input className="input" type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            <span className="caption">Salida</span>
            <input className="input" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <label>
            <span className="caption">Desc. (min)</span>
            <input className="input" type="number" min={0} max={480} required value={breakMinutes} onChange={(e) => setBreakMinutes(Number(e.target.value))} />
          </label>
        </div>
      )}
      <label className="sch-restore-note">
        <span className="caption">Nota (opcional)</span>
        <input className="input" maxLength={400} placeholder="Ej. repone el permiso del lunes" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="sch-restore-foot">
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn sm" disabled={busy || (choice === "nuevo" && start === end)}>
          {busy ? "Reponiendo…" : "Reponer horario"}
        </button>
      </div>
    </form>
  );
}

/** Días que ocupan `n` compensatorios desde `day`: seguidos, sin contar domingos. */
function compDays(day: string, n: number): string[] {
  const out: string[] = [];
  for (let d = day; out.length < n; d = addDays(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) out.push(d);
  }
  return out;
}

/** Compensatorio: lista de los asuetos ganados y sin usar de la persona; se pueden elegir varios
 *  y cada uno es un día compensatorio, desde el día elegido en adelante. */
function CompPanel({
  employee,
  day,
  busy,
  onCancel,
  onSave,
}: {
  employee: Employee;
  day: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (picked: { day: string; holiday: Holiday | null }[]) => void;
}) {
  const comp = useAsync(() => api.get<CompensatoryStatus[]>("/schedules/compensatory"), []);
  const available = comp.data?.find((c) => c.employee_id === employee.id)?.available ?? [];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const chosen = available.filter((h) => picked.has(h.id));
  const dates = compDays(day, Math.max(1, chosen.length));
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(chosen.length ? chosen.map((h, i) => ({ day: dates[i], holiday: h })) : [{ day, holiday: null }]);
  }

  return (
    <form className="sch-pop-sec sch-restore" onSubmit={submit}>
      <span className="sch-pop-label">
        Compensatorios disponibles · {available.length || (comp.data ? "ninguno" : "…")}
      </span>
      {comp.error && <div className="alert">{comp.error}</div>}
      {comp.loading && !comp.data ? (
        <span className="caption">Cargando compensatorios…</span>
      ) : available.length ? (
        <>
          <div className="picker-head">
            <span className="caption">Asuetos trabajados desde el 15/09/2026 y aún sin usar</span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setPicked(picked.size === available.length ? new Set() : new Set(available.map((h) => h.id)))}
            >
              {picked.size === available.length ? "Ninguno" : "Todos"}
            </button>
          </div>
          <div className="sch-restore-list">
            {available.map((h) => (
              <label key={h.id} className={`sch-restore-opt${picked.has(h.id) ? " on" : ""}`}>
                <input type="checkbox" checked={picked.has(h.id)} onChange={() => toggle(h.id)} />
                <i style={{ background: DAY_OFF_COLOR.compensatorio }} />
                <span>
                  <b>{fmtDate(h.day)}</b>
                  <small>{h.name}</small>
                </span>
              </label>
            ))}
          </div>
          <span className="caption">
            {chosen.length
              ? `${chosen.length === 1 ? "Queda compensatorio el" : `Quedan ${chosen.length} días compensatorio:`} ${dates.map(fmtShortDay).join(", ")}${chosen.length > 1 ? " (seguidos, sin contar domingos)" : ""}.`
              : "Elija uno o varios: cada asueto es un día compensatorio, desde este día en adelante."}
          </span>
        </>
      ) : (
        <span className="caption">No tiene asuetos trabajados sin usar. Puede marcar el día como compensatorio sin descontar uno en particular.</span>
      )}
      <div className="sch-restore-foot">
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn sm" disabled={busy || !comp.data || (available.length > 0 && !chosen.length)}>
          {busy ? "Guardando…" : chosen.length > 1 ? `Dar ${chosen.length} compensatorios` : "Dar compensatorio"}
        </button>
      </div>
    </form>
  );
}

/** Horas a mano para el día; con turno, también la fecha para reagendarlo. */
function ShiftEditor({ current, day, busy, onSave }: { current?: ShiftAssignment; day: string; busy: boolean; onSave: (f: ShiftForm) => void }) {
  const [f, setF] = useState<ShiftForm>(() => ({
    date: day,
    start: current ? fmtTime(current.start_at) : "08:00",
    end: current ? fmtTime(current.end_at) : "17:00",
    breakMinutes: current?.break_minutes ?? 60,
  }));
  const set = (patch: Partial<ShiftForm>) => setF((x) => ({ ...x, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(f);
  };
  const moving = !!current && f.date !== day;
  return (
    <form className="sch-pop-sec sch-pop-form" onSubmit={submit}>
      <span className="sch-pop-label">{current ? "Reagendar: otra fecha u otras horas" : "Horario personalizado"}</span>
      {current && (
        <label>
          <span className="caption">Fecha</span>
          <input className="input" type="date" required value={f.date} onChange={(e) => set({ date: e.target.value })} />
        </label>
      )}
      <div className="sch-pop-times">
        <label>
          <span className="caption">Entrada</span>
          <input className="input" type="time" required value={f.start} onChange={(e) => set({ start: e.target.value })} />
        </label>
        <label>
          <span className="caption">Salida</span>
          <input className="input" type="time" required value={f.end} onChange={(e) => set({ end: e.target.value })} />
        </label>
        <label>
          <span className="caption">Desc. (min)</span>
          <input className="input" type="number" min={0} max={480} required value={f.breakMinutes} onChange={(e) => set({ breakMinutes: Number(e.target.value) })} />
        </label>
      </div>
      {moving && <div className="caption">El {fmtShort(day)} queda como día libre.</div>}
      <button className="btn sm" disabled={busy || f.start === f.end}>
        {moving ? `Mover al ${fmtShort(f.date)}` : current ? "Guardar horas" : "Asignar"}
      </button>
    </form>
  );
}

const shortMonth = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", day: "numeric", month: "short" });
const fmtShort = (ymd: string) => shortMonth.format(new Date(`${ymd}T00:00:00Z`)).replace(".", "");

function ShiftBar({ a, day, h0, span, color, template }: { a: ShiftAssignment; day: string; h0: number; span: number; color: string; template?: ShiftTemplate }) {
  const s = hoursFrom(day, a.start_at);
  const e = hoursFrom(day, a.end_at);
  const len = e - s;
  // El descanso se dibuja a mitad del turno: el horario no dice a qué hora se toma.
  const brk = a.break_minutes / 60;
  const brkLeft = len > brk ? ((len - brk) / 2 / len) * 100 : 0;
  return (
    <div
      className="sch-bar"
      style={{ left: `${((s - h0) / span) * 100}%`, width: `${(len / span) * 100}%`, background: color, color: readableOn(color) }}
      title={[a.source === "crm" ? "Vino del CRM" : "Asignado aquí", a.notes].filter(Boolean).join(" · ")}
    >
      {/* Mismo texto que en el CRM: "8:00 a. m. – 5:00 p. m. · 8–5". */}
      <span>
        {ampm(fmtTime(a.start_at))} – {ampm(fmtTime(a.end_at))} · {template?.name ?? shiftLabel(fmtTime(a.start_at), fmtTime(a.end_at))}
      </span>
      {brk > 0 && <div className="sch-bar-break" style={{ left: `${brkLeft}%`, width: `${(brk / len) * 100}%` }} title={`Descanso de ${a.break_minutes} min`} />}
    </div>
  );
}

function TemplatesModal({ templates, canEdit, onClose, onSaved }: { templates: ShiftTemplate[]; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const [editing, setEditing] = useState<ShiftTemplate | "new" | null>(null);
  if (editing)
    return (
      <TemplateModal
        template={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onSaved();
        }}
      />
    );
  return (
    <Modal title="Turnos base" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {templates.map((t) => (
          <button key={t.id} className="sch-pop-item" disabled={!canEdit} onClick={() => setEditing(t)}>
            <span className="row" style={{ gap: 8 }}>
              <span className="swatch" style={{ background: shiftColor(hhmm(t.start_time), hhmm(t.end_time)), borderRadius: 4 }} />
              <b>{t.name}</b>
              {!t.is_active && <span className="caption">(inactivo)</span>}
            </span>
            <span className="caption">
              {hhmm(t.start_time)}–{hhmm(t.end_time)} · {t.break_minutes} min descanso{t.crosses_midnight ? " · nocturno" : ""}
            </span>
          </button>
        ))}
        {templates.length === 0 && <div className="muted">Cree turnos base (ej. “Mañana 8:00–17:00”) para asignarlos con un clic.</div>}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cerrar
        </button>
        {canEdit && (
          <button className="btn" onClick={() => setEditing("new")}>
            <IconPlus /> Nuevo turno
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Asignar un turno a varios empleados en un rango de fechas. Se usa en Horarios y en Empleados. */
export function AssignModal({
  employees,
  templates,
  defaultFrom,
  defaultTo,
  initialSelected = [],
  initialMode = "turno",
  initialWeekdays = [0, 1, 2, 3, 4],
  initialNotes = "",
  onClose,
  onDone,
}: {
  employees: Employee[];
  templates: ShiftTemplate[];
  defaultFrom: string;
  defaultTo: string;
  initialSelected?: number[];
  initialMode?: "turno" | Exclude<DayOffKind, "libre">;
  initialWeekdays?: number[];
  initialNotes?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialSelected));
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [weekdays, setWeekdays] = useState<number[]>(initialWeekdays);
  const [templateId, setTemplateId] = useState<string>(templates[0] ? String(templates[0].id) : "custom");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMin, setBreakMin] = useState(60);
  const [overwrite, setOverwrite] = useState(false);
  const [mode, setMode] = useState(initialMode);
  const [notes, setNotes] = useState(initialNotes);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Compensatorio: qué asueto ganado (y sin usar) se da; la nota lleva su fecha y así queda usado.
  const comp = useAsync(
    () => (mode === "compensatorio" ? api.get<CompensatoryStatus[]>("/schedules/compensatory") : Promise.resolve(null)),
    [mode],
  );
  const availableOf = useMemo(() => new Map((comp.data ?? []).map((c) => [c.employee_id, c.available])), [comp.data]);
  const inList = useMemo(() => new Set(employees.map((e) => e.id)), [employees]);
  // Asuetos con compensatorio disponible para alguien de la lista, con cuántos lo tienen.
  const holidayOptions = useMemo(() => {
    const map = new Map<number, { holiday: Holiday; count: number }>();
    for (const c of comp.data ?? []) {
      if (!inList.has(c.employee_id)) continue;
      for (const h of c.available) map.set(h.id, { holiday: h, count: (map.get(h.id)?.count ?? 0) + 1 });
    }
    return [...map.values()].sort((a, b) => a.holiday.day.localeCompare(b.holiday.day));
  }, [comp.data, inList]);
  const [holidayId, setHolidayId] = useState<string>("");
  const holiday = holidayOptions.find((o) => String(o.holiday.id) === holidayId)?.holiday ?? null;
  const hasIt = (id: number) => !!holiday && !!availableOf.get(id)?.some((h) => h.id === holiday.id);

  const shown = employees.filter(
    (e) => (!holiday || hasIt(e.id)) && (!search || e.full_name.toLowerCase().includes(search.toLowerCase()) || e.badge_number === search),
  );
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const custom = templateId === "custom";
    try {
      if (mode !== "turno") {
        await api.post("/schedules/days-off/bulk", {
          employee_ids: [...selected],
          date_from: from,
          date_to: to,
          weekdays,
          kind: mode,
          notes: (holiday && mode === "compensatorio" ? [`Compensatorio ${fmtDate(holiday.day)} (${holiday.name})`, notes.trim()].filter(Boolean).join(" · ") : notes.trim()) || null,
        });
        onDone();
        return;
      }
      const r = await api.post<{ created: number; updated: number; skipped: number }>("/schedules/assignments/bulk", {
        employee_ids: [...selected],
        date_from: from,
        date_to: to,
        weekdays,
        template_id: custom ? null : Number(templateId),
        start_time: custom ? startTime : null,
        end_time: custom ? endTime : null,
        break_minutes: custom ? breakMin : null,
        overwrite,
      });
      if (r.skipped && !r.created && !r.updated) {
        setResult(`Ya había ${r.skipped} horarios en esas fechas. Marque “Reemplazar existentes” para cambiarlos.`);
      } else {
        onDone();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const modeLabel = mode === "turno" ? "turno" : mode === "compensatorio" ? "día compensatorio" : DAY_OFF_LABEL[mode].toLowerCase();
  const dayCount = from && to && to >= from ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 0;
  // Días que realmente se asignan: los del rango que caen en los días de la semana marcados.
  const assignedDays = Array.from({ length: dayCount }, (_, i) => addDays(from, i)).filter((d) =>
    weekdays.includes((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7),
  ).length;

  return (
    <Modal
      title="Asignar horario"
      subtitle="Elija qué asignar, a quiénes y en qué fechas. Se aplica también en el horario del CRM."
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="modal-sec">
          <span className="modal-label">Qué asignar</span>
          <div className="seg wrap" role="radiogroup" aria-label="Qué asignar">
            {(
              [
                ["turno", "Turno"],
                ["vacacion", "Vacación"],
                ["compensatorio", "Compensatorio"],
                ["incapacidad", "Incapacidad"],
                ["suspendido", "Suspendido"],
                ["baja", "De baja"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "on" : undefined} onClick={() => setMode(value)}>
                {label}
              </button>
            ))}
          </div>
          {mode !== "turno" && (
            <span className="caption">
              Los días elegidos quedan como {modeLabel}: se quita el turno que hubiera y quedan como descanso también en el horario del CRM.
            </span>
          )}
        </div>
        {error && <div className="alert">{error}</div>}
        {result && <div className="alert warn">{result}</div>}

        {mode === "compensatorio" && (
          <div className="modal-sec">
            <span className="modal-label">
              Compensatorio disponible<small>asuetos trabajados desde el 15/09/2026 y aún sin usar</small>
            </span>
            {comp.error && <div className="alert">{comp.error}</div>}
            <select
              className="input"
              value={holidayId}
              disabled={!comp.data}
              aria-label="Compensatorio disponible"
              onChange={(e) => {
                setHolidayId(e.target.value);
                // Solo quedan seleccionadas las personas que tienen ese asueto disponible.
                const h = holidayOptions.find((o) => String(o.holiday.id) === e.target.value)?.holiday;
                if (h) setSelected((sel) => new Set([...sel].filter((id) => availableOf.get(id)?.some((x) => x.id === h.id))));
              }}
            >
              <option value="">{comp.data ? "Sin asueto: no descuenta uno en particular" : "Cargando compensatorios…"}</option>
              {holidayOptions.map(({ holiday: h, count }) => (
                <option key={h.id} value={h.id}>
                  {fmtDate(h.day)} · {h.name} — {count} {count === 1 ? "persona lo tiene" : "personas lo tienen"}
                </option>
              ))}
            </select>
            {comp.data && !holidayOptions.length && (
              <span className="caption">Nadie de la lista tiene compensatorios disponibles: no hay asuetos trabajados con marcas desde el 15/09/2026.</span>
            )}
            {holiday && <span className="caption">La lista muestra solo a quienes trabajaron el {fmtDate(holiday.day)} y aún no lo han usado.</span>}
            {holiday && assignedDays > 1 && (
              <div className="alert warn">Un asueto da un solo día compensatorio y el rango tiene {assignedDays} días. Elija un solo día.</div>
            )}
          </div>
        )}

        <div className="modal-sec">
          <span className="modal-label">
            Personas<small>{selected.size} seleccionadas</small>
          </span>
          <div className="picker-head">
            <label className="pn-search">
              <span className="sr-only">Buscar</span>
              <IconSearch width={16} height={16} aria-hidden />
              <input className="input" placeholder="Buscar por nombre o ID de reloj" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <button type="button" className="btn ghost sm" onClick={() => setSelected(new Set(shown.map((e) => e.id)))}>
              Todos
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setSelected(new Set())} disabled={!selected.size}>
              Ninguno
            </button>
          </div>
          <div className="emp-picker">
            {shown.map((e) => (
              <label key={e.id} className="check">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                {e.full_name} <span className="caption">{e.badge_number && `· ID ${e.badge_number}`}</span>
                {mode === "compensatorio" && !!availableOf.get(e.id)?.length && (
                  <span className="picker-tags">
                    {availableOf.get(e.id)!.map((h) => (
                      <span key={h.id} className={`picker-tag${holiday?.id === h.id ? " on" : ""}`} title={h.name}>
                        {fmtDate(h.day).slice(0, 5)}
                      </span>
                    ))}
                  </span>
                )}
              </label>
            ))}
            {shown.length === 0 && <span className="caption" style={{ padding: 8 }}>Nadie coincide con la búsqueda.</span>}
          </div>
        </div>

        <div className="modal-sec">
          <span className="modal-label">
            Fechas<small>{dayCount ? `${dayCount} día${dayCount === 1 ? "" : "s"} en el rango` : "Rango inválido"}</small>
          </span>
          <div className="form-grid">
            <label className="field">
              <span>Desde</span>
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </label>
            <label className="field">
              <span>Hasta</span>
              <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
            </label>
          </div>
          <div className="days" role="group" aria-label="Días de la semana">
            {WEEKDAYS.map((d, i) => (
              <button
                type="button"
                key={i}
                aria-pressed={weekdays.includes(i)}
                className={`day-toggle${weekdays.includes(i) ? " on" : ""}`}
                onClick={() => setWeekdays((w) => (w.includes(i) ? w.filter((x) => x !== i) : [...w, i].sort()))}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {mode === "turno" ? (
          <div className="modal-sec">
            <span className="modal-label">Turno</span>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Turno">
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({hhmm(t.start_time)}–{hhmm(t.end_time)})
                </option>
              ))}
              <option value="custom">Horario personalizado…</option>
            </select>
            {templateId === "custom" && (
              <div className="form-grid three">
                <label className="field">
                  <span>Entrada</span>
                  <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
                </label>
                <label className="field">
                  <span>Salida</span>
                  <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
                </label>
                <label className="field">
                  <span>Descanso (min)</span>
                  <input className="input" type="number" min={0} max={480} value={breakMin} onChange={(e) => setBreakMin(Number(e.target.value))} />
                </label>
                {endTime < startTime && <span className="caption full">Termina al día siguiente (turno nocturno).</span>}
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Reemplazar horarios existentes en esas fechas
            </label>
          </div>
        ) : (
          <div className="modal-sec">
            <label className="field">
              <span>Nota (opcional)</span>
              <input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. vacaciones anuales, compensa el sábado 3" />
            </label>
          </div>
        )}

        <div className="modal-foot">
          <span className="caption modal-foot-note">
            {selected.size} {selected.size === 1 ? "persona" : "personas"} · {weekdays.length} día{weekdays.length === 1 ? "" : "s"} de la semana
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !selected.size || !weekdays.length || (!!holiday && assignedDays > 1)}>
            {busy ? "Asignando…" : `Asignar ${modeLabel}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TemplateModal({ template, onClose, onSaved }: { template: ShiftTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: template?.name ?? "",
    start_time: template ? hhmm(template.start_time) : "08:00",
    end_time: template ? hhmm(template.end_time) : "17:00",
    break_minutes: template?.break_minutes ?? 60,
    tolerance_minutes: template?.tolerance_minutes ?? 5,
    // El color en pantalla sale de las horas (lib/shiftColors); este campo solo se conserva.
    color: template?.color ?? OTHER_SHIFT.color,
    is_active: template?.is_active ?? true,
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (template) await api.put(`/schedules/templates/${template.id}`, form);
      else await api.post("/schedules/templates", form);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={template ? "Editar turno" : "Nuevo turno"} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field full">
            <span>Nombre</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Mañana" required />
          </label>
          <label className="field">
            <span>Entrada</span>
            <input className="input" type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required />
          </label>
          <label className="field">
            <span>Salida</span>
            <input className="input" type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required />
          </label>
          <label className="field">
            <span>Minutos de descanso</span>
            <input className="input" type="number" min={0} max={480} value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Tolerancia de llegada (min)</span>
            <input className="input" type="number" min={0} max={120} value={form.tolerance_minutes} onChange={(e) => setForm({ ...form, tolerance_minutes: Number(e.target.value) })} />
          </label>
          <label className="check full">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Activo
          </label>
        </div>
        {form.end_time < form.start_time && <div className="alert info" style={{ marginTop: 16 }}>Turno nocturno: termina al día siguiente.</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn">Guardar</button>
        </div>
      </form>
    </Modal>
  );
}
