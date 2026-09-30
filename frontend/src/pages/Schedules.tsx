import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { IconChevronLeft, IconChevronRight, IconPlus, IconX } from "../components/Icons";
import { Modal } from "../components/Modal";
import { api, type Employee, type Page, type ShiftAssignment, type ShiftTemplate } from "../lib/api";
import { useAuth } from "../lib/auth";
import { addDays, fmtShortDay, fmtTime, hhmm, today, weekStart } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];

export function Schedules() {
  const { can } = useAuth();
  const canEdit = can("admin", "rrhh");
  const [start, setStart] = useState(() => weekStart(today()));
  const [filter, setFilter] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [templateModal, setTemplateModal] = useState<ShiftTemplate | "new" | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const end = days[6];

  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", limit: 500 }), []);
  const templates = useAsync(() => api.get<ShiftTemplate[]>("/schedules/templates", { include_inactive: true }), []);
  const assignments = useAsync(() => api.get<ShiftAssignment[]>("/schedules/assignments", { date_from: start, date_to: end }), [start, end]);

  const byKey = useMemo(() => {
    const map = new Map<string, ShiftAssignment>();
    assignments.data?.forEach((a) => map.set(`${a.employee_id}|${a.work_date}`, a));
    return map;
  }, [assignments.data]);
  const templateById = useMemo(() => new Map(templates.data?.map((t) => [t.id, t])), [templates.data]);

  const visible = (employees.data?.items ?? []).filter((e) => {
    const q = filter.trim().toLowerCase();
    return !q || e.full_name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q) || e.badge_number === q;
  });

  async function remove(a: ShiftAssignment) {
    if (!confirm("¿Quitar este horario?")) return;
    await api.delete(`/schedules/assignments/${a.id}`);
    assignments.reload();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Horarios</h1>
          <p>
            Los supervisores cargan los horarios en el CRM y llegan aquí automáticamente cada semana. RRHH puede ajustar un día a mano: esos cambios
            no se sobrescriben.
          </p>
        </div>
        {canEdit && (
          <button className="btn" onClick={() => setAssigning(true)} disabled={!employees.data?.items.length}>
            <IconPlus /> Asignar horario
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Turnos base</h3>
          {canEdit && (
            <button className="btn ghost sm" onClick={() => setTemplateModal("new")}>
              <IconPlus /> Nuevo turno
            </button>
          )}
        </div>
        <div className="row">
          {templates.data?.map((t) => (
            <button key={t.id} className="badge" style={{ cursor: canEdit ? "pointer" : "default", padding: "6px 12px", opacity: 1 }} onClick={() => canEdit && setTemplateModal(t)}>
              <span className="swatch" style={{ background: t.color }} />
              <b>{t.name}</b>
              <span className="mono">
                {hhmm(t.start_time)}–{hhmm(t.end_time)}
              </span>
              {t.crosses_midnight && <span className="caption">nocturno</span>}
              {!t.is_active && <span className="caption">(inactivo)</span>}
            </button>
          ))}
          {templates.data?.length === 0 && <span className="muted">Cree turnos base (ej. “Mañana 7:00–16:00”) para asignarlos rápido.</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="row">
            <button className="icon-btn" onClick={() => setStart(addDays(start, -7))} aria-label="Semana anterior">
              <IconChevronLeft width={20} height={20} />
            </button>
            <h3 className="mono">
              {start} → {end}
            </h3>
            <button className="icon-btn" onClick={() => setStart(addDays(start, 7))} aria-label="Semana siguiente">
              <IconChevronRight width={20} height={20} />
            </button>
            <button className="btn ghost sm" onClick={() => setStart(weekStart(today()))}>
              Hoy
            </button>
          </div>
          <input className="input" style={{ width: 240 }} placeholder="Filtrar empleados" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {assignments.error && <div className="alert">{assignments.error}</div>}
        <div className="table-wrap">
          <div className="week">
            <div className="wh">Empleado</div>
            {days.map((d) => (
              <div key={d} className={`wh${d === today() ? " today" : ""}`}>
                {fmtShortDay(d)}
              </div>
            ))}
            {visible.map((e) => (
              <Row key={e.id} employee={e} days={days} byKey={byKey} templateById={templateById} canEdit={canEdit} onRemove={remove} />
            ))}
          </div>
          {employees.data?.items.length === 0 && <div className="empty">Registre empleados para poder asignarles horarios.</div>}
        </div>
      </div>

      {assigning && (
        <AssignModal
          employees={employees.data?.items ?? []}
          templates={(templates.data ?? []).filter((t) => t.is_active)}
          defaultFrom={start}
          defaultTo={end}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            assignments.reload();
          }}
        />
      )}
      {templateModal && (
        <TemplateModal
          template={templateModal === "new" ? null : templateModal}
          onClose={() => setTemplateModal(null)}
          onSaved={() => {
            setTemplateModal(null);
            templates.reload();
          }}
        />
      )}
    </div>
  );
}

function Row({
  employee,
  days,
  byKey,
  templateById,
  canEdit,
  onRemove,
}: {
  employee: Employee;
  days: string[];
  byKey: Map<string, ShiftAssignment>;
  templateById: Map<number, ShiftTemplate>;
  canEdit: boolean;
  onRemove: (a: ShiftAssignment) => void;
}) {
  return (
    <>
      <div className="emp">
        <Link to={`/empleados/${employee.id}`} style={{ color: "var(--text)" }}>
          {employee.full_name}
        </Link>
        <div className="caption">{employee.badge_number ? `ID reloj ${employee.badge_number}` : employee.code}</div>
      </div>
      {days.map((d) => {
        const a = byKey.get(`${employee.id}|${d}`);
        const tpl = a?.template_id ? templateById.get(a.template_id) : undefined;
        return (
          <div key={d} className="cell-day">
            {a ? (
              <div className="shift-pill" style={{ borderLeftColor: tpl?.color ?? "var(--accent)" }} title={a.notes ?? undefined}>
                <b className="mono">
                  {fmtTime(a.start_at)}–{fmtTime(a.end_at)}
                </b>
                <span className="caption">
                  {a.source === "crm" ? <span className="badge accent" style={{ padding: "0 6px" }}>CRM</span> : (tpl?.name ?? "Manual")}
                </span>
                {canEdit && (
                  <button className="icon-btn" onClick={() => onRemove(a)} aria-label="Quitar horario">
                    <IconX width={12} height={12} />
                  </button>
                )}
              </div>
            ) : (
              <span className="caption" style={{ alignSelf: "center" }}>
                Libre
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function AssignModal({
  employees,
  templates,
  defaultFrom,
  defaultTo,
  onClose,
  onDone,
}: {
  employees: Employee[];
  templates: ShiftTemplate[];
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [templateId, setTemplateId] = useState<string>(templates[0] ? String(templates[0].id) : "custom");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMin, setBreakMin] = useState(60);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = employees.filter((e) => !search || e.full_name.toLowerCase().includes(search.toLowerCase()) || e.badge_number === search);
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const custom = templateId === "custom";
    try {
      const r = await api.post<{ created: number; updated: number; skipped: number }>("/schedules/assignments/bulk", {
        employee_ids: [...selected],
        date_from: from,
        date_to: to,
        weekdays,
        template_id: custom ? null : Number(templateId),
        start_time: custom ? startTime : null,
        end_time: custom ? endTime : null,
        break_minutes: custom ? breakMin : null,
        overwrite,
      });
      if (r.skipped && !r.created && !r.updated) {
        setResult(`Ya había ${r.skipped} horarios en esas fechas. Marque “Reemplazar existentes” para cambiarlos.`);
      } else {
        onDone();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Asignar horario" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error && <div className="alert">{error}</div>}
        {result && <div className="alert warn">{result}</div>}
        <div className="field">
          <span>
            Empleados ({selected.size} seleccionados)
            <button type="button" className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setSelected(new Set(shown.map((e) => e.id)))}>
              Todos
            </button>
            <button type="button" className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => setSelected(new Set())}>
              Ninguno
            </button>
          </span>
          <input className="input" placeholder="Buscar" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="emp-picker">
            {shown.map((e) => (
              <label key={e.id} className="check">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                {e.full_name} <span className="caption">{e.badge_number && `· ID ${e.badge_number}`}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Desde</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <div className="field full">
            <span>Días</span>
            <div className="days">
              {WEEKDAYS.map((d, i) => (
                <button
                  type="button"
                  key={i}
                  className={`day-toggle${weekdays.includes(i) ? " on" : ""}`}
                  onClick={() => setWeekdays((w) => (w.includes(i) ? w.filter((x) => x !== i) : [...w, i].sort()))}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <label className="field full">
            <span>Turno</span>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({hhmm(t.start_time)}–{hhmm(t.end_time)})
                </option>
              ))}
              <option value="custom">Horario personalizado…</option>
            </select>
          </label>
          {templateId === "custom" && (
            <>
              <label className="field">
                <span>Entrada</span>
                <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              </label>
              <label className="field">
                <span>Salida (si es menor que la entrada, termina al día siguiente)</span>
                <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
              </label>
              <label className="field">
                <span>Minutos de descanso</span>
                <input className="input" type="number" min={0} max={480} value={breakMin} onChange={(e) => setBreakMin(Number(e.target.value))} />
              </label>
            </>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Reemplazar horarios existentes en esas fechas
        </label>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !selected.size || !weekdays.length}>
            {busy ? "Asignando…" : "Asignar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const COLORS = ["#06b6d4", "#22d3ee", "#a855f7", "#7c3aed", "#e879f9", "#3b82f6", "#0e7490", "#d946ef"];

function TemplateModal({ template, onClose, onSaved }: { template: ShiftTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: template?.name ?? "",
    start_time: template ? hhmm(template.start_time) : "08:00",
    end_time: template ? hhmm(template.end_time) : "17:00",
    break_minutes: template?.break_minutes ?? 60,
    tolerance_minutes: template?.tolerance_minutes ?? 5,
    color: template?.color ?? COLORS[0],
    is_active: template?.is_active ?? true,
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (template) await api.put(`/schedules/templates/${template.id}`, form);
      else await api.post("/schedules/templates", form);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={template ? "Editar turno" : "Nuevo turno"} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field full">
            <span>Nombre</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Mañana" required />
          </label>
          <label className="field">
            <span>Entrada</span>
            <input className="input" type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required />
          </label>
          <label className="field">
            <span>Salida</span>
            <input className="input" type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required />
          </label>
          <label className="field">
            <span>Minutos de descanso</span>
            <input className="input" type="number" min={0} max={480} value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Tolerancia de llegada (min)</span>
            <input className="input" type="number" min={0} max={120} value={form.tolerance_minutes} onChange={(e) => setForm({ ...form, tolerance_minutes: Number(e.target.value) })} />
          </label>
          <div className="field full">
            <span>Color</span>
            <div className="row" style={{ gap: 8 }}>
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={c}
                  onClick={() => setForm({ ...form, color: c })}
                  style={{ width: 32, height: 32, borderRadius: 999, background: c, border: form.color === c ? "3px solid #ffffff" : "3px solid transparent", cursor: "pointer" }}
                />
              ))}
            </div>
          </div>
          <label className="check full">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Activo
          </label>
        </div>
        {form.end_time < form.start_time && <div className="alert info" style={{ marginTop: 16 }}>Turno nocturno: termina al día siguiente.</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn">Guardar</button>
        </div>
      </form>
    </Modal>
  );
}
