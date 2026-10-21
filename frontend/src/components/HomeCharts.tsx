import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { AREAS, DOCS, type Employee, type Lateness, type Punch } from "../lib/api";
import { addDays, fmtHms, fmtLongDate, localDate, TZ } from "../lib/format";

/* Gráficas de Inicio. Colores validados con el validador de la skill dataviz (azul / naranja /
 * aqua: categóricos 1-3, separación CVD ≥ 9). Los textos nunca van en el color de la serie. */

const weekday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/** Entrada de cada persona por día: su primera marca válida (las demás no cuentan). */
export interface Entry {
  date: string;
  key: string;
  minutes: number;
}

const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function entriesFrom(punches: Punch[]): Entry[] {
  const first = new Map<string, Entry>();
  for (const p of punches) {
    if (p.is_double_tap) continue;
    const date = localDate(p.punched_at);
    const who = p.employee ? `e${p.employee.id}` : `b${p.device_id}-${p.badge}`;
    const [h, m] = hm.format(new Date(p.punched_at)).split(":").map(Number);
    const minutes = h * 60 + m;
    const k = `${date}|${who}`;
    const prev = first.get(k);
    if (!prev || minutes < prev.minutes) first.set(k, { date, key: who, minutes });
  }
  return [...first.values()];
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;

interface DayStat {
  date: string;
  people: number;
  onTime: number;
  late: number;
  noShift: number;
  missing: number;
}

/** Personas que marcaron cada día del periodo. Si tienen turno, la columna se divide en a tiempo y
 *  tarde; el resto marcó sin turno asignado. Los turnos sin marca se cuentan aparte. */
export function AttendanceChart({ entries, lateness, range, loading }: { entries: Entry[]; lateness: Lateness[]; range: [string, string]; loading: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo<DayStat[]>(() => {
    const byDate = new Map<string, DayStat>();
    for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) byDate.set(d, { date: d, people: 0, onTime: 0, late: 0, noShift: 0, missing: 0 });
    for (const e of entries) {
      const s = byDate.get(e.date);
      if (s) s.people++;
    }
    for (const l of lateness) {
      const s = byDate.get(l.date);
      if (!s) continue;
      if (!l.check_in) s.missing++;
      else if (l.late_minutes > 0) s.late++;
      else s.onTime++;
    }
    for (const s of byDate.values()) s.noShift = Math.max(0, s.people - s.onTime - s.late);
    return [...byDate.values()];
  }, [entries, lateness, range]);
  const max = Math.max(1, ...days.map((d) => d.people));
  const worked = days.filter((d) => d.people);
  const totalPeople = worked.reduce((t, d) => t + d.people, 0);
  const avg = worked.length ? Math.round(totalPeople / worked.length) : 0;
  const avgEntry = entries.length ? entries.reduce((t, e) => t + e.minutes, 0) / entries.length : 0;
  const withShift = days.reduce((t, d) => t + d.onTime + d.late, 0);
  const late = days.reduce((t, d) => t + d.late, 0);
  const missing = days.reduce((t, d) => t + d.missing, 0);
  const shown = hover !== null ? days[hover] : null;
  const dense = days.length > 16;
  const busiest = worked.reduce<DayStat | null>((b, d) => (!b || d.people > b.people ? d : b), null);

  return (
    <div className="hc">
      <div className="hc-summary">
        <Figure value={String(avg)} label="Personas por día" note={busiest ? `Máximo ${busiest.people}, el ${fmtLongDate(busiest.date).toLowerCase()}` : "Sin marcas"} />
        <Figure value={entries.length ? clock(avgEntry) : "—"} label="Hora media de entrada" note={`${entries.length} entradas en ${worked.length} días`} />
        {withShift ? (
          <Figure value={`${pct(withShift - late, withShift)}%`} label="Puntualidad" note={`${late} tarde, ${missing} turnos sin marca`} />
        ) : (
          <Figure value="—" label="Puntualidad" note="Sin turnos asignados en este periodo" />
        )}
      </div>

      <div className="hc-legend" aria-hidden>
        {withShift > 0 && (
          <>
            <span><i className="hc-sw s1" /> A tiempo</span>
            <span><i className="hc-sw s2" /> Tarde</span>
          </>
        )}
        <span><i className={`hc-sw ${withShift ? "s3" : "s1"}`} /> {withShift ? "Sin turno asignado" : "Personas que marcaron"}</span>
      </div>

      {loading && !entries.length ? (
        <div className="hc-nodata">Cargando…</div>
      ) : !entries.length ? (
        <div className="hc-nodata">No hay marcas en este periodo. Suba el archivo del reloj para verlas aquí.</div>
      ) : (
        <div className="hc-plot" onMouseLeave={() => setHover(null)}>
          <div className="hc-gridlines" aria-hidden>
            <span data-v={max} />
            <span data-v={Math.round(max / 2)} />
            <span data-v={0} />
          </div>
          <div className="hc-cols" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d, i) => (
              <button
                key={d.date}
                type="button"
                className={`hc-col${hover === i ? " on" : ""}${weekday(d.date) % 6 === 0 ? " weekend" : ""}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${fmtLongDate(d.date)}: ${d.people} personas marcaron`}
              >
                <span className="hc-stack">
                  <span className="hc-track" style={{ height: `${(d.people / max) * 100}%` }}>
                    {d.noShift > 0 && <span className={`hc-seg ${withShift ? "s3" : "s1"}`} style={{ flexGrow: d.noShift }} />}
                    {d.late > 0 && <span className="hc-seg s2" style={{ flexGrow: d.late }} />}
                    {d.onTime > 0 && <span className="hc-seg s1" style={{ flexGrow: d.onTime }} />}
                  </span>
                </span>
                <span className="hc-x">{!dense || i % 2 === 0 ? Number(d.date.slice(8)) : ""}</span>
              </button>
            ))}
          </div>
          {shown && (
            <div className="hc-tip" style={{ left: `${((hover! + 0.5) / days.length) * 100}%` }} role="status">
              <b>{fmtLongDate(shown.date)}</b>
              <span>Marcaron <em>{shown.people}</em></span>
              {shown.onTime + shown.late + shown.missing > 0 && (
                <>
                  <span><i className="hc-sw s1" /> A tiempo <em>{shown.onTime}</em></span>
                  <span><i className="hc-sw s2" /> Tarde <em>{shown.late}</em></span>
                  <span>Turnos sin marca <em>{shown.missing}</em></span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {entries.length > 0 && (
        <details className="hc-table">
          <summary>Ver como tabla</summary>
          <div className="table-wrap">
            <table className="table dense">
              <thead>
                <tr>
                  <th>Día</th>
                  <th className="num">Marcaron</th>
                  <th className="num">A tiempo</th>
                  <th className="num">Tarde</th>
                  <th className="num">Turnos sin marca</th>
                </tr>
              </thead>
              <tbody>
                {worked.map((d) => (
                  <tr key={d.date}>
                    <td>{fmtLongDate(d.date)}</td>
                    <td className="num">{d.people}</td>
                    <td className="num">{d.onTime}</td>
                    <td className="num">{d.late}</td>
                    <td className="num">{d.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/** A qué hora entra la gente: entradas del periodo por franja de 30 minutos (un solo tono). */
export function EntryTimes({ entries }: { entries: Entry[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const buckets = useMemo(() => {
    if (!entries.length) return [];
    const mins = entries.map((e) => e.minutes).sort((a, b) => a - b);
    // Recorta el 2 % de los extremos para que una marca suelta de madrugada no aplaste la gráfica.
    const lo = Math.floor(mins[Math.floor(mins.length * 0.02)] / 30) * 30;
    const hi = Math.floor(mins[Math.ceil(mins.length * 0.98) - 1] / 30) * 30;
    const out: { from: number; n: number }[] = [];
    for (let m = lo; m <= hi; m += 30) out.push({ from: m, n: 0 });
    for (const m of mins) {
      const i = Math.min(out.length - 1, Math.max(0, Math.floor((m - lo) / 30)));
      out[i].n++;
    }
    return out;
  }, [entries]);
  if (!buckets.length) return <p className="muted">No hay entradas en este periodo.</p>;
  const max = Math.max(...buckets.map((b) => b.n));
  const peak = buckets.find((b) => b.n === max)!;
  const shown = hover !== null ? buckets[hover] : null;

  return (
    <div className="he">
      <p className="he-peak">
        <b className="mono">{clock(peak.from)}</b> es la franja con más entradas ({pct(peak.n, entries.length)}%).
      </p>
      <div className="he-plot" onMouseLeave={() => setHover(null)}>
        {buckets.map((b, i) => (
          <button
            key={b.from}
            type="button"
            className={`he-col${hover === i ? " on" : ""}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`De ${clock(b.from)} a ${clock(b.from + 30)}: ${b.n} entradas`}
          >
            <span className="he-bar" style={{ height: `${(b.n / max) * 100}%` }} />
          </button>
        ))}
        {shown && (
          <div className="hc-tip" style={{ left: `${((hover! + 0.5) / buckets.length) * 100}%` }} role="status">
            <b>
              {clock(shown.from)} – {clock(shown.from + 30)}
            </b>
            <span>Entradas <em>{shown.n}</em></span>
          </div>
        )}
      </div>
      <div className="he-axis" aria-hidden>
        <span>{clock(buckets[0].from)}</span>
        <span>{clock(buckets[Math.floor(buckets.length / 2)].from)}</span>
        <span>{clock(buckets[buckets.length - 1].from + 30)}</span>
      </div>
    </div>
  );
}

function Figure({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="hc-fig">
      <span>{label}</span>
      <b className="mono">{value}</b>
      <small>{note}</small>
    </div>
  );
}

/** Quién acumula más tiempo de llegada tarde en el periodo: barras horizontales de un solo tono. */
export function LateRanking({ rows, byId }: { rows: Lateness[]; byId: Map<number, Employee> }) {
  const top = useMemo(() => {
    const acc = new Map<number, { seconds: number; days: number }>();
    for (const l of rows) {
      if (!l.check_in || l.late_minutes <= 0) continue;
      const a = acc.get(l.employee_id) ?? { seconds: 0, days: 0 };
      a.seconds += l.late_seconds;
      a.days++;
      acc.set(l.employee_id, a);
    }
    return [...acc].sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 20);
  }, [rows]);
  const max = Math.max(1, ...top.map(([, a]) => a.seconds));

  if (!top.length) return <p className="muted">Nadie llegó tarde en este periodo.</p>;
  return (
    <ol className="hr-list qscroll">
      {top.map(([id, a]) => {
        const e = byId.get(id);
        return (
          <li key={id}>
            <Link to={`/empleados/${id}`} className="hr-row">
              <span className="hr-name">
                <span className="home-ellipsis">{e?.full_name ?? `Empleado ${id}`}</span>
                <small>{a.days} {a.days === 1 ? "día" : "días"}</small>
              </span>
              <span className="hr-bar" aria-hidden>
                <i style={{ transform: `scaleX(${a.seconds / max})` }} />
              </span>
              <b className="mono">{fmtHms(a.seconds)}</b>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/** Plantilla activa por área: una barra 100 % con las tres áreas y su cantidad, más los
 *  departamentos con más gente. */
export function Headcount({ employees }: { employees: Employee[] }) {
  const total = employees.length;
  const byArea = AREAS.map((a, i) => ({ ...a, n: employees.filter((e) => e.area === a.area).length, slot: i + 1 }));
  const depts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      const name = e.department?.name ?? "Sin departamento";
      m.set(name, (m.get(name) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [employees]);
  const maxDept = Math.max(1, ...depts.map(([, n]) => n));

  if (!total) return <p className="muted">No hay empleados activos.</p>;
  return (
    <div className="hh">
      <div className="hh-bar" role="img" aria-label={byArea.map((a) => `${a.label}: ${a.n}`).join(", ")}>
        {byArea.filter((a) => a.n).map((a) => (
          <span key={a.area} className={`hh-seg s${a.slot}`} style={{ flexGrow: a.n }} title={`${a.label}: ${a.n}`} />
        ))}
      </div>
      <ul className="hh-legend">
        {byArea.map((a) => (
          <li key={a.area}>
            <Link to={`/empleados/${a.slug}`}>
              <i className={`hc-sw s${a.slot}`} />
              <span className="home-grow">{a.label}</span>
              <b className="mono">{a.n}</b>
              <small className="mono">{pct(a.n, total)}%</small>
            </Link>
          </li>
        ))}
      </ul>
      <h3 className="hh-sub">Personal por departamento</h3>
      <ul className="hh-depts qscroll">
        {depts.map(([name, n]) => (
          <li key={name}>
            <span className="home-ellipsis">{name}</span>
            <span className="hr-bar thin" aria-hidden>
              <i style={{ transform: `scaleX(${n / maxDept})` }} />
            </span>
            <b className="mono">{n}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Expediente: qué parte de la plantilla tiene cada documento entregado. */
export function Paperwork({ employees }: { employees: Employee[] }) {
  const total = employees.length;
  const complete = employees.filter((e) => DOCS.every(([k]) => e[k])).length;
  if (!total) return <p className="muted">No hay empleados activos.</p>;
  return (
    <div className="hp">
      <div className="hp-head">
        <b className="mono">{pct(complete, total)}%</b>
        <span>
          de la plantilla tiene el expediente completo
          <small>{complete} de {total} empleados</small>
        </span>
      </div>
      <ul className="hp-list">
        {DOCS.map(([k, label]) => {
          const n = employees.filter((e) => e[k]).length;
          return (
            <li key={k}>
              <span>{label}</span>
              <span className="hr-bar" aria-hidden>
                <i style={{ transform: `scaleX(${total ? n / total : 0})` }} />
              </span>
              <b className="mono">{pct(n, total)}%</b>
              <small className="mono">faltan {total - n}</small>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

