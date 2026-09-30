import { Fragment, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { IconLink, IconPlus } from "../components/Icons";
import { api, groupByTeam, SECTION_LABEL, type Department, type Employee, type EmployeeInput, type Page, type UnmappedBadge } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EmployeeForm } from "./EmployeeForm";

type Editing = { employee: Employee | null; initial?: Partial<EmployeeInput> } | null;

export function Employees() {
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("activo");
  const [editing, setEditing] = useState<Editing>(null);
  const showUnmapped = params.get("vincular") === "1";

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const list = useAsync(() => api.get<Page<Employee>>("/employees", { q: debounced, status, limit: 500 }), [debounced, status]);
  const departments = useAsync(() => api.get<Department[]>("/departments"), []);
  const unmapped = useAsync(() => api.get<UnmappedBadge[]>("/attendance/unmapped-badges"), []);

  function saved() {
    setEditing(null);
    list.reload();
    unmapped.reload();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Empleados</h1>
          <p>{list.data?.total ?? 0} registrados</p>
        </div>
        <div className="row">
          {!!unmapped.data?.length && (
            <button className="btn ghost" onClick={() => setParams(showUnmapped ? {} : { vincular: "1" })}>
              <IconLink /> {unmapped.data.length} IDs sin vincular
            </button>
          )}
          {canEdit && (
            <button className="btn" onClick={() => setEditing({ employee: null })}>
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
                        <button className="btn sm" onClick={() => setEditing({ employee: null, initial: { badge_number: b.badge, code: `E-${b.badge.padStart(4, "0")}` } })}>
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
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Buscar por nombre, código, DUI o ID de reloj" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="activo">Activos</option>
            <option value="inactivo">Inactivos</option>
            <option value="">Todos</option>
          </select>
        </div>
        {list.error && <div className="alert">{list.error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Empleado</th>
                <th>ID reloj</th>
                <th>ID CRM</th>
                <th>Cargo</th>
                <th>Equipo</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {groupByTeam(list.data?.items ?? []).map((g) => (
                <Fragment key={g.key}>
                <tr className="team-row">
                  <td colSpan={6}>
                    <b>{g.team?.name ?? "Sin equipo"}</b>
                    {g.team && <span className="caption"> {SECTION_LABEL[g.team.section]}</span>}
                    <span className="caption"> · {g.items.length}</span>
                  </td>
                </tr>
                {g.items.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`/empleados/${e.id}`)}>
                  <td>
                    <div>{e.full_name}</div>
                    <div className="caption">{e.code}</div>
                  </td>
                  <td>{e.badge_number ? <span className="badge accent">{e.badge_number}</span> : <span className="badge">Sin ID</span>}</td>
                  <td>{e.crm_agent_id ? <span className="badge accent">{e.crm_agent_id}</span> : <span className="muted">—</span>}</td>
                  <td>{e.position ?? <span className="muted">—</span>}</td>
                  <td>{e.department?.name ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge${e.status === "activo" ? " accent" : ""}`}>{e.status}</span>
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
