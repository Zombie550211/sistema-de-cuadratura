import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";

import { useNow } from "../components/LiveClock";
import { useAuth } from "../lib/auth";
import { fmtDayLabel, TZ } from "../lib/format";

const hmFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const ssFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, second: "2-digit" });

interface Star {
  x: string;
  y: string;
  d: string;
  c: string;
  o?: string;
  glow?: string;
  twinkle?: string;
}

/** Estrellas con semilla fija: el cielo es el mismo en cada visita. */
function makeStars() {
  let seed = 20261002;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tints = ["#FFFFFF", "#FFFFFF", "#CFE4FF", "#FFE9C4", "#BFD8FF"];
  const tint = () => tints[Math.floor(rnd() * tints.length)];
  const far: Star[] = Array.from({ length: 170 }, () => ({
    x: (rnd() * 100).toFixed(2),
    y: (rnd() * 100).toFixed(2),
    d: (1 + rnd() * 0.7).toFixed(1),
    o: (0.25 + rnd() * 0.5).toFixed(2),
    c: tint(),
  }));
  const near: Star[] = Array.from({ length: 42 }, () => {
    const d = 1.6 + rnd() * rnd() * 2;
    const c = tint();
    const t = rnd();
    return {
      x: (rnd() * 100).toFixed(2),
      y: (rnd() * 100).toFixed(2),
      d: d.toFixed(1),
      c,
      glow: `0 0 ${(d * 3).toFixed(0)}px ${(d * 0.5).toFixed(1)}px rgba(200,225,255,0.45)`,
      twinkle: t < 0.2 ? "lg-tw" : t < 0.4 ? "lg-tw2" : "",
    };
  });
  return { far, near };
}

export function Login() {
  const { login } = useAuth();
  const now = useNow();
  const stars = useMemo(makeStars, []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Escriba su usuario y su contraseña para ingresar.");
      return;
    }
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

  const checkCaps = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);

  return (
    <div className="lg">
      <div className="lg-side">
        <div className="lg-brand">
          <div className="lg-mark" aria-hidden>
            C
          </div>
          <div>
            <div className="lg-brand-name">Connecting</div>
            <div className="lg-brand-sub">Asistencia y planillas</div>
          </div>
        </div>

        <main className="lg-main">
          <div className="lg-head">
            <h1>Bienvenido</h1>
            <p>Ingrese con su usuario asignado.</p>
          </div>

          <form onSubmit={submit} noValidate className="lg-form">
            <div className="lg-group">
              <label htmlFor="usuario">Usuario</label>
              <div className="lg-field">
                <input
                  id="usuario"
                  name="usuario"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError(null);
                  }}
                  autoFocus
                />
              </div>
            </div>

            <div className="lg-group">
              <label htmlFor="clave">Contraseña</label>
              <div className="lg-field">
                <input
                  id="clave"
                  name="clave"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  onKeyUp={checkCaps}
                  onKeyDown={checkCaps}
                />
                <button type="button" className="lg-toggle" onClick={() => setShow(!show)} aria-pressed={show}>
                  {show ? "Ocultar" : "Mostrar"}
                </button>
              </div>
              {caps && <div className="lg-caps">Bloq Mayús está activado.</div>}
            </div>

            {error && (
              <div role="alert" className="lg-error">
                {error}
              </div>
            )}

            <button type="submit" className="lg-submit" disabled={busy}>
              {busy ? "Ingresando…" : "Ingresar"}
            </button>
          </form>
        </main>

        <div className="lg-help">¿Problemas para ingresar? Contacte a Recursos Humanos.</div>
      </div>

      <div className="lg-space">
        <div className="lg-far" aria-hidden>
          {stars.far.map((s, i) => (
            <div key={i} className="lg-star" style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.d}px`, height: `${s.d}px`, background: s.c, opacity: s.o }} />
          ))}
        </div>
        <div className="lg-near" aria-hidden>
          {stars.near.map((s, i) => (
            <div key={i} className={`lg-star ${s.twinkle}`} style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.d}px`, height: `${s.d}px`, background: s.c, boxShadow: s.glow }} />
          ))}
        </div>
        <div className="lg-shoot-track" aria-hidden>
          <div className="lg-shoot" />
        </div>

        <SpaceScene />

        <div className="lg-clock">
          <div className="lg-time">
            <span>{hmFmt.format(now)}</span>
            <span className="lg-sec">{ssFmt.format(now).padStart(2, "0")}</span>
          </div>
          <div className="lg-date">{fmtDayLabel(now)}</div>
        </div>

        <div className="lg-astro-wrap">
          <Astronaut />
        </div>

        <div className="lg-tagline">
          <h2>Cada minuto, cuadrado.</h2>
          <p>Marcaciones, horarios y planillas de Connecting en un solo lugar.</p>
        </div>
      </div>
    </div>
  );
}

/** Nebulosa, luna y planeta con anillos. */
function SpaceScene() {
  return (
    <svg aria-hidden viewBox="0 0 1000 900" preserveAspectRatio="xMidYMid slice" className="lg-scene">
      <defs>
        <filter id="lgNebA" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0035 0.005" numOctaves={5} seed={11} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.24  0 0 0 0 0.78  1.9 0 0 0 -0.85" />
        </filter>
        <filter id="lgNebB" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.004 0.003" numOctaves={5} seed={4} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.5  0 0 0 0 0.62  0 1.9 0 0 -0.9" />
        </filter>
        <filter id="lgNebC" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.004" numOctaves={4} seed={23} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.85  0 0 0 0 0.5  0 0 0 0 0.25  0 0 1.7 0 -0.9" />
        </filter>
        <filter id="lgGas" filterUnits="userSpaceOnUse" x="-185" y="-185" width="370" height="370" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.005 0.045" numOctaves={4} seed={8} />
          <feColorMatrix type="matrix" values="0.9 0 0 0 -0.12  0.8 0 0 0 0.12  0.6 0 0 0 0.3  0 0 0 0 1" />
        </filter>
        <filter id="lgRock" filterUnits="userSpaceOnUse" x="-40" y="-40" width="80" height="80" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves={4} seed={3} />
          <feColorMatrix type="matrix" values="0.7 0 0 0 0.12  0.7 0 0 0 0.12  0.7 0 0 0 0.13  0 0 0 0 1" />
        </filter>
        <filter id="lgSoft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <radialGradient id="lgSun" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#FFF2D6" stopOpacity="0.26" />
          <stop offset="1" stopColor="#FFF2D6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lgHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#17869C" stopOpacity="0.22" />
          <stop offset="1" stopColor="#17869C" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lgPLight" cx="30%" cy="25%" r="50%">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.32" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lgPShade" cx="30%" cy="26%" r="90%">
          <stop offset="0" stopColor="#01060A" stopOpacity="0" />
          <stop offset="0.5" stopColor="#01060A" stopOpacity="0" />
          <stop offset="0.78" stopColor="#01060A" stopOpacity="0.72" />
          <stop offset="1" stopColor="#01060A" stopOpacity="0.97" />
        </radialGradient>
        <linearGradient id="lgAtmo" gradientUnits="userSpaceOnUse" x1="-180" y1="-180" x2="90" y2="90">
          <stop offset="0" stopColor="#9BEBFA" stopOpacity="0.9" />
          <stop offset="1" stopColor="#9BEBFA" stopOpacity="0" />
        </linearGradient>
        <clipPath id="lgPClip">
          <circle cx="0" cy="0" r="180" />
        </clipPath>
        <clipPath id="lgMClip">
          <circle cx="0" cy="0" r="34" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width="1000" height="900" filter="url(#lgNebA)" opacity="0.5" />
      <rect x="0" y="0" width="1000" height="900" filter="url(#lgNebB)" opacity="0.38" />
      <rect x="0" y="0" width="1000" height="900" filter="url(#lgNebC)" opacity="0.22" />
      <circle cx="0" cy="0" r="540" fill="url(#lgSun)" />
      <circle cx="500" cy="450" r="380" fill="url(#lgHalo)" />
      <g transform="translate(118 660)">
        <circle cx="0" cy="0" r="34" fill="#8E969B" />
        <g clipPath="url(#lgMClip)">
          <rect x="-34" y="-34" width="68" height="68" filter="url(#lgRock)" />
          <ellipse cx="-9" cy="-7" rx="8" ry="7" fill="#3E4549" opacity="0.5" />
          <ellipse cx="-8" cy="-6" rx="7" ry="6" fill="#70787D" opacity="0.6" />
          <ellipse cx="11" cy="9" rx="6" ry="5" fill="#3E4549" opacity="0.5" />
          <ellipse cx="4" cy="-18" rx="4" ry="3.4" fill="#3E4549" opacity="0.45" />
          <ellipse cx="-14" cy="14" rx="3.4" ry="3" fill="#3E4549" opacity="0.45" />
          <circle cx="0" cy="0" r="34" fill="url(#lgPLight)" />
          <circle cx="0" cy="0" r="34" fill="url(#lgPShade)" />
        </g>
      </g>
      <g transform="translate(880 812) rotate(-16)">
        <g fill="none" stroke="#E9D3A1">
          <ellipse cx="0" cy="0" rx="300" ry="60" strokeWidth="10" opacity="0.38" />
          <ellipse cx="0" cy="0" rx="286" ry="57" strokeWidth="3" opacity="0.2" />
          <ellipse cx="0" cy="0" rx="266" ry="53" strokeWidth="16" opacity="0.26" />
          <ellipse cx="0" cy="0" rx="244" ry="48.5" strokeWidth="3" opacity="0.16" />
        </g>
        <circle cx="0" cy="0" r="186" fill="#3FC0D8" opacity="0.28" filter="url(#lgSoft)" />
        <circle cx="0" cy="0" r="180" fill="#0F5566" />
        <g clipPath="url(#lgPClip)">
          <rect x="-185" y="-185" width="370" height="370" filter="url(#lgGas)" />
          <circle cx="0" cy="0" r="180" fill="url(#lgPLight)" />
          <circle cx="0" cy="0" r="180" fill="url(#lgPShade)" />
        </g>
        <circle cx="0" cy="0" r="180" fill="none" stroke="url(#lgAtmo)" strokeWidth="2.5" />
        <g fill="none" stroke="#E9D3A1">
          <path d="M -300 0 A 300 60 0 0 0 300 0" strokeWidth="10" opacity="0.62" />
          <path d="M -286 0 A 286 57 0 0 0 286 0" strokeWidth="3" opacity="0.32" />
          <path d="M -266 0 A 266 53 0 0 0 266 0" strokeWidth="16" opacity="0.44" />
          <path d="M -244 0 A 244 48.5 0 0 0 244 0" strokeWidth="3" opacity="0.26" />
        </g>
      </g>
    </svg>
  );
}

function Astronaut() {
  return (
    <svg className="lg-astro" role="img" aria-label="Astronauta flotando en el espacio" viewBox="0 0 420 530">
      <defs>
        <filter id="lgVol" filterUnits="userSpaceOnUse" x="-40" y="-40" width="500" height="620" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b" />
          <feDiffuseLighting in="b" surfaceScale="9" diffuseConstant="1.15" lightingColor="#FFF6E8" result="d">
            <feDistantLight azimuth="225" elevation="58" />
          </feDiffuseLighting>
          <feComposite in="d" in2="SourceAlpha" operator="in" result="dl" />
          <feBlend in="SourceGraphic" in2="dl" mode="multiply" result="lit" />
          <feSpecularLighting in="b" surfaceScale="9" specularConstant="0.8" specularExponent="9" lightingColor="#3FC0D8" result="sp">
            <feDistantLight azimuth="40" elevation="14" />
          </feSpecularLighting>
          <feComposite in="sp" in2="SourceAlpha" operator="in" result="sr" />
          <feComposite in="sr" in2="lit" operator="arithmetic" k1="0" k2="0.7" k3="1" k4="0" />
        </filter>
        <filter id="lgBlur2" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <radialGradient id="lgGold" cx="30%" cy="25%" r="90%">
          <stop offset="0" stopColor="#FFF1C2" />
          <stop offset="0.35" stopColor="#E9B23C" />
          <stop offset="0.7" stopColor="#8C5A0E" />
          <stop offset="1" stopColor="#231603" />
        </radialGradient>
        <clipPath id="lgVClip">
          <rect x="160" y="74" width="100" height="84" rx="38" />
        </clipPath>
      </defs>
      <path d="M 124 300 C 50 330 70 440 -80 470" fill="none" stroke="#3B4449" strokeWidth="7" strokeLinecap="round" />
      <path d="M 124 300 C 50 330 70 440 -80 470" fill="none" stroke="#C9D2D6" strokeWidth="3.5" strokeLinecap="round" />
      <g filter="url(#lgVol)">
        <rect x="120" y="150" width="180" height="200" rx="26" fill="#AEB6BB" />
      </g>
      <g filter="url(#lgVol)">
        <path d="M 184 350 L 172 420 L 178 480" fill="none" stroke="#E7EAEB" strokeWidth="54" strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="172" cy="420" rx="29" ry="9" fill="#B9C1C5" />
        <rect x="146" y="472" width="64" height="40" rx="18" fill="#8D979D" />
        <rect x="144" y="500" width="68" height="12" rx="6" fill="#4A5357" />
      </g>
      <g filter="url(#lgVol)">
        <path d="M 238 350 L 256 418 L 250 478" fill="none" stroke="#E7EAEB" strokeWidth="54" strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="256" cy="418" rx="29" ry="9" fill="#B9C1C5" />
        <rect x="220" y="470" width="64" height="40" rx="18" fill="#8D979D" />
        <rect x="218" y="498" width="68" height="12" rx="6" fill="#4A5357" />
      </g>
      <g filter="url(#lgVol)">
        <path d="M 152 212 L 98 268 L 80 332" fill="none" stroke="#E7EAEB" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="74" cy="356" rx="21" ry="25" transform="rotate(12 74 356)" fill="#A2ABB0" />
        <ellipse cx="80" cy="334" rx="25" ry="9" transform="rotate(14 80 334)" fill="#7C868C" />
      </g>
      <rect x="104" y="238" width="20" height="20" rx="5" transform="rotate(-46 114 248)" fill="#0B7285" />
      <g filter="url(#lgVol)">
        <path d="M 268 212 L 326 258 L 346 322" fill="none" stroke="#E7EAEB" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="352" cy="346" rx="21" ry="25" transform="rotate(-14 352 346)" fill="#A2ABB0" />
        <ellipse cx="347" cy="324" rx="25" ry="9" transform="rotate(-16 347 324)" fill="#7C868C" />
      </g>
      <g filter="url(#lgVol)">
        <rect x="138" y="180" width="144" height="190" rx="50" fill="#ECEEEF" />
      </g>
      <g filter="url(#lgVol)">
        <rect x="146" y="328" width="128" height="16" rx="8" fill="#B9C1C5" />
      </g>
      <path d="M 172 266 C 148 274 140 302 150 328" fill="none" stroke="#7C868C" strokeWidth="6" strokeLinecap="round" />
      <path d="M 248 266 C 272 274 280 302 270 328" fill="none" stroke="#6A747A" strokeWidth="6" strokeLinecap="round" />
      <g filter="url(#lgVol)">
        <rect x="168" y="236" width="84" height="56" rx="9" fill="#C9CFD2" />
      </g>
      <circle cx="186" cy="254" r="5" fill="#F5B942" />
      <circle cx="203" cy="254" r="5" fill="#35B4CC" />
      <rect x="218" y="247" width="24" height="13" rx="3" fill="#20282C" />
      <circle cx="188" cy="276" r="6" fill="#5F696E" />
      <circle cx="208" cy="276" r="6" fill="#5F696E" />
      <rect x="224" y="270" width="18" height="12" rx="3" fill="#5F696E" />
      <g filter="url(#lgVol)">
        <ellipse cx="210" cy="186" rx="56" ry="15" fill="#9AA4AA" />
      </g>
      <g filter="url(#lgVol)">
        <rect x="126" y="98" width="20" height="42" rx="7" fill="#A7B0B5" />
        <rect x="274" y="98" width="20" height="42" rx="7" fill="#A7B0B5" />
        <circle cx="210" cy="116" r="72" fill="#F1F2F3" />
      </g>
      <rect x="160" y="74" width="100" height="84" rx="38" fill="url(#lgGold)" />
      <g clipPath="url(#lgVClip)">
        <circle cx="266" cy="176" r="52" fill="#2AA3BB" opacity="0.5" />
        <ellipse cx="198" cy="104" rx="32" ry="9" transform="rotate(-28 198 104)" fill="#FFFFFF" opacity="0.22" />
        <circle cx="182" cy="96" r="8" fill="#FFFFFF" opacity="0.95" filter="url(#lgBlur2)" />
      </g>
      <rect x="160" y="74" width="100" height="84" rx="38" fill="none" stroke="#4A5357" strokeWidth="4" />
      <circle cx="136" cy="106" r="7" fill="#FFF6D6" opacity="0.7" filter="url(#lgBlur2)" />
      <circle cx="136" cy="106" r="3" fill="#FFFFFF" />
    </svg>
  );
}
