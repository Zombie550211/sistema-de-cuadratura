import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { AREAS, type Role } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABEL } from "../lib/format";
import { IconCalendar, IconChevronDown, IconChevronLeft, IconClock, IconFile, IconHome, IconLink, IconLogout, IconRepeat, IconShield, IconSun, IconUsers } from "./Icons";

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconHome;
  roles: Role[];
  /** Se despliega en las 3 áreas (Administrativo, Operativo, Agentes de ventas). */
  areas?: boolean;
}

const SECTIONS: { title: string; links: NavItem[] }[] = [
  {
    title: "Principal",
    links: [
      { to: "/", label: "Inicio", icon: IconHome, roles: ["admin", "rrhh"] },
      { to: "/marcaciones", label: "Marcaciones", icon: IconClock, roles: ["admin", "rrhh"] },
      { to: "/horarios", label: "Horarios", icon: IconCalendar, roles: ["admin", "rrhh"], areas: true },
    ],
  },
  {
    title: "Personal",
    links: [
      { to: "/empleados", label: "Empleados", icon: IconUsers, roles: ["admin", "rrhh"], areas: true },
      { to: "/vacaciones", label: "Días de vacación", icon: IconSun, roles: ["admin", "rrhh"], areas: true },
      { to: "/compensatorios", label: "Días compensatorio", icon: IconRepeat, roles: ["admin", "rrhh"], areas: true },
    ],
  },
  {
    title: "Sistema",
    links: [
      { to: "/recibos-google", label: "Recibos Google Ads", icon: IconFile, roles: ["admin", "rrhh"] },
      { to: "/integraciones", label: "Integración CRM", icon: IconLink, roles: ["admin", "rrhh"] },
      { to: "/usuarios", label: "Usuarios", icon: IconShield, roles: ["admin"] },
    ],
  },
];


/** Empleados, Horarios y los días libres se despliegan en sus áreas, con líneas de árbol; quedan
 *  abiertos mientras se navega dentro. Con la barra contraída, las áreas salen en un menú flotante. */
function SectionNav({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { pathname } = useLocation();
  const inside = pathname.startsWith(item.to);
  const [open, setOpen] = useState(inside);
  const [fly, setFly] = useState<{ top: number; left: number } | null>(null);
  const shown = open || inside;
  const Icon = item.icon;

  useEffect(() => setFly(null), [pathname, collapsed]);

  if (collapsed) {
    return (
      <div className="sb-group">
        <button
          type="button"
          className={`sb-link${inside ? " active" : ""}${fly ? " hover" : ""}`}
          title={item.label}
          aria-label={item.label}
          aria-expanded={!!fly}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFly(fly ? null : { top: r.top, left: r.right + 14 });
          }}
        >
          <Icon />
        </button>
        {fly && (
          <>
            <div className="sb-fly-backdrop" onClick={() => setFly(null)} />
            <div className="sb-fly" style={fly}>
              <span className="sb-fly-title">{item.label}</span>
              {AREAS.map((a) => (
                <NavLink key={a.slug} to={`${item.to}/${a.slug}`}>
                  {a.label}
                </NavLink>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="sb-group">
      <button type="button" className={`sb-link${inside ? " active" : ""}`} aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <Icon />
        <span className="sb-label">{item.label}</span>
        <IconChevronDown className={`sb-caret${shown ? " open" : ""}`} />
      </button>
      {shown && (
        <div className="sb-sub">
          {AREAS.map((a) => (
            <NavLink key={a.slug} to={`${item.to}/${a.slug}`}>
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
  const [menu, setMenu] = useState(false);
  // Contraído por defecto. Abierto se despliega encima de la página (no la empuja) y se cierra al
  // elegir una sección o al tocar fuera.
  const [collapsed, setCollapsed] = useState(true);
  const { pathname } = useLocation();
  useEffect(() => setCollapsed(true), [pathname]);
  const initials = user!.full_name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const toggle = () => setCollapsed(!collapsed);

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      {!collapsed && <div className="sb-scrim" onClick={() => setCollapsed(true)} aria-hidden />}
      <aside className="sidebar">
        <div className="sb-panel">
          <div className="sb-user">
            <button className="sb-me" onClick={() => setMenu(!menu)} aria-expanded={menu} title="Opciones de la cuenta">
              <div className="sb-avatar">{initials}</div>
              <div className="sb-who">
                <span>{ROLE_LABEL[user!.role]}</span>
                <b>{user!.full_name}</b>
              </div>
            </button>
            {menu && (
              <>
                <div className="sb-fly-backdrop" onClick={() => setMenu(false)} />
                <div className="sb-menu">
                  <button onClick={logout}>
                    <IconLogout /> Cerrar sesión
                  </button>
                </div>
              </>
            )}
            <button className="sb-toggle" onClick={toggle} aria-label={collapsed ? "Expandir menú" : "Contraer menú"} title={collapsed ? "Expandir menú" : "Contraer menú"}>
              <IconChevronLeft />
            </button>
          </div>

          <nav className="sb-nav">
            {SECTIONS.map((s) => {
              const links = s.links.filter((l) => can(...l.roles));
              if (!links.length) return null;
              return (
                <div key={s.title} className="sb-section">
                  <span className="sb-title">{s.title}</span>
                  {links.map((item) =>
                    item.areas ? (
                      <SectionNav key={item.to} item={item} collapsed={collapsed} />
                    ) : (
                      <NavLink key={item.to} to={item.to} end={item.to === "/"} className="sb-link" title={collapsed ? item.label : undefined}>
                        <item.icon />
                        <span className="sb-label">{item.label}</span>
                      </NavLink>
                    ),
                  )}
                </div>
              );
            })}
          </nav>

        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
