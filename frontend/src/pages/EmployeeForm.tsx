import { useState, type FormEvent } from "react";

import { Modal } from "../components/Modal";
import { api, type Department, type Employee, type EmployeeInput } from "../lib/api";

const EMPTY: EmployeeInput = {
  code: "",
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
  department_id: null,
  hire_date: null,
  termination_date: null,
  base_salary: "0.00",
  pay_frequency: "quincenal",
  status: "activo",
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
            <span>Código de empleado *</span>
            <input {...text("code")} required />
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
            <span>Departamento / campaña</span>
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
              <option>No cotiza</option>
            </select>
          </label>

          <div className="form-section">Contrato</div>
          <label className="field">
            <span>Fecha de ingreso</span>
            <input {...text("hire_date")} type="date" />
          </label>
          <label className="field">
            <span>Fecha de retiro</span>
            <input {...text("termination_date")} type="date" />
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
