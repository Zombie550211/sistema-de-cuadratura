import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";

import { IconFile, IconUpload } from "../components/Icons";
import { ConfirmDelete, RowMenu } from "../components/RowMenu";
import { api, ApiError, localName, type ImportBatch, type Locales, type Page } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { useAsync } from "../lib/useAsync";

/** Subida del archivo del reloj e historial de archivos, dentro de Marcaciones. `onChanged` avisa
 *  que entraron o se borraron marcas; `onView` abre en Marcaciones las fechas y el local de un archivo. */
export function ImportPanel({ onChanged, onView }: { onChanged: (batch?: ImportBatch) => void; onView: (batch: ImportBatch) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLocal, setNeedsLocal] = useState<File | null>(null);
  const [local, setLocal] = useState("");
  const [deleting, setDeleting] = useState<ImportBatch | null>(null);
  const history = useAsync(() => api.get<Page<ImportBatch>>("/attendance/imports", { limit: 20 }), []);
  const locales = useAsync(() => api.get<Locales>("/attendance/locales"), []);

  async function upload(file: File, localName?: string) {
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    if (localName) form.append("local", localName);
    try {
      const batch = await api.post<ImportBatch>("/attendance/imports", form);
      setResult(batch);
      setNeedsLocal(null);
      history.reload();
      locales.reload();
      onChanged(batch);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 422 && e.message.includes("local")) setNeedsLocal(file);
      setError(e.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file && !busy) upload(file);
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="caption" style={{ marginTop: -12 }}>
        Suba el archivo attlog (.dat) que descarga del reloj con la USB, o las marcaciones en Excel (.xlsx o .xls). El local se reconoce por el nombre del archivo (p. ej. «LA-18») o por las huellas.
      </p>

      <div
        className={`dropzone${over ? " over" : ""}${busy ? " busy" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <div className="icon">
          <IconUpload />
        </div>
        <h3>{busy ? "Procesando marcaciones…" : "Arrastre aquí el archivo del reloj"}</h3>
        <span className="muted">o haga clic para buscarlo · ej. BINH221860214_attlog.dat o marcaciones.xlsx</span>
        <input ref={input} type="file" accept=".dat,.txt,.xlsx,.xls" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      {error && <div className="alert">{error}</div>}

      {needsLocal && (
        <div className="card row">
          <label className="field" style={{ flex: 1 }}>
            <span>¿De qué local es este archivo? No se pudo reconocer por el nombre ni por las huellas.</span>
            <input className="input" list="locales-conocidos" value={local} onChange={(e) => setLocal(e.target.value)} placeholder="LA17" />
            <datalist id="locales-conocidos">
              {locales.data?.known.map((k) => <option key={k} value={k} />)}
            </datalist>
          </label>
          <button className="btn" style={{ alignSelf: "flex-end" }} disabled={!local.trim() || busy} onClick={() => upload(needsLocal, local.trim())}>
            Importar
          </button>
        </div>
      )}

      {result && (
        <div className="card">
          <div className="card-head">
            <h3>Importación completada · Local {localName(result.device)}</h3>
            <span className="badge accent">
              {result.date_from && fmtDate(result.date_from)} → {result.date_to && fmtDate(result.date_to)}
            </span>
          </div>
          <div className="result-grid">
            <Cell label="Líneas leídas" value={result.total_lines} />
            <Cell label="Marcas nuevas" value={result.inserted} />
            <Cell label="Ya existían" value={result.already_present} />
            <Cell label="Dobles marcas" value={result.double_taps} />
            <Cell label="Líneas inválidas" value={result.invalid_lines} />
          </div>
          {result.date_from && result.date_to && (
            <button className="btn" style={{ marginTop: 16 }} onClick={() => onView(result)}>
              Ver marcaciones de este archivo
            </button>
          )}
          {result.unknown_badges > 0 && (
            <Link to="/empleados/agentes?vincular=1" className="alert warn" style={{ display: "block", marginTop: 16 }}>
              {result.unknown_badges} IDs del reloj no están vinculados a ningún empleado. Clic aquí para vincularlos.
            </Link>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Historial</h3>
          <span className="caption">{history.data?.total ?? 0} archivos</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Local</th>
                <th>Periodo</th>
                <th className="num">Nuevas</th>
                <th className="num">Dobles</th>
                <th>Subido</th>
                <th className="row-actions" />
              </tr>
            </thead>
            <tbody>
              {history.data?.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <IconFile width={16} height={16} className="muted" />
                      {b.original_filename}
                    </span>
                  </td>
                  <td>
                    <span className="badge" title={`Reloj ${b.device.serial_number}`}>
                      {localName(b.device)}
                    </span>
                  </td>
                  <td className="mono">
                    {b.date_from} → {b.date_to}
                  </td>
                  <td className="num">{b.inserted}</td>
                  <td className="num">{b.double_taps}</td>
                  <td>
                    <div>{fmtDateTime(b.uploaded_at)}</div>
                    <div className="caption">{b.uploaded_by?.full_name}</div>
                  </td>
                  <td className="num row-actions">
                    <RowMenu
                      actions={[
                        { label: "Ver marcaciones", onClick: () => onView(b) },
                        { label: "Eliminar importación", danger: true, onClick: () => setDeleting(b) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.data?.items.length === 0 && <div className="empty">Aún no hay importaciones.</div>}
        </div>
      </div>

      {deleting && (
        <ConfirmDelete
          title="Eliminar importación"
          path={`/attendance/imports/${deleting.id}`}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            setResult(null);
            history.reload();
            locales.reload();
            onChanged();
          }}
        >
          <p>
            Se borrará <b>{deleting.original_filename}</b> (local {localName(deleting.device)}) y las {deleting.inserted} marcas que entraron con
            este archivo.
          </p>
          <p className="caption">Las marcas que ya existían por un archivo anterior se conservan. Después puede volver a subir el archivo.</p>
        </ConfirmDelete>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="cell">
      <b className="mono">{value}</b>
      <span className="caption">{label}</span>
    </div>
  );
}
