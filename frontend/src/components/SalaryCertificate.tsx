import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, type Employee } from "../lib/api";
import { today } from "../lib/format";
import { IconX } from "./Icons";

/** Constancia laboral con las plantillas de RRHH: con bono, con comisiones (promedio de 6 meses)
 *  o solo salario. Se llena con la ficha, todo el texto se puede corregir sobre la hoja y se
 *  descarga en PDF con "Guardar como PDF" del navegador (texto real, no imagen). */

type Template = "bono" | "comisiones" | "salario";

export interface IssuedCertificate {
  id: number;
  employee_id: number;
  template: Template;
  issue_date: string;
  salary: string;
  extra: string;
  issued_by_name: string;
  issued_at: string;
}

export const TEMPLATES: { id: Template; label: string }[] = [
  { id: "bono", label: "Salario + bono" },
  { id: "comisiones", label: "Salario + comisiones (6 meses)" },
  { id: "salario", label: "Solo salario" },
];

const ISSS_RATE = 0.03;
const ISSS_CAP = 1000; // el ISSS se calcula sobre un máximo de $1,000
const AFP_RATE = 0.0725;
const RENTA_RATE = 0.1;

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} de ${MESES[m - 1]} de ${y}`;
};

const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece",
  "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés",
  "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

function hasta999(n: number): string {
  if (n === 100) return "cien";
  const c = Math.floor(n / 100);
  const r = n % 100;
  const resto = r < 30 ? UNIDADES[r] : `${DECENAS[Math.floor(r / 10)]}${r % 10 ? ` y ${UNIDADES[r % 10]}` : ""}`;
  return [CENTENAS[c], resto].filter(Boolean).join(" ");
}

/** 408.8 → "cuatrocientos ocho 80/100" (como en las constancias). */
export function amountInWords(amount: number): string {
  const entero = Math.floor(round2(amount));
  const centavos = Math.round((round2(amount) - entero) * 100);
  const millones = Math.floor(entero / 1_000_000);
  const miles = Math.floor((entero % 1_000_000) / 1000);
  const unidades = entero % 1000;
  const partes = [
    millones ? (millones === 1 ? "un millón" : `${hasta999(millones).replace(/uno$/, "un")} millones`) : "",
    miles ? (miles === 1 ? "mil" : `${hasta999(miles).replace(/uno$/, "un")} mil`) : "",
    hasta999(unidades),
  ].filter(Boolean);
  return `${partes.join(" ") || "cero"} ${String(centavos).padStart(2, "0")}/100`;
}

interface Fields {
  template: Template;
  name: string;
  dui: string;
  position: string;
  hireDate: string;
  salary: number;
  extra: number;
  issueDate: string;
  signerName: string;
  signerTitle: string;
}

export function SalaryCertificate({ employee, onClose, onIssued }: { employee: Employee; onClose: () => void; onIssued: () => void }) {
  const [f, setF] = useState<Fields>(() => ({
    template: employee.area === "ventas" ? "comisiones" : "bono",
    name: employee.full_name.toUpperCase(),
    dui: employee.dui ?? "",
    position: employee.position ?? "",
    hireDate: employee.hire_date ?? "",
    salary: Number(employee.base_salary) || 0,
    extra: 0,
    issueDate: today(),
    signerName: "Kelvin Iván Rodríguez Zelada",
    signerTitle: "Gerente de Recursos Humanos",
  }));
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setF((s) => ({ ...s, [key]: value }));
  const page = useRef<HTMLDivElement>(null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const c = useMemo(() => {
    const isss = round2(Math.min(f.salary, ISSS_CAP) * ISSS_RATE);
    const afp = round2(f.salary * AFP_RATE);
    const deductions = round2(isss + afp);
    const renta = round2(f.extra * RENTA_RATE);
    return { isss, afp, deductions, net: round2(f.salary - deductions), renta, extraNet: round2(f.extra - renta) };
  }, [f.salary, f.extra]);

  // La hoja se vuelve a armar cuando cambia un dato del panel; las correcciones hechas a mano
  // sobre la hoja se conservan mientras no se toque el panel.
  const version = JSON.stringify(f);
  useEffect(() => setEdited(false), [version]);

  /** Primero se registra (quién, cuándo y la hoja exacta); si no se pudo guardar no se descarga. */
  async function download() {
    if (!page.current) return;
    const html = sanitizeCertificateHtml(page.current.outerHTML);
    setBusy(true);
    setError(null);
    try {
      await api.post(`/employees/${employee.id}/certificates`, {
        template: f.template,
        issue_date: f.issueDate,
        salary: f.salary.toFixed(2),
        extra: (f.template === "salario" ? 0 : f.extra).toFixed(2),
        html,
      });
      onIssued();
      printCertificate(html, `Constancia laboral - ${f.name}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const portador = employee.gender === "Femenino" ? "portadora" : "portador";
  const extraLabel = f.template === "bono" ? "Bono" : "Comisiones";
  const [issueY, issueM, issueD] = f.issueDate.split("-").map(Number);

  return createPortal(
    <div className="cert-overlay" role="dialog" aria-modal aria-label="Constancia salarial">
      <style>{CERT_CSS}</style>
      <aside className="cert-panel">
        <div className="modal-head">
          <h2>Constancia salarial</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <IconX width={20} height={20} />
          </button>
        </div>
        <label className="field">
          <span>Plantilla</span>
          <select className="input" value={f.template} onChange={(e) => set("template", e.target.value as Template)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <div className="cert-two">
          <label className="field">
            <span>DUI</span>
            <input className="input" value={f.dui} onChange={(e) => set("dui", e.target.value)} placeholder="00000000-0" />
          </label>
          <label className="field">
            <span>Labora desde</span>
            <input className="input" type="date" value={f.hireDate} onChange={(e) => set("hireDate", e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Cargo</span>
          <input className="input" value={f.position} onChange={(e) => set("position", e.target.value)} />
        </label>
        <div className="cert-two">
          <label className="field">
            <span>Salario mensual (USD)</span>
            <input className="input" type="number" min="0" step="0.01" value={f.salary} onChange={(e) => set("salary", Number(e.target.value))} />
          </label>
          {f.template !== "salario" && (
            <label className="field">
              <span>{f.template === "bono" ? "Bono mensual" : "Promedio comisiones 6 meses"}</span>
              <input className="input" type="number" min="0" step="0.01" value={f.extra} onChange={(e) => set("extra", Number(e.target.value))} />
            </label>
          )}
        </div>
        <label className="field">
          <span>Fecha de la constancia</span>
          <input className="input" type="date" value={f.issueDate} onChange={(e) => set("issueDate", e.target.value || today())} />
        </label>
        <div className="cert-two">
          <label className="field">
            <span>Firma</span>
            <input className="input" value={f.signerName} onChange={(e) => set("signerName", e.target.value)} />
          </label>
          <label className="field">
            <span>Cargo de quien firma</span>
            <input className="input" value={f.signerTitle} onChange={(e) => set("signerTitle", e.target.value)} />
          </label>
        </div>
        <p className="caption">
          ISSS 3% (máx. sobre $1,000) y AFP 7.25% se calculan solos; la renta del {extraLabel.toLowerCase()} es 10%. Puede
          corregir cualquier texto haciendo clic sobre la hoja{edited ? "; si cambia un dato de este panel, esas correcciones se pierden" : ""}.
        </p>
        <div className="cert-actions">
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn" onClick={download} disabled={busy || !f.name.trim()}>
            {busy ? "Registrando…" : "Descargar PDF"}
          </button>
        </div>
        {error && <div className="alert">{error}</div>}
        <span className="caption">Al descargar, la constancia queda registrada con su nombre y la fecha. En la ventana de impresión elija «Guardar como PDF».</span>
      </aside>

      <div className="cert-stage">
        <div
          key={version}
          ref={page}
          className="cert-page"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onInput={() => setEdited(true)}
        >
          <div className="cert-fit">
          <img className="cert-logo" src="/logo-connecting.png" alt="Connecting S.A. de C.V." />
          <h1 className="cert-title">CONSTANCIA LABORAL</h1>
          <p className="cert-to">A QUIEN INTERESE:</p>
          <p className="cert-body">
            Por medio de la presente hago constar que <b>{f.name || "XXXXXXX"}</b>, {portador} de su Documento Único de Identidad número{" "}
            {f.dui || "XXXXXXXX-X"}; labora para nosotros desde el {f.hireDate ? longDate(f.hireDate) : "XXXXXXX"} a la fecha, desempeñando el
            cargo de <b>{f.position.toUpperCase() || "XXXXXXX"}</b>, devengando un salario mensual de{" "}
            <b>
              {amountInWords(f.salary)} ({money(f.salary)})
            </b>
            {f.template === "bono" && (
              <>
                , más un bono mensual de{" "}
                <b>
                  {amountInWords(f.extra)} ({money(f.extra)})
                </b>
              </>
            )}
            {f.template === "comisiones" && (
              <>
                {" "}más promedio de comisiones de un periodo de 6 meses{" "}
                <b>
                  {amountInWords(f.extra)} ({money(f.extra)})
                </b>
              </>
            )}
            . Con la siguiente deducción:
          </p>

          <table className="cert-table">
            <tbody>
              <tr>
                <th>Salario Mensual:</th>
                <td>{money(f.salary)}</td>
              </tr>
              <tr>
                <td>Menos:</td>
                <td />
              </tr>
              <tr>
                <td>ISSS</td>
                <td>{money(c.isss)}</td>
              </tr>
              <tr>
                <td>AFP</td>
                <td className="u">{money(c.afp)}</td>
              </tr>
              <tr>
                <td>Total, deducciones:</td>
                <td>{money(c.deductions)}</td>
              </tr>
              <tr>
                <th>Sueldo líquido</th>
                <td>{money(c.net)}</td>
              </tr>
              {f.template !== "salario" && (
                <>
                  <tr className="gap">
                    <th>{extraLabel}:</th>
                    <td>{money(f.extra)}</td>
                  </tr>
                  <tr>
                    <td>Renta 10%</td>
                    <td className="u">{money(c.renta)}</td>
                  </tr>
                  <tr>
                    <th>Total, {extraLabel.toLowerCase()}</th>
                    <td>{money(c.extraNet)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          <p className="cert-body">
            Y para los usos de la parte interesada extiendo y firmo la presente a los {issueD} días del mes de {MESES[issueM - 1]} del año {issueY}.
          </p>

          <div className="cert-sign">
            <div>F.______________________________</div>
            <b>{f.signerName}</b>
            <div>{f.signerTitle}</div>
          </div>
          </div>

          <footer className="cert-foot">Calle la Reforma, Colonia San Benito Local LA-16 Condominio Plaza Suiza. Tel. 2118-0466 y 7494-0816</footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const ALLOWED_TAGS = new Set(["DIV", "P", "B", "STRONG", "I", "EM", "U", "SPAN", "BR", "H1", "TABLE", "TBODY", "TR", "TH", "TD", "FOOTER", "IMG"]);

/** Deja solo lo que puede tener una constancia: etiquetas de texto y tabla, con su clase, y el logo.
 *  Se aplica al guardar y al volver a imprimir una constancia guardada. */
export function sanitizeCertificateHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const clean = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const keep = attr.name === "class" || (child.tagName === "IMG" && attr.name === "alt");
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === "IMG") child.setAttribute("src", "/logo-connecting.png");
      clean(child);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

/** Abre la impresión de la hoja (para «Guardar como PDF») sin salir de la página. Siempre sale
 *  en una sola hoja carta: si el contenido no cabe (p.ej. se agregó texto), se reduce para que quepa. */
export function printCertificate(html: string, title: string) {
  const frame = document.createElement("iframe");
  // Del tamaño de la hoja y fuera de la vista, para medir el contenido como quedará impreso.
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:8.5in;height:11in;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title></title><base href="${location.origin}/">
    <style>${CERT_CSS}${PRINT_CSS}</style></head><body>${html}</body></html>`);
  doc.close();
  doc.title = title;
  const print = () => {
    const sheet = doc.querySelector<HTMLElement>(".cert-page");
    const content = sheet?.querySelector<HTMLElement>(".cert-fit");
    if (sheet && content) {
      // Espacio desde el inicio del contenido hasta el pie de página.
      const foot = sheet.querySelector<HTMLElement>(".cert-foot");
      const limit = (foot ? foot.offsetTop - 12 : sheet.clientHeight) - content.offsetTop;
      if (content.scrollHeight > limit) content.style.zoom = String(limit / content.scrollHeight);
    }
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
  };
  const logo = doc.querySelector("img");
  if (logo && !logo.complete) logo.onload = logo.onerror = print;
  else print();
}

/** La hoja impresa ocupa exactamente una página carta y nunca se parte en dos. */
const PRINT_CSS = `
@page { size: letter; margin: 0; }
html, body { margin: 0; padding: 0; }
.cert-page { width: 8.5in; height: 11in; min-height: 0; overflow: hidden; box-shadow: none; margin: 0; break-inside: avoid; }
@media print {
  html, body { width: 100%; height: 100%; overflow: hidden; }
  .cert-page { width: 100%; height: 100vh; }
}
`;

/** Estilos de la hoja: los mismos en pantalla y en el PDF. Tamaño carta, como las plantillas. */
const CERT_CSS = `
.cert-page {
  position: relative; box-sizing: border-box; width: 8.5in; min-height: 11in; padding: 0.55in 1in 1in;
  background: #fff; color: #111; font-family: "Century Gothic", "Plus Jakarta Sans", Arial, sans-serif;
  font-size: 11pt; line-height: 1.75; box-shadow: 0 6px 24px rgba(15, 23, 42, 0.18); outline: none;
}
.cert-logo { width: 1.9in; margin-left: -0.15in; display: block; }
.cert-title { font-size: 11pt; font-weight: 700; text-align: center; margin: 0.25in 0 0.3in; font-family: inherit; }
.cert-to { font-weight: 700; text-decoration: underline; margin: 0 0 6pt; }
.cert-body { text-align: justify; margin: 0 0 0.3in; }
.cert-table { border-collapse: collapse; margin: 0 0 0.35in; }
.cert-table th, .cert-table td { text-align: left; padding: 3pt 0; font-weight: 400; }
.cert-table th { font-weight: 700; }
.cert-table td:last-child { padding-left: 0.9in; }
.cert-table .u { text-decoration: underline; }
.cert-table .gap th, .cert-table .gap td { padding-top: 0.3in; }
.cert-sign { margin-top: 0.8in; line-height: 1.6; }
.cert-foot { position: absolute; left: 0; right: 0; bottom: 0.55in; text-align: center; font-size: 8.5pt; }
`;
