/** Dibuja una tabla como imagen PNG (con canvas, sin librerías) para descargarla y compartirla.
 *  Las celdas pueden llevar el valor como insignia (igual que en pantalla) y líneas de detalle. */

export interface ImageColumn {
  label: string;
  align?: "left" | "center";
}

export interface ImageCell {
  text: string;
  /** Resalta el valor en rojo (p. ej. llegada tarde o días que no se presentó). */
  danger?: boolean;
  muted?: boolean;
  /** Dibuja el valor como insignia: gris, roja o celeste (como la huella). */
  badge?: "plain" | "danger" | "accent";
  /** Líneas pequeñas debajo del valor (se parten si son largas). */
  sub?: string[];
}

const C = {
  bg: "#ffffff",
  head: "#f8fafc",
  zebra: "#fcfdfe",
  line: "#e2e8f0",
  text: "#0f172a",
  muted: "#56637d",
  danger: "#dc2626",
  dangerBg: "#fef2f2",
  accent: "#0891b2",
  plainBg: "#eef2f6",
};
const UI = '"Inter Variable", system-ui, sans-serif';
const DISPLAY = '"Inter Variable", system-ui, sans-serif';
const PAD = 32;
const CELL_X = 16;
const CELL_Y = 14;
const HEAD_H = 40;
const MAIN_H = 20;
const BADGE_H = 24;
const SUB_H = 17;
/** Ancho máximo de las líneas de detalle antes de partirlas (como en la tabla). */
const SUB_MAX = 190;
const SCALE = 2;

const mainFont = (col: number, cell: ImageCell) => `${col === 0 || cell.danger ? 600 : 500} ${cell.badge ? 12 : 14}px ${UI}`;
const SUB_FONT = `500 12px ${UI}`;

export async function tableImage(opts: {
  title: string;
  subtitle: string;
  columns: ImageColumn[];
  rows: ImageCell[][];
  footer?: string;
}): Promise<Blob> {
  await document.fonts.ready;
  const measure = document.createElement("canvas").getContext("2d")!;

  /** Parte un texto en líneas de hasta SUB_MAX px, por palabras. */
  function wrap(s: string): string[] {
    measure.font = SUB_FONT;
    const out: string[] = [];
    let line = "";
    for (const word of s.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure.measureText(next).width > SUB_MAX) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  const subs = opts.rows.map((row) => row.map((cell) => (cell.sub ?? []).flatMap(wrap)));
  const widths = opts.columns.map((col, i) => {
    measure.font = `700 12px ${UI}`;
    let w = measure.measureText(col.label.toUpperCase()).width;
    opts.rows.forEach((row, r) => {
      const cell = row[i];
      if (!cell) return;
      measure.font = mainFont(i, cell);
      w = Math.max(w, measure.measureText(cell.text).width + (cell.badge ? 20 : 0));
      measure.font = SUB_FONT;
      for (const s of subs[r][i]) w = Math.max(w, measure.measureText(s).width);
    });
    return Math.ceil(w) + CELL_X * 2;
  });
  const cellH = (cell: ImageCell | undefined, lines: string[]) => (cell?.badge ? BADGE_H : MAIN_H) + lines.length * SUB_H + (lines.length ? 4 : 0);
  const rowH = opts.rows.map((row, r) => Math.max(...row.map((cell, i) => cellH(cell, subs[r][i]))) + CELL_Y * 2);

  measure.font = `700 24px ${DISPLAY}`;
  const titleW = measure.measureText(opts.title).width;
  measure.font = `500 12px ${UI}`;
  const footerW = opts.footer ? measure.measureText(opts.footer).width : 0;
  const tableW = widths.reduce((a, b) => a + b, 0);
  const bodyH = rowH.reduce((a, b) => a + b, 0);
  const width = Math.ceil(Math.max(tableW, titleW, footerW, 480)) + PAD * 2;
  const tableTop = PAD + 64;
  const footerH = opts.footer ? 40 : 0;
  const height = tableTop + HEAD_H + bodyH + footerH + PAD;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "middle";

  ctx.fillStyle = C.text;
  ctx.font = `700 24px ${DISPLAY}`;
  ctx.fillText(opts.title, PAD, PAD + 14);
  ctx.fillStyle = C.muted;
  ctx.font = `500 14px ${UI}`;
  ctx.fillText(opts.subtitle, PAD, PAD + 44);

  const x0 = PAD;
  const cellX = (i: number) => x0 + widths.slice(0, i).reduce((a, b) => a + b, 0);
  /** X donde empieza un contenido de ancho w en la columna i. */
  const startX = (i: number, w: number) => (opts.columns[i].align === "center" ? cellX(i) + (widths[i] - w) / 2 : cellX(i) + CELL_X);

  ctx.fillStyle = C.head;
  ctx.fillRect(x0, tableTop, tableW, HEAD_H);
  ctx.fillStyle = C.muted;
  ctx.font = `700 12px ${UI}`;
  ctx.textAlign = "left";
  opts.columns.forEach((col, i) => {
    const label = col.label.toUpperCase();
    ctx.fillText(label, startX(i, ctx.measureText(label).width), tableTop + HEAD_H / 2);
  });
  ctx.fillStyle = C.line;
  ctx.fillRect(x0, tableTop + HEAD_H - 1, tableW, 1);

  let y = tableTop + HEAD_H;
  opts.rows.forEach((row, r) => {
    const h = rowH[r];
    if (r % 2) {
      ctx.fillStyle = C.zebra;
      ctx.fillRect(x0, y, tableW, h);
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(x0, y + h - 1, tableW, 1);
    row.forEach((cell, i) => {
      const lines = subs[r][i];
      let cy = y + (h - cellH(cell, lines)) / 2;
      ctx.font = mainFont(i, cell);
      const tw = ctx.measureText(cell.text).width;
      if (cell.badge) {
        const bw = tw + 20;
        const bx = startX(i, bw);
        const color = cell.badge === "danger" ? C.danger : cell.badge === "accent" ? C.accent : C.line;
        ctx.beginPath();
        ctx.roundRect(bx + 0.5, cy + 0.5, bw - 1, BADGE_H - 1, BADGE_H / 2);
        ctx.fillStyle = cell.badge === "danger" ? C.dangerBg : cell.badge === "accent" ? C.bg : C.plainBg;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = cell.badge === "danger" ? C.danger : cell.badge === "accent" ? C.accent : C.muted;
        ctx.fillText(cell.text, bx + 10, cy + BADGE_H / 2 + 0.5);
        cy += BADGE_H;
      } else {
        ctx.fillStyle = cell.danger ? C.danger : cell.muted ? C.muted : C.text;
        ctx.fillText(cell.text, startX(i, tw), cy + MAIN_H / 2);
        cy += MAIN_H;
      }
      if (lines.length) cy += 4;
      ctx.font = SUB_FONT;
      ctx.fillStyle = C.muted;
      for (const s of lines) {
        ctx.fillText(s, startX(i, ctx.measureText(s).width), cy + SUB_H / 2);
        cy += SUB_H;
      }
    });
    y += h;
  });
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, tableTop + 0.5, tableW - 1, HEAD_H + bodyH - 1);

  if (opts.footer) {
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = `500 12px ${UI}`;
    ctx.fillText(opts.footer, PAD, height - PAD - 8);
  }

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo crear la imagen"))), "image/png"));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
