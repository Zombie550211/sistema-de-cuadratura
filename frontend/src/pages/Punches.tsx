import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { IconCalendar, IconChevronDown, IconChevronLeft, IconChevronRight, IconSearch, IconUpload, IconX } from "../components/Icons";
import { Modal } from "../components/Modal";
import { RowMenu, type RowAction } from "../components/RowMenu";
import {
  api,
  type CutDate,
  type Device,
  ApiError,
  DAY_OFF_LABEL,
  LATE_ALLOWANCE,
  localName,
  NIGHT_START,
  type Employee,
  type ImportBatch,
  type Lateness,
  type Locales,
  type Page,
  type Punch,
  type ShiftAssignment,
  type ShiftDayOff,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { dayOffColor, isNoShow, NO_SHOW } from "../lib/shiftColors";
import { addDays, fmtLongDate, fmtMinutes, fmtRange, fmtTime, fmtHms, fmtTimeSec, localDate, quincena, today } from "../lib/format";
import { downloadBlob, tableImage, type ImageCell, type ImageColumn } from "../lib/tableImage";
import { useAsync } from "../lib/useAsync";
import { ImportPanel } from "./Import";

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
  // Cada archivo subido abre una pestaña con sus fechas (del primer al último día que trae); al
  // entrar se ve la del último archivo. Las flechas recorren quincenas (del 1 al 15 o del 16 a fin
  // de mes). Desde Importar llega ?desde=&hasta=&local= del archivo.
  const [quin, setQuin] = useState<[string, string]>(() => {
    const desde = params.get("desde");
    const hasta = params.get("hasta");
    return desde && hasta ? [desde, hasta] : quincena(hasta ?? desde ?? today());
  });
  // Importar el archivo del reloj se hace aquí mismo (antes era su propia página: /importar llega con ?importar=1).
  const [importing, setImporting] = useState(() => canEdit && params.get("importar") === "1");
  const [search, setSearch] = useState("");
  const [showDoubles, setShowDoubles] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Fecha de corte: si está puesta, en lugar de la quincena se ve de la fecha de inicio hasta el
  // día de corte (las marcas y las llegadas tarde se calculan solo hasta ese día). Se guarda en el
  // servidor, la misma para todos, y queda hasta que RRHH la cambie o la quite.
  const [cut, setCut] = useState<[string, string] | null>(null);
  const [cutError, setCutError] = useState<string | null>(null);
  // Fechas de corte guardadas (la más reciente primero), para volver a elegirlas.
  const [cuts, setCuts] = useState<[string, string][]>([]);
  const [from, to] = cut ?? quin;
  const periodDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

  const locales = useAsync(() => api.get<Locales>("/attendance/locales"), []);
  const tabs = (locales.data?.devices ?? []).filter((d) => d.punches > 0);
  const [lastDevice, setLastDevice] = useState<number | null>(null);
  const wanted = Number(params.get("local")) || lastDevice;
  const device = tabs.find((d) => d.id === wanted) ?? tabs[0] ?? null;
  const deviceId = device?.id ?? null;

  // Sin fecha en la URL, se abre en las fechas y el local del último archivo subido.
  function loadFiles(openLast: boolean) {
    return api
      .get<Page<ImportBatch>>("/attendance/imports", { limit: 5 })
      .then((page) => {
        const last = page.items.find((b) => b.date_from && b.date_to);
        if (!last || !openLast) return;
        setQuin([last.date_from!, last.date_to!]);
        setLastDevice(last.device.id);
      })
      .catch(() => {});
  }
  useEffect(() => {
    loadFiles(!params.get("hasta") && !params.get("desde"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Abre las fechas y el local de un archivo subido. */
  function viewBatch(b: ImportBatch) {
    if (b.date_from && b.date_to) setQuin([b.date_from, b.date_to]);
    selectTab(b.device.id);
  }

  function closeImport() {
    setImporting(false);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("importar");
        return next;
      },
      { replace: true },
    );
  }


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
  // Días del horario del periodo (incapacidad, compensatorio, «No se presentó») de todos.
  const daysOff = useAsync(() => api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: from, date_to: to }), [from, to]);

  function selectTab(id: number) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("local", String(id));
        return next;
      },
      { replace: true },
    );
    setOpenKey(null);
  }

  function openPerson(key: string) {
    setOpenKey(key);
  }

  function loadCuts() {
    api
      .get<CutDate[]>("/attendance/cut-dates")
      .then((list) => setCuts(list.map((c) => [c.date_from, c.date_to])))
      .catch(() => {});
  }
  useEffect(() => {
    api
      .get<CutDate | null>("/attendance/cut-date")
      .then((c) => setCut(c ? [c.date_from, c.date_to] : null))
      .catch(() => {});
    loadCuts();
  }, []);

  /** Aplica una fecha de corte (queda guardada para todos) o, con null, vuelve a ver por quincena. */
  async function saveCut(r: [string, string] | null) {
    setCutError(null);
    try {
      if (r) await api.put("/attendance/cut-date", { date_from: r[0], date_to: r[1] });
      else await api.delete("/attendance/cut-date");
      setCut(r);
      setOpenKey(null);
      loadCuts();
      return true;
    } catch (err) {
      setCutError((err as ApiError).message);
      return false;
    }
  }

  async function deleteCut(r: [string, string]) {
    setCutError(null);
    try {
      await api.delete(`/attendance/cut-dates?date_from=${r[0]}&date_to=${r[1]}`);
      if (cut && cut[0] === r[0] && cut[1] === r[1]) setCut(null);
      loadCuts();
    } catch (err) {
      setCutError((err as ApiError).message);
    }
  }

  function changed() {
    setDialog(null);
    reload();
    locales.reload();
    late.reload();
    daysOff.reload();
  }

  const people = useMemo(() => groupPeople(data?.items ?? []), [data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter((r) => !q || r.badge === q || !!r.name?.toLowerCase().includes(q) || !!r.code?.toLowerCase().includes(q));
  }, [people, search]);

  const open = people.find((p) => p.key === openKey) ?? null;
  const editing = people.find((p) => p.key === editingKey) ?? null;


  return (
    <div className="page wide pn">
      <h1 className="sr-only">Marcaciones</h1>

      <section className="pn-bar" aria-label="Periodo y local">
        <div className="pn-row">
          <div className="pn-group">
            <span className="pn-label">Fecha de corte</span>
            <CutControl cut={cut} cuts={cuts} canEdit={canEdit} error={cutError} onApply={saveCut} onDelete={deleteCut} />
          </div>
          {tabs.length > 0 && (
            <div className="pn-group">
              <span className="pn-label">Local</span>
              <LocalPicker devices={tabs} value={deviceId} onChange={selectTab} />
            </div>
          )}
          <span className="spacer" />
          {canEdit && (
            <button className="btn" onClick={() => setImporting(true)}>
              <IconUpload /> Importar archivo
            </button>
          )}
        </div>

        <div className="pn-row pn-tools">
          {cut ? (
            <div className="pn-period" title="Fecha de corte guardada">
              <span className="pn-period-label">Corte</span>
              <b>{fmtRange(cut)}</b>
            </div>
          ) : (
            <div className="pn-period">
              <button className="icon-btn" onClick={() => setQuin(quincena(addDays(quin[0], -1)))} aria-label="Quincena anterior">
                <IconChevronLeft width={18} height={18} />
              </button>
              <b>{fmtRange(quin)}</b>
              <button className="icon-btn" onClick={() => setQuin(quincena(addDays(quin[1], 1)))} aria-label="Quincena siguiente">
                <IconChevronRight width={18} height={18} />
              </button>
            </div>
          )}
          <label className="pn-search">
            <span className="sr-only">Buscar</span>
            <IconSearch width={16} height={16} aria-hidden />
            <input className="input" placeholder="Buscar por nombre, código o huella" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={showDoubles} onChange={(e) => setShowDoubles(e.target.checked)} /> Dobles marcas
          </label>
          <button className="btn ghost sm" onClick={() => setExporting(true)} disabled={!people.length} title="Descargar la tabla del local como imagen">
            Descargar imagen
          </button>
        </div>
      </section>

      {people.length > 0 && <PeriodSummary people={people} periodDays={periodDays} lateByKey={lateByKey} daysOff={daysOff.data ?? []} lateness={late.data ?? []} />}

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
            <h2 className="pn-h2">Empleados</h2>
            <span className="caption">
              {shown.length} {shown.length === 1 ? "persona" : "personas"}
              {search && ` de ${people.length}`}
            </span>
          </div>
          <div className="table-wrap pn-scroll">
            <table className="table pn-table">
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th>Huella</th>
                  <th>Días con marca</th>
                  <th title={`Días que entró después del inicio del turno. Se perdonan ${LATE_ALLOWANCE} min por quincena.`}>Llegadas tarde</th>
                  <th title={`Días con marca cuyo turno pasa de las ${NIGHT_START}, y horas desde esa hora hasta el fin del turno.`}>Nocturnidad</th>
                  <th title="Días de incapacidad en Horarios">Incapacidad</th>
                  <th title="Días marcados «No se presentó» en Horarios y días con turno sin marcas">No se presentó</th>
                  <th title="Días de compensatorio en Horarios">Compensatorio</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const ls = lateSummary(p, lateByKey);
                  const ns = nightSummary(p, lateByKey);
                  const dk = dayKinds(p.employeeId, daysOff.data ?? [], late.data ?? []);
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
                          <div className="pn-person">
                            <span className="pn-avatar" aria-hidden>{initials(p.name)}</span>
                            <span>
                              <b>{p.name}</b>
                              <span className="caption">{p.code}</span>
                            </span>
                          </div>
                        ) : (
                          <div className="pn-person">
                            <span className="pn-avatar none" aria-hidden>?</span>
                            <span>
                              <b className="pn-unlinked">Sin empleado</b>
                              <span className="caption">Huella {p.badge} del reloj</span>
                            </span>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="pn-badge mono" title="N° de huella (ID en el reloj)">
                          {p.badge}
                        </span>
                      </td>
                      <td>
                        <div className="pn-days" title={`${p.days.length} de ${periodDays} días con marca`}>
                          <span className="pn-days-bar" aria-hidden>
                            <i style={{ transform: `scaleX(${Math.min(1, p.days.length / periodDays)})` }} />
                          </span>
                          <span className="mono">
                            {p.days.length}/{periodDays}
                          </span>
                        </div>
                      </td>
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
                      <td className="nowrap">
                        {ns.days === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <span className="badge">{ns.days} día{ns.days === 1 ? "" : "s"}</span>
                            <div className="caption" title="Horas nocturnas del periodo">{fmtHms(ns.seconds)}</div>
                          </>
                        )}
                      </td>
                      <DayListCell dates={dk.incapacidad} />
                      <DayListCell dates={dk.noShow} danger />
                      <DayListCell dates={dk.compensatorio} />
                      <td className="num nowrap">
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

      {open && !dialog && !editing && (
        <PersonQuincena
          onEditAll={() => setEditingKey(open.key)}
          person={open}
          range={[from, to]}
          isCut={!!cut}
          showDoubles={showDoubles}
          canEdit={canEdit}
          onAction={setDialog}
          onClose={() => setOpenKey(null)}
        />
      )}
      {importing && (
        <Modal title="Importar archivo del reloj" onClose={closeImport} wide>
          <ImportPanel
            onChanged={(batch) => {
              locales.reload();
              reload();
              late.reload();
              daysOff.reload();
              loadFiles(false);
              if (batch) viewBatch(batch);
            }}
            onView={(b) => {
              viewBatch(b);
              closeImport();
            }}
          />
        </Modal>
      )}
      {exporting && device && (
        <DownloadImage device={device} range={[from, to]} people={people} lateness={late.data ?? []} onClose={() => setExporting(false)} />
      )}
      {editing && !dialog && (
        <EditPerson
          onLink={(row) => setDialog({ kind: "link", row })}
          person={editing}
          range={[from, to]}
          onChanged={() => {
            reload();
            late.reload();
            daysOff.reload();
          }}
          onDone={() => setEditingKey(null)}
        />
      )}
      {dialog?.kind === "edit" && <EditDay row={dialog.row} onChanged={reload} onDone={changed} />}
      {dialog?.kind === "link" && <LinkBadge row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog?.kind === "delete" && <DeleteDay row={dialog.row} onClose={() => setDialog(null)} onDone={changed} />}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** Resumen del local en el periodo: cuántos marcaron, cuántas huellas no tienen empleado y el total de
 *  llegadas tarde, nocturnidad y ausencias. */
function PeriodSummary({
  people,
  periodDays,
  lateByKey,
  daysOff,
  lateness,
}: {
  people: PersonRow[];
  periodDays: number;
  lateByKey: Map<string, Lateness>;
  daysOff: ShiftDayOff[];
  lateness: Lateness[];
}) {
  const named = people.filter((p) => p.name);
  const unlinked = people.length - named.length;
  const dayCount = people.reduce((t, p) => t + p.days.length, 0);
  const late = people.map((p) => lateSummary(p, lateByKey));
  const lateDays = late.reduce((t, l) => t + l.days, 0);
  const lateSeconds = late.reduce((t, l) => t + l.seconds, 0);
  const night = people.reduce((t, p) => t + nightSummary(p, lateByKey).seconds, 0);
  const noShow = named.reduce((t, p) => t + dayKinds(p.employeeId, daysOff, lateness).noShow.length, 0);
  return (
    <dl className="home-kpis pn-kpis">
      <div className="home-kpi">
        <dt>Personas que marcaron</dt>
        <dd className="home-kpi-value mono">{people.length}</dd>
        <dd className="home-kpi-note">{Math.round(dayCount / Math.max(1, periodDays))} por día en promedio</dd>
      </div>
      <div className="home-kpi">
        <dt>Huellas sin empleado</dt>
        <dd className={`home-kpi-value mono${unlinked ? " pn-warn" : ""}`}>{unlinked}</dd>
        <dd className="home-kpi-note">{unlinked ? "Sus marcas no cuentan para nadie" : "Todas tienen empleado"}</dd>
      </div>
      <div className="home-kpi">
        <dt>Llegadas tarde</dt>
        <dd className="home-kpi-value mono">{lateDays}</dd>
        <dd className="home-kpi-note">{lateDays ? `${fmtHms(lateSeconds)} en total` : "Sin turnos o todos a tiempo"}</dd>
      </div>
      <div className="home-kpi">
        <dt>No se presentó</dt>
        <dd className="home-kpi-value mono">{noShow}</dd>
        <dd className="home-kpi-note">{night ? `Nocturnidad: ${fmtHms(night)}` : "Días con turno y sin marca"}</dd>
      </div>
    </dl>
  );
}

/** Llegadas tarde de una persona en los días que marcó. */
function lateSummary(p: PersonRow, lateByKey: Map<string, Lateness>) {
  const list = p.employeeId ? p.days.map((d) => lateByKey.get(`${p.employeeId}|${d.date}`)).filter((l) => !!l?.late_minutes) : [];
  return {
    days: list.length,
    counted: list.reduce((sum, l) => sum + (l?.counted_minutes ?? 0), 0),
    seconds: list.reduce((sum, l) => sum + (l?.late_seconds ?? 0), 0),
  };
}

/** Nocturnidad de una persona: días y segundos después de las 19:00. */
function nightSummary(p: PersonRow, lateByKey: Map<string, Lateness>) {
  const list = p.employeeId ? p.days.map((d) => lateByKey.get(`${p.employeeId}|${d.date}`)).filter((l) => !!l?.night_seconds) : [];
  return { days: list.length, seconds: list.reduce((sum, l) => sum + (l?.night_seconds ?? 0), 0) };
}

/** Días de incapacidad, de compensatorio y en que no se presentó, de una persona en el periodo. */
function dayKinds(employeeId: number | null, daysOff: ShiftDayOff[], lateness: Lateness[]) {
  const none = { incapacidad: [], noShow: [], compensatorio: [] } as Record<"incapacidad" | "noShow" | "compensatorio", string[]>;
  if (!employeeId) return none;
  const mine = daysOff.filter((d) => d.employee_id === employeeId);
  const past = today();
  // No se presentó: marcado así en Horarios, o tenía turno (ya pasado) y no hay marcas.
  const missed = lateness.filter((l) => l.employee_id === employeeId && !l.check_in && l.date < past).map((l) => l.date);
  return {
    incapacidad: mine.filter((d) => d.kind === "incapacidad" && !isNoShow(d)).map((d) => d.work_date).sort(),
    noShow: [...new Set([...mine.filter(isNoShow).map((d) => d.work_date), ...missed])].sort(),
    compensatorio: mine.filter((d) => d.kind === "compensatorio" && !isNoShow(d)).map((d) => d.work_date).sort(),
  };
}

/** Día corto, p. ej. «Lun 3». */
function dayTag(ymd: string) {
  const wd = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", weekday: "short" }).format(new Date(`${ymd}T00:00:00Z`)).replace(".", "");
  return `${wd.charAt(0).toUpperCase()}${wd.slice(1)} ${Number(ymd.slice(8))}`;
}

/** Celda con la cantidad de días y cuáles fueron («Lun 3, Mié 5»). */
function DayListCell({ dates, danger }: { dates: string[]; danger?: boolean }) {
  if (!dates.length) return <td><span className="muted">—</span></td>;
  return (
    <td style={{ minWidth: 110 }}>
      <span className={`badge${danger ? " danger" : ""}`}>
        {dates.length} día{dates.length === 1 ? "" : "s"}
      </span>
      <div className="caption">{dates.map(dayTag).join(", ")}</div>
    </td>
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
  onEditAll,
  onClose,
}: {
  /** Abre la edición de todos los días del periodo a la vez. */
  onEditAll: () => void;
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
  const nightDays = (late.data ?? []).filter((l) => l.night_seconds > 0);
  const nightTotal = nightDays.reduce((sum, l) => sum + l.night_seconds, 0);

  // Horario del periodo (turnos y días libres) para compararlo con las marcas: así se ve qué
  // día del fin de semana le tocaba descansar (sábado o domingo, según la semana).
  const schedule = useAsync(
    () =>
      person.employeeId
        ? Promise.all([
            api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: from, date_to: to, employee_id: person.employeeId }),
            api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: from, date_to: to }),
          ])
        : Promise.resolve(null),
    [person.employeeId, from, to],
  );
  const shiftByDate = new Map((schedule.data?.[0] ?? []).map((a) => [a.work_date, a]));
  const offByDate = new Map((schedule.data?.[1] ?? []).filter((d) => d.employee_id === person.employeeId).map((d) => [d.work_date, d]));
  const hasSchedule = !!person.employeeId && !!schedule.data;
  // Intercambios de fin de semana: día trabajado → día del turno, y al revés.
  const swapFrom = new Map((late.data ?? []).filter((l) => l.swapped_from).map((l) => [l.date, l.swapped_from!]));
  const swapTo = new Map([...swapFrom].map(([worked, planned]) => [planned, worked]));

  // Sin empleado, una huella puede tener marcas de alguien vinculado antes: solo las de esta persona.
  const days = useMemo(() => groupPeople(punches.data?.items ?? []).find((p) => p.key === person.key)?.days ?? [], [punches.data, person.key]);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

  /** Comparación del día con el horario: faltó a un turno o marcó en su día de descanso. */
  function check(date: string): "falta" | "descanso" | null {
    if (!hasSchedule) return null;
    const off = offByDate.get(date);
    // «No se presentó» en Horarios es falta, aunque el día no tenga turno.
    if (off && isNoShow(off) && !byDate.has(date)) return "falta";
    if (swapFrom.has(date) || swapTo.has(date)) return null;
    if (byDate.has(date)) return off && !isNoShow(off) ? "descanso" : null;
    return shiftByDate.has(date) && date < today() ? "falta" : null;
  }
  const faltas = dates.filter((d) => check(d) === "falta").length;
  const workedOff = dates.filter((d) => check(d) === "descanso").length;

  function actions(date: string, r?: DayRow): RowAction[] {
    // Un día sin marcas también se edita: así se le corrige el horario.
    const row: DayRow = r ?? {
      key: `${date}|${person.badge}`,
      date,
      badge: person.badge,
      deviceId,
      employeeId: person.employeeId,
      name: person.name,
      code: person.code,
      punches: [],
      checkIn: null,
      ignored: 0,
    };
    const list: RowAction[] = [{ label: "Editar", onClick: () => onAction({ kind: "edit", row }) }];
    if (!r) return list;
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
        {nightTotal > 0 && (
          <span className="badge" title={`Horas del turno después de las ${NIGHT_START}, en los días que marcó`}>
            Nocturnidad: {nightDays.length} día{nightDays.length === 1 ? "" : "s"} · {fmtHms(nightTotal)}
          </span>
        )}
        {faltas > 0 && <span className="badge danger" title="Días con turno en el horario y sin marcas">{faltas} falta{faltas === 1 ? "" : "s"}</span>}
        {workedOff > 0 && <span className="badge warn" title="Días que el horario marca como descanso y tienen marcas">Marcó {workedOff} día{workedOff === 1 ? "" : "s"} de descanso</span>}
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
              {person.employeeId && <th>Horario</th>}
              <th>Marcas</th>
              {person.employeeId && <th>Llegada tarde</th>}
              {person.employeeId && <th title={`Horas del turno después de las ${NIGHT_START}`}>Nocturnidad</th>}
              {canEdit && <th className="row-actions" />}
            </tr>
          </thead>
          <tbody>
            {dates.map((date) => {
              const r = byDate.get(date);
              const planned = swapFrom.get(date);
              const shift = shiftByDate.get(planned ?? date);
              const off = planned ? undefined : offByDate.get(date);
              const movedTo = swapTo.get(date);
              const flag = check(date);
              return (
                <tr key={date}>
                  <td className="nowrap">{fmtLongDate(date)}</td>
                  {person.employeeId && (
                    <td className="nowrap">
                      {shift ? (
                        <>
                          <span className={movedTo ? "muted" : undefined} title={shift.source === "crm" ? "Turno del CRM" : "Turno asignado aquí"}>
                            {fmtTime(shift.start_at)} – {fmtTime(shift.end_at)}
                          </span>
                          {planned && <div className="caption">Cambio: turno del {fmtLongDate(planned).toLowerCase()}</div>}
                          {movedTo && <div className="caption">Lo trabajó el {fmtLongDate(movedTo).toLowerCase()}</div>}
                        </>
                      ) : off ? (
                        <span title={off.notes ?? undefined}>
                          <span className="swatch" style={{ background: dayOffColor(off), borderRadius: 4, marginRight: 6 }} />
                          {isNoShow(off) ? NO_SHOW.label : DAY_OFF_LABEL[off.kind]}
                        </span>
                      ) : (
                        <span className="muted">{schedule.loading ? "…" : "Sin horario"}</span>
                      )}
                    </td>
                  )}
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
                        {flag === "descanso" && (
                          <span className="badge warn" style={{ marginTop: 4 }} title="El horario marca este día como descanso">
                            Marcó en su día de descanso
                          </span>
                        )}
                      </>
                    ) : flag === "falta" && off && isNoShow(off) ? (
                      <span className="badge danger" title="Marcado «No se presentó» en Horarios: cuenta como falta">
                        No se presentó
                      </span>
                    ) : flag === "falta" ? (
                      <span className="badge danger" title="Tenía turno y no hay marcas">
                        Sin marcas · faltó
                      </span>
                    ) : (
                      <span className="muted">{movedTo ? "Sin marcas (cambió de día)" : off ? "Sin marcas (descanso)" : "Sin marcas"}</span>
                    )}
                  </td>
                  {person.employeeId &&
                    (r ? <LateCell late={lateByKey.get(`${person.employeeId}|${date}`)} off={off} /> : <td className="nowrap"><span className="muted">—</span></td>)}
                  {person.employeeId && (
                    <td className="nowrap">
                      {(() => {
                        const n = lateByKey.get(`${person.employeeId}|${date}`)?.night_seconds ?? 0;
                        return n > 0 ? <span className="badge" title={`Desde las ${NIGHT_START} hasta el fin del turno`}>{fmtHms(n)}</span> : <span className="muted">—</span>;
                      })()}
                    </td>
                  )}
                  {canEdit && <td className="num row-actions">{(r || person.employeeId) && <RowMenu actions={actions(date, r)} />}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-foot">
        {canEdit && (
          <button className="btn ghost" onClick={onEditAll} title="Corregir horario y marcas de todos los días del periodo">
            Editar todo el periodo
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Modal>
  );
}

interface ImageRow {
  id: number;
  name: string;
  code: string;
  /** La persona como en la tabla (sin días si no marcó en el periodo). */
  person: PersonRow;
  lateSeconds: number;
  noShow: number;
}

/** Imagen de la tabla del local, igual a la de la pantalla: RRHH quita a quien no quiere mostrar,
 *  revisa la vista previa y la descarga en PNG. Van los empleados que marcaron en este local en el
 *  periodo y los activos que tienen huella de este local. */
function DownloadImage({
  device,
  range,
  people,
  lateness,
  onClose,
}: {
  device: Device;
  range: [string, string];
  people: PersonRow[];
  lateness: Lateness[];
  onClose: () => void;
}) {
  const [from, to] = range;
  const local = localName(device);
  const periodDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const lateByKey = useMemo(() => new Map(lateness.map((l) => [`${l.employee_id}|${l.date}`, l])), [lateness]);
  const extra = useAsync(async () => {
    const employees: Employee[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.get<Page<Employee>>("/employees", { status: "activo", limit: 500, offset });
      employees.push(...page.items);
      if (employees.length >= page.total || !page.items.length) break;
    }
    const daysOff = await api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: from, date_to: to });
    return { employees, daysOff };
  }, [from, to]);

  const rows = useMemo<ImageRow[]>(() => {
    if (!extra.data) return [];
    const found = new Map<number, PersonRow>();
    for (const p of people) if (p.employeeId) found.set(p.employeeId, p);
    for (const e of extra.data.employees) {
      const badge = device.fingerprint_key ? e.fingerprints?.[device.fingerprint_key] : undefined;
      if (badge && !found.has(e.id)) {
        found.set(e.id, { key: `e${e.id}`, badge: String(badge), employeeId: e.id, name: e.full_name, code: e.code, days: [] });
      }
    }
    return [...found]
      .map(([id, person]) => ({
        id,
        name: person.name ?? "",
        code: person.code ?? "",
        person,
        lateSeconds: lateSummary(person, lateByKey).seconds,
        noShow: dayKinds(id, extra.data!.daysOff, lateness).noShow.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [extra.data, people, lateness, lateByKey, device.fingerprint_key]);

  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Vista previa: la imagen ya generada, que se revisa antes de descargarla.
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const selected = rows.filter((r) => !hidden.has(r.id));
  const fileName = `marcaciones-${local}-${from}-a-${to}.png`;

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  function toggle(id: number) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const none: ImageCell = { text: "—", muted: true };
      const days = (list: string[], danger?: boolean): ImageCell =>
        list.length ? { text: `${list.length} día${list.length === 1 ? "" : "s"}`, badge: danger ? "danger" : "plain", sub: [list.map(dayTag).join(", ")] } : none;
      const columns: ImageColumn[] = [
        { label: "Empleado" },
        { label: "Huella" },
        { label: "Días con marca" },
        { label: "Llegadas tarde" },
        { label: "Nocturnidad" },
        { label: "Incapacidad" },
        { label: "No se presentó" },
        { label: "Compensatorio" },
      ];
      const cells: ImageCell[][] = selected.map(({ person: p, id }) => {
        const ls = lateSummary(p, lateByKey);
        const ns = nightSummary(p, lateByKey);
        const dk = dayKinds(id, extra.data?.daysOff ?? [], lateness);
        return [
          { text: p.name ?? "", sub: p.code ? [p.code] : [] },
          { text: p.badge, badge: "accent" },
          { text: `${p.days.length} de ${periodDays}` },
          ls.days
            ? {
                text: `${ls.days} día${ls.days === 1 ? "" : "s"}`,
                badge: ls.counted ? "danger" : "plain",
                sub: [`Total: ${fmtHms(ls.seconds)}`, ...(ls.counted ? [`${fmtMinutes(ls.counted)} cuentan como tarde`] : [])],
              }
            : none,
          ns.days ? { text: `${ns.days} día${ns.days === 1 ? "" : "s"}`, badge: "plain", sub: [fmtHms(ns.seconds)] } : none,
          days(dk.incapacidad),
          days(dk.noShow, true),
          days(dk.compensatorio),
        ];
      });
      const blob = await tableImage({
        title: `Marcaciones · Local ${local}`,
        subtitle: `${fmtRange(range)} · ${selected.length} empleado${selected.length === 1 ? "" : "s"}`,
        columns,
        rows: cells,
        footer: `Se perdonan ${LATE_ALLOWANCE} min de llegada tarde por quincena. Nocturnidad: desde las ${NIGHT_START}. No se presentó: marcado así en Horarios o con turno sin marcas.`,
      });
      setPreview({ blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (preview) {
    return (
      <Modal title={`Vista previa · Local ${local}`} onClose={onClose} wide>
        <p className="caption" style={{ marginTop: -12, marginBottom: 16 }}>
          {fmtRange(range)} · {selected.length} empleado{selected.length === 1 ? "" : "s"} · Revise la imagen antes de descargarla.
        </p>
        <div style={{ maxHeight: "60vh", overflow: "auto", border: "1px solid var(--border, #e2e8f0)", borderRadius: 12 }}>
          <img src={preview.url} alt={`Tabla de marcaciones del local ${local}`} style={{ display: "block", width: "100%", height: "auto" }} />
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => setPreview(null)}>
            Volver a elegir
          </button>
          <button
            className="btn"
            onClick={() => {
              downloadBlob(preview.blob, fileName);
              onClose();
            }}
          >
            Descargar imagen
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Descargar imagen · Local ${local}`} onClose={onClose}>
      <p className="caption" style={{ marginTop: -12, marginBottom: 16 }}>
        {fmtRange(range)} · Quite a los empleados que no quiere mostrar en la imagen.
      </p>
      {extra.error && <div className="alert">{extra.error}</div>}
      {extra.loading && !extra.data ? (
        <div className="center-screen" style={{ minHeight: 120 }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: "center" }}>
            <button className="btn ghost sm" onClick={() => setHidden(new Set())}>
              Todos
            </button>
            <button className="btn ghost sm" onClick={() => setHidden(new Set(rows.map((r) => r.id)))}>
              Ninguno
            </button>
            <span className="caption" style={{ marginLeft: "auto" }}>
              {selected.length} de {rows.length} seleccionados
            </span>
          </div>
          <div className="emp-picker" style={{ maxHeight: 360 }}>
            {rows.map((r) => (
              <label key={r.id} className="check" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span>
                  <input type="checkbox" checked={!hidden.has(r.id)} onChange={() => toggle(r.id)} /> {r.name}
                </span>
                <span className="caption">
                  {r.lateSeconds ? `Tarde ${fmtHms(r.lateSeconds)}` : "Sin tarde"}
                  {r.noShow ? ` · ${r.noShow} sin presentarse` : ""}
                </span>
              </label>
            ))}
            {rows.length === 0 && <div className="empty">No hay empleados en este local.</div>}
          </div>
        </>
      )}
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn" disabled={busy || !selected.length} onClick={generate}>
          {busy ? "Generando…" : "Vista previa"}
        </button>
      </div>
    </Modal>
  );
}


/** Llegada tarde del día: minutos tarde contra el turno y cuánto de eso ya cuenta, porque en la
 *  quincena se perdonan los primeros LATE_ALLOWANCE minutos acumulados. */
function LateCell({ late, off }: { late?: Lateness; off?: ShiftDayOff }) {
  if (off) {
    return (
      <td className="nowrap">
        <span className="muted" title="Día de descanso en el horario: no cuenta como llegada tarde">
          {isNoShow(off) ? NO_SHOW.label : DAY_OFF_LABEL[off.kind]} · no cuenta
        </span>
      </td>
    );
  }
  if (!late) return <td className="nowrap"><span className="muted" title="No tiene turno asignado en Horarios este día: no cuenta como llegada tarde">Sin turno · no cuenta</span></td>;
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

/** Un día de una persona: RRHH corrige el horario (el mismo de Horarios) y la hora de las
 *  marcas, o elimina una marca. */
function EditDay({ row, onChanged, onDone }: { row: DayRow; onChanged: () => void; onDone: () => void }) {
  const employeeId = row.employeeId;
  const schedule = useAsync(
    () =>
      employeeId
        ? Promise.all([
            api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: row.date, date_to: row.date, employee_id: employeeId }),
            api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: row.date, date_to: row.date }),
          ])
        : Promise.resolve(null),
    [employeeId, row.date],
  );
  const shift = schedule.data?.[0][0];
  const off = schedule.data?.[1].find((d) => d.employee_id === employeeId);

  return (
    <Modal title="Editar" onClose={onDone}>
      <div className="stack">
        <p>
          <b>{row.name ?? `ID ${row.badge} sin empleado`}</b> · {fmtLongDate(row.date)} · huella {row.badge}
        </p>
        <p className="caption">Solo cuenta la primera marca del día. Si corrige una hora, queda guardada la que marcó el reloj. La llegada tarde se calcula contra el horario del día.</p>
        {schedule.error && <div className="alert">{schedule.error}</div>}
        {employeeId ? (
          <DayShiftEditor
            key={`${shift?.id}|${shift?.start_at}|${shift?.end_at}|${off?.id}`}
            employeeId={employeeId}
            date={row.date}
            shift={shift}
            off={off}
            loading={schedule.loading && !schedule.data}
            onChanged={() => {
              schedule.reload();
              onChanged();
            }}
          />
        ) : (
          <div className="caption">Horario: esta huella no tiene empleado; asígnela a un empleado para ver y editar su turno.</div>
        )}
        {row.punches.length > 0 ? <DayPunchEditor row={row} onChanged={onChanged} /> : <div className="caption">Este día no tiene marcas.</div>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onDone}>
          Listo
        </button>
      </div>
    </Modal>
  );
}

/** Edición de las marcas de una persona en todo el periodo (quincena o fecha de corte), día por día. */
function EditPerson({
  person,
  range,
  onChanged,
  onLink,
  onDone,
}: {
  person: PersonRow;
  range: [string, string];
  onChanged: () => void;
  /** Huella sin empleado: abrir la ventana para asignarla. */
  onLink?: (row: DayRow) => void;
  onDone: () => void;
}) {
  const [from, to] = range;
  // Horario del periodo: la llegada tarde se calcula contra el turno, así que se corrige aquí mismo.
  const schedule = useAsync(
    () =>
      person.employeeId
        ? Promise.all([
            api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: from, date_to: to, employee_id: person.employeeId }),
            api.get<ShiftDayOff[]>("/schedules/days-off", { date_from: from, date_to: to }),
          ])
        : Promise.resolve(null),
    [person.employeeId, from, to],
  );
  const shiftByDate = new Map((schedule.data?.[0] ?? []).map((a) => [a.work_date, a]));
  const offByDate = new Map((schedule.data?.[1] ?? []).filter((d) => d.employee_id === person.employeeId).map((d) => [d.work_date, d]));

  return (
    <Modal title="Editar marcación" onClose={onDone} wide>
      <p className="caption" style={{ marginTop: -12, marginBottom: 16 }}>
        <b>{person.name ?? `ID ${person.badge} sin empleado`}</b> · {person.code && `${person.code} · `}Huella {person.badge} · {fmtRange(range)}
        <br />
        Solo cuenta la primera marca del día. Si corrige una hora, queda guardada la que marcó el reloj. La llegada tarde se calcula contra el horario del día.
      </p>
      {schedule.error && <div className="alert" style={{ marginBottom: 16 }}>{schedule.error}</div>}
      <div className="stack">
        {person.days.map((d) => (
          <div key={d.key} className="card" style={{ padding: 16 }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>{fmtLongDate(d.date)}</h3>
            {!person.employeeId ? (
              <div className="row" style={{ alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span className="caption" style={{ width: 56 }}>Horario</span>
                <span className="badge warn">Sin empleado</span>
                <span className="caption" style={{ flex: 1 }}>El horario es del empleado: asigne esta huella a un empleado para ver y editar su turno.</span>
                {onLink && (
                  <button className="btn sm" onClick={() => onLink(d)}>
                    Asignar a un empleado
                  </button>
                )}
              </div>
            ) : (
              <DayShiftEditor
                // Se vuelve a montar al recargar el horario, para mostrar lo guardado.
                key={`${shiftByDate.get(d.date)?.id ?? "x"}|${shiftByDate.get(d.date)?.start_at}|${shiftByDate.get(d.date)?.end_at}|${offByDate.get(d.date)?.id}`}
                employeeId={person.employeeId}
                date={d.date}
                shift={shiftByDate.get(d.date)}
                off={offByDate.get(d.date)}
                loading={schedule.loading && !schedule.data}
                onChanged={() => {
                  schedule.reload();
                  onChanged();
                }}
              />
            )}
            <DayPunchEditor row={d} onChanged={onChanged} />
          </div>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onDone}>
          Listo
        </button>
      </div>
    </Modal>
  );
}

/** Horario de un día con las horas editables: cambia el turno (o pone uno si no tenía o era
 *  descanso). El cambio queda como manual y se devuelve al CRM, igual que en Horarios. */
function DayShiftEditor({
  employeeId,
  date,
  shift,
  off,
  loading,
  onChanged,
}: {
  employeeId: number;
  date: string;
  shift?: ShiftAssignment;
  off?: ShiftDayOff;
  loading: boolean;
  onChanged: () => void;
}) {
  const [start, setStart] = useState(shift ? fmtTime(shift.start_at) : "");
  const [end, setEnd] = useState(shift ? fmtTime(shift.end_at) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = shift ? start !== fmtTime(shift.start_at) || end !== fmtTime(shift.end_at) : !!start && !!end;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (shift) {
        await api.put(`/schedules/assignments/${shift.id}`, {
          work_date: date,
          start_time: start,
          end_time: end,
          break_minutes: shift.break_minutes,
          tolerance_minutes: shift.tolerance_minutes,
          notes: shift.notes,
        });
      } else {
        await api.post("/schedules/assignments/bulk", {
          employee_ids: [employeeId],
          date_from: date,
          date_to: date,
          weekdays: [(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7],
          start_time: start,
          end_time: end,
          overwrite: true,
        });
      }
      onChanged();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span className="caption" style={{ width: 56 }}>Horario</span>
        <input className="input mono" type="time" style={{ width: 130 }} value={start} disabled={loading} onChange={(e) => setStart(e.target.value)} aria-label="Inicio del turno" />
        <span className="muted">–</span>
        <input className="input mono" type="time" style={{ width: 130 }} value={end} disabled={loading} onChange={(e) => setEnd(e.target.value)} aria-label="Fin del turno" />
        <span className="caption" style={{ flex: 1 }}>
          {loading
            ? "…"
            : shift
              ? shift.source === "crm" ? "Turno del CRM" : "Turno asignado aquí"
              : off
                ? `${isNoShow(off) ? NO_SHOW.label : DAY_OFF_LABEL[off.kind]} · al guardar se le pone turno`
                : "Sin horario"}
        </span>
        <button className="btn sm" disabled={!dirty || busy || loading} onClick={save}>
          {busy ? "Guardando…" : "Guardar horario"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

/** Marcas de un día con su hora editable: guardar la corrección o eliminar la marca. */
function DayPunchEditor({ row, onChanged }: { row: DayRow; onChanged: () => void }) {
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
    <div className="stack">
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
      {error && <div className="alert">{error}</div>}
    </div>
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

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const spanDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
const sameRange = (a: [string, string] | null, b: [string, string]) => !!a && a[0] === b[0] && a[1] === b[1];

/** Panel que se abre debajo de su botón; se cierra al tocar fuera o con Escape. */
function Popover({ open, onClose, children, align = "left" }: { open: boolean; onClose: () => void; children: React.ReactNode; align?: "left" | "right" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="pop-backdrop" onClick={onClose} aria-hidden />
      <div className={`pop pop-${align}`} role="dialog">
        {children}
      </div>
    </>
  );
}

/** Fecha de corte: muestra la aplicada; al abrirla se ven las guardadas para elegir una (o volver a
 *  la quincena) y un calendario para marcar una nueva, del primer día al día de corte. */
function CutControl({
  cut,
  cuts,
  canEdit,
  error,
  onApply,
  onDelete,
}: {
  cut: [string, string] | null;
  cuts: [string, string][];
  canEdit: boolean;
  error: string | null;
  onApply: (r: [string, string] | null) => Promise<boolean>;
  onDelete: (r: [string, string]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<[string, string | null]>(() => [cut?.[0] ?? quincena(today())[0], cut?.[1] ?? null]);
  const [busy, setBusy] = useState(false);
  const close = () => setOpen(false);
  const days = range[1] ? spanDays(range[0], range[1]) : 0;
  const tooLong = days > 94;

  async function apply(r: [string, string] | null) {
    setBusy(true);
    const ok = await onApply(r);
    setBusy(false);
    if (ok) close();
  }

  return (
    <div className="pop-anchor">
      <button
        type="button"
        className={`picker-btn${cut ? " on" : ""}`}
        onClick={() => {
          setRange([cut?.[0] ?? quincena(today())[0], cut?.[1] ?? null]);
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <IconCalendar width={16} height={16} aria-hidden />
        <span>{cut ? fmtRange(cut) : "Por quincena"}</span>
        {cuts.length > 1 && <span className="seg-count">{cuts.length} guardadas</span>}
        <IconChevronDown width={14} height={14} aria-hidden className="picker-caret" />
      </button>
      <Popover open={open} onClose={close}>
        <div className="cut-pop">
          <div className="cut-saved">
            <span className="pop-title">Guardadas</span>
            <button type="button" className={`cut-item${cut ? "" : " on"}`} disabled={!canEdit || busy} onClick={() => apply(null)}>
              <span className="cut-radio" aria-hidden />
              <span className="home-grow">
                Por quincena
                <small>Sin fecha de corte</small>
              </span>
            </button>
            <div className="cut-list qscroll">
              {cuts.map((c) => (
                <div key={c.join("|")} className={`cut-item${sameRange(cut, c) ? " on" : ""}`}>
                  <button type="button" className="cut-pick" disabled={!canEdit || busy} onClick={() => apply(c)}>
                    <span className="cut-radio" aria-hidden />
                    <span className="home-grow">
                      {fmtRange(c)}
                      <small>{spanDays(c[0], c[1])} días</small>
                    </span>
                  </button>
                  {canEdit && (
                    <button type="button" className="icon-btn cut-del" onClick={() => onDelete(c)} aria-label={`Borrar la fecha de corte ${fmtRange(c)}`} title="Borrar de las guardadas">
                      <IconX width={14} height={14} />
                    </button>
                  )}
                </div>
              ))}
              {!cuts.length && <p className="caption" style={{ padding: "4px 8px" }}>Todavía no hay fechas de corte guardadas.</p>}
            </div>
          </div>

          <div className="cut-new">
            <span className="pop-title">Nueva fecha de corte</span>
            <RangeCalendar value={range} onChange={setRange} />
            <div className="cut-foot">
              <span className="cut-summary">
                {range[1] ? (
                  <>
                    <b>{fmtRange([range[0], range[1]])}</b>
                    <small className={tooLong ? "danger-text" : undefined}>{tooLong ? "Máximo 3 meses" : `${days} días`}</small>
                  </>
                ) : (
                  <small>Elija el primer día y luego el día de corte</small>
                )}
              </span>
              <button type="button" className="btn sm" disabled={!canEdit || !range[1] || tooLong || busy} onClick={() => range[1] && apply([range[0], range[1]])}>
                {busy ? "Aplicando…" : "Aplicar"}
              </button>
            </div>
            {error && <div className="alert">{error}</div>}
            {!canEdit && <p className="caption">Solo RRHH cambia la fecha de corte.</p>}
          </div>
        </div>
      </Popover>
    </div>
  );
}

/** Dos meses lado a lado para marcar un rango: primer clic el inicio, segundo clic el día de corte. */
function RangeCalendar({ value, onChange }: { value: [string, string | null]; onChange: (r: [string, string | null]) => void }) {
  const [month, setMonth] = useState(() => (value[1] ?? value[0]).slice(0, 7));
  const [hover, setHover] = useState<string | null>(null);
  const prevMonth = addDays(`${month}-01`, -1).slice(0, 7);
  const months = [prevMonth, month];
  const [start, end] = value;
  const until = end ?? (hover && hover >= start ? hover : null);
  const now = today();

  function pick(d: string) {
    if (!start || end || d < start) onChange([d, null]);
    else onChange([start, d]);
  }

  return (
    <div className="rc">
      <div className="rc-nav">
        <button type="button" className="icon-btn" onClick={() => setMonth(prevMonth)} aria-label="Mes anterior">
          <IconChevronLeft width={16} height={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => setMonth(addDays(`${month}-28`, 7).slice(0, 7))} aria-label="Mes siguiente">
          <IconChevronRight width={16} height={16} />
        </button>
      </div>
      <div className="rc-months" onMouseLeave={() => setHover(null)}>
        {months.map((m) => {
          const lead = (new Date(`${m}-01T00:00:00Z`).getUTCDay() + 6) % 7;
          const count = Number(addDays(`${addDays(`${m}-28`, 4).slice(0, 8)}01`, -1).slice(8));
          return (
            <div key={m} className="rc-month">
              <b className="rc-title">
                {MONTH_NAMES[Number(m.slice(5)) - 1]} {m.slice(0, 4)}
              </b>
              <div className="rc-grid">
                {WEEKDAYS.map((w, i) => (
                  <span key={i} className="rc-dow" aria-hidden>
                    {w}
                  </span>
                ))}
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`x${i}`} />
                ))}
                {Array.from({ length: count }, (_, i) => {
                  const d = `${m}-${String(i + 1).padStart(2, "0")}`;
                  const inRange = !!until && d > start && d < until;
                  const cls = [
                    "rc-day",
                    d === start ? "start" : "",
                    d === until ? "end" : "",
                    inRange ? "in" : "",
                    d === now ? "today" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button key={d} type="button" className={cls} onClick={() => pick(d)} onMouseEnter={() => setHover(d)} aria-label={fmtLongDate(d)} aria-pressed={d === start || d === end}>
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Local del reloj: con varios, una lista desplegable con sus marcas; con uno solo, su nombre. */
function LocalPicker({ devices, value, onChange }: { devices: (Device & { punches: number })[]; value: number | null; onChange: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const current = devices.find((d) => d.id === value) ?? devices[0];
  if (devices.length <= 1) {
    return (
      <span className="picker-btn static" title={`Reloj ${current.serial_number}`}>
        {localName(current)}
        <span className="seg-count">{current.punches} marcas</span>
      </span>
    );
  }
  return (
    <div className="pop-anchor">
      <button type="button" className="picker-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">
        <span>{localName(current)}</span>
        <span className="seg-count">{current.punches} marcas</span>
        <IconChevronDown width={14} height={14} aria-hidden className="picker-caret" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <ul className="local-list qscroll" role="listbox" aria-label="Locales">
          {devices.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                role="option"
                aria-selected={d.id === current.id}
                className={`cut-item${d.id === current.id ? " on" : ""}`}
                onClick={() => {
                  onChange(d.id);
                  setOpen(false);
                }}
              >
                <span className="cut-radio" aria-hidden />
                <span className="home-grow">
                  Local {localName(d)}
                  <small>Reloj {d.serial_number}</small>
                </span>
                <span className="seg-count">{d.punches}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}
