// Todo se muestra en hora de El Salvador, sin importar dónde esté el navegador.
export const TZ = "America/El_Salvador";

const timeFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const timeSecFmt = new Intl.DateTimeFormat("es-SV", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
const isoDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const longDateFmt = new Intl.DateTimeFormat("es-SV", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});
const shortDayFmt = new Intl.DateTimeFormat("es-SV", { timeZone: "UTC", weekday: "short", day: "numeric" });

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
export const fmtTimeSec = (iso: string) => timeSecFmt.format(new Date(iso));
export const fmtDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

/** Fecha local (El Salvador) de un instante, como AAAA-MM-DD. */
export const localDate = (d: Date | string) => isoDateFmt.format(typeof d === "string" ? new Date(d) : d);
export const today = () => localDate(new Date());

/** Fechas AAAA-MM-DD (sin hora) se interpretan en UTC para no correr un día. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtLongDate = (ymd: string) => cap(longDateFmt.format(new Date(`${ymd}T00:00:00Z`)));
export const fmtDayLabel = (d: Date) => cap(new Intl.DateTimeFormat("es-SV", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(d));
export const fmtShortDay = (ymd: string) => shortDayFmt.format(new Date(`${ymd}T00:00:00Z`));

/** El Salvador no usa horario de verano: UTC-6 todo el año. */
export const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00-06:00`);
/** Horas transcurridas desde la medianoche local del día indicado (puede pasar de 24). */
export const hoursFrom = (ymd: string, iso: string) => (new Date(iso).getTime() - dayStart(ymd).getTime()) / 3_600_000;

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana que contiene la fecha. */
export function weekStart(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

/** AAAA-MM-DD → dd/mm/aaaa, como se escriben las fechas en RRHH. */
export const fmtDate = (ymd: string) => ymd.slice(0, 10).split("-").reverse().join("/");

/** Antigüedad desde una fecha AAAA-MM-DD hasta hoy: "5 años", "3 meses", "12 días". */
export function seniority(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const [ty, tm, td] = today().split("-").map(Number);
  let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
  if (months < 0) return "aún no ingresa";
  if (months >= 12) {
    const years = Math.floor(months / 12);
    return `${years} año${years === 1 ? "" : "s"}`;
  }
  if (months >= 1) return `${months} mes${months === 1 ? "" : "es"}`;
  const days = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000);
  return `${days} día${days === 1 ? "" : "s"}`;
}

export const hhmm = (t: string) => t.slice(0, 5);

export const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador",
  rrhh: "Recursos Humanos",
  supervisor: "Supervisor",
  empleado: "Empleado",
};

const moneyFmt = new Intl.NumberFormat("es-SV", { style: "currency", currency: "USD" });
export const fmtMoney = (amount: string | number) => moneyFmt.format(Number(amount));

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** '07-19' → '19 jul'. */
export const fmtBirthday = (mmdd: string) => `${Number(mmdd.slice(3))} ${MONTHS[Number(mmdd.slice(0, 2)) - 1]}`;
