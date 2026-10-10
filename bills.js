// Stores bills uploaded through the in-chat upload box and renders previews
// Claude can read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import heicConvert from "heic-convert";

export const ALLOWED_EXT = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic"];
export const MAX_BYTES = 20 * 1024 * 1024;

const ROOT = path.join(os.homedir(), ".nht-mcp");
const UPLOAD_DIR = path.join(ROOT, "uploads");

const safeName = (name) => path.basename(name).replace(/[^\w.-]+/g, "_");

export async function saveUpload(name, base64) {
  let ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`Unsupported file type "${ext}". Use ${ALLOWED_EXT.join(", ")}.`);
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error("The uploaded file is empty.");
  if (bytes.length > MAX_BYTES) throw new Error(`File is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`);

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = crypto.randomBytes(4).toString("hex");
  let file = path.join(UPLOAD_DIR, `${id}-${safeName(name)}`);

  // iPhone photos arrive as HEIC, which the portal may not accept and the
  // preview renderer can't decode.
  if (ext === ".heic") {
    const jpg = await heicConvert({ buffer: bytes, format: "JPEG", quality: 0.9 });
    file = file.replace(/\.heic$/i, ".jpg");
    fs.writeFileSync(file, Buffer.from(jpg));
  } else {
    fs.writeFileSync(file, bytes);
  }
  return { id, file, name: path.basename(file).slice(id.length + 1), bytes: bytes.length };
}

export function getBill(id) {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`Invalid bill_id "${id}".`);
  const match = fs.existsSync(UPLOAD_DIR) && fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(`${id}-`));
  if (!match) throw new Error(`No uploaded bill with id ${id}. Ask the user to upload it again with claim_bills.`);
  return path.join(UPLOAD_DIR, match);
}

// Claude rejects images over ~5 MB (base64); stay well under that.
const PREVIEW_MAX_BYTES = 1.5 * 1024 * 1024;

const PREVIEW_PX = 1600;

// First page of a PDF, drawn to a canvas whose longest side is PREVIEW_PX.
// pdf.js is large, so it's only loaded when a PDF comes in.
async function renderPdfPage(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pkgDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    standardFontDataUrl: path.join(pkgDir, "standard_fonts") + path.sep,
    cMapUrl: path.join(pkgDir, "cmaps") + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PREVIEW_PX / Math.max(base.width, base.height) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // PDFs are transparent by default; JPEG would turn that black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}

// Renders the first page of a PDF / any image to a JPEG, as base64.
// JPEG, not PNG: a 1600px camera photo as PNG is several MB and gets rejected.
// Steps down size/quality until the preview fits under PREVIEW_MAX_BYTES.
export async function renderPreview(file) {
  const source = path.extname(file).toLowerCase() === ".pdf" ? await renderPdfPage(file) : await loadImage(fs.readFileSync(file));
  let bytes;
  for (const [px, quality] of [[PREVIEW_PX, 80], [1280, 70], [1024, 60]]) {
    const scale = Math.min(1, px / Math.max(source.width, source.height));
    const canvas = createCanvas(Math.round(source.width * scale), Math.round(source.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // flatten transparent PNGs onto white
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    bytes = await canvas.encode("jpeg", quality);
    if (bytes.length <= PREVIEW_MAX_BYTES) break;
  }
  return bytes.toString("base64");
}
