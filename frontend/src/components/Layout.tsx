import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { AREAS, type Role } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABEL } from "../lib/format";
import { IconCalendar, IconChevronDown, IconClock, IconHome, IconLink, IconLogout, IconRepeat, IconShield, IconSun, IconUpload, IconUsers } from "./Icons";
import { LiveClock } from "./LiveClock";

const LINKS: { to: string; label: string; icon: typeof IconHome; roles: Role[] }[] = [
  { to: "/", label: "Inicio", icon: IconHome, roles: ["admin", "rrhh"] },
  { to: "/marcaciones", label: "Marcaciones", icon: IconClock, roles: ["admin", "rrhh"] },
  { to: "/importar", label: "Importar reloj", icon: IconUpload, roles: ["admin", "rrhh"] },
  { to: "/horarios", label: "Horarios", icon: IconCalendar, roles: ["admin", "rrhh"] },
  { to: "/vacaciones", label: "Días de vacación", icon: IconSun, roles: ["admin", "rrhh"] },
  { to: "/compensatorios", label: "Días compensatorio", icon: IconRepeat, roles: ["admin", "rrhh"] },
  { to: "/empleados", label: "Empleados", icon: IconUsers, roles: ["admin", "rrhh"] },
  { to: "/integraciones", label: "Integración CRM", icon: IconLink, roles: ["admin", "rrhh"] },
  { to: "/usuarios", label: "Usuarios", icon: IconShield, roles: ["admin"] },
];

/** Empleados, Horarios y los días libres se despliegan en sus secciones; quedan abiertos mientras se navega
 *  dentro de ellas. */
function SectionNav({ base, label, icon: Icon }: { base: string; label: string; icon: typeof IconHome }) {
  const inside = useLocation().pathname.startsWith(base);
  const [open, setOpen] = useState(inside);
  const shown = open || inside;
  return (
    <div className="nav-group">
      <button type="button" className={`nav-parent${inside ? " active" : ""}`} aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <Icon />
        {label}
        <IconChevronDown className={`nav-caret${shown ? " open" : ""}`} />
      </button>
      {shown && (
        <div className="nav-sub">
          {AREAS.map((a) => (
            <NavLink key={a.slug} to={`${base}/${a.slug}`}>
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
            ["/empleados", "/horarios", "/vacaciones", "/compensatorios"].includes(to) ? (
              <SectionNav key={to} base={to} label={label} icon={Icon} />
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
