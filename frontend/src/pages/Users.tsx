import { useState, type FormEvent } from "react";

import { IconPlus } from "../components/Icons";
import { Modal } from "../components/Modal";
import { api, type Employee, type Page, type Role, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABEL } from "../lib/format";
import { useAsync } from "../lib/useAsync";

export function Users() {
  const { user: me } = useAuth();
  const users = useAsync(() => api.get<User[]>("/users"), []);
  const [editing, setEditing] = useState<User | "new" | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Usuarios</h1>
          <p>Quién puede entrar al sistema y qué puede hacer.</p>
        </div>
        <button className="btn" onClick={() => setEditing("new")}>
          <IconPlus /> Nuevo usuario
        </button>
      </div>
      {users.error && <div className="alert">{users.error}</div>}
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => setEditing(u)}>
                <td className="mono">{u.username}</td>
                <td>
                  {u.full_name} {u.id === me?.id && <span className="caption">(usted)</span>}
                </td>
                <td>
                  <span className="badge accent">{ROLE_LABEL[u.role]}</span>
                </td>
                <td>{u.is_active ? <span className="badge">Activo</span> : <span className="badge danger">Desactivado</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <UserModal
          user={editing === "new" ? null : editing}
          isSelf={editing !== "new" && editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            users.reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({ user, isSelf, onClose, onSaved }: { user: User | null; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "rrhh");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [password, setPassword] = useState("");
  const [employeeId, setEmployeeId] = useState<number | null>(user?.employee_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const employees = useAsync(() => api.get<Page<Employee>>("/employees", { status: "activo", limit: 500 }), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (user) {
        await api.patch(`/users/${user.id}`, {
          full_name: fullName,
          role,
          is_active: active,
          employee_id: employeeId,
          ...(password ? { password } : {}),
        });
      } else {
        await api.post("/users", { username, full_name: fullName, role, password, employee_id: employeeId });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={user ? `Editar ${user.username}` : "Nuevo usuario"} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Usuario</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!user} required minLength={3} pattern="[a-zA-Z0-9._\-]+" />
          </label>
          <label className="field">
            <span>Nombre completo</span>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Rol</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
              {Object.entries(ROLE_LABEL).filter(([value]) => value !== "supervisor" || user?.role === "supervisor").map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{user ? "Nueva contraseña (dejar vacío para no cambiar)" : "Contraseña"}</span>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required={!user} />
          </label>
          <label className="field full">
            <span>Empleado vinculado (el rol Empleado ve el perfil de esta ficha)</span>
            <select
              className="input"
              value={employeeId ?? ""}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                setEmployeeId(id);
                const emp = employees.data?.items.find((x) => x.id === id);
                if (emp && !fullName) setFullName(emp.full_name);
              }}
            >
              <option value="">Ninguno</option>
              {employees.data?.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </select>
          </label>
          {user && !isSelf && (
            <label className="check full">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Usuario activo
            </label>
          )}
        </div>
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
