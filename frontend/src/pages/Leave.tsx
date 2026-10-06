import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { IconChevronLeft, IconChevronRight, IconPlus, IconX } from "../components/Icons";
import { ConfirmDelete, RowMenu } from "../components/RowMenu";
import { api, AREAS, DAY_OFF_LABEL, type Area, type Employee, type Page, type ShiftDayOff, type ShiftTemplate } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtDate, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { AssignModal } from "./Schedules";

type Kind = "vacacion" | "compensatorio";

/** Un tramo de días seguidos (p. ej. una semana de vacación), para mostrarlo como "5–9 ene". */
interface Range {
  from: string;
  to: string;
  days: ShiftDayOff[];
}

const shortFmt = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", day: "numeric", month: "short" });
const short = (ymd: string) => shortFmt.format(new Date(`${ymd}T00:00:00Z`)).replace(".", "");

function ranges(days: ShiftDayOff[]): Range[] {
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

const rangeLabel = (r: Range) => (r.from === r.to ? short(r.from) : `${short(r.from)} – ${short(r.to)}`);

/** Días de vacación o compensatorios de una sección: todos sus empleados, con los días que
 *  tienen en el año. Se asignan con el mismo modal de Horarios y se quitan desde aquí. */
export function Leave({ kind, area }: { kind: Kind; area: Area }) {
  const section = AREAS.find((a) => a.area === area)!.label;
  const label = kind === "vacacion" ? "Días de vacación" : "Días compensatorio";
  const noun = DAY_OFF_LABEL[kind].toLowerCase();
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const navigate = useNavigate();
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const [q, setQ] = useState("");
  const [assigning, setAssigning] = useState<number[] | null>(null);
  const [removing, setRemoving] = useState<{ employee: Employee; range: Range } | null>(null);

  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", area, limit: 500 }), [area]);
  const templates = useAsync(() => (canEdit ? api.get<ShiftTemplate[]>("/schedules/templates") : Promise.resolve([])), [canEdit]);
  const days = useAsync(
    () => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: `${year}-01-01`, date_to: `${year}-12-31`, kind }),
    [year, kind],
  );

  const byEmployee = useMemo(() => {
    const map = new Map<number, ShiftDayOff[]>();
    for (const d of days.data ?? []) map.set(d.employee_id, [...(map.get(d.employee_id) ?? []), d]);
    return map;
  }, [days.data]);

  const all = employees.data?.items ?? [];
  const search = q.trim().toLowerCase();
  const shown = all.filter((e) => !search || e.full_name.toLowerCase().includes(search) || e.code.toLowerCase().includes(search));
  const total = all.reduce((n, e) => n + (byEmployee.get(e.id)?.length ?? 0), 0);
  const withDays = all.filter((e) => byEmployee.has(e.id)).length;

  function done() {
    setAssigning(null);
    setRemoving(null);
    days.reload();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="caption">{label}</span>
          <h1>{section}</h1>
          <p>
            {total} día{total === 1 ? "" : "s"} de {noun} en {year} · {withDays} de {all.length} empleados con días. Esos días se quita el turno y el CRM no lo
            vuelve a poner.
          </p>
        </div>
        {canEdit && (
          <button className="btn" onClick={() => setAssigning([])} disabled={!all.length || !templates.data}>
            <IconPlus /> Asignar {noun}
          </button>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="icon-btn" onClick={() => setYear(year - 1)} aria-label="Año anterior">
              <IconChevronLeft width={20} height={20} />
            </button>
            <span className="sch-week" style={{ minWidth: 80 }}>
              {year}
            </span>
            <button className="icon-btn" onClick={() => setYear(year + 1)} aria-label="Año siguiente">
              <IconChevronRight width={20} height={20} />
            </button>
          </div>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Buscar por nombre o código" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {(employees.error || days.error) && <div className="alert">{employees.error ?? days.error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Empleado</th>
                <th className="num">Días en {year}</th>
                <th>Fechas</th>
                {canEdit && <th className="row-actions" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const mine = byEmployee.get(e.id) ?? [];
                return (
                  <tr key={e.id}>
                    <td>
                      <div className="nowrap">{e.full_name}</div>
                      <div className="caption">
                        {e.code}
                        {e.position && ` · ${e.position}`}
                      </div>
                    </td>
                    <td className="num">{mine.length ? <b className="mono">{mine.length}</b> : <span className="muted">0</span>}</td>
                    <td>
                      {mine.length ? (
                        <div className="chips" style={{ flexWrap: "wrap" }}>
                          {ranges(mine).map((r) => (
                            <span key={r.from} className="badge accent" title={r.days.map((d) => fmtDate(d.work_date) + (d.notes ? ` · ${d.notes}` : "")).join("\n")}>
                              {rangeLabel(r)}
                              {r.days.length > 1 && ` (${r.days.length})`}
                              {canEdit && (
                                <button className="chip-x" aria-label={`Quitar ${rangeLabel(r)}`} onClick={() => setRemoving({ employee: e, range: r })}>
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
                            { label: `Asignar ${noun}`, onClick: () => setAssigning([e.id]) },
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
          {employees.data && shown.length === 0 && <div className="empty">No hay empleados que coincidan.</div>}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={all}
          templates={templates.data ?? []}
          defaultFrom={today()}
          defaultTo={addDays(today(), 4)}
          initialSelected={assigning}
          initialMode={kind}
          onClose={() => setAssigning(null)}
          onDone={done}
        />
      )}
      {removing && (
        <RemoveRange employee={removing.employee} range={removing.range} noun={noun} onClose={() => setRemoving(null)} onDone={done} />
      )}
    </div>
  );
}

/** Quita un tramo de días: cada día vuelve a quedar sin turno (el CRM lo puede volver a llenar). */
function RemoveRange({ employee, range, noun, onClose, onDone }: { employee: Employee; range: Range; noun: string; onClose: () => void; onDone: () => void }) {
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
