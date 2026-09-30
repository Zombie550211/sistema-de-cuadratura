import { useState } from "react";

import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Modal } from "./Modal";

interface RosterRow {
  line: number;
  code: string;
  first_name: string;
  last_name: string;
  position: string;
  hire_date: string;
  status: "nuevo" | "actualizar" | "sin_cambios";
}
interface RosterResult {
  rows: RosterRow[];
  errors: { line: number; text: string; message: string }[];
  created: number;
  updated: number;
  unchanged: number;
  applied: boolean;
}

const STATUS = { nuevo: ["Nuevo", "accent"], actualizar: ["Se actualiza", "warn"], sin_cambios: ["Sin cambios", ""] } as const;

/** Pegar la nómina de RRHH desde Excel: código, nombre completo, cargo, fecha de ingreso. */
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
          <span>Copie las columnas desde Excel y péguelas aquí: código · nombre completo · cargo · fecha de ingreso (dd/mm/aaaa)</span>
          <textarea
            className="input mono"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"4 CN\tIRANIA CECILIA SERRANO MEJIA\tSUPERVISORA DE VENTAS\t07/04/2021"}
            autoFocus
          />
          <span className="caption">Si el código ya existe se actualizan nombre, cargo y fecha de ingreso. El ID de reloj, el ID de CRM y el team no se tocan.</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row">
            <span className="badge accent">{preview.created} nuevos</span>
            <span className="badge warn">{preview.updated} se actualizan</span>
            <span className="badge">{preview.unchanged} sin cambios</span>
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
                  <th>Nombres</th>
                  <th>Apellidos</th>
                  <th>Cargo</th>
                  <th>Ingreso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.code}>
                    <td className="mono">{r.code}</td>
                    <td>{r.first_name}</td>
                    <td>{r.last_name}</td>
                    <td>{r.position}</td>
                    <td className="mono">{fmtDate(r.hire_date)}</td>
                    <td>
                      <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
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
