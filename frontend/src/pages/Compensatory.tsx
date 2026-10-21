import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { IconCalendar, IconCheck, IconChevronLeft, IconChevronRight, IconPlus, IconSearch, IconX } from "../components/Icons";
import { RowMenu } from "../components/RowMenu";
import { api, AREAS, type Area, type CompensatoryStatus, type Employee, type Holiday, type Page, type ShiftDayOff, type ShiftTemplate } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { CompensatoryModal } from "./EmployeeProfile";
import { HolidaysModal, ranges, RemoveRange, type Range } from "./Leave";
import { AssignModal } from "./Schedules";

type Filter = "todos" | "saldo" | "negativo";

/** Los compensatorios se llevan desde el asueto del 15 de septiembre de 2026 (igual en el servidor). */
const START = "2026-09-15";

const shortFmt = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", day: "numeric", month: "short" });
const short = (ymd: string) => shortFmt.format(new Date(`${ymd}T00:00:00Z`)).replace(".", "");
const rangeLabel = (r: Range) => (r.from === r.to ? short(r.from) : `${short(r.from)} – ${short(r.to)}`);
const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** Compensatorios de una sección, vistos desde los asuetos: cada asueto trabajado gana un día
 *  compensatorio y cada día asignado lo gasta. Arriba los asuetos del año (quién trabajó cada
 *  uno), abajo la matriz persona × asueto con el saldo y las fechas asignadas. */
export function Compensatory({ area }: { area: Area }) {
  const section = AREAS.find((a) => a.area === area)!.label;
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const navigate = useNavigate();
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [holidayId, setHolidayId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState<number[] | null>(null);
  const [giving, setGiving] = useState<Employee | null>(null);
  const [removing, setRemoving] = useState<{ employee: Employee; range: Range } | null>(null);
  const [editingHolidays, setEditingHolidays] = useState(false);
  const strip = useRef<HTMLDivElement>(null);

  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", area, limit: 500 }), [area]);
  const templates = useAsync(() => (canEdit ? api.get<ShiftTemplate[]>("/schedules/templates") : Promise.resolve([])), [canEdit]);
  const holidays = useAsync(() => api.get<Holiday[]>("/schedules/holidays", { year }), [year]);
  const comp = useAsync(() => api.get<CompensatoryStatus[]>("/schedules/compensatory", { area }), [area]);
  const days = useAsync(
    () => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: `${year}-01-01`, date_to: `${year}-12-31`, kind: "compensatorio" }),
    [year],
  );

  const all = employees.data?.items ?? [];
  const now = today();
  const compOf = useMemo(() => new Map((comp.data ?? []).map((c) => [c.employee_id, c])), [comp.data]);
  const byEmployee = useMemo(() => {
    const map = new Map<number, ShiftDayOff[]>();
    for (const d of days.data ?? []) map.set(d.employee_id, [...(map.get(d.employee_id) ?? []), d]);
    return map;
  }, [days.data]);
  const yearHolidays = holidays.data ?? [];
  // Por asueto: quién lo trabajó (ganó) y quién no marcó (perdió).
  const holidayStats = useMemo(() => {
    const map = new Map<number, { earned: number; lost: number }>();
    for (const h of yearHolidays) map.set(h.id, { earned: 0, lost: 0 });
    for (const e of all) {
      const c = compOf.get(e.id);
      c?.earned.forEach((h) => map.get(h.id) && map.get(h.id)!.earned++);
      c?.lost.forEach((h) => map.get(h.id) && map.get(h.id)!.lost++);
    }
    return map;
  }, [yearHolidays, all, compOf]);
  const statusOn = (id: number, h: Holiday): "earned" | "lost" | null => {
    const c = compOf.get(id);
    if (c?.earned.some((x) => x.id === h.id)) return "earned";
    if (c?.lost.some((x) => x.id === h.id)) return "lost";
    return null;
  };

  const search = q.trim().toLowerCase();
  const picked = yearHolidays.find((h) => h.id === holidayId) ?? null;
  const shown = all
    .filter((e) => {
      const balance = compOf.get(e.id)?.balance ?? 0;
      if (filter === "saldo" && balance <= 0) return false;
      if (filter === "negativo" && balance >= 0) return false;
      if (picked && !statusOn(e.id, picked)) return false;
      return !search || e.full_name.toLowerCase().includes(search) || e.code.toLowerCase().includes(search);
    })
    // Con un asueto elegido, primero quienes lo trabajaron.
    .sort((a, b) => (picked ? Number(statusOn(b.id, picked) === "earned") - Number(statusOn(a.id, picked) === "earned") : 0));

  const withBalance = all.filter((e) => (compOf.get(e.id)?.balance ?? 0) > 0);
  const balanceDays = withBalance.reduce((s, e) => s + compOf.get(e.id)!.balance, 0);
  const negative = all.filter((e) => (compOf.get(e.id)?.balance ?? 0) < 0).length;
  const earnedYear = [...holidayStats.values()].reduce((s, x) => s + x.earned, 0);
  const lostYear = [...holidayStats.values()].reduce((s, x) => s + x.lost, 0);
  const ids = new Set(all.map((e) => e.id));
  const takenYear = (days.data ?? []).filter((d) => ids.has(d.employee_id)).length;
  const offToday = (days.data ?? []).filter((d) => ids.has(d.employee_id) && d.work_date === now).length;
  const nextHoliday = yearHolidays.find((h) => h.day >= now);

  // La franja de asuetos avanza sola (unos 30 px por segundo); se detiene con el mouse encima o
  // con el foco dentro, y al llegar al final espera un momento y vuelve al inicio.
  useEffect(() => {
    const el = strip.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let paused = false;
    let wait = 0;
    let last = performance.now();
    let pos = el.scrollLeft;
    let frame = 0;
    const pause = () => (paused = true);
    const resume = () => {
      paused = false;
      pos = el.scrollLeft;
    };
    const step = (t: number) => {
      const dt = Math.min(t - last, 100);
      last = t;
      const end = el.scrollWidth - el.clientWidth;
      if (!paused && end > 0) {
        if (wait > 0) {
          wait -= dt;
          if (wait <= 0 && pos >= end) {
            pos = 0;
            el.scrollTo({ left: 0, behavior: "smooth" });
            wait = 1500;
          }
        } else {
          pos = Math.min(end, pos + dt * 0.03);
          el.scrollLeft = pos;
          if (pos >= end) wait = 2000;
        }
      }
      frame = requestAnimationFrame(step);
    };
    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", resume);
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", resume);
    el.addEventListener("touchstart", pause, { passive: true });
    el.addEventListener("touchend", resume);
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("mouseenter", pause);
      el.removeEventListener("mouseleave", resume);
      el.removeEventListener("focusin", pause);
      el.removeEventListener("focusout", resume);
      el.removeEventListener("touchstart", pause);
      el.removeEventListener("touchend", resume);
    };
  }, [yearHolidays.length]);

  function done() {
    setAssigning(null);
    setGiving(null);
    setRemoving(null);
    days.reload();
    comp.reload();
  }

  return (
    <div className="page wide cp">
      <h1 className="sr-only">Días compensatorio · {section}</h1>

      <section className="pn-bar" aria-label="Sección y filtros">
        <div className="pn-row">
          <nav className="seg" aria-label="Sección">
            {AREAS.map((a) => (
              <NavLink key={a.slug} to={`/compensatorios/${a.slug}`} className={({ isActive }) => `seg-link${isActive ? " on" : ""}`}>
                {a.label}
              </NavLink>
            ))}
          </nav>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setEditingHolidays(true)}>
            <IconCalendar /> Asuetos {year}
          </button>
          {canEdit && (
            <button className="btn" onClick={() => setAssigning([])} disabled={!all.length || !templates.data}>
              <IconPlus /> Asignar compensatorio
            </button>
          )}
        </div>
        <div className="pn-row pn-tools">
          <div className="pn-period">
            <button
              className="icon-btn"
              onClick={() => {
                setYear(year - 1);
                setHolidayId(null);
              }}
              aria-label="Año anterior"
            >
              <IconChevronLeft width={18} height={18} />
            </button>
            <b className="lv-year">{year}</b>
            <button
              className="icon-btn"
              onClick={() => {
                setYear(year + 1);
                setHolidayId(null);
              }}
              aria-label="Año siguiente"
            >
              <IconChevronRight width={18} height={18} />
            </button>
          </div>
          <label className="pn-search">
            <span className="sr-only">Buscar</span>
            <IconSearch width={16} height={16} aria-hidden />
            <input className="input" placeholder="Buscar por nombre o código" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Mostrar">
            {(
              [
                ["todos", "Todos"],
                ["saldo", "Con saldo a favor"],
                ["negativo", "Saldo negativo"],
              ] as const
            ).map(([value, text]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} className={filter === value ? "on" : undefined} onClick={() => setFilter(value)}>
                {text}
              </button>
            ))}
          </div>
        </div>
      </section>

      <dl className="home-kpis lv-kpis">
        <div className="home-kpi">
          <dt>Compensatorios por dar</dt>
          <dd className={`home-kpi-value mono${balanceDays ? " emp-warn" : ""}`}>{balanceDays}</dd>
          <dd className="home-kpi-note">
            {withBalance.length} {withBalance.length === 1 ? "persona" : "personas"} con saldo a favor{negative ? ` · ${negative} en negativo` : ""}
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Ganados en {year}</dt>
          <dd className="home-kpi-value mono">{earnedYear}</dd>
          <dd className="home-kpi-note">
            {lostYear} perdido{lostYear === 1 ? "" : "s"} por no marcar en el asueto
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Asignados en {year}</dt>
          <dd className="home-kpi-value mono">{takenYear}</dd>
          <dd className="home-kpi-note">{offToday ? `${offToday} con compensatorio hoy` : "Nadie con compensatorio hoy"}</dd>
        </div>
        <div className="home-kpi">
          <dt>Próximo asueto</dt>
          <dd className="home-kpi-value text">{nextHoliday ? short(nextHoliday.day) : "—"}</dd>
          <dd className="home-kpi-note">{nextHoliday ? nextHoliday.name : `No quedan asuetos en ${year}`}</dd>
        </div>
      </dl>

      {(employees.error || comp.error || days.error || holidays.error) && <div className="alert">{employees.error ?? comp.error ?? days.error ?? holidays.error}</div>}

      {/* Los asuetos del año: cuántos lo trabajaron y cuántos no; clic para ver solo a esas personas. */}
      <section className="card emp-card" aria-label={`Asuetos de ${year}`}>
        <div className="emp-card-head">
          <div className="emp-card-title">
            <h2 className="pn-h2">Asuetos de {year}</h2>
            <span className="caption">Quien marca en un asueto gana un compensatorio. Clic en un asueto para ver quién lo trabajó.</span>
          </div>
          {picked && (
            <button className="btn ghost sm" onClick={() => setHolidayId(null)}>
              <IconX width={14} height={14} /> Quitar filtro: {short(picked.day)}
            </button>
          )}
        </div>
        <div className="cp-holidays" ref={strip}>
          {yearHolidays.map((h) => {
            const st = holidayStats.get(h.id)!;
            const total = st.earned + st.lost;
            const future = h.day > now;
            const before = h.day < START;
            return (
              <button
                key={h.id}
                type="button"
                className={`cp-holiday${holidayId === h.id ? " on" : ""}${future ? " future" : ""}${before ? " before" : ""}`}
                aria-pressed={holidayId === h.id}
                disabled={!total}
                onClick={() => setHolidayId(holidayId === h.id ? null : h.id)}
                title={h.name}
              >
                <span className="cp-holiday-date">
                  <b>{Number(h.day.slice(8))}</b> {short(h.day).split(" ")[1]}
                </span>
                <span className="cp-holiday-name">{h.name}</span>
                {total ? (
                  <>
                    <span className="cp-holiday-bar" aria-hidden>
                      <i style={{ width: `${(st.earned / total) * 100}%` }} />
                    </span>
                    <span className="cp-holiday-meta">
                      <b>{st.earned}</b> trabajaron · {st.lost} no
                    </span>
                  </>
                ) : (
                  <span className="cp-holiday-meta">{before ? "Antes del inicio (15/09/2026)" : future ? "Próximo" : "Sin marcas importadas"}</span>
                )}
              </button>
            );
          })}
          {holidays.data && !yearHolidays.length && <span className="caption">No hay asuetos cargados para {year}.</span>}
        </div>
      </section>

      <div className="card emp-card">
        <div className="emp-card-head">
          <div className="emp-card-title">
            <h2 className="pn-h2">{picked ? `${picked.name} · ${fmtDate(picked.day)}` : `Saldo por persona · ${section}`}</h2>
            <span className="caption">
              {shown.length} {shown.length === 1 ? "persona" : "personas"}
              {shown.length !== all.length && ` de ${all.length}`} · el saldo cuenta todos los años
            </span>
          </div>
          <div className="cp-legend" aria-hidden>
            <span>
              <i className="cp-cell earned">
                <IconCheck width={10} height={10} />
              </i>{" "}
              Trabajó (ganó)
            </span>
            <span>
              <i className="cp-cell lost" /> No marcó (perdió)
            </span>
            <span>
              <i className="cp-cell" /> Sin dato
            </span>
          </div>
        </div>
        <div className="table-wrap emp-scroll">
          <table className="table pn-table emp-table cp-table">
            <thead>
              <tr>
                <th>Empleado</th>
                {yearHolidays.map((h) => (
                  <th key={h.id} className={`cp-hcol${holidayId === h.id ? " on" : ""}`} title={`${fmtDate(h.day)} · ${h.name}`}>
                    {short(h.day)}
                  </th>
                ))}
                <th title="Compensatorios ganados menos los asignados (todos los años)">Saldo</th>
                <th>Asignados en {year}</th>
                {canEdit && <th className="row-actions" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const c = compOf.get(e.id);
                const mine = byEmployee.get(e.id) ?? [];
                const earned = c?.earned.length ?? 0;
                const taken = c?.taken ?? 0;
                const balance = c?.balance ?? 0;
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
                    {yearHolidays.map((h) => {
                      const st = statusOn(e.id, h);
                      return (
                        <td key={h.id} className={`cp-hcol${holidayId === h.id ? " on" : ""}`}>
                          <i
                            className={`cp-cell${st ? ` ${st}` : ""}`}
                            title={`${h.name}: ${st === "earned" ? "marcó, ganó un compensatorio" : st === "lost" ? "no marcó, lo perdió" : "sin dato"}`}
                          >
                            {st === "earned" && <IconCheck width={10} height={10} />}
                          </i>
                        </td>
                      );
                    })}
                    <td>
                      <div className="cp-balance" title={`${earned} ganados · ${taken} asignados`}>
                        <span className={`lv-pill${balance > 0 ? " warn" : balance < 0 ? " bad" : " ok"}`}>{balance > 0 ? `+${balance}` : balance}</span>
                        <span className="caption nowrap">
                          {earned} ganado{earned === 1 ? "" : "s"} · {taken} usado{taken === 1 ? "" : "s"}
                        </span>
                      </div>
                    </td>
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
                            ...(c?.available.length ? [{ label: "Dar un compensatorio ganado (elegir asueto y día)", onClick: () => setGiving(e) }] : []),
                            { label: "Asignar compensatorio en fechas", onClick: () => setAssigning([e.id]) },
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
          {employees.data && shown.length === 0 && (
            <div className="empty">{picked ? "Nadie tiene marcas en ese asueto con este filtro." : "No hay empleados que coincidan."}</div>
          )}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={all}
          templates={templates.data ?? []}
          defaultFrom={now}
          defaultTo={now}
          initialSelected={assigning}
          initialMode="compensatorio"
          initialWeekdays={[0, 1, 2, 3, 4, 5, 6]}
          onClose={() => setAssigning(null)}
          onDone={done}
        />
      )}
      {giving && <CompensatoryModal employee={giving} initialMonth={now.slice(0, 7)} onClose={() => setGiving(null)} onDone={done} />}
      {editingHolidays && (
        <HolidaysModal
          year={year}
          canEdit={canEdit}
          onClose={() => setEditingHolidays(false)}
          onChanged={() => {
            holidays.reload();
            comp.reload();
          }}
        />
      )}
      {removing && <RemoveRange employee={removing.employee} range={removing.range} noun="día compensatorio" onClose={() => setRemoving(null)} onDone={done} />}
    </div>
  );
}

