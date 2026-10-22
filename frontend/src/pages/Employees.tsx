import { Fragment, useEffect, useState } from "react";
import { NavLink, useNavigate, useSearchParams } from "react-router-dom";

import { IconChevronDown, IconLink, IconPlus, IconSearch, IconX } from "../components/Icons";
import { RosterImport } from "../components/RosterImport";
import { ConfirmDelete, RowMenu } from "../components/RowMenu";
import { useCollapsedTeams } from "../components/TeamGroups";
import { api, AREAS, DOCS, groupByPosition, type Area, type Department, type Employee, type EmployeeInput, type Page, type ShiftTemplate, type UnmappedBadge } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtDate, fmtDateTime, fmtMoney, seniority, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EmployeeForm } from "./EmployeeForm";
import { AssignModal } from "./Schedules";

type Editing = { employee: Employee | null; initial?: Partial<EmployeeInput> } | null;

/** Una de las 3 secciones de Empleados (Administrativo, Operativo, Agentes de ventas). */
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
  const [deleting, setDeleting] = useState<Employee | null>(null);
  const showUnmapped = params.get("vincular") === "1";
  // Empleados va por cargo de la planilla (Horarios, en cambio, por team del CRM).
  const groups = useCollapsedTeams(`empleados.${area}.cargos-plegados`);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const COLS = canEdit ? 9 : 7;

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const list = useAsync(() => api.get<Page<Employee>>("/employees", { q: debounced, status, area, limit: 500 }), [debounced, status, area]);
  const departments = useAsync(() => api.get<Department[]>("/departments"), []);
  const unmapped = useAsync(() => api.get<UnmappedBadge[]>("/attendance/unmapped-badges"), []);
  const templates = useAsync(() => (canEdit ? api.get<ShiftTemplate[]>("/schedules/templates") : Promise.resolve([])), [canEdit]);
  const items = list.data?.items ?? [];
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allChecked = items.length > 0 && items.every((e) => selected.has(e.id));

  function saved() {
    setEditing(null);
    list.reload();
    unmapped.reload();
  }

  // Indicadores con lo que muestra la lista (sección, estado y búsqueda).
  const monthAgo = addDays(today(), -30);
  const recent = items.filter((e) => e.hire_date && e.hire_date >= monthAgo).length;
  const noBadge = items.filter((e) => !e.badge_number && !Object.keys(e.fingerprints).length).length;
  const docsDone = items.filter((e) => DOCS.every(([key]) => e[key])).length;
  const supervisors = items.filter((e) => e.is_supervisor).length;
  const statusLabel = status === "activo" ? "activos" : status === "inactivo" ? "inactivos" : "en total";

  return (
    <div className="page wide emp">
      <h1 className="sr-only">Empleados · {section.label}</h1>

      <div className="page-sticky">
      <section className="pn-bar" aria-label="Sección y filtros">
        <div className="pn-row">
          <nav className="seg" aria-label="Sección">
            {AREAS.map((a) => (
              <NavLink key={a.slug} to={`/empleados/${a.slug}`} className={({ isActive }) => `seg-link${isActive ? " on" : ""}`}>
                {a.label}
              </NavLink>
            ))}
          </nav>
          <span className="spacer" />
          {!!unmapped.data?.length && (
            <button className={`btn ghost${showUnmapped ? " on" : ""}`} onClick={() => setParams(showUnmapped ? {} : { vincular: "1" })} aria-pressed={showUnmapped}>
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
        <div className="pn-row pn-tools">
          <label className="pn-search">
            <span className="sr-only">Buscar</span>
            <IconSearch width={16} height={16} aria-hidden />
            <input className="input" placeholder="Buscar por nombre, ID de usuario, DUI o ID de reloj" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Estado">
            {(
              [
                ["activo", "Activos"],
                ["inactivo", "Inactivos"],
                ["", "Todos"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={status === value} className={status === value ? "on" : undefined} onClick={() => setStatus(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <dl className="home-kpis emp-kpis">
        <div className="home-kpi">
          <dt>Empleados {statusLabel}</dt>
          <dd className="home-kpi-value mono">{items.length}</dd>
          <dd className="home-kpi-note">
            {supervisors} {supervisors === 1 ? "supervisor" : "supervisores"} · {groupByPosition(items).length} cargos
          </dd>
        </div>
        <div className="home-kpi">
          <dt>Ingresaron en 30 días</dt>
          <dd className="home-kpi-value mono">{recent}</dd>
          <dd className="home-kpi-note">Desde el {fmtDate(monthAgo)}</dd>
        </div>
        <div className="home-kpi">
          <dt>Sin huella</dt>
          <dd className={`home-kpi-value mono${noBadge ? " emp-warn" : ""}`}>{noBadge}</dd>
          <dd className="home-kpi-note">{noBadge ? "Sus marcas no se pueden cuadrar" : "Todos tienen huella en algún reloj"}</dd>
        </div>
        <div className="home-kpi">
          <dt>Expediente completo</dt>
          <dd className="home-kpi-value mono">{items.length ? Math.round((docsDone / items.length) * 100) : 0}%</dd>
          <dd className="home-kpi-note">
            {docsDone} de {items.length} con {DOCS.map(([, label]) => label).join(", ")}
          </dd>
        </div>
      </dl>
      </div>

      {showUnmapped && !!unmapped.data?.length && (
        <div className="card emp-card">
          <div className="emp-card-head">
            <div className="emp-card-title">
              <h2 className="pn-h2">IDs del reloj sin empleado</h2>
              <span className="caption">Cree el empleado con ese ID o asígnelo a uno existente editándolo. Sus marcas se vinculan al instante.</span>
            </div>
            <button className="icon-btn" onClick={() => setParams({})} aria-label="Cerrar">
              <IconX width={16} height={16} />
            </button>
          </div>
          <div className="table-wrap">
            <table className="table pn-table emp-table">
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
                      <span className="pn-badge mono">{b.badge}</span>
                    </td>
                    <td className="num">{b.punches}</td>
                    <td className="caption">{fmtDateTime(b.first_seen)}</td>
                    <td className="caption">{fmtDateTime(b.last_seen)}</td>
                    <td className="num">
                      {canEdit && (
                        <button className="btn ghost sm" onClick={() => setEditing({ employee: null, initial: { area, badge_number: b.badge } })}>
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

      {list.error && <div className="alert">{list.error}</div>}

      <div className="card emp-card">
        <div className="emp-card-head">
          <div className="emp-card-title">
            <h2 className="pn-h2">{section.label}</h2>
            <span className="caption">
              {items.length} {items.length === 1 ? "persona" : "personas"} por cargo de la planilla · clic en una fila para ver la ficha
            </span>
          </div>
          {canEdit && selected.size > 0 && (
            <div className="emp-selbar" role="status">
              <span>
                <b>{selected.size}</b> {selected.size === 1 ? "seleccionada" : "seleccionadas"}
              </span>
              <button className="btn sm" onClick={() => setAssigning(true)} disabled={!templates.data}>
                Asignar horario
              </button>
              <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
                Quitar selección
              </button>
            </div>
          )}
        </div>
        <div className="table-wrap emp-scroll">
          <table className="table pn-table emp-table">
            <thead>
              <tr>
                {canEdit && (
                  <th className="emp-check">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todos para asignar horario"
                      checked={allChecked}
                      onChange={() => setSelected(allChecked ? new Set() : new Set(items.map((e) => e.id)))}
                    />
                  </th>
                )}
                <th>Empleado</th>
                <th>Ingreso</th>
                <th className="num">Sueldo</th>
                <th>DUI · ISSS / AFP</th>
                <th title="Número de huella en cada reloj">Huellas</th>
                <th>Expediente</th>
                <th>Estado</th>
                {canEdit && <th className="row-actions" />}
              </tr>
            </thead>
            <tbody>
              {groupByPosition(items).map((g) => {
                const open = groups.isOpen(g.key);
                return (
                  <Fragment key={g.key}>
                    <tr className="emp-group">
                      <td colSpan={COLS}>
                        <button type="button" className={`emp-group-head${open ? "" : " closed"}`} onClick={() => groups.toggle(g.key)} aria-expanded={open}>
                          <IconChevronDown width={16} height={16} className="emp-group-caret" />
                          <b>{g.position ?? "Sin cargo"}</b>
                          <span className="caption">
                            {g.items.length} {g.items.length === 1 ? "persona" : "personas"}
                          </span>
                        </button>
                      </td>
                    </tr>
                    {open &&
                      g.items.map((e) => {
                        const clocks = Object.entries(e.fingerprints);
                        return (
                          <tr
                            key={e.id}
                            className={`clickable${selected.has(e.id) ? " emp-selected" : ""}`}
                            tabIndex={0}
                            onClick={() => navigate(`/empleados/${e.id}`)}
                            onKeyDown={(ev) => ev.key === "Enter" && navigate(`/empleados/${e.id}`)}
                          >
                            {canEdit && (
                              <td className="emp-check" onClick={(ev) => ev.stopPropagation()}>
                                <input type="checkbox" aria-label={`Seleccionar a ${e.full_name}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                              </td>
                            )}
                            <td>
                              <div className="pn-person">
                                <span className="pn-avatar" aria-hidden>
                                  {initials(e.full_name)}
                                </span>
                                <span>
                                  <b>{e.full_name}</b>
                                  <span className="caption emp-sub">
                                    {e.user_code && <span className="mono">{e.user_code}</span>}
                                    {e.is_supervisor && <span className="sch-sup">Supervisor</span>}
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td>
                              {e.hire_date ? (
                                <>
                                  <div className="mono">{fmtDate(e.hire_date)}</div>
                                  <div className="caption nowrap">
                                    {seniority(e.hire_date)}
                                    {e.payroll_date && e.payroll_date !== e.hire_date && ` · planilla ${fmtDate(e.payroll_date)}`}
                                  </div>
                                </>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td className="num mono">{Number(e.base_salary) > 0 ? fmtMoney(e.base_salary) : <span className="muted">—</span>}</td>
                            <td>
                              <div className="mono nowrap">{e.dui ?? <span className="muted">Sin DUI</span>}</div>
                              <div className="caption nowrap">
                                {e.isss_number ? `ISSS ${e.isss_number}` : "Sin ISSS"} · {e.afp ?? "Sin AFP"}
                              </div>
                            </td>
                            <td>
                              {e.badge_number || clocks.length ? (
                                <div className="emp-clock">
                                  {e.badge_number && (
                                    <span className="emp-chip id" title="ID en el reloj de marcación">
                                      ID {e.badge_number}
                                    </span>
                                  )}
                                  {clocks.map(([clock, n]) => (
                                    <span key={clock} className="emp-chip" title={`Huella ${n} en el reloj ${clock}`}>
                                      {clock.replace(" comedor", " com.")} <b className="mono">{n}</b>
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="emp-warn-text">Sin huella</span>
                              )}
                            </td>
                            <td>
                              <DocsMeter employee={e} />
                            </td>
                            <td>
                              <span className={`emp-status ${e.status}`}>{e.status === "activo" ? "Activo" : "Inactivo"}</span>
                              {e.termination_note && <div className="caption emp-note">{e.termination_note}</div>}
                            </td>
                            {canEdit && (
                              <td className="num row-actions" onClick={(ev) => ev.stopPropagation()}>
                                <RowMenu
                                  label={`Acciones de ${e.full_name}`}
                                  actions={[
                                    { label: "Ver ficha", onClick: () => navigate(`/empleados/${e.id}`) },
                                    { label: "Editar", onClick: () => setEditing({ employee: e }) },
                                    { label: "Eliminar empleado", danger: true, onClick: () => setDeleting(e) },
                                  ]}
                                />
                              </td>
                            )}
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {list.data?.items.length === 0 && <div className="empty">No hay empleados que coincidan.</div>}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={items.filter((e) => e.status === "activo")}
          templates={templates.data ?? []}
          defaultFrom={weekStart(today())}
          defaultTo={addDays(weekStart(today()), 6)}
          initialSelected={[...selected]}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            setSelected(new Set());
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
            list.reload();
          }}
        >
          <p>
            Se eliminará la ficha de <b>{deleting.full_name}</b> junto con sus turnos y constancias emitidas. Esto no se
            puede deshacer.
          </p>
          <p className="caption">Sus marcas del reloj se conservan, pero quedan sin nombre. Si la persona solo dejó de trabajar, mejor edítela y márquela como inactiva.</p>
        </ConfirmDelete>
      )}
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

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** Expediente como barra de 4 tramos (CV, contrato, confidencialidad, memorándum); lo que falta va en el tooltip. */
function DocsMeter({ employee }: { employee: Employee }) {
  const done = DOCS.filter(([key]) => employee[key]).length;
  const missing = DOCS.filter(([key]) => !employee[key]).map(([, label]) => label);
  return (
    <span className={`emp-docs${done === DOCS.length ? " full" : ""}`} title={missing.length ? `Falta: ${missing.join(", ")}` : "Expediente completo"}>
      <span className="emp-docs-bar" aria-hidden>
        {DOCS.map(([key]) => (
          <i key={key} className={employee[key] ? "on" : undefined} />
        ))}
      </span>
      <span className="mono">
        {done}/{DOCS.length}
      </span>
    </span>
  );
}
