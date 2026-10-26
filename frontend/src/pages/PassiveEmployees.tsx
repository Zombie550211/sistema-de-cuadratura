import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { IconSearch } from "../components/Icons";
import { api, AREAS, type Area, type Employee, type Page } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** Empleados pasivos: los que se dieron de baja (inactivos) y ya no trabajan con nosotros. Al darlos
 *  de baja se les quita el ID de marcación; aquí quedan solo con el código que genera el sistema. */
export function PassiveEmployees() {
  const navigate = useNavigate();
  const [area, setArea] = useState<Area | "todas">("todas");
  const [q, setQ] = useState("");

  const list = useAsync(() => api.get<Page<Employee>>("/employees", { status: "inactivo", limit: 500 }), []);
  const all = list.data?.items ?? [];

  const search = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      all
        .filter((e) => (area === "todas" || e.area === area) && (!search || e.full_name.toLowerCase().includes(search)))
        .sort((a, b) => (b.termination_date ?? "").localeCompare(a.termination_date ?? "") || a.full_name.localeCompare(b.full_name, "es")),
    [all, area, search],
  );

  return (
    <div className="page wide">
      <h1 className="sr-only">Empleados pasivos</h1>

      <div className="page-sticky">
        <section className="pn-bar" aria-label="Sección y filtros">
          <div className="pn-row">
            <nav className="seg" aria-label="Sección">
              {[{ area: "todas" as const, label: "Todas" }, ...AREAS].map((a) => (
                <button key={a.area} type="button" aria-pressed={area === a.area} className={area === a.area ? "on" : undefined} onClick={() => setArea(a.area)}>
                  {a.label}
                  <span className="seg-count">{all.filter((e) => a.area === "todas" || e.area === a.area).length}</span>
                </button>
              ))}
            </nav>
            <span className="spacer" />
            <label className="pn-search">
              <span className="sr-only">Buscar</span>
              <IconSearch width={16} height={16} aria-hidden />
              <input className="input" placeholder="Buscar por nombre" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
        </section>

        <dl className="home-kpis">
          <div className="home-kpi">
            <dt>Empleados pasivos</dt>
            <dd className="home-kpi-value mono">{all.length}</dd>
            <dd className="home-kpi-note">Dados de baja · sin ID de marcación, solo con el código del sistema</dd>
          </div>
        </dl>
      </div>

      {list.error && <div className="alert">{list.error}</div>}

      <div className="card emp-card">
        <div className="emp-card-head">
          <div className="emp-card-title">
            <h2 className="pn-h2">Dados de baja</h2>
            <span className="caption">
              {shown.length} {shown.length === 1 ? "persona" : "personas"}
              {shown.length !== all.length && ` de ${all.length}`} · ya no trabajan con nosotros
            </span>
          </div>
        </div>
        <div className="table-wrap emp-scroll">
          <table className="table pn-table emp-table">
            <thead>
              <tr>
                <th>Empleado</th>
                <th>Código del sistema</th>
                <th>Área / puesto</th>
                <th>Fecha de baja</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className="clickable" tabIndex={0} onClick={() => navigate(`/empleados/${e.id}`)} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), navigate(`/empleados/${e.id}`))}>
                  <td>
                    <div className="pn-person">
                      <span className="pn-avatar none" aria-hidden>{initials(e.full_name)}</span>
                      <span>
                        <b>{e.full_name}</b>
                        {(e.badge_number || Object.keys(e.fingerprints).length > 0) && (
                          <span className="caption">Aún con ID de reloj {e.badge_number ?? ""} — vuelva a guardarlo como inactivo para liberarlo</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="pn-badge mono" title="Código que genera el sistema">{e.code}</span>
                  </td>
                  <td className="nowrap">
                    {AREAS.find((a) => a.area === e.area)?.label ?? e.area}
                    {e.position && <span className="caption"> · {e.position}</span>}
                  </td>
                  <td className="nowrap">{e.termination_date ? fmtDate(e.termination_date) : <span className="muted">—</span>}</td>
                  <td>{e.termination_note || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && shown.length === 0 && (
            <div className="empty">{all.length ? "Nadie coincide con el filtro." : "No hay empleados dados de baja."}</div>
          )}
        </div>
      </div>
    </div>
  );
}
