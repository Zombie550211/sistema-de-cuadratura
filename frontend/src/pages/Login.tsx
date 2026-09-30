import { useState, type FormEvent } from "react";

import { useNow } from "../components/LiveClock";
import { useAuth } from "../lib/auth";
import { fmtDayLabel, TZ } from "../lib/format";

const hmFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function Login() {
  const { login } = useAuth();
  const now = useNow();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim().toLowerCase(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art" aria-hidden>
        <div className="big-orbit">
          <div className="ring r1" />
          <div className="ring r2" />
          <div className="ring r3" />
          <div className="sat" />
          <div className="sat s2" />
          <div className="center">
            <div>
              <div className="time">{hmFmt.format(now)}</div>
              <div className="caption" style={{ marginTop: 8 }}>
                {fmtDayLabel(now)}
              </div>
            </div>
          </div>
        </div>
        <div className="tagline">
          <h2>Cada minuto, cuadrado.</h2>
          <p className="muted">Marcaciones, horarios y planillas de Connecting en un solo lugar.</p>
        </div>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">C</div>
            <div>
              <strong>Connecting</strong>
              <span className="caption">Asistencia y planillas</span>
            </div>
          </div>
          <div>
            <h1>Bienvenido</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Ingrese con su usuario asignado.
            </p>
          </div>
          {error && <div className="alert">{error}</div>}
          <label className="field">
            <span>Usuario</span>
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>Contraseña</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className="btn" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </section>
    </div>
  );
}
