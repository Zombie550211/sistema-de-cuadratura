/** PDF de Marcaciones sin librerías: cada tabla se dibuja con el mismo canvas de «Descargar imagen»
 *  (tableImage) y las imágenes se acomodan en páginas carta horizontales de un PDF escrito a mano.
 *  Así no se agrega ninguna dependencia de npm. */
import { tableImage, type ImageCell } from "./tableImage";

export interface PdfCell {
  text: string;
  /** Línea pequeña debajo del valor (p. ej. los días o el total). */
  sub?: string;
  danger?: boolean;
  muted?: boolean;
}

export interface PdfSection {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: PdfCell[][];
}

const W = 792; // carta horizontal, en puntos
const H = 612;
const M = 36;
const FOOT = 22; // alto reservado para el pie de página
const PX = 0.5; // puntos por píxel CSS del canvas
const GAP = 14;
/** Filas por imagen, para que cada tabla quepa en una página sin achicarse. */
const SUMMARY_ROWS = 12;
const DETAIL_ROWS = 16;

interface Placed {
  jpeg: Uint8Array;
  pxW: number;
  pxH: number;
}

const toImageCell = (c: PdfCell): ImageCell => ({ text: c.text, sub: c.sub ? [c.sub] : [], danger: c.danger, muted: c.muted });

async function draw(s: PdfSection, part: number, parts: number, footer?: string): Promise<Placed> {
  const blob = await tableImage({
    title: s.title,
    subtitle: [s.subtitle, parts > 1 ? `Parte ${part} de ${parts}` : ""].filter(Boolean).join(" · "),
    columns: s.columns.map((label) => ({ label })),
    rows: s.rows.map((r) => r.map(toImageCell)),
    footer,
    mime: "image/jpeg",
  });
  const bmp = await createImageBitmap(blob);
  const placed = { jpeg: new Uint8Array(await blob.arrayBuffer()), pxW: bmp.width, pxH: bmp.height };
  bmp.close();
  return placed;
}

/** Parte una sección en varias tablas de hasta n filas. */
function chunks(s: PdfSection, n: number): PdfSection[] {
  if (s.rows.length <= n) return [s];
  const out: PdfSection[] = [];
  for (let i = 0; i < s.rows.length; i += n) out.push({ ...s, rows: s.rows.slice(i, i + n) });
  return out;
}

// --- Escritura del PDF -----------------------------------------------------------------------

/** Texto en WinAnsi (latín-1) para la fuente Helvetica estándar; lo que no cabe se cambia. */
function latin1(s: string): Uint8Array {
  const clean = s.replace(/[   ]/g, " ").replace(/[–—]/g, "-");
  return Uint8Array.from(clean, (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));
}
const pdfString = (s: string) => {
  const bytes = latin1(s);
  let out = "";
  for (const b of bytes) out += b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}` : String.fromCharCode(b);
  return `(${out})`;
};

function writePdf(pages: { images: { img: Placed; x: number; y: number; w: number; h: number }[]; footLeft: string; footRight: string }[]): Blob {
  const chunksOut: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? Uint8Array.from(b, (c) => c.charCodeAt(0) & 0xff) : b;
    chunksOut.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, ...body: (Uint8Array | string)[]) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };

  // 1 catálogo, 2 páginas, 3 fuente; luego por página: página, contenido e imágenes.
  let next = 4;
  const plan = pages.map((p) => {
    const page = next++;
    const content = next++;
    const imgs = p.images.map(() => next++);
    return { page, content, imgs };
  });

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${plan.map((p) => `${p.page} 0 R`).join(" ")}] >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  pages.forEach((p, i) => {
    const ids = plan[i];
    const xobjs = ids.imgs.map((id, k) => `/Im${k} ${id} 0 R`).join(" ");
    obj(ids.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R >> /XObject << ${xobjs} >> >> /Contents ${ids.content} 0 R >>`);
    let stream = "";
    p.images.forEach((im, k) => {
      stream += `q ${im.w.toFixed(2)} 0 0 ${im.h.toFixed(2)} ${im.x.toFixed(2)} ${(H - im.y - im.h).toFixed(2)} cm /Im${k} Do Q\n`;
    });
    stream += `BT /F1 8 Tf 0.34 0.39 0.49 rg ${M} ${M / 2} Td ${pdfString(p.footLeft)} Tj ET\n`;
    const rightW = p.footRight.length * 4.2; // aproximado para alinear a la derecha
    stream += `BT /F1 8 Tf 0.34 0.39 0.49 rg ${(W - M - rightW).toFixed(2)} ${M / 2} Td ${pdfString(p.footRight)} Tj ET\n`;
    const bytes = Uint8Array.from(stream, (c) => c.charCodeAt(0) & 0xff);
    obj(ids.content, `<< /Length ${bytes.length} >>\nstream\n`, bytes, "\nendstream");
    p.images.forEach((im, k) => {
      obj(
        ids.imgs[k],
        `<< /Type /XObject /Subtype /Image /Width ${im.img.pxW} /Height ${im.img.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.img.jpeg.length} >>\nstream\n`,
        im.img.jpeg,
        "\nendstream",
      );
    });
  });

  const xref = size;
  const total = next;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunksOut as BlobPart[], { type: "application/pdf" });
}

export async function marcacionesPdf(opts: {
  title: string;
  /** «Fecha de corte: 1 – 12 nov 2026» o «Quincena: …». */
  period: string;
  summary: PdfSection;
  details: PdfSection[];
  footer: string;
}): Promise<Blob> {
  const generated = new Intl.DateTimeFormat("es-SV", { timeZone: "America/El_Salvador", dateStyle: "long", timeStyle: "short" }).format(new Date());

  // Resumen: el título lleva el local y el periodo; la nota va en la última parte.
  const summaryParts = chunks({ ...opts.summary, title: opts.title, subtitle: `${opts.period} · ${opts.summary.subtitle ?? ""}` }, SUMMARY_ROWS);
  const images: { img: Placed; newPage: boolean }[] = [];
  for (let i = 0; i < summaryParts.length; i++) {
    images.push({ img: await draw(summaryParts[i], i + 1, summaryParts.length, i === summaryParts.length - 1 ? opts.footer : undefined), newPage: false });
  }
  // Detalle: empieza en página nueva; cada empleado es una tabla (o varias si el periodo es largo).
  let first = true;
  for (const s of opts.details) {
    const parts = chunks(s, DETAIL_ROWS);
    for (let i = 0; i < parts.length; i++) {
      images.push({ img: await draw(parts[i], i + 1, parts.length), newPage: first });
      first = false;
    }
  }

  return paginar(images, opts.title, opts.period, generated);
}

/** PDF de una sola ventana (p. ej. el detalle de un empleado): una tabla, partida en páginas si
 *  es larga, con el título y el periodo arriba. */
export async function ventanaPdf(opts: { title: string; period: string; section: PdfSection; footer?: string; rowsPerPage?: number }): Promise<Blob> {
  const generated = new Intl.DateTimeFormat("es-SV", { timeZone: "America/El_Salvador", dateStyle: "long", timeStyle: "short" }).format(new Date());
  const parts = chunks(opts.section, opts.rowsPerPage ?? 14);
  const images: { img: Placed; newPage: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    images.push({ img: await draw(parts[i], i + 1, parts.length, i === parts.length - 1 ? opts.footer : undefined), newPage: i > 0 });
  }
  return paginar(images, opts.title, opts.period, generated);
}

/** Acomoda las imágenes de arriba abajo; si una no cabe en lo que queda, pasa a la página siguiente. */
function paginar(images: { img: Placed; newPage: boolean }[], title: string, period: string, generated: string): Blob {
  const maxW = W - M * 2;
  const maxH = H - M * 2 - FOOT;
  const pages: { images: { img: Placed; x: number; y: number; w: number; h: number }[] }[] = [{ images: [] }];
  let y = M;
  for (const { img, newPage } of images) {
    // El canvas está a escala 2: el ancho CSS es la mitad de los píxeles.
    let w = (img.pxW / 2) * PX;
    let h = (img.pxH / 2) * PX;
    const fit = Math.min(1, maxW / w, maxH / h);
    w *= fit;
    h *= fit;
    const page = pages[pages.length - 1];
    if ((newPage && page.images.length) || (page.images.length && y + h > M + maxH)) {
      pages.push({ images: [] });
      y = M;
    }
    pages[pages.length - 1].images.push({ img, x: M, y, w, h });
    y += h + GAP;
  }

  return writePdf(
    pages.map((p, i) => ({
      ...p,
      footLeft: `${title} · ${period} · Generado el ${generated}`,
      footRight: `Página ${i + 1} de ${pages.length}`,
    })),
  );
}
