import { useState, type FormEvent } from "react";

import { Modal } from "../components/Modal";
import { api, AREAS, DOCS, type Area, type Department, type Employee, type EmployeeInput } from "../lib/api";

const EMPTY: EmployeeInput = {
  code: "",
  user_code: null,
  badge_number: null,
  crm_agent_id: null,
  first_name: "",
  last_name: "",
  dui: null,
  nit: null,
  isss_number: null,
  nup: null,
  afp: null,
  email: null,
  phone: null,
  position: null,
  area: null,
  department_id: null,
  hire_date: null,
  termination_date: null,
  base_salary: "0.00",
  pay_frequency: "quincenal",
  status: "activo",
  payroll_date: null,
  birthday: null,
  gender: null,
  bank_account: null,
  locker: null,
  fingerprints: {},
  emergency_contact: null,
  termination_note: null,
  has_cv: false,
  has_contract: false,
  has_nda: false,
  has_memo: false,
};

interface Props {
  employee: Employee | null;
  initial?: Partial<EmployeeInput>;
  departments: Department[];
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDepartmentCreated: (d: Department) => void;
}

export function EmployeeForm({ employee, initial, departments, readOnly, onClose, onSaved, onDepartmentCreated }: Props) {
  const [form, setForm] = useState<EmployeeInput>(() => {
    if (!employee) return { ...EMPTY, ...initial };
    const { id: _id, full_name: _fn, department: _d, ...rest } = employee;
    return rest;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const text = (key: keyof EmployeeInput) => ({
    value: (form[key] as string | null) ?? "",
    onChange: (e: { target: { value: string } }) => set(key, (e.target.value || null) as never),
    disabled: readOnly,
    className: "input",
  });

  async function addDepartment() {
    const name = prompt("Nombre del nuevo departamento o campaña");
    if (!name?.trim()) return;
    try {
      const dept = await api.post<Department>("/departments", { name: name.trim() });
      onDepartmentCreated(dept);
      set("department_id", dept.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (employee) await api.put(`/employees/${employee.id}`, form);
      else await api.post("/employees", form);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={employee ? employee.full_name : "Nuevo empleado"} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Nombres *</span>
            <input {...text("first_name")} required />
          </label>
          <label className="field">
            <span>Apellidos *</span>
            <input {...text("last_name")} required />
          </label>
          <label className="field">
            <span>ID de usuario</span>
            <input
              {...text("user_code")}
              placeholder="Se genera con iniciales y cumpleaños (KR1907)"
              pattern="[A-Za-z]{2}\d{4}(-\d+)?"
              title="Dos letras y día y mes de nacimiento, p.ej. KR1907"
            />
          </label>
          <label className="field">
            <span>ID en el reloj de marcación</span>
            <input {...text("badge_number")} inputMode="numeric" placeholder="Ej. 83" />
          </label>
          <label className="field">
            <span>ID en el CRM</span>
            <input {...text("crm_agent_id")} placeholder="Lo completa el CRM al enviar horarios" />
          </label>
          <label className="field">
            <span>Cargo</span>
            <input {...text("position")} placeholder="Agente, supervisor…" />
          </label>
          <label className="field">
            <span>Área</span>
            <select className="input" value={form.area ?? ""} disabled={readOnly} onChange={(e) => set("area", (e.target.value || null) as Area | null)}>
              <option value="">Según el cargo</option>
              {AREAS.map((a) => (
                <option key={a.area} value={a.area}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Equipo</span>
            <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
              <select
                className="input"
                value={form.department_id ?? ""}
                disabled={readOnly}
                onChange={(e) => set("department_id", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Sin asignar</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {!readOnly && (
                <button type="button" className="btn ghost sm" onClick={addDepartment}>
                  Nuevo
                </button>
              )}
            </div>
          </label>
          <label className="field">
            <span>Correo</span>
            <input {...text("email")} type="email" />
          </label>
          <label className="field">
            <span>Teléfono</span>
            <input {...text("phone")} />
          </label>

          <div className="form-section">Datos personales</div>
          <label className="field">
            <span>Género</span>
            <select className="input" value={form.gender ?? ""} disabled={readOnly} onChange={(e) => set("gender", e.target.value || null)}>
              <option value="">—</option>
              <option>Femenino</option>
              <option>Masculino</option>
            </select>
          </label>
          <label className="field">
            <span>Cumpleaños (día y mes)</span>
            <input
              className="input"
              type="date"
              disabled={readOnly}
              value={form.birthday ? `2000-${form.birthday}` : ""}
              onChange={(e) => set("birthday", e.target.value ? e.target.value.slice(5) : null)}
            />
          </label>
          <label className="field full">
            <span>Contacto de emergencia</span>
            <input {...text("emergency_contact")} placeholder="Nombre, parentesco y teléfono" />
          </label>
          <label className="field">
            <span>Locker</span>
            <input {...text("locker")} />
          </label>

          <div className="form-section">Documentos</div>
          <label className="field">
            <span>DUI</span>
            <input {...text("dui")} placeholder="00000000-0" pattern="\d{8}-\d" />
          </label>
          <label className="field">
            <span>NIT</span>
            <input {...text("nit")} />
          </label>
          <label className="field">
            <span>Número de afiliación ISSS</span>
            <input {...text("isss_number")} />
          </label>
          <label className="field">
            <span>NUP (AFP)</span>
            <input {...text("nup")} />
          </label>
          <label className="field">
            <span>AFP</span>
            <select className="input" value={form.afp ?? ""} disabled={readOnly} onChange={(e) => set("afp", e.target.value || null)}>
              <option value="">—</option>
              <option>AFP Confía</option>
              <option>AFP Crecer</option>
              <option>IPSFA</option>
              <option>UPISSS</option>
              <option>No cotiza</option>
            </select>
          </label>

          <div className="field full">
            <span>Expediente entregado</span>
            <div className="row">
              {DOCS.map(([key, label]) => (
                <label key={key} className="check">
                  <input type="checkbox" checked={form[key]} disabled={readOnly} onChange={(e) => set(key, e.target.checked)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="form-section">Contrato</div>
          <label className="field">
            <span>Fecha de ingreso</span>
            <input {...text("hire_date")} type="date" />
          </label>
          <label className="field">
            <span>Ingreso a planilla</span>
            <input {...text("payroll_date")} type="date" />
          </label>
          <label className="field">
            <span>Fecha de retiro</span>
            <input {...text("termination_date")} type="date" />
          </label>
          <label className="field">
            <span>Motivo de finalización</span>
            <input {...text("termination_note")} placeholder="Renuncia, despido, abandono…" />
          </label>
          <label className="field">
            <span>Salario base mensual (USD)</span>
            <input {...text("base_salary")} type="number" min="0" step="0.01" required />
          </label>
          <label className="field">
            <span>Frecuencia de pago</span>
            <select className="input" value={form.pay_frequency} disabled={readOnly} onChange={(e) => set("pay_frequency", e.target.value as EmployeeInput["pay_frequency"])}>
              <option value="quincenal">Quincenal</option>
              <option value="mensual">Mensual</option>
            </select>
          </label>
          <label className="field">
            <span>Cuenta bancaria</span>
            <input {...text("bank_account")} inputMode="numeric" />
          </label>
          <label className="field">
            <span>Estado</span>
            <select className="input" value={form.status} disabled={readOnly} onChange={(e) => set("status", e.target.value as EmployeeInput["status"])}>
              <option value="activo">Activo</option>
              <option value="inactivo">Inactivo</option>
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {readOnly ? "Cerrar" : "Cancelar"}
          </button>
          {!readOnly && (
            <button className="btn" disabled={busy}>
              {busy ? "Guardando…" : "Guardar"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
