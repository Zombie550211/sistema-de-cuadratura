import { useState } from "react";

import { api, AREAS } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Modal } from "./Modal";

interface RosterRow {
  line: number;
  code: string | null;
  first_name: string;
  last_name: string;
  position: string;
  hire_date: string | null;
  badge: string | null;
  area: string | null;
  status: "nuevo" | "actualizar" | "sin_cambios" | "ambiguo";
  note: string | null;
}
interface RosterResult {
  rows: RosterRow[];
  errors: { line: number; text: string; message: string }[];
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  applied: boolean;
}

const STATUS = {
  nuevo: ["Nuevo", "accent"],
  actualizar: ["Se actualiza", "warn"],
  sin_cambios: ["Sin cambios", ""],
  ambiguo: ["Revisar", "danger"],
} as const;

/** Pegar la nómina de RRHH desde Excel: código, nombre completo, cargo, fecha de ingreso; o el
 *  listado de personal con encabezados, que trae la huella (ID de reloj) en vez del código. */
export function RosterImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<RosterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<RosterResult>("/employees/import", { text, dry_run: dryRun });
      if (r.applied) onDone();
      else setPreview(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const changes = preview ? preview.created + preview.updated : 0;
  return (
    <Modal title="Importar nómina" onClose={onClose}>
      {error && <div className="alert" style={{ marginBottom: 16 }}>{error}</div>}
      {!preview ? (
        <div className="field">
          <span>Copie las columnas desde Excel y péguelas aquí: código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa). También puede pegar la planilla completa de RRHH con sus encabezados (N°, EMPLEADO, CARGO, SUELDO…): se guardan sueldo, DUI, NIT, ISSS, AFP, cuenta, huellas, expediente y finalización. La columna de contraseñas se ignora.</span>
          <textarea
            className="input mono"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"4 CN\tIRANIA CECILIA SERRANO MEJIA\tSUPERVISORA DE VENTAS\t07/04/2021"}
            autoFocus
          />
          <span className="caption">Si el empleado ya existe se actualizan nombre, cargo, fecha de ingreso y, del listado, la huella (ID de reloj, la columna HUELLA sin N/A). El ID de CRM y el team no se tocan.</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row">
            <span className="badge accent">{preview.created} nuevos</span>
            <span className="badge warn">{preview.updated} se actualizan</span>
            <span className="badge">{preview.unchanged} sin cambios</span>
            {preview.skipped > 0 && <span className="badge danger">{preview.skipped} por revisar (no se tocan)</span>}
            {preview.errors.length > 0 && <span className="badge danger">{preview.errors.length} con errores</span>}
          </div>
          {preview.errors.length > 0 && (
            <div className="alert">
              Corrija estas líneas y vuelva a revisar; mientras haya errores no se guarda nada.
              {preview.errors.map((e) => (
                <div key={e.line} className="caption" style={{ marginTop: 4 }}>
                  Línea {e.line}: {e.message} — <span className="mono">{e.text}</span>
                </div>
              ))}
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Huella</th>
                  <th>Nombres</th>
                  <th>Apellidos</th>
                  <th>Cargo</th>
                  <th>Ingreso</th>
                  <th>Área</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line}>
                    <td className="mono">{r.code ?? "—"}</td>
                    <td className="mono">{r.badge ?? "—"}</td>
                    <td>{r.first_name}</td>
                    <td>{r.last_name}</td>
                    <td>{r.position}</td>
                    <td className="mono">{r.hire_date ? fmtDate(r.hire_date) : "—"}</td>
                    <td>{AREAS.find((a) => a.area === r.area)?.label ?? "—"}</td>
                    <td>
                      <span className={`badge ${STATUS[r.status][1]}`} title={r.note ?? undefined}>
                        {STATUS[r.status][0]}
                      </span>
                      {r.note && <div className="caption" style={{ maxWidth: 240, marginTop: 4 }}>{r.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="caption">Revise que nombres y apellidos estén bien separados antes de importar.</span>
        </div>
      )}
      <div className="modal-foot">
        {preview ? (
          <button className="btn ghost" onClick={() => setPreview(null)}>
            Volver a editar
          </button>
        ) : (
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        )}
        {preview ? (
          <button className="btn" disabled={busy || preview.errors.length > 0 || changes === 0} onClick={() => send(false)}>
            {busy ? "Importando…" : `Importar ${changes} empleado${changes === 1 ? "" : "s"}`}
          </button>
        ) : (
          <button className="btn" disabled={busy || !text.trim()} onClick={() => send(true)}>
            {busy ? "Revisando…" : "Revisar"}
          </button>
        )}
      </div>
    </Modal>
  );
}
