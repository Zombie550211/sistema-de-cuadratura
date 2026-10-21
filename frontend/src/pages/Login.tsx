import { useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";

import { IconEye, IconEyeOff } from "../components/Icons";
import { useNow } from "../components/LiveClock";
import { useAuth } from "../lib/auth";
import { fmtDayLabel, TZ } from "../lib/format";

/** Usuario recordado en este navegador (opcional, nunca la contraseña). */
const REMEMBER_KEY = "connecting.login.usuario";

function readRemembered() {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? "";
  } catch {
    return "";
  }
}

const hmFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function Login() {
  const { login } = useAuth();
  const now = useNow(15000);
  const [username, setUsername] = useState(readRemembered);
  const [remember, setRemember] = useState(() => readRemembered() !== "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [forgot, setForgot] = useState(false);
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
      if (remember) localStorage.setItem(REMEMBER_KEY, username.trim().toLowerCase());
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* sin almacenamiento: se ignora */
    }
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
      <GalaxyScene />
      <Mountains />

      <main className="lg-card">
        <h1>Iniciar sesión</h1>
        <p className="lg-sub">Connecting S.A. de C.V.</p>

        <form onSubmit={submit} noValidate className="lg-form">
          <label className="sr-only" htmlFor="usuario">
            Usuario
          </label>
          <input
            id="usuario"
            name="usuario"
            className="lg-input"
            autoComplete="username"
            placeholder="Usuario"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            autoFocus={!username}
          />

          <label className="sr-only" htmlFor="clave">
            Contraseña
          </label>
          <div className="lg-pass">
            <input
              id="clave"
              name="clave"
              className="lg-input"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Contraseña"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              onKeyUp={checkCaps}
              onKeyDown={checkCaps}
              autoFocus={!!username}
            />
            <button
              type="button"
              className="lg-toggle"
              onClick={() => setShow(!show)}
              aria-pressed={show}
              aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
            >
              {show ? <IconEyeOff width={17} height={17} /> : <IconEye width={17} height={17} />}
            </button>
          </div>
          {caps && <div className="lg-caps">Bloq Mayús está activado.</div>}

          <div className="lg-paragraphs">
            <button type="button" className="lg-link" onClick={() => setForgot(!forgot)} aria-expanded={forgot}>
              ¿Olvidó su contraseña?
            </button>
            <label className="lg-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Recordarme
            </label>
          </div>
          {forgot && <div className="lg-note">Solicite a Recursos Humanos que restablezca su contraseña.</div>}

          {error && (
            <div role="alert" className="lg-error">
              {error}
            </div>
          )}

          <button type="submit" className="lg-submit" disabled={busy}>
            {busy ? "Verificando…" : "Ingresar"}
          </button>
        </form>

        <p className="lg-time">
          {fmtDayLabel(now)} · {hmFmt.format(now)}
        </p>
      </main>
    </div>
  );
}

/** Estrellas con semilla fija: el cielo es el mismo en cada visita. */
function makeStars() {
  let seed = 20261019;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tints = ["#FFFFFF", "#FFFFFF", "#CFE0FF", "#FFE6C4"];
  return Array.from({ length: 260 }, (_, i) => ({
    x: rnd() * 1600,
    y: rnd() * 640,
    r: i < 230 ? 0.5 + rnd() * 0.9 : 1.4 + rnd() * 1.2,
    o: 0.35 + rnd() * 0.65,
    c: tints[Math.floor(rnd() * tints.length)],
    tw: rnd() < 0.15,
  }));
}
const STARS = makeStars();

/** Anillos del planeta grande: [radio x, color, grosor, opacidad, trazo]. El alto es 1/4.6 del ancho.
 *  El trazo da textura (segmentos y partículas) para que se note el giro. */
const RINGS: [number, string, number, number, string][] = [
  [262, "#F6D9A8", 6, 0.55, "60 5 18 4 90 6"],
  [276, "#E3A866", 3, 0.45, "30 7 70 5"],
  [292, "#FBE6BF", 10, 0.5, "120 4 40 7 70 3"],
  [301, "#FFF4DC", 1.8, 0.85, "0.1 8"],
  [312, "#C98A4E", 3, 0.4, "50 9 20 6"],
  [326, "#F3CE94", 7, 0.42, "90 6 30 4"],
  [340, "#FFE9C2", 2, 0.75, "0.1 12"],
  [352, "#FFF0D2", 1.5, 0.5, "40 10 8 10"],
  [372, "#E9B67A", 4, 0.3, "70 12 25 8"],
  [430, "#F3C98B", 2, 0.35, "260 60 90 40"],
  [470, "#FFE9C2", 1.6, 0.5, "0.1 16"],
  [500, "#BFD0FF", 1.2, 0.35, "120 50 300 30"],
  [580, "#FFE2B0", 2.5, 0.3, "340 80 60 40"],
  [670, "#E39A50", 7, 0.14, "500 140"],
];

/** Media elipse de cada anillo: "back" pasa por arriba (detrás del planeta), "front" por abajo.
 *  El trazo avanza con stroke-dashoffset; los anillos interiores giran más rápido (como en Kepler). */
function Rings({ half }: { half: "back" | "front" }) {
  const sweep = half === "back" ? 1 : 0;
  return (
    <g fill="none" strokeLinecap="round">
      {RINGS.map(([rx, c, w, o, dash]) => {
        const ry = rx / 4.6;
        const period = dash.split(" ").reduce((t, n) => t + Number(n), 0);
        const style = { "--p": `${period}px`, animationDuration: `${(5 * (rx / 262) ** 1.5).toFixed(1)}s` } as CSSProperties;
        return (
          <path
            key={rx}
            className={`lg-ring-${half}`}
            style={style}
            d={`M${-rx} 0 A${rx} ${ry} 0 0 ${sweep} ${rx} 0`}
            stroke={c}
            strokeWidth={w}
            opacity={half === "front" ? Math.min(o * 1.25, 0.85) : o}
            strokeDasharray={dash}
          />
        );
      })}
    </g>
  );
}

/** Bandas del planeta grande: [y, alto, color, opacidad]. */
const BANDS: [number, number, string, number][] = [
  [-150, 14, "#7A2A0A", 0.37],
  [-112, 8, "#FFD39A", 0.37],
  [-70, 18, "#8E3610", 0.34],
  [-30, 6, "#FFE2B4", 0.42],
  [8, 22, "#7A2A0A", 0.31],
  [52, 9, "#FFCB8A", 0.37],
  [92, 16, "#6E240A", 0.37],
  [136, 7, "#FFD9A6", 0.34],
];
/** Banda ondulada más ancha que el planeta, para poder desplazarla sin que se vean los bordes. */
const band = (y: number, h: number) => {
  let d = `M-420 ${y}`;
  for (let x = -420; x < 420; x += 120) d += ` Q${x + 30} ${y - h * 0.35} ${x + 60} ${y} T${x + 120} ${y}`;
  d += ` L420 ${y + h}`;
  for (let x = 420; x > -420; x -= 120) d += ` Q${x - 30} ${y + h + h * 0.35} ${x - 60} ${y + h} T${x - 120} ${y + h}`;
  return d + " Z";
};

const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Galaxia: nebulosa, anillos de polvo, planetas y un viajero mirando desde las rocas. */
function GalaxyScene() {
  return (
    <svg aria-hidden viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" className="lg-bg">
      <defs>
        <linearGradient id="lgSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#03050E" />
          <stop offset="0.55" stopColor="#0B1430" />
          <stop offset="0.8" stopColor="#2B2346" />
          <stop offset="1" stopColor="#4A3550" />
        </linearGradient>
        <filter id="lgNebA" filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0025 0.004" numOctaves={5} seed={11} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.25  0 0 0 0 0.75  1.9 0 0 0 -0.85" />
        </filter>
        <filter id="lgNebB" filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.003 0.0025" numOctaves={5} seed={4} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.1  0 0 0 0 0.45  0 0 0 0 0.7  0 1.9 0 0 -0.9" />
        </filter>
        <filter id="lgNebC" filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.005 0.0035" numOctaves={4} seed={23} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.95  0 0 0 0 0.45  0 0 0 0 0.2  0 0 1.7 0 -0.95" />
        </filter>
        <filter id="lgGas" filterUnits="userSpaceOnUse" x="-200" y="-200" width="400" height="400" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.03" numOctaves={5} seed={8} />
          <feColorMatrix type="matrix" values="0.7 0 0 0 0.5  1.1 0 0 0 -0.12  0.5 0 0 0 -0.1  0 0 0 0 1" />
        </filter>
        <filter id="lgGasTan" filterUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.01 0.09" numOctaves={3} seed={5} />
          <feColorMatrix type="matrix" values="0.5 0 0 0 0.62  0.5 0 0 0 0.45  0.4 0 0 0 0.25  0 0 0 0 1" />
        </filter>
        <filter id="lgB3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
        <filter id="lgB12" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12" /></filter>
        <radialGradient id="lgShade" cx="32%" cy="30%" r="85%">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="0.45" stopColor="#000" stopOpacity="0" />
          <stop offset="0.8" stopColor="#05030A" stopOpacity="0.75" />
          <stop offset="1" stopColor="#05030A" stopOpacity="0.95" />
        </radialGradient>
        <radialGradient id="lgLight" cx="35%" cy="30%" r="50%">
          <stop offset="0" stopColor="#FFF4D8" stopOpacity="0.45" />
          <stop offset="1" stopColor="#FFF4D8" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lgGlowOrange" cx="50%" cy="50%" r="50%">
          <stop offset="0.6" stopColor="#FF8A2A" stopOpacity="0.45" />
          <stop offset="1" stopColor="#FF8A2A" stopOpacity="0" />
        </radialGradient>
        <clipPath id="lgPlanetClip"><circle r="190" /></clipPath>
        <clipPath id="lgTanClip"><circle r="40" /></clipPath>
      </defs>

      {/* Cielo y nebulosa */}
      <rect width="1600" height="900" fill="url(#lgSky)" />
      <rect width="1600" height="900" filter="url(#lgNebA)" opacity="0.45" />
      <rect width="1600" height="900" filter="url(#lgNebB)" opacity="0.35" />
      <rect width="1600" height="900" filter="url(#lgNebC)" opacity="0.25" />

      {/* Estrellas */}
      <g>
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill={s.c} opacity={s.o.toFixed(2)} className={s.tw ? "lg-tw" : undefined} />
        ))}
      </g>

      {/* Planeta pequeño arriba: deriva lenta y textura que gira */}
      <g className="lg-drift-a">
        <g transform="translate(560 120)">
          <circle r="40" fill="#B98B52" />
          <g clipPath="url(#lgTanClip)">
            <g className="lg-tex">
              <rect x="-60" y="-60" width="120" height="120" filter="url(#lgGasTan)" />
            </g>
            <circle r="40" fill="url(#lgLight)" />
            <circle r="40" fill="url(#lgShade)" />
          </g>
        </g>
      </g>
      {/* Planeta con bandas a la derecha, con su luna en órbita */}
      <g className="lg-drift-b">
        <g transform="translate(1270 300)">
          <circle r="62" fill="#FFB060" opacity="0.25" filter="url(#lgB12)" />
          <circle r="56" fill="#C98B4A" />
          <g clipPath="url(#lgTanClip)" transform="scale(1.4)">
            <g className="lg-tex lg-tex-slow">
              <rect x="-60" y="-60" width="120" height="120" filter="url(#lgGasTan)" />
            </g>
            <circle r="40" fill="url(#lgLight)" />
            <circle r="40" fill="url(#lgShade)" />
          </g>
          <g transform="rotate(-14)">
            <g>
              {!reduceMotion && <animateMotion dur="16s" repeatCount="indefinite" path="M175 0 A175 82 0 1 1 -175 0 A175 82 0 1 1 175 0" />}
              <g transform={reduceMotion ? "translate(175 0)" : undefined}>
                <circle r="15" fill="#E8B26A" transform="rotate(14)" />
                <circle r="15" fill="url(#lgShade)" transform="rotate(14)" />
              </g>
            </g>
          </g>
        </g>
      </g>

      <g className="lg-float-big">
      {/* Anillos: mitad trasera, detrás del planeta */}
      <g className="lg-rings">
        <Rings half="back" />
      </g>

      {/* Gran planeta naranja */}
      <g transform="translate(330 470)">
        <circle r="250" fill="url(#lgGlowOrange)" />
        <circle r="190" fill="#C4511A" />
        <g clipPath="url(#lgPlanetClip)">
          <rect x="-200" y="-200" width="400" height="400" filter="url(#lgGas)" transform="rotate(-12)" />
          {/* Bandas de nubes que corren con la rotación del planeta */}
          <g transform="rotate(-12)">
            <g className="lg-bands">
              {BANDS.map(([y, h, c, o], i) => (
                <path key={i} d={band(y, h)} fill={c} opacity={o} />
              ))}
            </g>
          </g>
          <circle r="190" fill="url(#lgLight)" />
          <circle r="190" fill="url(#lgShade)" />
        </g>
        <circle r="190" fill="none" stroke="#FFD7A0" strokeWidth="2" opacity="0.5" />
      </g>
      {/* Anillos: mitad delantera, cruzando la cara del planeta */}
      <g className="lg-rings">
        <Rings half="front" />
      </g>
      </g>

      {/* Chispas */}
      <g fill="#FFB062">
        <circle cx="1440" cy="600" r="3" filter="url(#lgB3)" />
        <circle cx="1460" cy="612" r="1.6" />
        <circle cx="760" cy="200" r="2.4" filter="url(#lgB3)" />
        <circle cx="1180" cy="640" r="2" />
      </g>

    </svg>
  );
}

type Pt = [number, number];

/** Cresta fractal: entre cada par de anclas desplaza el punto medio, cada vez con menos amplitud. */
function ridge(anchors: Pt[], amp: number, seed: number, depth = 6): Pt[] {
  let st = seed;
  const rnd = () => {
    st = (st * 1103515245 + 12345) & 0x7fffffff;
    return st / 0x7fffffff;
  };
  const out: Pt[] = [anchors[0]];
  const split = (a: Pt, b: Pt, h: number, d: number) => {
    if (d === 0) {
      out.push(b);
      return;
    }
    const m: Pt = [(a[0] + b[0]) / 2 + (rnd() - 0.5) * h * 0.3, (a[1] + b[1]) / 2 + (rnd() - 0.5) * h];
    split(a, m, h * 0.56, d - 1);
    split(m, b, h * 0.56, d - 1);
  };
  for (let i = 1; i < anchors.length; i++) split(anchors[i - 1], anchors[i], amp, depth);
  return out;
}
const line = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const land = (pts: Pt[]) => `${line(pts)} L${pts[pts.length - 1][0]} 900 L${pts[0][0]} 900 Z`;

const R_FAR = ridge([[0, 650], [140, 596], [260, 636], [380, 566], [520, 628], [640, 588], [780, 636], [900, 574], [1040, 618], [1130, 552], [1250, 606], [1360, 570], [1480, 622], [1600, 584]], 46, 11);
const R_MID = ridge([[0, 716], [160, 672], [300, 698], [460, 652], [600, 702], [760, 664], [900, 698], [1060, 646], [1200, 688], [1340, 656], [1480, 698], [1600, 664]], 32, 29);
const R_NEAR = ridge([[420, 900], [470, 800], [620, 776], [800, 796], [980, 764], [1120, 796], [1280, 774], [1420, 800], [1600, 782]], 22, 47, 5);
const R_LEFT = ridge([[0, 690], [60, 656], [120, 682], [175, 628], [240, 668], [300, 651], [350, 688], [420, 702], [480, 762], [520, 830], [560, 900]], 20, 5, 5);
const R_RIGHT = ridge([[1240, 900], [1320, 828], [1400, 812], [1460, 768], [1530, 786], [1600, 752]], 20, 71, 5);

/** Relieve de una cordillera: ruido iluminado desde el planeta, recortado a su silueta. */
function Relief({ id, d, filter, opacity }: { id: string; d: string; filter: string; opacity: number }) {
  return (
    <>
      <clipPath id={id}>
        <path d={d} />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        <rect width="1600" height="900" filter={`url(#${filter})`} opacity={opacity} />
      </g>
    </>
  );
}

/** Cordilleras con perspectiva atmosférica, lago, neblina y las rocas del viajero. Capa sin animaciones. */
function Mountains() {
  const far = land(R_FAR);
  const mid = land(R_MID);
  const near = land(R_NEAR);
  const left = land(R_LEFT);
  const right = land(R_RIGHT);
  return (
    <svg aria-hidden viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" className="lg-bg">
      <defs>
        {[
          ["lgRelFar", "0.010 0.022", 3, 5],
          ["lgRelMid", "0.008 0.016", 9, 6],
          ["lgRelNear", "0.006 0.012", 17, 6],
        ].map(([id, f, seed, scale]) => (
          <filter key={id as string} id={id as string} filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency={f as string} numOctaves={6} seed={seed as number} result="n" />
            <feDiffuseLighting in="n" surfaceScale={scale as number} diffuseConstant="1.15" lightingColor="#FFFFFF" result="l">
              <feDistantLight azimuth="200" elevation="32" />
            </feDiffuseLighting>
            {/* Caras en sombra: oscuro con alfa según lo poco iluminadas que estén */}
            <feColorMatrix in="l" type="matrix" values="0 0 0 0 0.03  0 0 0 0 0.02  0 0 0 0 0.07  -1.3 0 0 0 0.95" result="sh" />
            {/* Caras de cara al planeta: brillo cálido solo donde la luz es fuerte */}
            <feColorMatrix in="l" type="matrix" values="0 0 0 0 1  0 0 0 0 0.84  0 0 0 0 0.68  1.5 0 0 0 -1.0" result="hi" />
            <feMerge>
              <feMergeNode in="sh" />
              <feMergeNode in="hi" />
            </feMerge>
          </filter>
        ))}
        <filter id="lgMist" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="14" /></filter>
        <filter id="lgRim" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="2.2" /></filter>
        <linearGradient id="lgSnow" gradientUnits="userSpaceOnUse" x1="0" y1="550" x2="0" y2="720">
          <stop offset="0" stopColor="#E4E8F6" />
          <stop offset="0.16" stopColor="#B9C0DC" />
          <stop offset="0.3" stopColor="#6A7298" />
          <stop offset="0.65" stopColor="#3A4064" />
          <stop offset="1" stopColor="#242842" />
        </linearGradient>
        <linearGradient id="lgMid" gradientUnits="userSpaceOnUse" x1="0" y1="640" x2="0" y2="800">
          <stop offset="0" stopColor="#4A4F74" />
          <stop offset="0.5" stopColor="#2A2D48" />
          <stop offset="1" stopColor="#15172A" />
        </linearGradient>
        <linearGradient id="lgNear" gradientUnits="userSpaceOnUse" x1="0" y1="760" x2="0" y2="900">
          <stop offset="0" stopColor="#2A2436" />
          <stop offset="1" stopColor="#0B0A12" />
        </linearGradient>
        <linearGradient id="lgFront" gradientUnits="userSpaceOnUse" x1="0" y1="630" x2="0" y2="900">
          <stop offset="0" stopColor="#2B2130" />
          <stop offset="0.4" stopColor="#141019" />
          <stop offset="1" stopColor="#040306" />
        </linearGradient>
        <linearGradient id="lgLakeV" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A9A6CC" stopOpacity="0.5" />
          <stop offset="1" stopColor="#3A3F64" stopOpacity="0.15" />
        </linearGradient>
        <filter id="lgSoft1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.8" /></filter>
        <linearGradient id="lgSuit" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#F2DCCB" />
          <stop offset="0.22" stopColor="#CDCFD9" />
          <stop offset="0.65" stopColor="#959AAD" />
          <stop offset="1" stopColor="#5C6175" />
        </linearGradient>
        <linearGradient id="lgSuitShade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#A2A7B9" />
          <stop offset="0.6" stopColor="#787D91" />
          <stop offset="1" stopColor="#4C5164" />
        </linearGradient>
        <linearGradient id="lgSuitArm" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#E9CDB8" />
          <stop offset="1" stopColor="#8A8FA2" />
        </linearGradient>
        <linearGradient id="lgPack" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#C9B5A8" />
          <stop offset="0.4" stopColor="#8E93A6" />
          <stop offset="1" stopColor="#4C5164" />
        </linearGradient>
        <linearGradient id="lgBox" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6E7488" />
          <stop offset="1" stopColor="#3A3E4E" />
        </linearGradient>
        <linearGradient id="lgGlove" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#C9B9AE" />
          <stop offset="1" stopColor="#6E7385" />
        </linearGradient>
        <linearGradient id="lgGloveDark" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8E93A6" />
          <stop offset="1" stopColor="#4C5164" />
        </linearGradient>
        <radialGradient id="lgHelmet" cx="30%" cy="28%" r="80%">
          <stop offset="0" stopColor="#FFF4EA" />
          <stop offset="0.35" stopColor="#CFD2DC" />
          <stop offset="0.8" stopColor="#7C8195" />
          <stop offset="1" stopColor="#4C5164" />
        </radialGradient>
        <radialGradient id="lgVisor" cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#FFD58A" />
          <stop offset="0.35" stopColor="#D88A2E" />
          <stop offset="0.75" stopColor="#6B3410" />
          <stop offset="1" stopColor="#1E0E05" />
        </radialGradient>
        <linearGradient id="lgRimGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFB067" />
          <stop offset="0.6" stopColor="#FF8A3D" />
          <stop offset="1" stopColor="#FF8A3D" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Cordillera lejana con nieve */}
      <path d={far} fill="url(#lgSnow)" />
      <Relief id="lgClipFar" d={far} filter="lgRelFar" opacity={0.9} />
      <path d={line(R_FAR)} fill="none" stroke="#F2F4FF" strokeWidth="1" opacity="0.35" />
      <ellipse cx="800" cy="668" rx="900" ry="22" fill="#9EA6D6" opacity="0.22" filter="url(#lgMist)" />

      {/* Cordillera media */}
      <path d={mid} fill="url(#lgMid)" />
      <Relief id="lgClipMid" d={mid} filter="lgRelMid" opacity={0.85} />
      <path d={line(R_MID)} fill="none" stroke="#A7AEDA" strokeWidth="1" opacity="0.25" />

      {/* Lago con reflejo */}
      <path d="M400 774 C700 764 1200 760 1600 756 L1600 802 C1200 806 700 812 400 814 Z" fill="url(#lgLakeV)" />
      <path d="M700 782 L860 781M940 786 L1120 784M1240 779 L1420 778" stroke="#E7E4FF" strokeWidth="1.2" opacity="0.35" strokeLinecap="round" />
      <ellipse cx="900" cy="760" rx="800" ry="18" fill="#8C93C4" opacity="0.18" filter="url(#lgMist)" />

      {/* Colinas cercanas */}
      <path d={near} fill="url(#lgNear)" />
      <Relief id="lgClipNear" d={near} filter="lgRelNear" opacity={0.6} />

      {/* Rocas del frente, con el borde iluminado por el planeta */}
      <path d={right} fill="url(#lgFront)" />
      <Relief id="lgClipRight" d={right} filter="lgRelNear" opacity={0.5} />
      <path d={left} fill="url(#lgFront)" />
      <Relief id="lgClipLeft" d={left} filter="lgRelNear" opacity={0.55} />
      <path d={line(R_LEFT.filter(([x]) => x < 470))} fill="none" stroke="url(#lgRimGrad)" strokeWidth="3" opacity="0.55" filter="url(#lgRim)" />
      <path d={line(R_LEFT.filter(([x]) => x < 470))} fill="none" stroke="url(#lgRimGrad)" strokeWidth="1" opacity="0.7" />

      {/* Astronauta sobre la roca, a contraluz del planeta */}
      <g transform="translate(300 652) scale(1.3)">
        <ellipse cx="3" cy="0.5" rx="20" ry="2.6" fill="#000" opacity="0.6" filter="url(#lgSoft1)" />

        {/* Mochila de soporte vital (PLSS) */}
        <path d="M-25 -76 C-25 -79 -23 -80 -21 -80 L-10 -80 L-9 -40 L-22 -40 C-24 -40 -25 -42 -25 -44 Z" fill="url(#lgPack)" />
        <path d="M-24 -66 L-11 -66M-24 -52 L-11 -52" stroke="#2E3242" strokeWidth="0.8" opacity="0.7" />
        <path d="M-25 -76 L-25 -44" stroke="#FFB774" strokeWidth="1.1" opacity="0.8" strokeLinecap="round" />

        {/* Brazo de atrás */}
        <path d="M-14 -76 C-20 -70 -22 -61 -21.5 -53 C-21 -47 -20.5 -43 -20 -39" fill="none" stroke="url(#lgSuitArm)" strokeWidth="9" strokeLinecap="round" />
        <path d="M-25 -58 C-22 -57 -19 -57 -17 -58M-25.5 -55 C-22 -54 -19 -54 -17 -55" stroke="#4E5366" strokeWidth="0.7" fill="none" opacity="0.8" />
        <rect x="-24.5" y="-41" width="9" height="3" rx="1.2" fill="#3A3E4E" />
        <path d="M-24 -38 C-25 -34 -23 -30 -19.5 -30 C-16 -30 -15 -34 -16 -38 Z" fill="url(#lgGlove)" />

        {/* Piernas con fuelles en las rodillas */}
        <path d="M-14.5 -44 C-15.5 -32 -15.5 -20 -14 -9 L-3 -9 C-2.5 -20 -2.5 -32 -1.5 -44 Z" fill="url(#lgSuit)" />
        <path d="M0.5 -44 C1.5 -32 2.5 -20 3.5 -9 L14.5 -9 C14.5 -20 13.5 -32 12.5 -44 Z" fill="url(#lgSuitShade)" />
        <path d="M-15 -27 C-11 -25.5 -6 -25.5 -2.5 -27M-15.2 -24.5 C-11 -23 -6 -23 -2.6 -24.5M-15.2 -22 C-11 -20.5 -6 -20.5 -2.7 -22" stroke="#555A6D" strokeWidth="0.7" fill="none" opacity="0.85" />
        <path d="M1.8 -27 C5.5 -25.5 10 -25.5 13.6 -27M2 -24.5 C5.5 -23 10 -23 13.8 -24.5M2.2 -22 C5.5 -20.5 10 -20.5 14 -22" stroke="#3E4253" strokeWidth="0.7" fill="none" opacity="0.85" />
        <path d="M-10 -40 C-11 -34 -10 -31 -9 -29M7 -40 C8 -35 8 -32 7 -29M-9 -17 C-10 -14 -9 -12 -8 -10M9 -18 C10 -15 10 -12 9 -10" stroke="#3E4253" strokeWidth="0.9" fill="none" opacity="0.45" filter="url(#lgSoft1)" />
        <path d="M-14.5 -44 C-15.5 -32 -15.5 -20 -14 -9" stroke="#FFB774" strokeWidth="1" fill="none" opacity="0.75" />

        {/* Botas */}
        <path d="M-15.5 -10 L-2 -10 L-1.2 -3.5 C-1 -1.2 -2 0 -4 0 L-17 0 C-18.3 0 -18.6 -2 -17.5 -3.6 Z" fill="#6E7385" />
        <path d="M-18 -2 L-1.2 -2 L-1.3 0 L-17.5 0 Z" fill="#2B2E3A" />
        <path d="M2.5 -10 L15 -10 L18.5 -4.5 C19.6 -2.6 19 0 16.6 0 L2.6 0 Z" fill="#4C5062" />
        <path d="M2.6 -2 L19.2 -2 L18.6 0 L2.6 0 Z" fill="#23262F" />
        <path d="M-15.5 -10 L-2 -10M2.5 -10 L15 -10" stroke="#2E3242" strokeWidth="1.4" />

        {/* Torso (HUT) */}
        <path d="M-15.5 -78 C-17.5 -70 -17.5 -55 -15.5 -43 L13.5 -43 C15.5 -55 15.5 -70 13.5 -78 C6 -82.5 -8 -82.5 -15.5 -78 Z" fill="url(#lgSuit)" />
        <path d="M-6 -76 C-7 -66 -6 -54 -7 -46M5 -74 C6 -64 6 -54 7 -46" stroke="#5A5F72" strokeWidth="1" fill="none" opacity="0.35" filter="url(#lgSoft1)" />
        <rect x="-16" y="-46" width="30" height="4.2" rx="2" fill="#4A4E60" />
        <path d="M-16 -45.5 L14 -45.5" stroke="#9EA3B6" strokeWidth="0.6" opacity="0.6" />
        {/* Caja de control en el pecho y mangueras */}
        <path d="M-8 -60 C-12 -58 -15 -56 -17 -51" stroke="#8D93A7" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M-6 -59 C-9 -54 -13 -51 -16.5 -48" stroke="#C25A3A" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.85" />
        <rect x="-8" y="-68.5" width="15" height="10" rx="1.6" fill="url(#lgBox)" />
        <rect x="-7" y="-67.6" width="13" height="1.4" rx="0.7" fill="#A9AFC2" opacity="0.6" />
        <circle cx="-4" cy="-63" r="1.5" fill="#20232D" />
        <circle cx="0" cy="-63" r="1.5" fill="#20232D" />
        <rect x="2.5" y="-64.5" width="3.2" height="2.6" rx="0.5" fill="#1E2A30" />
        <circle cx="4.1" cy="-63.2" r="0.6" fill="#47E0F5" />
        <circle cx="-4" cy="-60.2" r="0.6" fill="#FF8E4A" />
        {/* Insignia en el hombro */}
        <rect x="-15" y="-75" width="5" height="3.4" rx="0.5" fill="#28407A" />
        <rect x="-15" y="-73.6" width="5" height="0.8" fill="#D9DCE6" />
        <path d="M-15.5 -78 C-17.5 -70 -17.5 -55 -15.5 -43" stroke="#FFB774" strokeWidth="1.2" fill="none" opacity="0.85" />

        {/* Brazo del frente con fuelle en el codo */}
        <path d="M13 -76 C18 -70 20 -62 19.5 -55 C19 -49 18.5 -45 18 -41" fill="none" stroke="url(#lgSuitShade)" strokeWidth="9.5" strokeLinecap="round" />
        <path d="M14.8 -59 C17.5 -58 20.5 -58 24 -59.5M14.6 -56 C17.5 -55 20.5 -55 23.8 -56.5" stroke="#3E4253" strokeWidth="0.7" fill="none" opacity="0.85" />
        <rect x="13.4" y="-43" width="9.4" height="3" rx="1.2" fill="#2E3242" />
        <path d="M13.8 -40 C12.8 -36 14.6 -31.5 18.2 -31.5 C21.8 -31.5 23.2 -35.6 22.2 -40 Z" fill="url(#lgGloveDark)" />
        <path d="M15.5 -36 L15.6 -33M17.6 -35.5 L17.7 -32.2M19.7 -36 L19.8 -33" stroke="#2A2D38" strokeWidth="0.6" />

        {/* Anillo del cuello y casco */}
        <ellipse cx="-1" cy="-80.5" rx="10.5" ry="3.2" fill="#5F6478" />
        <ellipse cx="-1" cy="-81.2" rx="10.5" ry="2.4" fill="#9298AC" />
        <circle cx="0" cy="-90" r="11" fill="url(#lgHelmet)" />
        <rect x="-11.6" y="-95" width="3.4" height="5" rx="1" fill="#6E7385" />
        <circle cx="-9.9" cy="-92.4" r="1" fill="#FFF2D0" opacity="0.9" />
        <ellipse cx="2.4" cy="-89.6" rx="8.2" ry="7.6" fill="url(#lgVisor)" />
        <ellipse cx="2.4" cy="-89.6" rx="8.2" ry="7.6" fill="none" stroke="#2A2D38" strokeWidth="0.9" />
        {/* Reflejos en el visor: el planeta y una ventana de luz */}
        <circle cx="-1.5" cy="-91" r="3.4" fill="#FF9A4A" opacity="0.55" filter="url(#lgSoft1)" />
        <path d="M-2.5 -94.5 C0 -96 3.5 -96 6 -94.6" stroke="#FFF6E2" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.85" />
        <ellipse cx="7" cy="-86" rx="1.2" ry="2.2" fill="#FFFFFF" opacity="0.25" transform="rotate(20 7 -86)" />
        <path d="M-10.6 -93 C-11.6 -89 -11 -85 -9 -82" stroke="#FFB774" strokeWidth="1.2" fill="none" opacity="0.9" strokeLinecap="round" />
      </g>
    </svg>
  );
}
