import { Fragment, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";

import { IconChevronDown, IconChevronLeft, IconChevronRight, IconHouse, IconPlus, IconSim, IconTrash } from "../components/Icons";
import { ConfirmDelete } from "../components/RowMenu";
import { Modal } from "../components/Modal";
import { useCollapsedTeams } from "../components/TeamGroups";
import {
  api,
  AREAS,
  DAY_OFF_LABEL,
  groupBySection,
  groupByTeam,
  SECTION_LABEL,
  type Area,
  type Employee,
  type Page,
  type Punch,
  type ShiftAssignment,
  type ShiftDayOff,
  type ShiftTemplate,
  type Sync,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { DAY_OFF_COLOR, dayOffColor, isNoShow, NO_SHOW, OTHER_SHIFT, SHIFT_KINDS, shiftColor, shiftKind } from "../lib/shiftColors";
import { addDays, fmtDateTime, fmtTime, hhmm, hoursFrom, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];
const DOW = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
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

  // Agentes de ventas: solo por sección (Residencial / Líneas), sin teams. El resto, por team.
  const bySection = area === "ventas";
  const allGroups = useMemo(() => {
    const items = employees.data?.items ?? [];
    return bySection
      ? groupBySection(items).map((g) => ({ ...g, label: g.section ? SECTION_LABEL[g.section] : "Sin team" }))
      : groupByTeam(items).map((g) => ({ key: g.key, section: g.team?.section ?? null, label: g.team?.name ?? "Sin team", items: g.items }));
  }, [employees.data, bySection]);
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
    const top = ev.clientY + 520 > window.innerHeight ? Math.max(8, ev.clientY - 520) : ev.clientY + 12;
    setError(null);
    setPop({
      employee: e,
      day,
      dayIndex,
      current: byKey.get(`${e.id}|${day}`),
      dayOff: offByKey.get(`${e.id}|${day}`),
      top,
      left: Math.min(ev.clientX, window.innerWidth - 320),
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

  function clearDay() {
    if (!pop?.current) return;
    return popAction(() => api.delete(`/schedules/assignments/${pop.current!.id}`));
  }

  function giveDayOff() {
    if (!pop) return;
    return popAction(() => api.post("/schedules/days-off", { employee_id: pop.employee.id, work_date: pop.day }));
  }

  function removeDayOff() {
    if (!pop?.dayOff) return;
    return popAction(() => api.delete(`/schedules/days-off/${pop.dayOff!.id}`));
  }

  const sync = lastSync.data?.items[0];
  const activeTemplates = (templates.data ?? []).filter((t) => t.is_active);
  const popTemplate = pop?.current ? templateOf(pop.current) : undefined;
  let lastSection: string | null = null;

  return (
    <div className="page sch">
      <div className="sch-head">
        <div className="sch-kicker">Horarios · {section}</div>
        {sync && (
          <span className={`caption${sync.status === "ok" ? "" : " sch-warn"}`}>
            Última actualización del CRM: {fmtDateTime(sync.received_at)}
            {sync.status !== "ok" && ` · ${sync.status}`}
          </span>
        )}
        <button
          className="btn ghost sm"
          onClick={() => {
            setStart(weekStart(today()));
            setDayIndex((new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7);
          }}
        >
          Hoy
        </button>
      </div>

      {/* KPIs: personas en turno por día de la semana elegida; las flechas cambian de semana. */}
      <div className="sch-days">
        <button className="icon-btn sch-arrow" onClick={() => setStart(addDays(start, -7))} aria-label="Semana anterior">
          <IconChevronLeft width={20} height={20} />
        </button>
        {days.map((d, i) => {
          const on = visible.filter((e) => byKey.has(`${e.id}|${d}`)).length;
          return (
            <button key={d} className={`sch-day${i === dayIndex ? " on" : ""}`} onClick={() => setDayIndex(i)}>
              <span className="sch-day-top">
                <b>
                  {DOW[i]} {d.slice(8)}
                </b>
                {d === today() && <i>Hoy</i>}
              </span>
              <span className="caption">{on} en turno</span>
            </button>
          );
        })}
        <button className="icon-btn sch-arrow" onClick={() => setStart(addDays(start, 7))} aria-label="Semana siguiente">
          <IconChevronRight width={20} height={20} />
        </button>
      </div>

      {/* Una sola barra: filtros y acciones. */}
      <div className="sch-toolbar">
        <div className="spacer" />
        <select className="input" style={{ width: 200 }} value={team} onChange={(e) => setTeam(e.target.value)} aria-label={bySection ? "Filtrar por sección" : "Filtrar por team"}>
          <option value="all">{bySection ? "Todas las secciones" : "Todos los teams"}</option>
          {allGroups.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
        <input className="input" style={{ width: 200 }} placeholder="Buscar persona o ID" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn ghost" onClick={() => setTemplatesOpen(true)}>
          Turnos base
        </button>
        {canEdit && (
          <button className="btn" onClick={() => setAssigning(true)} disabled={!employees.data?.items.length}>
            <IconPlus /> Asignar horario
          </button>
        )}
      </div>

      <div className="sch-legend">
        {SHIFT_KINDS.filter((k) => !k.short).map((k) => (
          <span key={k.label}>
            <span className="swatch" style={{ background: k.color, borderRadius: 4 }} /> {k.label}
          </span>
        ))}
        <span>
          <span className="swatch" style={{ background: OTHER_SHIFT.color, borderRadius: 4 }} /> {OTHER_SHIFT.label}
        </span>
        {(
          [
            ["Libre", DAY_OFF_COLOR.libre],
            ["Vacaciones", DAY_OFF_COLOR.vacacion],
            ["Incapacidad", DAY_OFF_COLOR.incapacidad],
            [NO_SHOW.label, NO_SHOW.color],
          ] as const
        ).map(([label, color]) => (
          <span key={label}>
            <span className="swatch" style={{ background: color, borderRadius: 4 }} /> {label}
          </span>
        ))}
        <span>
          <span className="sch-hatch" /> Descanso (ubicación referencial)
        </span>
        {canEdit && <span>Clic en una fila para asignar el turno del día</span>}
      </div>

      {(assignments.error || punches.error) && <div className="alert">{assignments.error || punches.error}</div>}

      <div className="sch-scroll">
        <div className={`sch-board${canEdit ? " can-delete" : ""}`}>
          <div className="sch-grid sch-hist-row">
            <div className="sch-hist-label">
              <b>Personas en turno por hora</b>
              {thin.length > 0 && visible.length > 0 && (
                <span className="sch-warn">
                  Menos de {MIN_COVERAGE}: {thin.map(hourLabel).join(", ")}
                </span>
              )}
            </div>
            <div className="sch-hist">
              {coverage.map((v, k) => (
                <div key={k} className={`sch-hist-col${v < MIN_COVERAGE ? " thin" : ""}`}>
                  <span>{v}</span>
                  <div style={{ height: `${Math.max(4, (v / maxCoverage) * 100 - 24)}%` }} />
                </div>
              ))}
            </div>
            <div />
            {canEdit && <div />}
          </div>

          <div className="sch-grid sch-head">
            <span>Persona · marcación</span>
            <div className="sch-hours">
              {hours.map((h) => (
                <span key={h}>{hourLabel(h)}</span>
              ))}
            </div>
            <div className="sch-head-week">
              <span>Semana</span>
              <span>Horas</span>
            </div>
            {canEdit && <span />}
          </div>

          {groups.map((g) => {
            const section = g.section;
            const showSection = !bySection && section !== null && section !== lastSection;
            lastSection = section;
            const open = teams.isOpen(g.key);
            const teamHours = g.items.reduce((s, e) => s + weekHours(e), 0);
            const noShift = g.items.filter((e) => !byKey.has(`${e.id}|${day}`)).length;
            const SectionIcon = section === "lineas" ? IconSim : IconHouse;
            return (
              <Fragment key={g.key}>
                {showSection && (
                  <div className="sch-section">
                    <SectionIcon width={14} height={14} /> {SECTION_LABEL[section]}
                  </div>
                )}
                <section className="sch-team">
                  <div className="sch-team-head">
                    <button className={`sch-team-toggle${open ? "" : " closed"}`} onClick={() => teams.toggle(g.key)} aria-expanded={open}>
                      <IconChevronDown width={14} height={14} />
                      {bySection && section && <SectionIcon width={14} height={14} />}
                      <span>{g.label}</span>
                    </button>
                    <span className="muted">
                      {g.items.length} agente{g.items.length === 1 ? "" : "s"} · {fmtHours(teamHours)} semana
                    </span>
                    {noShift > 0 && <span className="caption">{noShift} sin turno este día</span>}
                  </div>
                  {open &&
                    g.items.map((e) => {
                      const a = byKey.get(`${e.id}|${day}`);
                      const m = mark(e, a);
                      const total = weekHours(e);
                      return (
                        <div key={e.id} className="sch-grid sch-row">
                          <div className="sch-agent">
                            <Link to={`/empleados/${e.id}`} className="sch-name">
                              {e.full_name}
                            </Link>
                            <div className={m.warn ? "sch-warn" : "caption"}>
                              {e.is_supervisor && <span className="badge accent sup-tag">Supervisor</span>}
                              {m.text}
                            </div>
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
                            ) : offByKey.has(`${e.id}|${day}`) ? (
                              <span className="sch-empty" title={offByKey.get(`${e.id}|${day}`)?.notes ?? undefined}>
                                <span className="swatch" style={{ background: dayOffColor(offByKey.get(`${e.id}|${day}`)!), borderRadius: 4, marginRight: 8 }} />
                                {isNoShow(offByKey.get(`${e.id}|${day}`)!) ? NO_SHOW.label : DAY_OFF_LABEL[offByKey.get(`${e.id}|${day}`)!.kind]}
                                {offByKey.get(`${e.id}|${day}`)!.source === "crm" ? " (CRM)" : " (RRHH)"}
                                {canEdit ? " — clic para cambiar" : ""}
                              </span>
                            ) : (
                              <span className="sch-empty">{canEdit ? "Sin turno — clic para asignar" : "Sin turno"}</span>
                            )}
                          </div>
                          <div className="sch-weekcol">
                            <div className="sch-squares">
                              {days.map((d, i) => {
                                const wa = byKey.get(`${e.id}|${d}`);
                                const off = offByKey.get(`${e.id}|${d}`);
                                const offLabel = off && (isNoShow(off) ? NO_SHOW.label : DAY_OFF_LABEL[off.kind]);
                                return (
                                  <span
                                    key={d}
                                    title={`${DOW[i]}: ${wa ? `${fmtTime(wa.start_at)}–${fmtTime(wa.end_at)}` : off ? `${offLabel} (${off.source === "crm" ? "CRM" : "RRHH"})` : "Sin turno"}`}
                                    className={`${wa || off ? "" : "none"}${i === dayIndex ? " sel" : ""}`}
                                    style={wa ? { background: colorOf(wa) } : off ? { background: dayOffColor(off) } : undefined}
                                  />
                                );
                              })}
                            </div>
                            <b className={total > WEEK_LIMIT_HOURS ? "sch-warn" : total ? "" : "muted"}>{fmtHours(total)}</b>
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
            <div className="empty">{employees.data.items.length ? "Ningún agente coincide con el filtro." : "Registre empleados para poder asignarles horarios."}</div>
          )}
        </div>
      </div>

      {pop && (
        <>
          <div className="sch-pop-backdrop" onClick={() => setPop(null)} />
          <div className="sch-pop" style={{ top: pop.top, left: pop.left, maxHeight: `calc(100vh - ${pop.top + 8}px)` }} role="dialog" aria-label="Asignar turno">
            <div className="caption sch-pop-title">
              {pop.employee.full_name} · {DOW[pop.dayIndex]} {pop.day.slice(8)}
            </div>
            {error && <div className="alert">{error}</div>}
            {activeTemplates.map((t) => (
              <button key={t.id} className={`sch-pop-item${popTemplate?.id === t.id ? " on" : ""}`} disabled={busy} onClick={() => applyTemplate(t, [pop.dayIndex])}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="swatch" style={{ background: shiftColor(hhmm(t.start_time), hhmm(t.end_time)), borderRadius: 4 }} />
                  {t.name}
                </span>
                <span className="caption">
                  {hhmm(t.start_time)}–{hhmm(t.end_time)}
                  {t.break_minutes ? ` · ${t.break_minutes} min desc.` : ""}
                </span>
              </button>
            ))}
            {activeTemplates.length === 0 && <div className="caption sch-pop-title">Cree un turno base para asignarlo con un clic.</div>}
            <ShiftEditor
              key={`${pop.employee.id}|${pop.day}`}
              current={pop.current}
              day={pop.day}
              busy={busy}
              onSave={saveCustom}
            />
            {pop.current?.source === "crm" && (
              <div className="caption sch-pop-note">
                Este turno vino del CRM. Lo que cambie aquí (horas, reagendar, quitar o dar el día libre) también se cambia en el horario del CRM.
              </div>
            )}
            {pop.dayOff && (
              <div className="caption sch-pop-note">
                {DAY_OFF_LABEL[pop.dayOff.kind]} {pop.dayOff.source === "crm" ? "marcado en el CRM" : "fijado por RRHH"}
                {pop.dayOff.notes ? ` · ${pop.dayOff.notes}` : ""}. Está igual en los dos horarios; asignar un turno lo quita en ambos.
              </div>
            )}
            <div className="sch-pop-foot">
              {popTemplate && (
                <button className="btn ghost sm" disabled={busy} onClick={() => applyTemplate(popTemplate, [0, 1, 2, 3, 4, 5])}>
                  Aplicar {popTemplate.name} a Lun–Sáb
                </button>
              )}
              {pop.current && (
                <button className="btn ghost sm" disabled={busy} onClick={clearDay}>
                  Quitar turno del día
                </button>
              )}
              {!pop.dayOff && (
                <button className="btn ghost sm" disabled={busy} onClick={giveDayOff}>
                  Dar día libre
                </button>
              )}
              {pop.dayOff && (
                <button className="btn ghost sm" disabled={busy} onClick={removeDayOff}>
                  Quitar {DAY_OFF_LABEL[pop.dayOff.kind].toLowerCase()}
                </button>
              )}
            </div>
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
            Se eliminará la ficha de <b>{deleting.full_name}</b> ({deleting.code}) en todo el sistema: Empleados, Horarios, Marcaciones,
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
    <form className="sch-pop-form" onSubmit={submit}>
      <div className="caption">{current ? "Reagendar: otra fecha u otras horas" : "Horario personalizado"}</div>
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
      title={a.notes ?? undefined}
    >
      <span>
        {fmtTime(a.start_at)}–{fmtTime(a.end_at)} · {template?.name ?? (shiftKind(fmtTime(a.start_at), fmtTime(a.end_at)) ? (shiftKind(fmtTime(a.start_at), fmtTime(a.end_at))!.short ? "Shortday" : "Jornada completa") : "Personalizado")}
        {a.source === "crm" && " · CRM"}
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
  initialMode?: "turno" | "vacacion" | "compensatorio" | "incapacidad";
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

  const shown = employees.filter((e) => !search || e.full_name.toLowerCase().includes(search.toLowerCase()) || e.badge_number === search);
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
          notes: notes.trim() || null,
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

  return (
    <Modal title="Asignar horario" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="chips" role="radiogroup" aria-label="Qué asignar">
          {(
            [
              ["turno", "Turno"],
              ["vacacion", "Vacación"],
              ["compensatorio", "Día compensatorio"],
              ["incapacidad", "Incapacidad"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={`btn sm${mode === value ? "" : " ghost"}`} onClick={() => setMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {mode !== "turno" && (
          <div className="caption">
            Los días elegidos quedan como {mode === "vacacion" ? "vacación" : mode === "incapacidad" ? "incapacidad" : "día compensatorio"}: se quita el turno que hubiera y quedan como descanso también en el horario del CRM.
          </div>
        )}
        {error && <div className="alert">{error}</div>}
        {result && <div className="alert warn">{result}</div>}
        <div className="field">
          <span>
            Empleados ({selected.size} seleccionados)
            <button type="button" className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setSelected(new Set(shown.map((e) => e.id)))}>
              Todos
            </button>
            <button type="button" className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => setSelected(new Set())}>
              Ninguno
            </button>
          </span>
          <input className="input" placeholder="Buscar" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="emp-picker">
            {shown.map((e) => (
              <label key={e.id} className="check">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                {e.full_name} <span className="caption">{e.badge_number && `· ID ${e.badge_number}`}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Desde</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <div className="field full">
            <span>Días</span>
            <div className="days">
              {WEEKDAYS.map((d, i) => (
                <button
                  type="button"
                  key={i}
                  className={`day-toggle${weekdays.includes(i) ? " on" : ""}`}
                  onClick={() => setWeekdays((w) => (w.includes(i) ? w.filter((x) => x !== i) : [...w, i].sort()))}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          {mode !== "turno" && (
            <label className="field full">
              <span>Nota (opcional)</span>
              <input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. vacaciones anuales, compensa el sábado 3" />
            </label>
          )}
          {mode === "turno" && (
          <label className="field full">
            <span>Turno</span>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({hhmm(t.start_time)}–{hhmm(t.end_time)})
                </option>
              ))}
              <option value="custom">Horario personalizado…</option>
            </select>
          </label>
          )}
          {mode === "turno" && templateId === "custom" && (
            <>
              <label className="field">
                <span>Entrada</span>
                <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              </label>
              <label className="field">
                <span>Salida (si es menor que la entrada, termina al día siguiente)</span>
                <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
              </label>
              <label className="field">
                <span>Minutos de descanso</span>
                <input className="input" type="number" min={0} max={480} value={breakMin} onChange={(e) => setBreakMin(Number(e.target.value))} />
              </label>
            </>
          )}
        </div>
        {mode === "turno" && (
          <label className="check">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Reemplazar horarios existentes en esas fechas
          </label>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !selected.size || !weekdays.length}>
            {busy ? "Asignando…" : mode === "turno" ? "Asignar" : mode === "vacacion" ? "Asignar vacación" : "Asignar compensatorio"}
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
