/** Dibuja una tabla como imagen PNG (con canvas, sin librerías) para descargarla y compartirla. */

export interface ImageColumn {
  label: string;
  align?: "left" | "center";
}

export interface ImageCell {
  text: string;
  /** Resalta el valor en rojo (p. ej. llegada tarde o días que no se presentó). */
  danger?: boolean;
  muted?: boolean;
}

const C = {
  bg: "#ffffff",
  head: "#f1f5f9",
  zebra: "#f8fafc",
  line: "#e2e8f0",
  text: "#0f172a",
  muted: "#56637d",
  danger: "#dc2626",
  accent: "#0891b2",
};
const UI = '"Plus Jakarta Sans", system-ui, sans-serif';
const DISPLAY = '"Outfit", system-ui, sans-serif';
const PAD = 32;
const CELL_X = 16;
const ROW_H = 40;
const HEAD_H = 40;
const SCALE = 2;

export async function tableImage(opts: {
  title: string;
  subtitle: string;
  columns: ImageColumn[];
  rows: ImageCell[][];
  footer?: string;
}): Promise<Blob> {
  await document.fonts.ready;
  const measure = document.createElement("canvas").getContext("2d")!;
  const widths = opts.columns.map((col, i) => {
    measure.font = `700 12px ${UI}`;
    let w = measure.measureText(col.label.toUpperCase()).width;
    for (const row of opts.rows) {
      measure.font = `${i === 0 ? 600 : 500} 14px ${UI}`;
      w = Math.max(w, measure.measureText(row[i]?.text ?? "").width);
    }
    return Math.ceil(w) + CELL_X * 2;
  });
  measure.font = `700 24px ${DISPLAY}`;
  const titleW = measure.measureText(opts.title).width;
  measure.font = `500 12px ${UI}`;
  const footerW = opts.footer ? measure.measureText(opts.footer).width : 0;
  const tableW = widths.reduce((a, b) => a + b, 0);
  const width = Math.ceil(Math.max(tableW, titleW, footerW, 480)) + PAD * 2;
  const tableTop = PAD + 64;
  const footerH = opts.footer ? 40 : 0;
  const height = tableTop + HEAD_H + opts.rows.length * ROW_H + footerH + PAD;

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
  const text = (s: string, i: number, y: number) => {
    const center = opts.columns[i].align === "center";
    ctx.textAlign = center ? "center" : "left";
    ctx.fillText(s, center ? cellX(i) + widths[i] / 2 : cellX(i) + CELL_X, y);
  };

  ctx.fillStyle = C.head;
  ctx.fillRect(x0, tableTop, tableW, HEAD_H);
  ctx.fillStyle = C.muted;
  ctx.font = `700 12px ${UI}`;
  opts.columns.forEach((col, i) => text(col.label.toUpperCase(), i, tableTop + HEAD_H / 2));

  opts.rows.forEach((row, r) => {
    const y = tableTop + HEAD_H + r * ROW_H;
    if (r % 2) {
      ctx.fillStyle = C.zebra;
      ctx.fillRect(x0, y, tableW, ROW_H);
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(x0, y + ROW_H - 1, tableW, 1);
    row.forEach((cell, i) => {
      ctx.fillStyle = cell.danger ? C.danger : cell.muted ? C.muted : C.text;
      ctx.font = `${i === 0 || cell.danger ? 600 : 500} 14px ${UI}`;
      text(cell.text, i, y + ROW_H / 2);
    });
  });
  ctx.strokeStyle = C.line;
  ctx.strokeRect(x0 + 0.5, tableTop + 0.5, tableW - 1, HEAD_H + opts.rows.length * ROW_H - 1);

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
