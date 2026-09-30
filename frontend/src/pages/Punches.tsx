import { useMemo, useState } from "react";

import { api, type Page, type Punch } from "../lib/api";
import { addDays, fmtLongDate, fmtTimeSec, localDate, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";

interface DayRow {
  key: string;
  date: string;
  badge: string;
  name: string | null;
  code: string | null;
  punches: Punch[];
}

/** Vista de línea de tiempo: una fila por empleado y día, con cada marca como chip. */
export function Punches() {
  const [from, setFrom] = useState(() => addDays(today(), -6));
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");
  const [showDoubles, setShowDoubles] = useState(true);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  const { data, error, loading } = useAsync(
    () =>
      api.get<Page<Punch>>("/attendance/punches", {
        date_from: from,
        date_to: to,
        include_double_taps: showDoubles,
        only_unmapped: onlyUnmapped,
        limit: 2000,
      }),
    [from, to, showDoubles, onlyUnmapped],
  );

  const days = useMemo(() => {
    const rows = new Map<string, DayRow>();
    for (const p of data?.items ?? []) {
      const date = localDate(p.punched_at);
      const key = `${date}|${p.badge}`;
      if (!rows.has(key)) {
        rows.set(key, { key, date, badge: p.badge, name: p.employee?.full_name ?? null, code: p.employee?.code ?? null, punches: [] });
      }
      rows.get(key)!.punches.push(p);
    }
    const q = search.trim().toLowerCase();
    const list = [...rows.values()]
      .filter((r) => !q || r.badge === q || r.name?.toLowerCase().includes(q) || r.code?.toLowerCase().includes(q))
      .map((r) => ({ ...r, punches: [...r.punches].sort((a, b) => a.punched_at.localeCompare(b.punched_at)) }));
    list.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        Number(!a.name) - Number(!b.name) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.badge.localeCompare(b.badge, undefined, { numeric: true }),
    );

    const byDate = new Map<string, DayRow[]>();
    for (const r of list) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    return [...byDate.entries()];
  }, [data, search]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Marcaciones</h1>
          <p>Marcas crudas del reloj en hora de El Salvador. Las tachadas son dobles marcas y no cuentan.</p>
        </div>
      </div>

      <div className="card row">
        <label className="field">
          <span>Desde</span>
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>Hasta</span>
          <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <span>Buscar</span>
          <input className="input" placeholder="Nombre, código o ID de reloj" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignSelf: "flex-end" }}>
          <label className="check">
            <input type="checkbox" checked={showDoubles} onChange={(e) => setShowDoubles(e.target.checked)} /> Mostrar dobles marcas
          </label>
          <label className="check">
            <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} /> Solo IDs sin empleado
          </label>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {data && data.total > data.items.length && (
        <div className="alert info">Mostrando {data.items.length} de {data.total} marcas. Acorte el rango de fechas para ver todas.</div>
      )}

      {loading && !data ? (
        <div className="center-screen" style={{ minHeight: 200 }}>
          <div className="spinner" />
        </div>
      ) : days.length === 0 ? (
        <div className="card empty">No hay marcaciones en este rango.</div>
      ) : (
        days.map(([date, rows]) => (
          <div className="card" key={date}>
            <div className="card-head">
              <h3>{fmtLongDate(date)}</h3>
              <span className="caption">{rows.length} personas</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {rows.map((r) => {
                    const valid = r.punches.filter((p) => !p.is_double_tap).length;
                    return (
                      <tr key={r.key}>
                        <td style={{ width: 260 }}>
                          {r.name ? (
                            <>
                              <div>{r.name}</div>
                              <div className="caption">
                                {r.code} · ID reloj {r.badge}
                              </div>
                            </>
                          ) : (
                            <>
                              <span className="badge warn">ID {r.badge} sin empleado</span>
                            </>
                          )}
                        </td>
                        <td>
                          <div className="punch-list">
                            {r.punches.map((p, i) => (
                              <span
                                key={p.id}
                                className={`punch${p.is_double_tap ? " double" : ""}`}
                                style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                                title={p.is_double_tap ? "Doble marca (ignorada)" : "Marca válida"}
                              >
                                {fmtTimeSec(p.punched_at)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="num" style={{ width: 120 }}>
                          {valid === 1 ? <span className="badge danger">1 marca</span> : <span className="caption">{valid} marcas</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
