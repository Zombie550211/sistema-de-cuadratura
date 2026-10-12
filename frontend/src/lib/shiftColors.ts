import type { DayOffKind, ShiftDayOff } from "./api";

/** Colores de los horarios: los mismos del CRM (/horarios.html), para leerlos igual en los dos lados. */
export const SHIFT_KINDS = [
  { label: "8–5", start: "08:00", end: "17:00", color: "#007098", short: false },
  { label: "10–7", start: "10:00", end: "19:00", color: "#15803d", short: false },
  { label: "1–9", start: "13:00", end: "21:00", color: "#3a464e", short: false },
  { label: "9–6", start: "09:00", end: "18:00", color: "#a16207", short: false },
  { label: "8–12", start: "08:00", end: "12:00", color: "#007098", short: true },
  { label: "3–7", start: "15:00", end: "19:00", color: "#15803d", short: true },
  { label: "5–9", start: "17:00", end: "21:00", color: "#3a464e", short: true },
] as const;

export const OTHER_SHIFT = { label: "Otro horario", color: "#30a0c8" };

export const DAY_OFF_COLOR: Record<DayOffKind, string> = {
  libre: "#e2e8f0",
  compensatorio: "#e2e8f0",
  vacacion: "#facc15",
  incapacidad: "#4ade80",
  suspendido: "#fb923c",
  baja: "#94a3b8",
};
export const NO_SHOW = { label: "No se presentó", color: "#f87171" };

/** Turno habitual con esas horas ("HH:MM"), o undefined si es otro horario. */
export const shiftKind = (start: string, end: string) => SHIFT_KINDS.find((k) => k.start === start && k.end === end);

export const shiftColor = (start: string, end: string) => shiftKind(start, end)?.color ?? OTHER_SHIFT.color;

/** El CRM guarda «No se presentó» como día libre con esa nota. */
export const isNoShow = (d: ShiftDayOff) => (d.notes ?? "").trim().toLowerCase() === NO_SHOW.label.toLowerCase();

export const dayOffColor = (d: ShiftDayOff) => (isNoShow(d) ? NO_SHOW.color : DAY_OFF_COLOR[d.kind]);
