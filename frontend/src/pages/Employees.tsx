import { Fragment, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { IconLink, IconPlus } from "../components/Icons";
import { RosterImport } from "../components/RosterImport";
import { SectionBanner, TeamHeader, useCollapsedTeams } from "../components/TeamGroups";
import { api, AREAS, DOCS, groupByTeam, type Area, type Department, type Employee, type EmployeeInput, type Page, type UnmappedBadge } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, fmtDateTime, fmtMoney, seniority } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EmployeeForm } from "./EmployeeForm";

const COLS = 10;

type Editing = { employee: Employee | null; initial?: Partial<EmployeeInput> } | null;

/** Una de las 4 secciones de Empleados (Administrativo, Operativo, Supervisores, Agentes de ventas). */
export function Employees({ area }: { area: Area }) {
  const section = AREAS.find((a) => a.area === area)!;
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("activo");
  const [editing, setEditing] = useState<Editing>(null);
  const [importing, setImporting] = useState(false);
  const showUnmapped = params.get("vincular") === "1";
  const teams = useCollapsedTeams(`empleados.${area}.teams-plegados`);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const list = useAsync(() => api.get<Page<Employee>>("/employees", { q: debounced, status, area, limit: 500 }), [debounced, status, area]);
  const departments = useAsync(() => api.get<Department[]>("/departments"), []);
  const unmapped = useAsync(() => api.get<UnmappedBadge[]>("/attendance/unmapped-badges"), []);

  function saved() {
    setEditing(null);
    list.reload();
    unmapped.reload();
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <span className="caption">Empleados</span>
          <h1>{section.label}</h1>
          <p>{list.data?.total ?? 0} registrados</p>
        </div>
        <div className="row">
          {!!unmapped.data?.length && (
            <button className="btn ghost" onClick={() => setParams(showUnmapped ? {} : { vincular: "1" })}>
              <IconLink /> {unmapped.data.length} IDs sin vincular
            </button>
          )}
          {canEdit && (
            <button className="btn ghost" onClick={() => setImporting(true)}>
              Importar nómina
            </button>
          )}
          {canEdit && (
            <button className="btn" onClick={() => setEditing({ employee: null, initial: { area } })}>
              <IconPlus /> Nuevo empleado
            </button>
          )}
        </div>
      </div>

      {showUnmapped && !!unmapped.data?.length && (
        <div className="card">
          <div className="card-head">
            <div>
              <h3>IDs del reloj sin empleado</h3>
              <span className="caption">Cree el empleado con ese ID o asígnelo a uno existente editándolo. Sus marcas se vinculan al instante.</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID reloj</th>
                  <th className="num">Marcas</th>
                  <th>Primera</th>
                  <th>Última</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unmapped.data.map((b) => (
                  <tr key={b.badge}>
                    <td>
                      <span className="badge warn">{b.badge}</span>
                    </td>
                    <td className="num">{b.punches}</td>
                    <td className="caption">{fmtDateTime(b.first_seen)}</td>
                    <td className="caption">{fmtDateTime(b.last_seen)}</td>
                    <td className="num">
                      {canEdit && (
                        <button className="btn sm" onClick={() => setEditing({ employee: null, initial: { area, badge_number: b.badge, code: `E-${b.badge.padStart(4, "0")}` } })}>
                          Crear empleado
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 16 }}>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Buscar por nombre, ID de usuario, código, DUI o ID de reloj" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="activo">Activos</option>
            <option value="inactivo">Inactivos</option>
            <option value="">Todos</option>
          </select>
        </div>
        {list.error && <div className="alert">{list.error}</div>}
        <div className="table-wrap">
          <table className="table dense">
            <thead>
              <tr>
                <th>Empleado</th>
                <th>Cargo</th>
                <th className="num">Sueldo</th>
                <th>Ingreso</th>
                <th>Planilla</th>
                <th>DUI</th>
                <th>ISSS / AFP</th>
                <th>Huellas</th>
                <th>Expediente</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {groupByTeam(list.data?.items ?? []).map((g) => (
                <Fragment key={g.key}>
                {g.newSection && g.team && (
                  <tr className="section-row">
                    <td colSpan={COLS}>
                      <SectionBanner group={g} />
                    </td>
                  </tr>
                )}
                <tr className="team-row">
                  <td colSpan={COLS}>
                    <TeamHeader group={g} open={teams.isOpen(g.key)} onToggle={() => teams.toggle(g.key)} />
                  </td>
                </tr>
                {teams.isOpen(g.key) && g.items.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`/empleados/${e.id}`)}>
                  <td>
                    <div className="nowrap">{e.full_name}</div>
                    <div className="caption">
                      {e.user_code && <b className="mono">{e.user_code} · </b>}
                      {e.code}
                      {g.supervisor?.id === e.id && <b> · Supervisor</b>}
                    </div>
                  </td>
                  <td className="nowrap">{e.position ?? <span className="muted">—</span>}</td>
                  <td className="num">{Number(e.base_salary) > 0 ? fmtMoney(e.base_salary) : <span className="muted">—</span>}</td>
                  <td>
                    {e.hire_date ? (
                      <>
                        <div className="mono">{fmtDate(e.hire_date)}</div>
                        <div className="caption">{seniority(e.hire_date)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono">{e.payroll_date ? fmtDate(e.payroll_date) : <span className="muted">—</span>}</td>
                  <td className="mono nowrap">{e.dui ?? <span className="muted">—</span>}</td>
                  <td>
                    <div className="mono">{e.isss_number ?? "—"}</div>
                    <div className="caption">{e.afp ?? "Sin AFP"}</div>
                  </td>
                  <td>
                    <div className="chips">
                      {e.badge_number && <span className="badge accent" title="ID en el reloj de marcación">{e.badge_number}</span>}
                      {Object.entries(e.fingerprints).map(([clock, n]) => (
                        <span key={clock} className="badge" title={`Huella en el reloj ${clock}`}>
                          {clock.replace(" comedor", " com.")} · {n}
                        </span>
                      ))}
                      {!e.badge_number && !Object.keys(e.fingerprints).length && <span className="muted">—</span>}
                    </div>
                  </td>
                  <td>
                    <DocsBadge employee={e} />
                  </td>
                  <td>
                    <span className={`badge${e.status === "activo" ? " accent" : " danger"}`}>{e.status}</span>
                    {e.termination_note && <div className="caption" style={{ maxWidth: 180 }}>{e.termination_note}</div>}
                  </td>
                </tr>
                ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {list.data?.items.length === 0 && <div className="empty">No hay empleados que coincidan.</div>}
        </div>
      </div>

      {importing && (
        <RosterImport
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            list.reload();
          }}
        />
      )}
      {editing && (
        <EmployeeForm
          employee={editing.employee}
          initial={editing.initial}
          departments={departments.data ?? []}
          readOnly={!canEdit}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onDepartmentCreated={(d) => departments.setData([...(departments.data ?? []), d])}
        />
      )}
    </div>
  );
}

/** Expediente en un solo indicador (3/4); el detalle de lo que falta va en el tooltip. */
function DocsBadge({ employee }: { employee: Employee }) {
  const done = DOCS.filter(([key]) => employee[key]);
  const missing = DOCS.filter(([key]) => !employee[key]).map(([, label]) => label);
  const tone = done.length === DOCS.length ? " accent" : done.length ? " warn" : "";
  return (
    <span className={`badge${tone}`} title={missing.length ? `Falta: ${missing.join(", ")}` : "Expediente completo"}>
      {done.length}/{DOCS.length}
    </span>
  );
}
