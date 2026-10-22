import { DAY_OFF_LABEL, type DayOffKind, type ShiftDayOff } from "./api";

/** Colores de los horarios: los mismos del CRM (/horarios.html), para leerlos igual en los dos lados. */
export const SHIFT_KINDS = [
  { label: "8–5", start: "08:00", end: "17:00", color: "#007098", short: false },
  { label: "10–7", start: "10:00", end: "19:00", color: "#15803d", short: false },
  { label: "1–9", start: "13:00", end: "21:00", color: "#3a464e", short: false },
  { label: "9–6", start: "09:00", end: "18:00", color: "#a16207", short: false },
  { label: "7:15–4:15", start: "07:15", end: "16:15", color: "#6d28d9", short: false },
  { label: "7:30–4:30", start: "07:30", end: "16:30", color: "#be123c", short: false },
  { label: "7:15–11:15", start: "07:15", end: "11:15", color: "#6d28d9", short: true },
  { label: "7:30–11:30", start: "07:30", end: "11:30", color: "#be123c", short: true },
  { label: "8–12", start: "08:00", end: "12:00", color: "#007098", short: true },
  { label: "3–7", start: "15:00", end: "19:00", color: "#15803d", short: true },
  { label: "5–9", start: "17:00", end: "21:00", color: "#3a464e", short: true },
] as const;

export const OTHER_SHIFT = { label: "Otro horario", color: "#30a0c8" };

export const DAY_OFF_COLOR: Record<DayOffKind, string> = {
  libre: "#e2e8f0",
  compensatorio: "#fde68a",
  vacacion: "#facc15",
  incapacidad: "#4ade80",
  suspendido: "#c084fc",
  baja: "#94a3b8",
};
export const NO_SHOW = { label: "No se presentó", color: "#f87171" };
/** Marcado en el CRM: el día queda pendiente de que RRHH le asigne el horario («Reponer horario»). */
export const WILL_RESTORE = { label: "Repondrá horario", color: "#f97316" };

/** Franja del día sin turno en la línea de tiempo (fondo y texto), igual que en el CRM. */
export const DAY_OFF_BAND: Record<DayOffKind | "no_show" | "will_restore", { bg: string; fg: string }> = {
  libre: { bg: "#f1f5f9", fg: "#334155" },
  compensatorio: { bg: "#fefce8", fg: "#a16207" },
  vacacion: { bg: "#fef9c3", fg: "#854d0e" },
  incapacidad: { bg: "#dcfce7", fg: "#166534" },
  suspendido: { bg: "#f3e8ff", fg: "#6b21a8" },
  baja: { bg: "#f1f5f9", fg: "#334155" },
  no_show: { bg: "#fee2e2", fg: "#991b1b" },
  will_restore: { bg: "#ffedd5", fg: "#9a3412" },
};

/** Turno habitual con esas horas ("HH:MM"), o undefined si es otro horario. */
export const shiftKind = (start: string, end: string) => SHIFT_KINDS.find((k) => k.start === start && k.end === end);

export const shiftColor = (start: string, end: string) => shiftKind(start, end)?.color ?? OTHER_SHIFT.color;

/** El CRM guarda «No se presentó» como día libre con esa nota. */
export const isNoShow = (d: ShiftDayOff) => (d.notes ?? "").trim().toLowerCase() === NO_SHOW.label.toLowerCase();

/** «Repondrá horario» también es un día libre con esa nota. */
export const isWillRestore = (d: ShiftDayOff) => (d.notes ?? "").trim().toLowerCase() === WILL_RESTORE.label.toLowerCase();

export const dayOffColor = (d: ShiftDayOff) =>
  isNoShow(d) ? NO_SHOW.color : isWillRestore(d) ? WILL_RESTORE.color : DAY_OFF_COLOR[d.kind];

export const dayOffBand = (d: ShiftDayOff) => DAY_OFF_BAND[isNoShow(d) ? "no_show" : isWillRestore(d) ? "will_restore" : d.kind];

/** Nombre del día sin turno: el tipo, o «No se presentó» / «Repondrá horario» por su nota. */
export const dayOffLabel = (d: ShiftDayOff) =>
  isNoShow(d) ? NO_SHOW.label : isWillRestore(d) ? WILL_RESTORE.label : DAY_OFF_LABEL[d.kind];

/** Hora como en el CRM: "08:00" → "8:00 a. m.", "15:30" → "3:30 p. m.". */
export function ampm(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "a. m." : "p. m."}`;
}

/** Nombre corto del turno como en el CRM: "8–5", "Shortday 8–12" u "Personalizado". */
export function shiftLabel(start: string, end: string) {
  const k = shiftKind(start, end);
  return k ? (k.short ? `Shortday ${k.label}` : k.label) : "Personalizado";
}
