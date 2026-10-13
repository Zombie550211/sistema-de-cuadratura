import { Fragment, useState, type FormEvent } from "react";

import { IconChevronDown, IconFile } from "../components/Icons";
import { api, type GoogleAdsReceipt, type GoogleAdsSummary } from "../lib/api";
import { fmtLongDate, today } from "../lib/format";
import { useAsync } from "../lib/useAsync";

/** Cuentas de la facturación del CRM, en su orden (CRM: routers/recibos_google.py). */
const CUENTAS: { key: string; label: string }[] = [
  { key: "alexis", label: "Alexis" },
  { key: "alexis2", label: "Alexis 2" },
  { key: "garay_lineas", label: "Garay Líneas" },
  { key: "tito", label: "Tito" },
  { key: "tito_lineas", label: "Tito Líneas" },
];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (cents: number) => usd.format(cents / 100);
const shortDate = (ymd: string) => ymd.split("-").reverse().join("/");

interface Filters {
  desde: string;
  hasta: string;
  cuenta: string;
  q: string;
}

/** Recibos de pago de Google Ads. Se registran en el CRM y llegan aquí solos; esta vista es de solo lectura. */
export function GoogleAdsReceipts() {
  const hoy = today();
  const [draft, setDraft] = useState<Filters>({ desde: `${hoy.slice(0, 8)}01`, hasta: hoy, cuenta: "", q: "" });
  const [filters, setFilters] = useState(draft);
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const summary = useAsync(() => api.get<GoogleAdsSummary>("/google-ads-receipts/summary"), []);
  const list = useAsync(
    () => api.get<GoogleAdsReceipt[]>("/google-ads-receipts", { desde: filters.desde, hasta: filters.hasta, cuenta: filters.cuenta, q: filters.q.trim() }),
    [filters],
  );

  const groups = new Map<string, GoogleAdsReceipt[]>();
  for (const r of list.data ?? []) {
    if (!groups.has(r.payment_date)) groups.set(r.payment_date, []);
    groups.get(r.payment_date)!.push(r);
  }
  const totalFiltered = (list.data ?? []).reduce((s, r) => s + r.amount_cents, 0);

  function submit(e: FormEvent) {
    e.preventDefault();
    setFilters({ ...draft });
  }

  function toggle(date: string) {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  const s = summary.data;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Recibos de Google Ads</h1>
          <p>Pagos de publicidad con su comprobante PDF. Se registran en el CRM (Facturación → Recibos Google Ads) y llegan aquí solos.</p>
        </div>
      </div>

      {summary.error && <div className="alert">{summary.error}</div>}
      <div className="stats gads-stats">
        <Stat label={s ? `Total pagado en ${MESES[Number(s.month.slice(5, 7)) - 1]}` : "Total pagado este mes"} value={s ? money(s.total_month_cents) : "—"} />
        <Stat label="Recibos registrados" value={s ? String(s.receipts) : "—"} />
        <Stat label="Último pago" value={s?.last_payment ? shortDate(s.last_payment) : "—"} />
      </div>

      <form className="card row" onSubmit={submit}>
        <label className="field">
          <span>Desde</span>
          <input className="input" type="date" value={draft.desde} onChange={(e) => setDraft({ ...draft, desde: e.target.value })} />
        </label>
        <label className="field">
          <span>Hasta</span>
          <input className="input" type="date" value={draft.hasta} onChange={(e) => setDraft({ ...draft, hasta: e.target.value })} />
        </label>
        <label className="field">
          <span>Cuenta</span>
          <select className="input" value={draft.cuenta} onChange={(e) => setDraft({ ...draft, cuenta: e.target.value })}>
            <option value="">Todas las cuentas</option>
            {CUENTAS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 180 }}>
          <span>Billing ID</span>
          <input className="input mono" maxLength={14} placeholder="0000-0000-0000" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
        </label>
        <button className="btn" type="submit" style={{ alignSelf: "flex-end" }}>
          Filtrar
        </button>
      </form>

      {list.error && <div className="alert">{list.error}</div>}
      <div className="card">
        <div className="card-head">
          <h3>Historial de recibos</h3>
          {!!list.data?.length && (
            <span className="badge accent">
              {list.data.length} {list.data.length === 1 ? "recibo" : "recibos"} · {money(totalFiltered)}
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table className="table gads-table">
            <thead>
              <tr>
                <th>Fecha de pago</th>
                <th>Cuenta</th>
                <th>Billing ID</th>
                <th className="num">Monto</th>
                <th>Archivo PDF</th>
                <th className="num">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {[...groups].map(([date, rows]) => {
                const open = !closed.has(date);
                return (
                  <Fragment key={date}>
                    <tr className="gads-group">
                      <td colSpan={3}>
                        <button type="button" className="gads-toggle" aria-expanded={open} onClick={() => toggle(date)}>
                          <IconChevronDown width={16} height={16} className={open ? "" : "gads-closed"} />
                          <b>{fmtLongDate(date)}</b>
                          <span className="muted">
                            · {rows.length} {rows.length === 1 ? "recibo" : "recibos"}
                          </span>
                        </button>
                      </td>
                      <td className="num mono">
                        <b>{money(rows.reduce((t, r) => t + r.amount_cents, 0))}</b>
                      </td>
                      <td colSpan={2} />
                    </tr>
                    {open &&
                      rows.map((r) => (
                        <tr key={r.id} title={[r.payment_method, `Subido por ${r.uploaded_by} en el CRM`].filter(Boolean).join(" · ")}>
                          <td className="mono gads-indent">{shortDate(r.payment_date)}</td>
                          <td>
                            <span className={`badge gads-${r.account_key}`}>{r.account_name}</span>
                          </td>
                          <td className="mono">{r.billing_id ?? "—"}</td>
                          <td className="num mono">{money(r.amount_cents)}</td>
                          <td>
                            <span className="gads-file" title={r.file_name}>
                              <IconFile width={16} height={16} />
                              <span>{r.file_name}</span>
                            </span>
                          </td>
                          <td className="num">
                            <div className="gads-actions">
                              <a className="btn ghost sm" href={`/api/google-ads-receipts/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">
                                Ver
                              </a>
                              <a className="btn ghost sm" href={`/api/google-ads-receipts/${r.id}/pdf?descargar=true`}>
                                Descargar
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {list.data?.length === 0 && <div className="empty">No hay recibos con estos filtros.</div>}
          {list.loading && !list.data && <div className="empty">Cargando…</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="bar" />
      <span className="label">{label}</span>
      <span className="value mono">{value}</span>
    </div>
  );
}
