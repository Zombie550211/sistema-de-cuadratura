import { useState, type FormEvent } from "react";

import { IconPlus } from "../components/Icons";
import { Modal } from "../components/Modal";
import { api, type ApiClient, type Page, type Sync } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const STATUS_CLASS: Record<string, string> = { ok: "accent", parcial: "warn", error: "danger" };

export function Integrations() {
  const { can } = useAuth();
  const isAdmin = can("admin");
  const clients = useAsync(() => (isAdmin ? api.get<ApiClient[]>("/integrations/clients") : Promise.resolve([])), [isAdmin]);
  const syncs = useAsync(() => api.get<Page<Sync>>("/integrations/syncs", { limit: 30 }), []);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [detail, setDetail] = useState<Sync | null>(null);

  async function toggle(c: ApiClient) {
    if (c.is_active && !confirm(`¿Revocar la clave de “${c.name}”? El CRM dejará de poder enviar horarios.`)) return;
    await api.patch(`/integrations/clients/${c.id}`, { is_active: !c.is_active });
    clients.reload();
  }

  async function openDetail(s: Sync) {
    setDetail(await api.get<Sync>(`/integrations/syncs/${s.id}`));
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Integración CRM</h1>
          <p>Los horarios se sincronizan en los dos sentidos: lo que los supervisores cargan en el CRM llega aquí, y lo que RRHH cambia aquí (turnos, días libres, vacaciones, compensatorios) vuelve al CRM.</p>
        </div>
        {isAdmin && (
          <button className="btn" onClick={() => setCreating(true)}>
            <IconPlus /> Nueva clave API
          </button>
        )}
      </div>

      {newKey && (
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <div className="card-head">
            <h3>Clave para “{newKey.name}”</h3>
            <button className="icon-btn" onClick={() => setNewKey(null)}>
              Listo
            </button>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Cópiela ahora y entréguela al equipo del CRM por un canal seguro. <b>No se volverá a mostrar.</b>
          </p>
          <div className="row">
            <code className="input mono" style={{ flex: 1, display: "flex", alignItems: "center", overflowX: "auto", whiteSpace: "nowrap" }}>
              {newKey.key}
            </code>
            <button className="btn" onClick={() => navigator.clipboard.writeText(newKey.key)}>
              Copiar
            </button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card">
          <div className="card-head">
            <h3>Claves API</h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sistema</th>
                  <th>Clave</th>
                  <th>Último uso</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {clients.data?.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="mono muted">{c.key_prefix}…</td>
                    <td className="caption">{c.last_used_at ? fmtDateTime(c.last_used_at) : "Nunca"}</td>
                    <td>{c.is_active ? <span className="badge accent">Activa</span> : <span className="badge danger">Revocada</span>}</td>
                    <td className="num">
                      <button className={`btn sm ${c.is_active ? "danger" : "ghost"}`} onClick={() => toggle(c)}>
                        {c.is_active ? "Revocar" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {clients.data?.length === 0 && <div className="empty">Cree una clave para que el CRM pueda enviar los horarios.</div>}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Envíos recibidos</h3>
          <button className="btn ghost sm" onClick={syncs.reload}>
            Actualizar
          </button>
        </div>
        {syncs.error && <div className="alert">{syncs.error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Recibido</th>
                <th>Periodo</th>
                <th>Estado</th>
                <th className="num">Agentes</th>
                <th className="num">Nuevos</th>
                <th className="num">Turnos +/~/−</th>
                <th className="num">Conflictos</th>
                <th className="num">Errores</th>
              </tr>
            </thead>
            <tbody>
              {syncs.data?.items.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => openDetail(s)}>
                  <td>
                    <div>{fmtDateTime(s.received_at)}</div>
                    <div className="caption">{s.client?.name}</div>
                  </td>
                  <td className="mono">
                    {s.date_from} → {s.date_to}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[s.status] ?? ""}`}>{s.status}</span>
                  </td>
                  <td className="num">{s.agents_received}</td>
                  <td className="num">{s.employees_created}</td>
                  <td className="num mono">
                    {s.shifts_created}/{s.shifts_updated}/{s.shifts_removed}
                  </td>
                  <td className="num">{s.conflicts || "—"}</td>
                  <td className={`num${s.errors ? " danger-text" : ""}`}>{s.errors || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {syncs.data?.items.length === 0 && <div className="empty">El CRM todavía no ha enviado horarios.</div>}
        </div>
      </div>

      {creating && (
        <CreateClient
          onClose={() => setCreating(false)}
          onCreated={(name, key) => {
            setCreating(false);
            setNewKey({ name, key });
            clients.reload();
          }}
        />
      )}
      {detail && <SyncDetail sync={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CreateClient({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, key: string) => void }) {
  const [name, setName] = useState("CRM Connecting");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ client: ApiClient; api_key: string }>("/integrations/clients", { name });
      onCreated(r.client.name, r.api_key);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title="Nueva clave API" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error && <div className="alert">{error}</div>}
        <label className="field">
          <span>Nombre del sistema</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn">Generar clave</button>
        </div>
      </form>
    </Modal>
  );
}

function SyncDetail({ sync, onClose }: { sync: Sync; onClose: () => void }) {
  const agents = sync.details?.result?.agents ?? [];
  const issues = agents.filter((a) => a.status !== "ok");
  return (
    <Modal title={`Envío #${sync.id} · ${sync.date_from} → ${sync.date_to}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        {agents.length} agentes · {agents.length - issues.length} sin observaciones
      </p>
      {issues.length === 0 ? (
        <div className="alert info">Todos los horarios se aplicaron correctamente.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agente CRM</th>
                <th>Estado</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((a) => (
                <tr key={a.crm_agent_id}>
                  <td className="mono">{a.crm_agent_id}</td>
                  <td>
                    <span className={`badge ${a.status === "error" ? "danger" : "warn"}`}>{a.status}</span>
                  </td>
                  <td>
                    {a.message}
                    {a.conflict_dates.length > 0 && <div className="caption mono">{a.conflict_dates.join(", ")}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
