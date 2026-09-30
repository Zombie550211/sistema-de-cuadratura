import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import type { Role } from "./lib/api";
import { AuthProvider, useAuth } from "./lib/auth";
import { Dashboard } from "./pages/Dashboard";
import { EmployeeProfile, EmployeeProfilePage } from "./pages/EmployeeProfile";
import { Employees } from "./pages/Employees";
import { Import } from "./pages/Import";
import { Integrations } from "./pages/Integrations";
import { Login } from "./pages/Login";
import { Punches } from "./pages/Punches";
import { Schedules } from "./pages/Schedules";
import { Users } from "./pages/Users";

const STAFF: Role[] = ["admin", "rrhh", "supervisor"];

function Guard({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(...roles) ? children : <Navigate to="/" replace />;
}

function App() {
  const { user, loading, logout } = useAuth();
  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }
  if (!user) return <Login />;
  if (user.role === "empleado") {
    // Portal del agente: ve su propio perfil con el horario que llegó del CRM y sus marcas.
    return (
      <main className="main">
        <div className="page-head" style={{ maxWidth: 1240, margin: "0 auto 24px" }}>
          <span className="caption">Portal del empleado · Connecting</span>
          <button className="btn ghost sm" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
        {user.employee_id ? (
          <EmployeeProfile employeeId={user.employee_id} />
        ) : (
          <div className="card" style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
            <h2>Usuario sin vincular</h2>
            <p className="muted">Pida a Recursos Humanos que vincule su usuario con su ficha de empleado.</p>
          </div>
        )}
      </main>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="marcaciones" element={<Punches />} />
        <Route path="importar" element={<Guard roles={["admin", "rrhh"]}><Import /></Guard>} />
        <Route path="horarios" element={<Guard roles={STAFF}><Schedules /></Guard>} />
        <Route path="empleados" element={<Guard roles={STAFF}><Employees /></Guard>} />
        <Route path="empleados/:id" element={<Guard roles={STAFF}><EmployeeProfilePage /></Guard>} />
        <Route path="integraciones" element={<Guard roles={["admin", "rrhh"]}><Integrations /></Guard>} />
        <Route path="usuarios" element={<Guard roles={["admin"]}><Users /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
