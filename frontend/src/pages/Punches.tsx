import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type ImportBatch, type Page, type Punch } from "../lib/api";
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

type View = "lista" | "dia";

/** Marcaciones en dos vistas: lista (una fila por marca: agente, día, hora y huella)
 *  y línea de tiempo (una fila por empleado y día, con cada marca como chip). */
export function Punches() {
  const [params] = useSearchParams();
  // Desde Importar llega ?desde=&hasta= con el periodo del archivo recién subido.
  const [from, setFrom] = useState(() => params.get("desde") ?? addDays(today(), -6));
  const [to, setTo] = useState(() => params.get("hasta") ?? today());
  const [search, setSearch] = useState("");
  const [showDoubles, setShowDoubles] = useState(true);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [view, setView] = useState<View>("lista");

  // Sin rango en la URL, se abre en el periodo del último archivo subido.
  useEffect(() => {
    if (params.get("desde")) return;
    api
      .get<Page<ImportBatch>>("/attendance/imports", { limit: 1 })
      .then((page) => {
        const last = page.items[0];
        if (last?.date_from && last.date_to) {
          setFrom(last.date_from);
          setTo(last.date_to);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const matches = (q: string, badge: string, name?: string | null, code?: string | null) =>
    !q || badge === q || !!name?.toLowerCase().includes(q) || !!code?.toLowerCase().includes(q);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? []).filter((p) => matches(q, p.badge, p.employee?.full_name, p.employee?.code));
  }, [data, search]);

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
      .filter((r) => matches(q, r.badge, r.name, r.code))
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
        <div className="chips">
          <button className={`btn sm${view === "lista" ? "" : " ghost"}`} onClick={() => setView("lista")}>
            Lista
          </button>
          <button className={`btn sm${view === "dia" ? "" : " ghost"}`} onClick={() => setView("dia")}>
            Por día
          </button>
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
      ) : view === "lista" ? (
        <div className="card">
          <div className="card-head">
            <h3>Registro de marcas</h3>
            <span className="caption">{list.length} marcas</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Día</th>
                  <th>Hora</th>
                  <th>Huella</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className={p.is_double_tap ? "muted" : undefined}>
                    <td>
                      {p.employee ? (
                        <>
                          <div>{p.employee.full_name}</div>
                          <div className="caption">{p.employee.code}</div>
                        </>
                      ) : (
                        <span className="badge warn">Sin empleado</span>
                      )}
                    </td>
                    <td className="nowrap">{fmtLongDate(localDate(p.punched_at))}</td>
                    <td className="nowrap">
                      <span className={`punch${p.is_double_tap ? " double" : ""}`} title={p.is_double_tap ? "Doble marca (ignorada)" : "Marca válida"}>
                        {fmtTimeSec(p.punched_at)}
                      </span>
                    </td>
                    <td>
                      <span className="badge accent" title="N° de huella (ID en el reloj)">
                        {p.badge}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
