import { Link } from "react-router-dom";

import { IconLink, IconUpload } from "../components/Icons";
import { api, type DashboardSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtLongDate, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";

export function Dashboard() {
  const { user, can } = useAuth();
  const { data, error } = useAsync(() => api.get<DashboardSummary>("/dashboard/summary"), []);
  const firstName = user!.full_name.split(" ")[0];
  const last = data?.last_import;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Hola, {firstName}</h1>
          <p>{fmtLongDate(today())}</p>
        </div>
        {can("admin", "rrhh") && (
          <Link to="/importar" className="btn">
            <IconUpload /> Importar marcaciones
          </Link>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="stats">
        <Stat label="Empleados activos" value={data?.employees_active} />
        <Stat label="Marcas hoy" value={data?.punches_today} />
        <Stat label="Turnos asignados hoy" value={data?.shifts_today} />
        <Stat label="IDs de reloj sin vincular" value={data?.unmapped_badges} warn={!!data?.unmapped_badges} />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Última importación</h3>
            <Link to="/importar" className="caption">
              Ver historial
            </Link>
          </div>
          {last ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row">
                <span className="badge accent">{last.device.serial_number}</span>
                <span className="muted">{fmtDateTime(last.uploaded_at)}</span>
              </div>
              <div className="row">
                <span className="badge">{last.inserted} nuevas</span>
                <span className="badge">{last.double_taps} dobles marcas</span>
                <span className="badge">
                  {last.date_from} → {last.date_to}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted">Todavía no se ha importado ningún archivo del reloj.</p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Pendientes</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!!data?.unmapped_badges && (
              <Link to="/empleados/agentes?vincular=1" className="alert warn row" style={{ gap: 8 }}>
                <IconLink width={16} height={16} />
                Hay {data.unmapped_badges} IDs del reloj sin empleado. Vincúlelos para ver sus marcaciones por nombre.
              </Link>
            )}
            {!!data?.employees_without_badge && (
              <Link to="/empleados/agentes" className="alert info">
                {data.employees_without_badge} empleados activos no tienen ID de reloj asignado.
              </Link>
            )}
            {data && !data.unmapped_badges && !data.employees_without_badge && (
              <p className="muted">Todo en orden. No hay pendientes.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value?: number; warn?: boolean }) {
  return (
    <div className={`stat${warn ? " warn" : ""}`}>
      <div className="bar" />
      <span className="label">{label}</span>
      <span className="value mono">{value ?? "—"}</span>
    </div>
  );
}
