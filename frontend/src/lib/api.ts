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
}

export interface EmployeeInput {
  code: string;
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
  department_id: number | null;
  hire_date: string | null;
  termination_date: string | null;
  base_salary: string;
  pay_frequency: "quincenal" | "mensual";
  status: "activo" | "inactivo";
}

export interface Employee extends EmployeeInput {
  id: number;
  full_name: string;
  department: Department | null;
}

export interface EmployeeBrief {
  id: number;
  code: string;
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
  verify_mode: number;
  work_code: number;
  is_double_tap: boolean;
  employee: EmployeeBrief | null;
}

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

export interface WorkDay {
  date: string;
  shift: ShiftAssignment | null;
  punches: { id: number; punched_at: string; is_double_tap: boolean }[];
}

export interface EmployeeSchedule {
  employee_id: number;
  date_from: string;
  date_to: string;
  last_crm_sync_at: string | null;
  days: WorkDay[];
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
