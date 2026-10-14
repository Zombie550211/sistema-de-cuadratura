export type Role = "admin" | "rrhh" | "supervisor" | "empleado";

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  employee_id: number | null;
}

export interface Department {
  id: number;
  name: string;
  section: "residencial" | "lineas";
}

export interface TeamGroup<T> {
  key: string;
  team: Department | null;
  /** Supervisor del team: el marcado como supervisor (rol del CRM o cargo). */
  supervisor: T | null;
  items: T[];
  /** true si el grupo abre una sección (Residencial / Líneas) distinta a la del anterior. */
  newSection: boolean;
}

/** Agrupa empleados consecutivos por team. La API ya los devuelve en el orden del CRM. */
export function groupByTeam<T extends { department: Department | null; is_supervisor: boolean }>(items: T[]) {
  const groups: TeamGroup<T>[] = [];
  for (const item of items) {
    const key = item.department ? String(item.department.id) : "none";
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.items.push(item);
      if (last.team && item.is_supervisor && !last.supervisor) last.supervisor = item;
      continue;
    }
    const section = item.department?.section ?? "none";
    const lastSection = last ? (last.team?.section ?? "none") : null;
    groups.push({
      key,
      team: item.department,
      supervisor: item.department && item.is_supervisor ? item : null,
      items: [item],
      newSection: section !== lastSection,
    });
  }
  return groups;
}

export const SECTION_LABEL = { residencial: "Residencial", lineas: "Líneas" } as const;

export interface PositionGroup<T> {
  key: string;
  /** Cargo tal como viene en la planilla ("Agente de ventas", "Bo"…); null = sin cargo. */
  position: string | null;
  items: T[];
}

/** Agrupa por cargo (Empleados va por cargo de la planilla; Horarios, por team del CRM).
 *  Cargos por nombre y "Sin cargo" al final; dentro de cada uno, por nombre. */
export function groupByPosition<T extends { position: string | null; full_name: string }>(items: T[]) {
  const byKey = new Map<string, PositionGroup<T>>();
  for (const item of items) {
    const position = item.position?.trim() || null;
    const key = position?.toLowerCase() ?? "";
    if (!byKey.has(key)) byKey.set(key, { key: key || "none", position, items: [] });
    byKey.get(key)!.items.push(item);
  }
  const groups = [...byKey.values()].sort((a, b) =>
    a.position === null ? 1 : b.position === null ? -1 : a.position.localeCompare(b.position, "es"),
  );
  for (const g of groups) g.items.sort((a, b) => a.full_name.localeCompare(b.full_name, "es"));
  return groups;
}

export type Area = "administrativo" | "operativo" | "ventas";

/** Las 3 secciones de Empleados, en el orden del menú, con su ruta /empleados/<slug>. */
export const AREAS: { area: Area; slug: string; label: string }[] = [
  { area: "administrativo", slug: "administrativo", label: "Administrativo" },
  { area: "operativo", slug: "operativo", label: "Operativo" },
  { area: "ventas", slug: "agentes", label: "Agentes de ventas" },
];

export const areaPath = (area: Area) => `/empleados/${AREAS.find((a) => a.area === area)!.slug}`;

export interface EmployeeInput {
  code: string;
  /** ID de usuario: iniciales del nombre y apellido + día y mes de nacimiento (KR1907). Vacío: se genera solo. */
  user_code: string | null;
  badge_number: string | null;
  crm_agent_id: string | null;
  first_name: string;
  last_name: string;
  dui: string | null;
  nit: string | null;
  isss_number: string | null;
  nup: string | null;
  afp: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  /** null al crear: el backend la deduce del cargo. */
  area: Area | null;
  department_id: number | null;
  hire_date: string | null;
  termination_date: string | null;
  base_salary: string;
  pay_frequency: "quincenal" | "mensual";
  status: "activo" | "inactivo";
  // Planilla de RRHH
  payroll_date: string | null;
  /** MM-DD: la planilla no trae el año. */
  birthday: string | null;
  gender: string | null;
  bank_account: string | null;
  locker: string | null;
  /** Número de huella en cada reloj, p.ej. { LA17: "26", "LA24 comedor": "89" }. */
  fingerprints: Record<string, string>;
  emergency_contact: string | null;
  termination_note: string | null;
  has_cv: boolean;
  has_contract: boolean;
  has_nda: boolean;
  has_memo: boolean;
}

/** Documentos del expediente, en el orden de la planilla. */
export const DOCS = [
  ["has_cv", "CV"],
  ["has_contract", "Contrato"],
  ["has_nda", "Confidencialidad"],
  ["has_memo", "Memorándum"],
] as const;

export interface Employee extends EmployeeInput {
  id: number;
  area: Area;
  full_name: string;
  crm_order: number | null;
  /** Supervisor de su team (rol del CRM o cargo): va con su team en Agentes de ventas. */
  is_supervisor: boolean;
  department: Department | null;
}

export interface EmployeeBrief {
  id: number;
  code: string;
  user_code: string | null;
  full_name: string;
  badge_number: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Device {
  id: number;
  serial_number: string;
  name: string;
  location: string | null;
  /** Local del reloj (columna HUELLA de la planilla, p. ej. "LA17"). */
  fingerprint_key: string | null;
}

/** Nombre del local para mostrar: el de la planilla o, si no se conoce, el del reloj. */
export const localName = (d: Device) => d.fingerprint_key ?? d.name;

export interface Locales {
  devices: (Device & { punches: number })[];
  known: string[];
}

export interface ImportBatch {
  id: number;
  original_filename: string;
  uploaded_at: string;
  total_lines: number;
  inserted: number;
  already_present: number;
  double_taps: number;
  invalid_lines: number;
  unknown_badges: number;
  date_from: string | null;
  date_to: string | null;
  device: Device;
  uploaded_by: User | null;
}

export interface Punch {
  id: number;
  badge: string;
  punched_at: string;
  /** Hora que trajo el reloj, si RRHH la corrigió. */
  original_punched_at: string | null;
  device_id: number;
  verify_mode: number;
  work_code: number;
  is_double_tap: boolean;
  employee: EmployeeBrief | null;
}

/** Llegada tarde de un día con turno: entrada vs. inicio del turno, acumulada por quincena. */
/** Fecha de corte de Marcaciones, guardada para todos (de date_from a date_to, incluidos). */
export interface CutDate {
  date_from: string;
  date_to: string;
}

export interface Lateness {
  employee_id: number;
  date: string;
  shift_start: string;
  check_in: string | null;
  late_minutes: number;
  /** Segundos exactos de llegada tarde. */
  late_seconds: number;
  /** Minutos tarde acumulados en la quincena hasta ese día. */
  quincena_minutes: number;
  /** Minutos de ese día que ya cuentan (pasados los 15 perdonados por quincena). */
  counted_minutes: number;
  /** Intercambio de fin de semana: fecha del turno que trabajó este día (vino sábado en vez de domingo o al revés). */
  swapped_from: string | null;
}

/** Minutos de llegada tarde que se perdonan por quincena. */
export const LATE_ALLOWANCE = 15;

export interface UnmappedBadge {
  badge: string;
  punches: number;
  first_seen: string;
  last_seen: string;
}

export interface ShiftTemplate {
  id: number;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  tolerance_minutes: number;
  color: string;
  is_active: boolean;
  crosses_midnight: boolean;
}

export interface ShiftAssignment {
  id: number;
  employee_id: number;
  work_date: string;
  start_at: string;
  end_at: string;
  break_minutes: number;
  tolerance_minutes: number;
  template_id: number | null;
  notes: string | null;
  source: "manual" | "crm";
}

/** Día sin turno: lo fija RRHH (al reagendar o dar el día) o viene del CRM como descanso. */
export type DayOffKind = "libre" | "vacacion" | "compensatorio" | "incapacidad" | "suspendido" | "baja";

export const DAY_OFF_LABEL: Record<DayOffKind, string> = {
  libre: "Día libre",
  vacacion: "Vacación",
  compensatorio: "Compensatorio",
  incapacidad: "Incapacidad",
  suspendido: "Suspendido",
  baja: "De baja",
};

export interface ShiftDayOff {
  id: number;
  employee_id: number;
  work_date: string;
  kind: DayOffKind;
  notes: string | null;
  /** rrhh = lo fijó RRHH aquí; crm = vino del horario del CRM. */
  source: "rrhh" | "crm";
}

/** Un período de 15 días de vacación (un año desde el aniversario de ingreso) y cómo se entregó. */
export interface VacationPeriod {
  start: string;
  end: string;
  /** Días que descansó (días de vacación del calendario aplicados a este período). */
  rested: string[];
  /** Días que trabajó en lugar de descansar. */
  worked: number;
  /** Cerrado por RRHH como completo (historia anterior al sistema). */
  settled: boolean;
  notes: string | null;
  pending: number;
}

/** Vacaciones por antigüedad: 15 días al cumplir cada año desde la fecha de ingreso. */
export interface VacationStatus {
  employee_id: number;
  hire_date: string | null;
  years: number;
  /** Siguiente aniversario: cuando le tocan los próximos 15 días. */
  next_date: string | null;
  periods: VacationPeriod[];
  /** Días descansados que no caben en ningún período. */
  extra: string[];
  pending: number;
}

/** Asueto: se trabaja; quien marca ese día gana un compensatorio. */
export interface Holiday {
  id: number;
  day: string;
  name: string;
}

/** Compensatorios del empleado: asuetos marcados (ganados), no marcados (perdidos) y saldo. */
export interface CompensatoryStatus {
  employee_id: number;
  earned: Holiday[];
  lost: Holiday[];
  taken: number;
  balance: number;
}

export interface WorkDay {
  date: string;
  shift: ShiftAssignment | null;
  punches: { id: number; punched_at: string; is_double_tap: boolean }[];
  /** Primera marca válida de la jornada: la entrada. Las demás no cuentan. */
  check_in: { id: number; punched_at: string } | null;
  /** Día sin turno fijado por RRHH (libre, vacación o compensatorio). */
  day_off: ShiftDayOff | null;
}

export interface EmployeeSchedule {
  employee_id: number;
  date_from: string;
  date_to: string;
  last_crm_sync_at: string | null;
  days: WorkDay[];
  /** Días de vacación y compensatorios en el año de la semana mostrada. */
  leave: { year: number; vacacion: number; compensatorio: number };
}

/** Recibo de Google Ads que envía el CRM (solo lectura aquí, salvo la conciliación). Montos en centavos. */
export interface GoogleAdsReceipt {
  id: number;
  crm_id: number;
  payment_date: string;
  account_key: string;
  account_name: string;
  amount_cents: number;
  billing_id: string | null;
  payment_method: string | null;
  file_name: string;
  uploaded_by: string;
  received_at: string;
  /** RRHH ya revisó el documento (se marca aquí y se muestra en el CRM). */
  reconciled: boolean;
  reconciled_by: string | null;
  reconciled_at: string | null;
}

export interface GoogleAdsSummary {
  month: string;
  total_month_cents: number;
  receipts: number;
  last_payment: string | null;
}

export interface DashboardSummary {
  employees_active: number;
  employees_without_badge: number;
  unmapped_badges: number;
  punches_today: number;
  last_import: ImportBatch | null;
  shifts_today: number;
}

export interface ApiClient {
  id: number;
  name: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface AgentResult {
  crm_agent_id: string;
  status: "ok" | "conflicto" | "error";
  employee_id: number | null;
  employee_created: boolean;
  message: string | null;
  conflict_dates: string[];
}

export interface Sync {
  id: number;
  kind: string;
  received_at: string;
  date_from: string | null;
  date_to: string | null;
  status: "ok" | "parcial" | "error" | "procesando";
  agents_received: number;
  employees_created: number;
  shifts_created: number;
  shifts_updated: number;
  shifts_removed: number;
  conflicts: number;
  errors: number;
  client: ApiClient | null;
  details?: { result?: { agents: AgentResult[] } } | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown = null,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return `/api${path}${qs ? `?${qs}` : ""}`;
}

function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d: { msg?: string; loc?: string[] }) => {
        const field = d.loc?.slice(1).join(".");
        const msg = (d.msg ?? "").replace(/^Value error, /, "");
        return field ? `${field}: ${msg}` : msg;
      })
      .join(" · ");
  }
  return status >= 500 ? "Error del servidor, intente de nuevo" : `Error ${status}`;
}

async function request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    credentials: "same-origin",
    headers: opts.body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(res.status, errorMessage(body, res.status), body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  delete: (path: string) => request<void>("DELETE", path),
};
