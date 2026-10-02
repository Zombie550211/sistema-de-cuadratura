import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { AREAS, type Role } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABEL } from "../lib/format";
import { IconCalendar, IconChevronDown, IconClock, IconHome, IconLink, IconLogout, IconShield, IconUpload, IconUsers } from "./Icons";
import { LiveClock } from "./LiveClock";

const LINKS: { to: string; label: string; icon: typeof IconHome; roles: Role[] }[] = [
  { to: "/", label: "Inicio", icon: IconHome, roles: ["admin", "rrhh", "supervisor"] },
  { to: "/marcaciones", label: "Marcaciones", icon: IconClock, roles: ["admin", "rrhh", "supervisor"] },
  { to: "/importar", label: "Importar reloj", icon: IconUpload, roles: ["admin", "rrhh"] },
  { to: "/horarios", label: "Horarios", icon: IconCalendar, roles: ["admin", "rrhh", "supervisor"] },
  { to: "/empleados", label: "Empleados", icon: IconUsers, roles: ["admin", "rrhh", "supervisor"] },
  { to: "/integraciones", label: "Integración CRM", icon: IconLink, roles: ["admin", "rrhh"] },
  { to: "/usuarios", label: "Usuarios", icon: IconShield, roles: ["admin"] },
];

/** Empleados se despliega en sus 4 secciones; queda abierto mientras se navega dentro de ellas. */
function EmployeesNav() {
  const inside = useLocation().pathname.startsWith("/empleados");
  const [open, setOpen] = useState(inside);
  const shown = open || inside;
  return (
    <div className="nav-group">
      <button type="button" className={`nav-parent${inside ? " active" : ""}`} aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <IconUsers />
        Empleados
        <IconChevronDown className={`nav-caret${shown ? " open" : ""}`} />
      </button>
      {shown && (
        <div className="nav-sub">
          {AREAS.map((a) => (
            <NavLink key={a.slug} to={`/empleados/${a.slug}`}>
              {a.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout, can } = useAuth();
  const initials = user!.full_name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <strong>Connecting</strong>
            <span className="caption">Asistencia y planillas</span>
          </div>
        </div>
        <nav className="nav">
          {LINKS.filter((l) => can(...l.roles)).map(({ to, label, icon: Icon }) =>
            to === "/empleados" ? (
              <EmployeesNav key={to} />
            ) : (
              <NavLink key={to} to={to} end={to === "/"}>
                <Icon />
                {label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <LiveClock />
          <div className="user-chip">
            <div className="avatar">{initials}</div>
            <div className="who">
              <div>{user!.full_name}</div>
              <div className="caption">{ROLE_LABEL[user!.role]}</div>
            </div>
            <button className="icon-btn" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">
              <IconLogout width={20} height={20} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
