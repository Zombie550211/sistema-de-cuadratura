import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { IconChevronLeft, IconChevronRight, IconX } from "../components/Icons";
import { Modal } from "../components/Modal";
import { RowMenu, type RowAction } from "../components/RowMenu";
import {
  api,
  ApiError,
  LATE_ALLOWANCE,
  localName,
  type Employee,
  type ImportBatch,
  type Lateness,
  type Locales,
  type Page,
  type Punch,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtLongDate, fmtMinutes, fmtRange, fmtTime, fmtHms, fmtTimeSec, localDate, quincena, today } from "../lib/format";
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

/** Una persona (empleado, o huella del reloj sin empleado) con sus días marcados en el periodo. */
interface PersonRow {
  key: string;
  badge: string;
  employeeId: number | null;
  name: string | null;
  code: string | null;
  days: DayRow[];
}

type Dialog = { kind: "edit" | "delete" | "link"; row: DayRow } | null;

function entry(punches: Punch[]) {
  const valid = punches.filter((p) => !p.is_double_tap);
  return { checkIn: valid[0] ?? null, ignored: Math.max(valid.length - 1, 0) };
}

/** Agrupa las marcas por persona (empleado, o huella sin empleado) y, dentro, por día. */
function groupPeople(items: Punch[]): PersonRow[] {
  const byDay = new Map<string, DayRow>();
  for (const p of items) {
    const date = localDate(p.punched_at);
    const key = `${date}|${p.badge}`;
    if (!byDay.has(key)) {
      byDay.set(key, {
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
    byDay.get(key)!.punches.push(p);
  }
  const byPerson = new Map<string, PersonRow>();
  for (const d of byDay.values()) {
    const punches = [...d.punches].sort((a, b) => a.punched_at.localeCompare(b.punched_at));
    const day = { ...d, punches, ...entry(punches) };
    const key = day.employeeId ? `e${day.employeeId}` : `b${day.badge}`;
    if (!byPerson.has(key)) {
      byPerson.set(key, { key, badge: day.badge, employeeId: day.employeeId, name: day.name, code: day.code, days: [] });
    }
    byPerson.get(key)!.days.push(day);
  }
  const list = [...byPerson.values()];
  for (const p of list) p.days.sort((a, b) => a.date.localeCompare(b.date));
  list.sort(
    (a, b) =>
      Number(!a.name) - Number(!b.name) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.badge.localeCompare(b.badge, undefined, { numeric: true }),
  );
  return list;
}

function punchRole(r: DayRow, p: Punch): { cls: string; title: string } {
  const edited = p.original_punched_at ? ` · corregida (el reloj marcó ${fmtTimeSec(p.original_punched_at)})` : "";
  const cls = p.original_punched_at ? " edited" : "";
  if (p.is_double_tap) return { cls: " double" + cls, title: "Doble marca (ignorada)" + edited };
  if (p.id === r.checkIn?.id) return { cls: " in" + cls, title: "Entrada" + edited };
  return { cls: " middle" + cls, title: "No cuenta: solo vale la primera marca del día" + edited };
}

/** Marcaciones de todos los empleados, con una pestaña por local: una fila por persona y, al
 *  tocarla, una ventana con sus marcas de la quincena día por día (la entrada resaltada). */
export function Punches() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  // Se ve una quincena a la vez (del 1 al 15 o del 16 a fin de mes): la del último archivo subido;
  // las demás se recorren con las flechas. Desde Importar llega ?hasta=&local= del archivo.
  const [quin, setQuin] = useState(() => quincena(params.get("hasta") ?? params.get("desde") ?? today()));
  const [latestQuin, setLatestQuin] = useState<[string, string] | null>(null);
  const [search, setSearch] = useState("");
  const [showDoubles, setShowDoubles] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Fecha de corte: si está puesta, en lugar de la quincena se ve de la fecha de inicio hasta el
  // día de corte (las marcas y las llegadas tarde se calculan solo hasta ese día).
  const [cut, setCut] = useState<[string, string] | null>(null);
  const [pickingCut, setPickingCut] = useState(false);
  const [from, to] = cut ?? quin;
  const periodDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

  const locales = useAsync(() => api.get<Locales>("/attendance/locales"), []);
  const tabs = (locales.data?.devices ?? []).filter((d) => d.punches > 0);
  const [lastDevice, setLastDevice] = useState<number | null>(null);
  const wanted = Number(params.get("local")) || lastDevice;
  const deviceId = tabs.find((d) => d.id === wanted)?.id ?? tabs[0]?.id ?? null;

  // Sin fecha en la URL, se abre en la quincena y el local del último archivo subido.
  useEffect(() => {
    api
      .get<Page<ImportBatch>>("/attendance/imports", { limit: 1 })
      .then((page) => {
        const last = page.items[0];
        if (!last?.date_to) return;
        setLatestQuin(quincena(last.date_to));
        if (params.get("hasta") || params.get("desde")) return;
        setQuin(quincena(last.date_to));
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
            limit: 10000,
          })
        : Promise.resolve({ items: [], total: 0 }),
    [from, to, deviceId, showDoubles],
  );

  // Llegadas tarde del periodo de todos los empleados con turno.
  const late = useAsync(() => api.get<Lateness[]>("/attendance/lateness", { date_from: from, date_to: to }), [from, to]);
  const lateByKey = useMemo(() => new Map((late.data ?? []).map((l) => [`${l.employee_id}|${l.date}`, l])), [late.data]);

  function selectTab(id: number) {
    const next = new URLSearchParams(params);
    next.set("local", String(id));
    setParams(next, { replace: true });
    setOpenKey(null);
  }

  function openPerson(key: string) {
    setOpenKey(key);
  }

  function moveQuin(r: [string, string]) {
    setCut(null);
    setQuin(r);
  }

  function changed() {
    setDialog(null);
    reload();
    locales.reload();
    late.reload();
  }

  const people = useMemo(() => groupPeople(data?.items ?? []), [data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter((r) => !q || r.badge === q || !!r.name?.toLowerCase().includes(q) || !!r.code?.toLowerCase().includes(q));
  }, [people, search]);

  const open = people.find((p) => p.key === openKey) ?? null;

  function lateSummary(p: PersonRow) {
    const list = p.employeeId ? p.days.map((d) => lateByKey.get(`${p.employeeId}|${d.date}`)).filter((l) => !!l?.late_minutes) : [];
    return {
      days: list.length,
      counted: list.reduce((sum, l) => sum + (l?.counted_minutes ?? 0), 0),
      seconds: list.reduce((sum, l) => sum + (l?.late_seconds ?? 0), 0),
    };
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="caption">Asistencia</span>
          <h1>Marcaciones</h1>
          <p>Toque a una persona para ver sus marcas de la quincena. Hora de El Salvador. Solo cuenta la primera marca del día (la entrada); las tachadas son dobles marcas.</p>
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
          <button className="icon-btn" onClick={() => moveQuin(quincena(addDays(quin[0], -1)))} aria-label="Quincena anterior">
            <IconChevronLeft width={20} height={20} />
          </button>
          <span className="sch-week">{cut ? `Corte: ${fmtRange(cut)}` : fmtRange(quin)}</span>
          <button className="icon-btn" onClick={() => moveQuin(quincena(addDays(quin[1], 1)))} aria-label="Quincena siguiente">
            <IconChevronRight width={20} height={20} />
          </button>
          {latestQuin && (cut || latestQuin[0] !== quin[0]) && (
            <button className="btn ghost sm" onClick={() => moveQuin(latestQuin)}>
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
          <div className="row" style={{ gap: 4 }}>
            <button className={`btn sm${cut ? "" : " ghost"}`} onClick={() => setPickingCut(true)} title="Calcular desde una fecha de inicio hasta la fecha de corte">
              {cut ? `Corte: ${fmtRange(cut)}` : "Fecha de corte"}
            </button>
            {cut && (
              <button className="icon-btn" onClick={() => setCut(null)} aria-label="Quitar fecha de corte" title="Quitar fecha de corte">
                <IconX width={16} height={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {data && data.total > data.items.length && (
        <div className="alert info">Mostrando {data.items.length} de {data.total} marcas del periodo.</div>
      )}

      {loading && !data ? (
        <div className="center-screen" style={{ minHeight: 200 }}>
          <div className="spinner" />
        </div>
      ) : shown.length === 0 ? (
        <div className="card empty">{tabs.length ? (search ? "Nadie coincide con la búsqueda." : "No hay marcaciones en este periodo.") : "Aún no hay marcaciones."}</div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h3>Empleados</h3>
            <span className="caption">{shown.length} personas</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th>Huella</th>
                  <th>Días con marca</th>
                  <th title={`Días que entró después del inicio del turno. Se perdonan ${LATE_ALLOWANCE} min por quincena.`}>Llegadas tarde</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const ls = lateSummary(p);
                  return (
                    <tr
                      key={p.key}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => openPerson(p.key)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openPerson(p.key))}
                    >
                      <td>
                        {p.name ? (
                          <>
                            <div>{p.name}</div>
                            <div className="caption">{p.code}</div>
                          </>
                        ) : (
                          <span className="badge warn">ID {p.badge} sin empleado</span>
                        )}
                      </td>
                      <td>
                        <span className="badge accent" title="N° de huella (ID en el reloj)">
                          {p.badge}
                        </span>
                      </td>
                      <td>{p.days.length} de {periodDays}</td>
                      <td className="nowrap">
                        {ls.days === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <span className={`badge${ls.counted ? " danger" : ""}`}>
                              {ls.days} día{ls.days === 1 ? "" : "s"}
                            </span>
                            <div className="caption" title="Total de llegada tarde en el periodo">Total: {fmtHms(ls.seconds)}</div>
                            {ls.counted > 0 && <div className="caption">{fmtMinutes(ls.counted)} cuentan como tarde</div>}
                          </>
                        )}
                      </td>
                      <td className="num">
                        <IconChevronRight width={18} height={18} className="muted" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && !dialog && (
        <PersonQuincena
          person={open}
          range={[from, to]}
          isCut={!!cut}
          showDoubles={showDoubles}
          canEdit={canEdit}
          onAction={setDialog}
          onClose={() => setOpenKey(null)}
        />
      )}
      {pickingCut && (
        <CutDatePicker
          initial={cut ?? [quincena(today())[0], today()]}
          onApply={(r) => {
            setCut(r);
            setPickingCut(false);
          }}
          onClose={() => setPickingCut(false)}
        />
      )}
      {dialog?.kind === "edit" && <EditDay row={dialog.row} onChanged={reload} onDone={changed} />}
      {dialog?.kind === "link" && <LinkBadge row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog?.kind === "delete" && <DeleteDay row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
    </div>
  );
}

/** Ventana con el periodo de una persona (la quincena o, si hay, la fecha de corte): cada día,
 *  sus marcas, la llegada tarde y el total tarde en horas, minutos y segundos. */
function PersonQuincena({
  person,
  range,
  isCut,
  showDoubles,
  canEdit,
  onAction,
  onClose,
}: {
  person: PersonRow;
  range: [string, string];
  /** El rango es la fecha de corte elegida, no una quincena. */
  isCut: boolean;
  showDoubles: boolean;
  canEdit: boolean;
  onAction: (d: Dialog) => void;
  onClose: () => void;
}) {
  const [from, to] = range;
  const deviceId = person.days[0].deviceId;
  const punches = useAsync(
    () =>
      api.get<Page<Punch>>("/attendance/punches", {
        date_from: from,
        date_to: to,
        device_id: deviceId,
        ...(person.employeeId ? { employee_id: person.employeeId } : { badge: person.badge }),
        include_double_taps: showDoubles,
        limit: 10000,
      }),
    [person.key, deviceId, showDoubles, from, to],
  );
  const late = useAsync(
    () =>
      person.employeeId
        ? api.get<Lateness[]>("/attendance/lateness", { date_from: from, date_to: to, employee_id: person.employeeId })
        : Promise.resolve([]),
    [person.employeeId, from, to],
  );
  const lateByKey = useMemo(() => new Map((late.data ?? []).map((l) => [`${l.employee_id}|${l.date}`, l])), [late.data]);
  const lateTotal = (late.data ?? []).filter((l) => l.late_minutes > 0).reduce((sum, l) => sum + l.late_seconds, 0);

  // Sin empleado, una huella puede tener marcas de alguien vinculado antes: solo las de esta persona.
  const days = useMemo(() => groupPeople(punches.data?.items ?? []).find((p) => p.key === person.key)?.days ?? [], [punches.data, person.key]);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

  function actions(r: DayRow): RowAction[] {
    const list: RowAction[] = [{ label: "Editar marcas", onClick: () => onAction({ kind: "edit", row: r }) }];
    if (!r.name) list.push({ label: "Asignar a un empleado", onClick: () => onAction({ kind: "link", row: r }) });
    list.push({ label: "Eliminar marcas del día", danger: true, onClick: () => onAction({ kind: "delete", row: r }) });
    return list;
  }

  return (
    <Modal title={person.name ?? `ID ${person.badge} sin empleado`} onClose={onClose} wide>
      <p className="caption" style={{ marginTop: -12, marginBottom: 16 }}>
        {person.code && `${person.code} · `}Huella {person.badge} · {days.length} día{days.length === 1 ? "" : "s"} con marcas {isCut ? "hasta la fecha de corte" : "en la quincena"}
      </p>
      <div className="row" style={{ gap: 12, marginBottom: 16, alignItems: "center" }}>
        <span className="sch-week">{isCut ? `Corte: ${fmtRange(range)}` : fmtRange(range)}</span>
        {lateTotal > 0 && <span className="badge danger" title="Total de llegada tarde en el periodo">Tarde en total: {fmtHms(lateTotal)}</span>}
        {(punches.loading || late.loading) && <div className="spinner" style={{ width: 16, height: 16 }} />}
      </div>
      {punches.error && <div className="alert" style={{ marginBottom: 16 }}>{punches.error}</div>}
      {!person.name && canEdit && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          Esta huella no tiene empleado.{" "}
          <button className="btn sm" onClick={() => onAction({ kind: "link", row: person.days[0] })}>
            Asignar a un empleado
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Día</th>
              <th>Marcas</th>
              {person.employeeId && <th>Llegada tarde</th>}
              {canEdit && <th className="row-actions" />}
            </tr>
          </thead>
          <tbody>
            {dates.map((date) => {
              const r = byDate.get(date);
              return (
                <tr key={date}>
                  <td className="nowrap">{fmtLongDate(date)}</td>
                  <td>
                    {r ? (
                      <>
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
                        {r.ignored > 0 && (
                          <div className="caption">
                            +{r.ignored} marca{r.ignored === 1 ? "" : "s"} después de la entrada (no cuenta{r.ignored === 1 ? "" : "n"})
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">Sin marcas</span>
                    )}
                  </td>
                  {person.employeeId &&
                    (r ? <LateCell late={lateByKey.get(`${person.employeeId}|${date}`)} /> : <td className="nowrap"><span className="muted">—</span></td>)}
                  {canEdit && <td className="num row-actions">{r && <RowMenu actions={actions(r)} />}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Modal>
  );
}

/** Calendario para elegir la fecha de inicio y la fecha de corte. */
function CutDatePicker({ initial, onApply, onClose }: { initial: [string, string]; onApply: (r: [string, string]) => void; onClose: () => void }) {
  const [from, setFrom] = useState(initial[0]);
  const [to, setTo] = useState(initial[1]);
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) : 0;
  const error = !from || !to ? "Elija las dos fechas." : to < from ? "La fecha de corte no puede ser antes de la de inicio." : days > 93 ? "El rango no puede pasar de 3 meses." : null;

  return (
    <Modal title="Fecha de corte" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) onApply([from, to]);
        }}
      >
        <p className="caption">Las marcas y las llegadas tarde de cada persona se calculan desde la fecha de inicio hasta la fecha de corte (incluida).</p>
        <div className="row" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Fecha de inicio</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Fecha de corte</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {error && from && to && <div className="alert">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={!!error}>
            Aplicar
          </button>
        </div>
      </form>
    </Modal>
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
      <span className={`badge${counted ? " danger" : ""}`}>{fmtHms(late.late_seconds)}</span>
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
