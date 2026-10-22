import { useMemo, useState, type FormEvent } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { IconCalendar, IconChevronLeft, IconChevronRight, IconPlus, IconSearch, IconX } from "../components/Icons";
import { Modal } from "../components/Modal";
import { ConfirmDelete, RowMenu } from "../components/RowMenu";
import { api, ApiError, AREAS, DAY_OFF_LABEL, type Area, type CompensatoryStatus, type Holiday, type Employee, type Page, type ShiftDayOff, type ShiftTemplate, type VacationPeriod, type VacationStatus } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtDate, fmtLongDate, seniority, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Compensatory } from "./Compensatory";
import { AssignModal } from "./Schedules";

type Kind = "vacacion" | "compensatorio";
type Filter = "todos" | "pendientes" | "pronto" | "hoy";

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** Un tramo de días seguidos (p. ej. una semana de vacación), para mostrarlo como "5–9 ene". */
export interface Range {
  from: string;
  to: string;
  days: ShiftDayOff[];
}

const shortFmt = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", day: "numeric", month: "short" });
const short = (ymd: string) => shortFmt.format(new Date(`${ymd}T00:00:00Z`)).replace(".", "");

export function ranges(days: ShiftDayOff[]): Range[] {
  const out: Range[] = [];
  for (const d of [...days].sort((a, b) => a.work_date.localeCompare(b.work_date))) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d.work_date) {
      last.to = d.work_date;
      last.days.push(d);
    } else {
      out.push({ from: d.work_date, to: d.work_date, days: [d] });
    }
  }
  return out;
}

/** Asignación abierta desde la página: a quién y, para vacaciones, las fechas ya calculadas. */
interface Assigning {
  ids: number[];
  from?: string;
  to?: string;
  notes?: string;
}

/** Fechas sueltas agrupadas en tramos seguidos: "5–9 ene, 2 feb". */
function datesLabel(dates: string[]): string {
  const out: { from: string; to: string }[] = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out.map((r) => (r.from === r.to ? short(r.from) : `${short(r.from)} – ${short(r.to)}`)).join(", ");
}

const periodLabel = (p: VacationPeriod) => `${fmtDate(p.start)} – ${fmtDate(p.end)}`;

/** Fechas sugeridas para los días que le faltan de un período: desde que le tocan (o desde hoy,
 *  si ya le tocaban). Sin período, los 15 días del próximo aniversario. */
function vacationRange(employeeId: number, p: VacationPeriod | null, nextDate: string): Assigning {
  const now = today();
  const from = p ? (p.start > now ? p.start : now) : nextDate;
  const days = p ? p.pending : 15;
  return { ids: [employeeId], from, to: addDays(from, days - 1), notes: p ? `Vacaciones ${periodLabel(p)}` : undefined };
}

const rangeLabel = (r: Range) => (r.from === r.to ? short(r.from) : `${short(r.from)} – ${short(r.to)}`);

/** Días de vacación o compensatorios de una sección: todos sus empleados, con los días que
 *  tienen en el año. Se asignan con el mismo modal de Horarios y se quitan desde aquí. */
export function Leave({ kind, area }: { kind: Kind; area: Area }) {
  return kind === "compensatorio" ? <Compensatory /> : <LeaveView kind={kind} area={area} />;
}

function LeaveView({ kind, area }: { kind: Kind; area: Area }) {
  const section = AREAS.find((a) => a.area === area)!.label;
  const label = kind === "vacacion" ? "Días de vacación" : "Días compensatorio";
  const noun = DAY_OFF_LABEL[kind].toLowerCase();
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const navigate = useNavigate();
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const base = kind === "vacacion" ? "vacaciones" : "compensatorios";
  const [assigning, setAssigning] = useState<Assigning | null>(null);
  const [removing, setRemoving] = useState<{ employee: Employee; range: Range } | null>(null);

  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", area, limit: 500 }), [area]);
  const templates = useAsync(() => (canEdit ? api.get<ShiftTemplate[]>("/schedules/templates") : Promise.resolve([])), [canEdit]);
  const days = useAsync(
    () => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: `${year}-01-01`, date_to: `${year}-12-31`, kind }),
    [year, kind],
  );

  const isVacation = kind === "vacacion";
  const vacations = useAsync(
    () => (isVacation ? api.get<VacationStatus[]>("/schedules/vacations", { area }) : Promise.resolve([])),
    [isVacation, area],
  );
  const vacationOf = useMemo(() => new Map((vacations.data ?? []).map((v) => [v.employee_id, v])), [vacations.data]);
  const comp = useAsync(
    () => (isVacation ? Promise.resolve([]) : api.get<CompensatoryStatus[]>("/schedules/compensatory", { area })),
    [isVacation, area],
  );
  const compOf = useMemo(() => new Map((comp.data ?? []).map((c) => [c.employee_id, c])), [comp.data]);
  const inYear = (h: Holiday) => h.day.startsWith(String(year));
  const [editingHolidays, setEditingHolidays] = useState(false);
  const [periodsOf, setPeriodsOf] = useState<Employee | null>(null);
  const [vacationFor, setVacationFor] = useState<{ employee: Employee; period: VacationPeriod | null } | null>(null);

  const byEmployee = useMemo(() => {
    const map = new Map<number, ShiftDayOff[]>();
    for (const d of days.data ?? []) map.set(d.employee_id, [...(map.get(d.employee_id) ?? []), d]);
    return map;
  }, [days.data]);

  const all = employees.data?.items ?? [];
  const search = q.trim().toLowerCase();
  const now = today();
  const soon = addDays(now, 60);
  const isOffToday = (id: number) => (byEmployee.get(id) ?? []).some((d) => d.work_date === now);
  const comesSoon = (id: number) => {
    const v = vacationOf.get(id);
    return !!v?.next_date && v.pending === 0 && v.next_date >= now && v.next_date <= soon;
  };
  const matches = (e: Employee) => {
    if (filter === "pendientes") return isVacation ? (vacationOf.get(e.id)?.pending ?? 0) > 0 : (compOf.get(e.id)?.balance ?? 0) > 0;
    if (filter === "pronto") return comesSoon(e.id);
    if (filter === "hoy") return isOffToday(e.id);
    return true;
  };
  const shown = all.filter((e) => matches(e) && (!search || e.full_name.toLowerCase().includes(search) || e.code.toLowerCase().includes(search)));

  // Indicadores de la sección (sin filtros ni búsqueda).
  const withPending = all.filter((e) => (vacationOf.get(e.id)?.pending ?? 0) > 0);
  const pendingDays = withPending.reduce((s, e) => s + vacationOf.get(e.id)!.pending, 0);
  const soonCount = all.filter((e) => comesSoon(e.id)).length;
  const offToday = all.filter((e) => isOffToday(e.id)).length;
  const yearDays = (days.data ?? []).filter((d) => all.some((e) => e.id === d.employee_id)).length;
  const withBalance = all.filter((e) => (compOf.get(e.id)?.balance ?? 0) > 0);
  const balanceDays = withBalance.reduce((s, e) => s + compOf.get(e.id)!.balance, 0);
  const earnedYear = all.reduce((s, e) => s + (compOf.get(e.id)?.earned.filter(inYear).length ?? 0), 0);
  const lostYear = all.reduce((s, e) => s + (compOf.get(e.id)?.lost.filter(inYear).length ?? 0), 0);
  const filters: [Filter, string][] = isVacation
    ? [
        ["todos", "Todos"],
        ["pendientes", "Con días pendientes"],
        ["pronto", "Les tocan en 60 días"],
        ["hoy", "De vacación hoy"],
      ]
    : [
        ["todos", "Todos"],
        ["pendientes", "Con saldo a favor"],
        ["hoy", "Con compensatorio hoy"],
      ];

  function done() {
    setAssigning(null);
    setRemoving(null);
    days.reload();
    vacations.reload();
    comp.reload();
  }

  return (
    <div className="page wide lv">
      <h1 className="sr-only">
        {label} · {section}
      </h1>

      <div className="page-sticky">
      <section className="pn-bar" aria-label="Sección y filtros">
        <div className="pn-row">
          <nav className="seg" aria-label="Sección">
            {AREAS.map((a) => (
              <NavLink key={a.slug} to={`/${base}/${a.slug}`} className={({ isActive }) => `seg-link${isActive ? " on" : ""}`}>
                {a.label}
              </NavLink>
            ))}
          </nav>
          <span className="spacer" />
          {!isVacation && (
            <button className="btn ghost" onClick={() => setEditingHolidays(true)}>
              <IconCalendar /> Asuetos {year}
            </button>
          )}
          {canEdit && (
            <button className="btn" onClick={() => setAssigning({ ids: [] })} disabled={!all.length || !templates.data}>
              <IconPlus /> Asignar {noun}
            </button>
          )}
        </div>
        <div className="pn-row pn-tools">
          <div className="pn-period">
            <button className="icon-btn" onClick={() => setYear(year - 1)} aria-label="Año anterior">
              <IconChevronLeft width={18} height={18} />
            </button>
            <b className="lv-year">{year}</b>
            <button className="icon-btn" onClick={() => setYear(year + 1)} aria-label="Año siguiente">
              <IconChevronRight width={18} height={18} />
            </button>
          </div>
          <label className="pn-search">
            <span className="sr-only">Buscar</span>
            <IconSearch width={16} height={16} aria-hidden />
            <input className="input" placeholder="Buscar por nombre o código" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Mostrar">
            {filters.map(([value, text]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} className={filter === value ? "on" : undefined} onClick={() => setFilter(value)}>
                {text}
              </button>
            ))}
          </div>
        </div>
      </section>

      {isVacation ? (
        <dl className="home-kpis lv-kpis">
          <div className="home-kpi">
            <dt>Con días pendientes</dt>
            <dd className={`home-kpi-value mono${withPending.length ? " emp-warn" : ""}`}>{withPending.length}</dd>
            <dd className="home-kpi-note">{pendingDays ? `${pendingDays} días por dar en total` : "Nadie debe vacaciones"}</dd>
          </div>
          <div className="home-kpi">
            <dt>Les tocan en 60 días</dt>
            <dd className="home-kpi-value mono">{soonCount}</dd>
            <dd className="home-kpi-note">Cumplen un año más antes del {fmtDate(soon)}</dd>
          </div>
          <div className="home-kpi">
            <dt>De vacación hoy</dt>
            <dd className="home-kpi-value mono">{offToday}</dd>
            <dd className="home-kpi-note">{fmtLongDate(now)}</dd>
          </div>
          <div className="home-kpi">
            <dt>Días asignados en {year}</dt>
            <dd className="home-kpi-value mono">{yearDays}</dd>
            <dd className="home-kpi-note">Descansados o por descansar</dd>
          </div>
        </dl>
      ) : (
        <dl className="home-kpis lv-kpis">
          <div className="home-kpi">
            <dt>Con saldo a favor</dt>
            <dd className={`home-kpi-value mono${withBalance.length ? " emp-warn" : ""}`}>{withBalance.length}</dd>
            <dd className="home-kpi-note">{balanceDays ? `${balanceDays} compensatorios por dar` : "Nadie tiene saldo"}</dd>
          </div>
          <div className="home-kpi">
            <dt>Asuetos trabajados en {year}</dt>
            <dd className="home-kpi-value mono">{earnedYear}</dd>
            <dd className="home-kpi-note">Cada uno gana un compensatorio</dd>
          </div>
          <div className="home-kpi">
            <dt>Asignados en {year}</dt>
            <dd className="home-kpi-value mono">{yearDays}</dd>
            <dd className="home-kpi-note">{offToday} con compensatorio hoy</dd>
          </div>
          <div className="home-kpi">
            <dt>Asuetos perdidos</dt>
            <dd className="home-kpi-value mono">{lostYear}</dd>
            <dd className="home-kpi-note">No marcaron en el asueto</dd>
          </div>
        </dl>
      )}
      </div>

      {(employees.error || days.error || comp.error || vacations.error) && <div className="alert">{employees.error ?? days.error ?? comp.error ?? vacations.error}</div>}

      <div className="card emp-card">
        <div className="emp-card-head">
          <div className="emp-card-title">
            <h2 className="pn-h2">{section}</h2>
            <span className="caption">
              {shown.length} {shown.length === 1 ? "persona" : "personas"}
              {shown.length !== all.length && ` de ${all.length}`}
              {isVacation ? " · 15 días por cada año cumplido" : " · un compensatorio por cada asueto trabajado"}
            </span>
          </div>
        </div>
        <div className="table-wrap emp-scroll">
          <table className="table pn-table emp-table">
            <thead>
              <tr>
                <th>Empleado</th>
                {isVacation && <th>Ingreso</th>}
                {isVacation && <th>Vacaciones</th>}
                {!isVacation && <th>Asuetos trabajados en {year}</th>}
                {!isVacation && (
                  <th className="num" title="Compensatorios ganados menos los ya asignados (todos los años)">
                    Saldo
                  </th>
                )}
                <th className="num">{isVacation ? `Días en ${year}` : `Asignados en ${year}`}</th>
                <th>Fechas</th>
                {canEdit && <th className="row-actions" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const mine = byEmployee.get(e.id) ?? [];
                const v = vacationOf.get(e.id);
                const firstPending = v?.periods.find((p) => p.pending > 0) ?? null;
                const suggested = isVacation && v?.next_date;
                const c = compOf.get(e.id);
                return (
                  <tr key={e.id}>
                    <td>
                      <div className="pn-person">
                        <span className="pn-avatar" aria-hidden>
                          {initials(e.full_name)}
                        </span>
                        <span>
                          <b>{e.full_name}</b>
                          <span className="caption">
                            {e.code}
                            {e.position && ` · ${e.position}`}
                          </span>
                        </span>
                      </div>
                    </td>
                    {isVacation && (
                      <td className="nowrap">
                        {e.hire_date ? (
                          <>
                            <div className="mono">{fmtDate(e.hire_date)}</div>
                            <div className="caption">{seniority(e.hire_date)}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    {isVacation && <VacationCell v={v} onOpen={() => setPeriodsOf(e)} />}
                    {!isVacation && <EarnedCell c={c} inYear={inYear} />}
                    {!isVacation && (
                      <td className="num">
                        {c ? (
                          <span className={`lv-pill${c.balance > 0 ? " warn" : c.balance < 0 ? " bad" : " ok"}`} title={`${c.earned.length} ganados · ${c.taken} asignados`}>
                            {c.balance}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    <td className="num">{mine.length ? <b className="mono">{mine.length}</b> : <span className="muted">0</span>}</td>
                    <td>
                      {mine.length ? (
                        <div className="lv-ranges">
                          {ranges(mine).map((r) => (
                            <span
                              key={r.from}
                              className={`lv-range${r.from <= now && now <= r.to ? " now" : r.to < now ? " past" : ""}`}
                              title={r.days.map((d) => fmtDate(d.work_date) + (d.notes ? ` · ${d.notes}` : "")).join("\n")}
                            >
                              {rangeLabel(r)}
                              {r.days.length > 1 && <small>{r.days.length} d</small>}
                              {canEdit && (
                                <button className="lv-range-x" aria-label={`Quitar ${rangeLabel(r)}`} onClick={() => setRemoving({ employee: e, range: r })}>
                                  <IconX width={12} height={12} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="num row-actions">
                        <RowMenu
                          label={`Acciones de ${e.full_name}`}
                          actions={[
                            ...(isVacation && v?.periods.length ? [{ label: "Períodos: días descansados y trabajados", onClick: () => setPeriodsOf(e) }] : []),
                            ...(isVacation && v?.next_date
                              ? [{ label: "Asignar vacaciones: descansadas o trabajadas", onClick: () => setVacationFor({ employee: e, period: firstPending }) }]
                              : []),
                            { label: suggested ? "Asignar otras fechas" : `Asignar ${noun}`, onClick: () => setAssigning({ ids: [e.id] }) },
                            { label: "Ver ficha", onClick: () => navigate(`/empleados/${e.id}`) },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {employees.data && shown.length === 0 && <div className="empty">{filter === "todos" ? "No hay empleados que coincidan." : "Nadie en este filtro."}</div>}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={all}
          templates={templates.data ?? []}
          defaultFrom={assigning.from ?? today()}
          defaultTo={assigning.to ?? addDays(today(), 4)}
          initialSelected={assigning.ids}
          initialMode={kind}
          initialWeekdays={assigning.from ? [0, 1, 2, 3, 4, 5, 6] : undefined}
          initialNotes={assigning.notes}
          onClose={() => setAssigning(null)}
          onDone={done}
        />
      )}
      {periodsOf && vacationOf.get(periodsOf.id) && (
        <VacationPeriodsModal
          employee={periodsOf}
          v={vacationOf.get(periodsOf.id)!}
          canEdit={canEdit}
          onAssign={(p) => {
            setPeriodsOf(null);
            setVacationFor({ employee: periodsOf, period: p });
          }}
          onClose={() => setPeriodsOf(null)}
          onChanged={() => vacations.reload()}
        />
      )}
      {vacationFor && vacationOf.get(vacationFor.employee.id) && (
        <AssignVacationModal
          employee={vacationFor.employee}
          v={vacationOf.get(vacationFor.employee.id)!}
          initialPeriod={vacationFor.period}
          onClose={() => setVacationFor(null)}
          onDone={() => {
            setVacationFor(null);
            done();
          }}
        />
      )}
      {editingHolidays && <HolidaysModal year={year} canEdit={canEdit} onClose={() => setEditingHolidays(false)} onChanged={() => comp.reload()} />}
      {removing && (
        <RemoveRange employee={removing.employee} range={removing.range} noun={noun} onClose={() => setRemoving(null)} onDone={done} />
      )}
    </div>
  );
}

/** Asuetos del año que el empleado marcó (compensatorio ganado) y los que no (perdido). */
function EarnedCell({ c, inYear }: { c?: CompensatoryStatus; inYear: (h: Holiday) => boolean }) {
  const earned = c?.earned.filter(inYear) ?? [];
  const lost = c?.lost.filter(inYear) ?? [];
  if (!earned.length && !lost.length) return <td><span className="muted">—</span></td>;
  return (
    <td>
      <div className="lv-ranges">
        {earned.map((h) => (
          <span key={h.id} className="lv-range" title={`${h.name}: marcó, ganó un compensatorio`}>
            {short(h.day)}
          </span>
        ))}
      </div>
      {lost.length > 0 && (
        <div className="caption" title={lost.map((h) => `${fmtDate(h.day)} ${h.name}`).join("\n")}>
          {lost.length} perdido{lost.length === 1 ? "" : "s"} (no marcó)
        </div>
      )}
    </td>
  );
}

/** Asuetos del año: vienen cargados los nacionales; RRHH agrega los locales o quita alguno. */
export function HolidaysModal({ year, canEdit, onClose, onChanged }: { year: number; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const list = useAsync(() => api.get<Holiday[]>("/schedules/holidays", { year }), [year]);
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      list.reload();
      onChanged();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      await api.post("/schedules/holidays", { day, name });
      setDay("");
      setName("");
    });
  }

  return (
    <Modal
      title={`Asuetos ${year}`}
      subtitle="Quien marca en un asueto gana un día compensatorio; quien no marca, lo pierde. Si un asueto aún no tiene marcas importadas, no se cuenta como perdido."
      onClose={onClose}
    >
      {list.error && <div className="alert">{list.error}</div>}
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {list.data?.map((h) => (
              <tr key={h.id}>
                <td className="nowrap">{fmtDate(h.day)}</td>
                <td>{h.name}</td>
                {canEdit && (
                  <td className="num">
                    <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.delete(`/schedules/holidays/${h.id}`))}>
                      Quitar
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <form className="row" style={{ marginTop: 16, alignItems: "flex-end" }} onSubmit={add}>
          <label className="field">
            <span>Fecha</span>
            <input className="input" type="date" required min={`${year}-01-01`} max={`${year}-12-31`} value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            <span>Nombre</span>
            <input className="input" required maxLength={120} placeholder="p. ej. Fiestas patronales" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn" disabled={busy}>
            <IconPlus /> Agregar
          </button>
        </form>
      )}
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Listo
        </button>
      </div>
    </Modal>
  );
}

/** Estado de las vacaciones: días pendientes de todos sus períodos o, si está al día, cuánto
 *  falta para las próximas (barra del año en curso hasta el aniversario). */
function VacationCell({ v, onOpen }: { v?: VacationStatus; onOpen: () => void }) {
  if (!v?.next_date) return <td><span className="emp-warn-text" title="Agregue la fecha de ingreso en la ficha del empleado">Sin fecha de ingreso</span></td>;
  const owing = v.periods.filter((p) => p.pending > 0);
  if (v.pending > 0) {
    return (
      <td className="nowrap">
        <button type="button" className="lv-status warn" onClick={onOpen} title="Ver períodos: días descansados y trabajados">
          <b className="mono">{v.pending}</b> día{v.pending === 1 ? "" : "s"} pendiente{v.pending === 1 ? "" : "s"}
        </button>
        <div className="caption">{owing.length > 1 ? `De ${owing.length} períodos` : `Período ${periodLabel(owing[0])}`}</div>
      </td>
    );
  }
  const left = daysBetween(today(), v.next_date) - 1;
  const progress = Math.min(1, Math.max(0, 1 - left / 365));
  return (
    <td className="nowrap">
      {v.periods.length ? (
        <button type="button" className="lv-status ok" onClick={onOpen} title="Ver períodos: días descansados y trabajados">
          Al día
        </button>
      ) : (
        <span className="lv-status">Primer año</span>
      )}
      <div className="lv-next" title={`Próximas vacaciones: ${fmtDate(v.next_date)}`}>
        <span className="lv-next-bar" aria-hidden>
          <i style={{ transform: `scaleX(${progress})` }} />
        </span>
        <span className="caption">
          {fmtDate(v.next_date)} · {left <= 0 ? "hoy" : `en ${left} día${left === 1 ? "" : "s"}`}
        </span>
      </div>
    </td>
  );
}

/** Los períodos de vacaciones del empleado: qué días descansó, cuántos trabajó y cuántos le
 *  faltan. RRHH anota los días trabajados, cierra la historia vieja como completa o asigna los
 *  días descansados (también fechas pasadas) en el calendario. */
function VacationPeriodsModal({
  employee,
  v,
  canEdit,
  onAssign,
  onClose,
  onChanged,
}: {
  employee: Employee;
  v: VacationStatus;
  canEdit: boolean;
  onAssign: (p: VacationPeriod) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [worked, setWorked] = useState<Record<string, number>>(() => Object.fromEntries(v.periods.map((p) => [p.start, p.worked])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(p: VacationPeriod, body: { worked_days: number; settled: boolean }) {
    setBusy(p.start);
    setError(null);
    try {
      await api.put(`/schedules/vacations/${employee.id}/periods/${p.start}`, { ...body, notes: p.notes });
      onChanged();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title={`Vacaciones de ${employee.full_name}`}
      subtitle={`Ingreso ${fmtDate(v.hire_date!)} · 15 días por cada año cumplido. Los días descansados se aplican al período más antiguo con días pendientes (también puede asignar fechas pasadas).`}
      onClose={onClose}
      wide
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Período</th>
              <th>Descansó</th>
              <th>Trabajó</th>
              <th>Pendientes</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {[...v.periods].reverse().map((p) => {
              const max = Math.max(15 - p.rested.length, 0);
              const value = worked[p.start] ?? p.worked;
              const dirty = value !== p.worked;
              return (
                <tr key={p.start}>
                  <td className="nowrap">{periodLabel(p)}</td>
                  <td>
                    {p.rested.length ? (
                      <div title={p.rested.map(fmtDate).join("\n")}>
                        <b className="mono">{p.rested.length}</b>{" "}
                        <span className="caption">{datesLabel(p.rested)}</span>
                      </div>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {canEdit && !p.settled ? (
                      <input
                        className="input mono"
                        type="number"
                        min={0}
                        max={max}
                        style={{ width: 80 }}
                        value={value}
                        onChange={(e) => setWorked({ ...worked, [p.start]: Math.min(Math.max(Number(e.target.value) || 0, 0), max) })}
                      />
                    ) : (
                      <span className="mono">{p.worked}</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {p.settled || p.pending <= 0 ? (
                      <span className="lv-status ok">Completas</span>
                    ) : (
                      <span className="lv-status warn">
                        <b className="mono">{p.pending}</b> pendiente{p.pending === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="num">
                      <div className="chips" style={{ justifyContent: "flex-end" }}>
                        {dirty && (
                          <button className="btn sm" disabled={busy !== null} onClick={() => save(p, { worked_days: value, settled: false })}>
                            Guardar
                          </button>
                        )}
                        {!p.settled && p.pending > 0 && !dirty && (
                          <>
                            <button className="btn sm ghost" disabled={busy !== null} onClick={() => onAssign(p)}>
                              Asignar descanso
                            </button>
                            <button
                              className="btn sm ghost"
                              disabled={busy !== null}
                              title="Trabajó todos los días que le faltaban de este período"
                              onClick={() => save(p, { worked_days: p.worked + p.pending, settled: false })}
                            >
                              Las trabajó
                            </button>
                            <button
                              className="btn sm ghost"
                              disabled={busy !== null}
                              title="Ya se tomaron antes de usar el sistema: cerrar el período sin pendientes"
                              onClick={() => save(p, { worked_days: p.worked, settled: true })}
                            >
                              Ya las tomó
                            </button>
                          </>
                        )}
                        {p.settled && (
                          <button className="btn sm ghost" disabled={busy !== null} onClick={() => save(p, { worked_days: p.worked, settled: false })}>
                            Reabrir
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {v.extra.length > 0 && (
        <div className="alert info" style={{ marginTop: 16 }}>
          {v.extra.length} día{v.extra.length === 1 ? "" : "s"} descansado{v.extra.length === 1 ? "" : "s"} de más (adelantado{v.extra.length === 1 ? "" : "s"} al próximo período):{" "}
          {v.extra.map(fmtDate).join(", ")}.
        </div>
      )}
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <span className="caption" style={{ marginRight: "auto" }}>
          Total pendiente: <b>{v.pending}</b> día{v.pending === 1 ? "" : "s"}
        </span>
        <button className="btn" onClick={onClose}>
          Listo
        </button>
      </div>
    </Modal>
  );
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Asigna vacaciones de un período con fechas que RRHH puede cambiar (vienen sugeridas) y decide
 *  si el empleado las descansó (días de vacación en el calendario) o las trabajó (se suman a los
 *  días trabajados del período, con las fechas en la nota). */
function AssignVacationModal({
  employee,
  v,
  initialPeriod,
  onClose,
  onDone,
}: {
  employee: Employee;
  v: VacationStatus;
  initialPeriod: VacationPeriod | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const owing = v.periods.filter((p) => !p.settled && p.pending > 0);
  const [start, setStart] = useState(initialPeriod?.start ?? "");
  const period = owing.find((p) => p.start === start) ?? null;
  const suggested = vacationRange(employee.id, period, v.next_date!);
  const [from, setFrom] = useState(suggested.from!);
  const [to, setTo] = useState(suggested.to!);
  const [worked, setWorked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = from && to && to >= from ? daysBetween(from, to) : 0;
  const tooMany = worked && period !== null && count > period.pending;

  function pickPeriod(value: string) {
    setStart(value);
    const p = owing.find((x) => x.start === value) ?? null;
    const r = vacationRange(employee.id, p, v.next_date!);
    setFrom(r.from!);
    setTo(r.to!);
    if (!p) setWorked(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (worked && period) {
        const range = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
        const note = `Trabajó ${range} (${count} día${count === 1 ? "" : "s"})`;
        await api.put(`/schedules/vacations/${employee.id}/periods/${period.start}`, {
          worked_days: period.worked + count,
          settled: false,
          notes: (period.notes ? `${period.notes}; ${note}` : note).slice(0, 500),
        });
      } else {
        await api.post("/schedules/days-off/bulk", {
          employee_ids: [employee.id],
          date_from: from,
          date_to: to,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          kind: "vacacion",
          notes: period ? `Vacaciones ${periodLabel(period)}` : null,
        });
      }
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Vacaciones de ${employee.full_name}`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="field">
          <span>Período</span>
          <select className="input" value={start} onChange={(e) => pickPeriod(e.target.value)}>
            {owing.map((p) => (
              <option key={p.start} value={p.start}>
                {periodLabel(p)} · {p.pending} pendiente{p.pending === 1 ? "" : "s"}
              </option>
            ))}
            <option value="">Próximo período (desde {fmtDate(v.next_date!)})</option>
          </select>
        </label>
        <div className="seg" role="radiogroup" aria-label="Qué pasó con las vacaciones" style={{ alignSelf: "flex-start" }}>
          <button type="button" role="radio" aria-checked={!worked} className={worked ? undefined : "on"} onClick={() => setWorked(false)}>
            Las descansó
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={worked}
            className={worked ? "on" : undefined}
            disabled={!period}
            title={period ? undefined : "Solo se pueden trabajar días de un período que ya le tocó"}
            onClick={() => setWorked(true)}
          >
            Las trabajó
          </button>
        </div>
        <div className="caption">
          {worked
            ? "Los días se suman a los trabajados del período (se pagan en lugar de descansarse); el horario no cambia."
            : "Los días quedan como vacación en el calendario: se quita el turno que hubiera y quedan como descanso también en el CRM."}
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
        </div>
        <div className="caption">
          {count} día{count === 1 ? "" : "s"}
          {period && ` · el período tiene ${period.pending} pendiente${period.pending === 1 ? "" : "s"}`}
        </div>
        {tooMany && <div className="alert warn">No puede anotar más días trabajados que los pendientes del período ({period!.pending}).</div>}
        {error && <div className="alert">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !count || tooMany}>
            {worked ? "Anotar como trabajadas" : "Asignar descanso"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Quita un tramo de días: cada día vuelve a quedar sin turno (también en el CRM). */
export function RemoveRange({ employee, range, noun, onClose, onDone }: { employee: Employee; range: Range; noun: string; onClose: () => void; onDone: () => void }) {
  const [rest, ...others] = range.days;
  return (
    <ConfirmDelete
      title={`Quitar ${noun}`}
      path={`/schedules/days-off/${rest.id}`}
      onClose={onClose}
      onDone={async () => {
        for (const d of others) await api.delete(`/schedules/days-off/${d.id}`);
        onDone();
      }}
    >
      <p>
        Se quitarán {range.days.length === 1 ? "el día" : `los ${range.days.length} días`} de {noun} de <b>{employee.full_name}</b> ({rangeLabel(range)}).
      </p>
      <p className="caption">Esos días quedan sin turno; asígnele horario en Horarios si debe trabajar.</p>
    </ConfirmDelete>
  );
}
