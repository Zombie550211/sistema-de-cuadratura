import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { IconChevronLeft, IconChevronRight } from "../components/Icons";
import { Modal } from "../components/Modal";
import { RowMenu, type RowAction } from "../components/RowMenu";
import {
  api,
  ApiError,
  AREAS,
  LATE_ALLOWANCE,
  localName,
  type Area,
  type Employee,
  type ImportBatch,
  type Lateness,
  type Locales,
  type Page,
  type Punch,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtLongDate, fmtMinutes, fmtTime, fmtTimeSec, fmtWeek, localDate, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";

interface DayRow {
  key: string;
  date: string;
  badge: string;
  deviceId: number;
  employeeId: number | null;
  name: string | null;
  code: string | null;
  punches: Punch[];
  /** Regla de RRHH: solo cuenta la primera marca válida del día (la entrada). */
  checkIn: Punch | null;
  /** Marcas válidas después de la entrada: el agente salió y volvió, no cuentan. */
  ignored: number;
}

type View = "lista" | "dia";
type Dialog = { kind: "edit" | "delete" | "link"; row: DayRow } | null;

function entry(punches: Punch[]) {
  const valid = punches.filter((p) => !p.is_double_tap);
  return { checkIn: valid[0] ?? null, ignored: Math.max(valid.length - 1, 0) };
}

function punchRole(r: DayRow, p: Punch): { cls: string; title: string } {
  const edited = p.original_punched_at ? ` · corregida (el reloj marcó ${fmtTimeSec(p.original_punched_at)})` : "";
  const cls = p.original_punched_at ? " edited" : "";
  if (p.is_double_tap) return { cls: " double" + cls, title: "Doble marca (ignorada)" + edited };
  if (p.id === r.checkIn?.id) return { cls: " in" + cls, title: "Entrada" + edited };
  return { cls: " middle" + cls, title: "No cuenta: solo vale la primera marca del día" + edited };
}

/** Marcaciones de una sección (como Empleados; `area` null = IDs del reloj sin empleado), con una
 *  pestaña por local y dos vistas: lista (una fila por persona y día con su hora de entrada y
 *  huella) y por día (cada marca como chip, con la entrada resaltada). */
export function Punches({ area }: { area: Area | null }) {
  const section = area ? AREAS.find((a) => a.area === area)!.label : "Sin empleado";
  const sectionQuery = area ? { area } : { only_unmapped: true };
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  // Se ve una semana (lunes a domingo) a la vez: la del último archivo subido; las anteriores
  // quedan ocultas y se recorren con las flechas. Desde Importar llega ?hasta=&local= del archivo.
  const [week, setWeek] = useState(() => weekStart(params.get("hasta") ?? params.get("desde") ?? today()));
  const [latestWeek, setLatestWeek] = useState<string | null>(null);
  const from = week;
  const to = addDays(week, 6);
  const [search, setSearch] = useState("");
  const [showDoubles, setShowDoubles] = useState(true);
  const [view, setView] = useState<View>("lista");
  const [dialog, setDialog] = useState<Dialog>(null);

  const locales = useAsync(() => api.get<Locales>("/attendance/locales", sectionQuery), [area]);
  const tabs = (locales.data?.devices ?? []).filter((d) => d.punches > 0);
  const [lastDevice, setLastDevice] = useState<number | null>(null);
  const wanted = Number(params.get("local")) || lastDevice;
  const deviceId = tabs.find((d) => d.id === wanted)?.id ?? tabs[0]?.id ?? null;

  // Sin fecha en la URL, se abre en la semana y el local del último archivo subido.
  useEffect(() => {
    api
      .get<Page<ImportBatch>>("/attendance/imports", { limit: 1 })
      .then((page) => {
        const last = page.items[0];
        if (!last?.date_to) return;
        setLatestWeek(weekStart(last.date_to));
        if (params.get("hasta") || params.get("desde")) return;
        setWeek(weekStart(last.date_to));
        setLastDevice(last.device.id);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, loading, reload } = useAsync(
    () =>
      deviceId
        ? api.get<Page<Punch>>("/attendance/punches", {
            date_from: from,
            date_to: to,
            device_id: deviceId,
            include_double_taps: showDoubles,
            ...sectionQuery,
            limit: 2000,
          })
        : Promise.resolve({ items: [], total: 0 }),
    [from, to, deviceId, showDoubles, area],
  );

  // Llegadas tarde de la semana (solo en las secciones con empleados).
  const late = useAsync(
    () => (area ? api.get<Lateness[]>("/attendance/lateness", { date_from: from, date_to: to, area }) : Promise.resolve([])),
    [from, to, area],
  );
  const lateByKey = useMemo(() => new Map((late.data ?? []).map((l) => [`${l.employee_id}|${l.date}`, l])), [late.data]);

  function selectTab(id: number) {
    const next = new URLSearchParams(params);
    next.set("local", String(id));
    setParams(next, { replace: true });
  }

  function changed() {
    setDialog(null);
    reload();
    locales.reload();
    late.reload();
  }

  const rows = useMemo(() => {
    const byKey = new Map<string, DayRow>();
    for (const p of data?.items ?? []) {
      const date = localDate(p.punched_at);
      const key = `${date}|${p.badge}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          date,
          badge: p.badge,
          deviceId: p.device_id,
          employeeId: p.employee?.id ?? null,
          name: p.employee?.full_name ?? null,
          code: p.employee?.code ?? null,
          punches: [],
          checkIn: null,
          ignored: 0,
        });
      }
      byKey.get(key)!.punches.push(p);
    }
    const q = search.trim().toLowerCase();
    const list = [...byKey.values()]
      .filter((r) => !q || r.badge === q || !!r.name?.toLowerCase().includes(q) || !!r.code?.toLowerCase().includes(q))
      .map((r) => {
        const punches = [...r.punches].sort((a, b) => a.punched_at.localeCompare(b.punched_at));
        return { ...r, punches, ...entry(punches) };
      });
    list.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(!a.name) - Number(!b.name) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.badge.localeCompare(b.badge, undefined, { numeric: true }),
    );
    return list;
  }, [data, search]);

  const days = useMemo(() => {
    const byDate = new Map<string, DayRow[]>();
    for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    return [...byDate.entries()];
  }, [rows]);

  function actions(r: DayRow): RowAction[] {
    const list: RowAction[] = [{ label: "Editar marcas", onClick: () => setDialog({ kind: "edit", row: r }) }];
    if (!r.name) list.push({ label: "Asignar a un empleado", onClick: () => setDialog({ kind: "link", row: r }) });
    list.push({ label: "Eliminar marcas del día", danger: true, onClick: () => setDialog({ kind: "delete", row: r }) });
    return list;
  }

  const agentCell = (r: DayRow) =>
    r.name ? (
      <>
        <div>{r.name}</div>
        <div className="caption">{r.code}</div>
      </>
    ) : (
      <span className="badge warn">ID {r.badge} sin empleado</span>
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="caption">Marcaciones</span>
          <h1>{section}</h1>
          <p>{!area && "IDs del reloj que aún no tienen empleado: asígnelos desde el menú ⋯ de cada fila. "}Hora de El Salvador. Solo cuenta la primera marca del día (la entrada); las demás no cuentan. Las tachadas son dobles marcas.</p>
        </div>
        <div className="chips">
          <button className={`btn sm${view === "lista" ? "" : " ghost"}`} onClick={() => setView("lista")}>
            Lista
          </button>
          <button className={`btn sm${view === "dia" ? "" : " ghost"}`} onClick={() => setView("dia")}>
            Por día
          </button>
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Locales">
          {tabs.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={d.id === deviceId}
              className={d.id === deviceId ? "active" : undefined}
              onClick={() => selectTab(d.id)}
              title={`Reloj ${d.serial_number}`}
            >
              Local {localName(d)}
              <span className="count">{d.punches}</span>
            </button>
          ))}
        </div>
      )}

      <div className="card row">
        <div className="row" style={{ gap: 4, alignSelf: "flex-end" }}>
          <button className="icon-btn" onClick={() => setWeek(addDays(week, -7))} aria-label="Semana anterior">
            <IconChevronLeft width={20} height={20} />
          </button>
          <span className="sch-week">{fmtWeek(week)}</span>
          <button className="icon-btn" onClick={() => setWeek(addDays(week, 7))} aria-label="Semana siguiente">
            <IconChevronRight width={20} height={20} />
          </button>
          {latestWeek && latestWeek !== week && (
            <button className="btn ghost sm" onClick={() => setWeek(latestWeek)}>
              Último archivo
            </button>
          )}
        </div>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <span>Buscar</span>
          <input className="input" placeholder="Nombre, código o huella" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignSelf: "flex-end" }}>
          <label className="check">
            <input type="checkbox" checked={showDoubles} onChange={(e) => setShowDoubles(e.target.checked)} /> Mostrar dobles marcas
          </label>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {data && data.total > data.items.length && (
        <div className="alert info">Mostrando {data.items.length} de {data.total} marcas. Acorte el rango de fechas para ver todas.</div>
      )}

      {loading && !data ? (
        <div className="center-screen" style={{ minHeight: 200 }}>
          <div className="spinner" />
        </div>
      ) : rows.length === 0 ? (
        <div className="card empty">{tabs.length ? "No hay marcaciones en este rango." : `No hay marcaciones de ${section.toLowerCase()}.`}</div>
      ) : view === "lista" ? (
        <div className="card">
          <div className="card-head">
            <h3>Entradas</h3>
            <span className="caption">{rows.length} registros</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Día</th>
                  <th>Hora de entrada</th>
                  {area && <th title={`Entrada vs. inicio del turno. Se perdonan ${LATE_ALLOWANCE} min por quincena.`}>Llegada tarde</th>}
                  <th>Huella</th>
                  {canEdit && <th className="row-actions" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{agentCell(r)}</td>
                    <td className="nowrap">{fmtLongDate(r.date)}</td>
                    <td className="nowrap">
                      {r.checkIn ? (
                        <span className={`punch${punchRole(r, r.checkIn).cls}`} title={punchRole(r, r.checkIn).title}>
                          {fmtTimeSec(r.checkIn.punched_at)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {r.ignored > 0 && (
                        <div
                          className="caption"
                          title={r.punches
                            .filter((p) => !p.is_double_tap && p.id !== r.checkIn?.id)
                            .map((p) => fmtTimeSec(p.punched_at))
                            .join(", ")}
                        >
                          +{r.ignored} marca{r.ignored === 1 ? "" : "s"} más (no cuenta{r.ignored === 1 ? "" : "n"})
                        </div>
                      )}
                    </td>
                    {area && <LateCell late={r.employeeId ? lateByKey.get(`${r.employeeId}|${r.date}`) : undefined} />}
                    <td>
                      <span className="badge accent" title="N° de huella (ID en el reloj)">
                        {r.badge}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="num row-actions">
                        <RowMenu actions={actions(r)} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        days.map(([date, dayRows]) => (
          <div className="card" key={date}>
            <div className="card-head">
              <h3>{fmtLongDate(date)}</h3>
              <span className="caption">{dayRows.length} personas</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {dayRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ width: 260 }}>
                        {agentCell(r)}
                        {r.name && <div className="caption">Huella {r.badge}</div>}
                      </td>
                      <td>
                        <div className="punch-list">
                          {r.punches.map((p, i) => {
                            const role = punchRole(r, p);
                            return (
                              <span key={p.id} className={`punch${role.cls}`} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }} title={role.title}>
                                {fmtTimeSec(p.punched_at)}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      {canEdit && (
                        <td className="num row-actions">
                          <RowMenu actions={actions(r)} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {dialog?.kind === "edit" && <EditDay row={dialog.row} onChanged={reload} onDone={changed} />}
      {dialog?.kind === "link" && <LinkBadge row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog?.kind === "delete" && <DeleteDay row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
    </div>
  );
}

/** Llegada tarde del día: minutos tarde contra el turno y cuánto de eso ya cuenta, porque en la
 *  quincena se perdonan los primeros LATE_ALLOWANCE minutos acumulados. */
function LateCell({ late }: { late?: Lateness }) {
  if (!late) return <td className="nowrap"><span className="muted" title="No tiene turno asignado en Horarios este día">Sin turno</span></td>;
  const turno = `Turno desde las ${fmtTime(late.shift_start)}`;
  if (!late.late_minutes) {
    return (
      <td className="nowrap" title={turno}>
        <span className="caption">A tiempo</span>
      </td>
    );
  }
  const counted = late.counted_minutes > 0;
  return (
    <td className="nowrap" title={`${turno}. Acumulado en la quincena: ${fmtMinutes(late.quincena_minutes)} (se perdonan ${LATE_ALLOWANCE}min).`}>
      <span className={`badge${counted ? " danger" : ""}`}>{fmtMinutes(late.late_minutes)}</span>
      <div className="caption">
        {counted
          ? `${fmtMinutes(late.counted_minutes)} cuentan como tarde`
          : `Dentro de los ${LATE_ALLOWANCE}min (${late.quincena_minutes}/${LATE_ALLOWANCE})`}
      </div>
    </td>
  );
}

/** Todas las marcas de una persona en un día: RRHH corrige la hora o elimina una marca. */
function EditDay({ row, onChanged, onDone }: { row: DayRow; onChanged: () => void; onDone: () => void }) {
  const [punches, setPunches] = useState(row.punches);
  const [times, setTimes] = useState<Record<number, string>>(() => Object.fromEntries(row.punches.map((p) => [p.id, fmtTimeSec(p.punched_at)])));
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstValid = punches.find((x) => !x.is_double_tap)?.id;

  async function run(id: number, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  const save = (p: Punch) =>
    run(p.id, async () => {
      const updated = await api.patch<Punch>(`/attendance/punches/${p.id}`, { punched_at: `${row.date}T${times[p.id]}-06:00` });
      setPunches((list) => list.map((x) => (x.id === p.id ? updated : x)).sort((a, b) => a.punched_at.localeCompare(b.punched_at)));
    });

  const remove = (p: Punch) =>
    run(p.id, async () => {
      await api.delete(`/attendance/punches/${p.id}`);
      setPunches((list) => list.filter((x) => x.id !== p.id));
    });

  return (
    <Modal title="Editar marcas" onClose={onDone}>
      <div className="stack">
        <p>
          <b>{row.name ?? `ID ${row.badge} sin empleado`}</b> · {fmtLongDate(row.date)} · huella {row.badge}
        </p>
        <p className="caption">Solo cuenta la primera marca del día. Si corrige una hora, queda guardada la que marcó el reloj.</p>
        {punches.length === 0 && <div className="empty">No quedan marcas este día.</div>}
        {punches.map((p) => {
          const dirty = times[p.id] !== fmtTimeSec(p.punched_at);
          return (
            <div key={p.id} className="row" style={{ alignItems: "center", gap: 8 }}>
              <input
                className="input mono"
                type="time"
                step={1}
                style={{ width: 150 }}
                value={times[p.id]}
                onChange={(e) => setTimes({ ...times, [p.id]: e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value })}
              />
              <span className="caption" style={{ flex: 1 }}>
                {p.is_double_tap ? "Doble marca" : p.id === firstValid ? "Entrada" : "No cuenta"}
                {p.original_punched_at && ` · el reloj marcó ${fmtTimeSec(p.original_punched_at)}`}
              </span>
              <button className="btn sm" disabled={!dirty || busy !== null} onClick={() => save(p)}>
                Guardar
              </button>
              <button className="btn sm danger" disabled={busy !== null} onClick={() => remove(p)}>
                Eliminar
              </button>
            </div>
          );
        })}
      </div>
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <button className="btn" onClick={onDone}>
          Listo
        </button>
      </div>
    </Modal>
  );
}

function DeleteDay({ row, onClose, onDone }: { row: DayRow; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      for (const p of row.punches) await api.delete(`/attendance/punches/${p.id}`);
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Eliminar marcas del día" onClose={onClose}>
      <div className="stack">
        <p>
          Se eliminarán las {row.punches.length} marcas de <b>{row.name ?? `ID ${row.badge}`}</b> del {fmtLongDate(row.date).toLowerCase()}.
        </p>
        <p className="caption">Quedan registradas en la auditoría y no vuelven a entrar al importar de nuevo el archivo del reloj.</p>
      </div>
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button className="btn danger" onClick={confirm} disabled={busy}>
          {busy ? "Eliminando…" : "Eliminar"}
        </button>
      </div>
    </Modal>
  );
}

/** Un ID del reloj sin empleado: RRHH elige a la persona y todas sus marcas toman su nombre. */
function LinkBadge({ row, onClose, onDone }: { row: DayRow; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = useAsync(
    () => (q.trim().length < 2 ? Promise.resolve(null) : api.get<Page<Employee>>("/employees", { q: q.trim(), limit: 10 })),
    [q],
  );

  async function link(e: Employee) {
    setBusy(true);
    setError(null);
    try {
      await api.post("/attendance/badges/link", { device_id: row.deviceId, badge: row.badge, employee_id: e.id });
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Asignar huella ${row.badge}`} onClose={onClose}>
      <div className="stack">
        <p className="caption">Todas las marcas de la huella {row.badge} en este local quedarán a nombre de la persona que elija.</p>
        <input className="input" autoFocus placeholder="Buscar empleado por nombre o código" value={q} onChange={(e) => setQ(e.target.value)} />
        {found.data?.items.map((e) => (
          <button key={e.id} className="btn ghost" style={{ justifyContent: "space-between" }} disabled={busy} onClick={() => link(e)}>
            <span>{e.full_name}</span>
            <span className="caption">{e.code}</span>
          </button>
        ))}
        {found.data?.items.length === 0 && <div className="empty">No hay empleados con ese nombre.</div>}
      </div>
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
    </Modal>
  );
}
