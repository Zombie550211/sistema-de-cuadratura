import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";

import { IconFile, IconUpload } from "../components/Icons";
import { api, ApiError, type ImportBatch, type Page } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useAsync } from "../lib/useAsync";

export function Import() {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSerial, setNeedsSerial] = useState<File | null>(null);
  const [serial, setSerial] = useState("");
  const history = useAsync(() => api.get<Page<ImportBatch>>("/attendance/imports", { limit: 20 }), []);

  async function upload(file: File, deviceSerial?: string) {
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    if (deviceSerial) form.append("device_serial", deviceSerial);
    try {
      setResult(await api.post<ImportBatch>("/attendance/imports", form));
      setNeedsSerial(null);
      history.reload();
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 422 && e.message.includes("número de serie")) setNeedsSerial(file);
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
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Importar reloj</h1>
          <p>Suba el archivo attlog (.dat) que descarga del reloj con la USB.</p>
        </div>
      </div>

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
        <span className="muted">o haga clic para buscarlo · ej. BINH221860214_attlog.dat</span>
        <input ref={input} type="file" accept=".dat,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      {error && <div className="alert">{error}</div>}

      {needsSerial && (
        <div className="card row">
          <label className="field" style={{ flex: 1 }}>
            <span>Número de serie del reloj (aparece en el nombre del archivo o en la etiqueta del equipo)</span>
            <input className="input" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="BINH221860214" />
          </label>
          <button className="btn" style={{ alignSelf: "flex-end" }} disabled={!serial.trim() || busy} onClick={() => upload(needsSerial, serial.trim())}>
            Importar
          </button>
        </div>
      )}

      {result && (
        <div className="card">
          <div className="card-head">
            <h3>Importación completada</h3>
            <span className="badge accent">
              {result.date_from} → {result.date_to}
            </span>
          </div>
          <div className="result-grid">
            <Cell label="Líneas leídas" value={result.total_lines} />
            <Cell label="Marcas nuevas" value={result.inserted} />
            <Cell label="Ya existían" value={result.already_present} />
            <Cell label="Dobles marcas" value={result.double_taps} />
            <Cell label="Líneas inválidas" value={result.invalid_lines} />
          </div>
          {result.unknown_badges > 0 && (
            <Link to="/empleados?vincular=1" className="alert warn" style={{ display: "block", marginTop: 16 }}>
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
                <th>Reloj</th>
                <th>Periodo</th>
                <th className="num">Nuevas</th>
                <th className="num">Dobles</th>
                <th>Subido</th>
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
                    <span className="badge">{b.device.serial_number}</span>
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
                </tr>
              ))}
            </tbody>
          </table>
          {history.data?.items.length === 0 && <div className="empty">Aún no hay importaciones.</div>}
        </div>
      </div>
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
