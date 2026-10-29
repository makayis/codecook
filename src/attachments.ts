import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import type { Attachment } from "./types";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const NO_VISION_MODEL = "No checked model can read images.";
export const OLD_DOC_MESSAGE =
  "This old .doc file cannot be parsed. Save it as PDF or .docx and attach that instead.";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DOC_EXT = new Set([".pdf", ".docx", ".doc", ".html", ".htm", ".txt", ".md"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

let rootDir = "";

export function modelCanReadImages(modelId: string): boolean {
  const match = /(?:^|\/)gemini-(\d+)(?:\.(\d+))?/i.exec(modelId);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 2 || (major === 2 && minor >= 5);
}

export function setAttachmentRoot(dir: string): void {
  rootDir = dir;
}

export function attachmentKind(name: string, mime = ""): "image" | "document" | undefined {
  const ext = path.extname(name).toLowerCase();
  const type = mime.toLowerCase().split(";")[0].trim();
  if (IMAGE_EXT.has(ext) || IMAGE_MIME.has(type)) {
    if (ext && !IMAGE_EXT.has(ext)) {
      return undefined;
    }
    return "image";
  }
  if (DOC_EXT.has(ext)) {
    return "document";
  }
  return undefined;
}

export function mimeFor(name: string, mime = ""): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  const type = mime.toLowerCase().split(";")[0].trim();
  return type || "application/octet-stream";
}

function ensureName(name: string, mime: string, kind: "image" | "document"): string {
  const base = path.basename(name).replace(/[\\/]/g, "").trim() || (kind === "image" ? "screenshot" : "attachment");
  if (path.extname(base)) {
    return base;
  }
  if (kind !== "image") {
    return base;
  }
  if (mime.includes("jpeg")) return `${base}.jpg`;
  if (mime.includes("webp")) return `${base}.webp`;
  if (mime.includes("gif")) return `${base}.gif`;
  return `${base}.png`;
}

export function decodeAttachment(input: { name?: string; mime?: string; data?: string }): {
  name: string;
  mime: string;
  kind: "image" | "document";
  bytes: Buffer;
} {
  const rawName = (input.name || "attachment").trim() || "attachment";
  const mime = input.mime || "";
  const kind = attachmentKind(rawName, mime);
  if (!kind) {
    throw new Error(`Cannot attach ${rawName}. Use an image, PDF, Word, HTML, or text file.`);
  }
  const name = ensureName(rawName, mime, kind);
  const data = String(input.data || "").replace(/\s/g, "");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) {
    throw new Error(`${name} was empty.`);
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than 8 MB.`);
  }
  return { name, mime: mimeFor(name, mime), kind, bytes };
}

export function resolveAttachmentPath(rel: string): string {
  if (!rootDir) {
    throw new Error("Attachment storage is not available.");
  }
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || path.isAbsolute(rel) || cleaned.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Attachment path is outside the temporary folder.");
  }
  const abs = path.resolve(rootDir, ...cleaned.split("/"));
  const relative = path.relative(path.resolve(rootDir), abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Attachment path is outside the temporary folder.");
  }
  return abs;
}

export function saveChatAttachment(chatId: string, name: string, bytes: Buffer): { name: string; path: string } {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than 8 MB.`);
  }
  const safeChat = chatId.replace(/[^A-Za-z0-9_-]+/g, "_") || "chat";
  const safe = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "attachment";
  const rel = `${safeChat}/${Date.now().toString(36)}-${safe}`;
  const abs = resolveAttachmentPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return { name, path: rel };
}

export function attachmentPrompt(text: string, files: Attachment[]): string {
  const lines: string[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    lines.push(trimmed);
  }
  const docs = files.filter((file) => file.kind === "document");
  const images = files.filter((file) => file.kind === "image");
  if (docs.length) {
    lines.push("Attached documents. Call read_attachment on each path before answering:");
    for (const doc of docs) {
      lines.push(`- ${doc.name}: ${doc.path}`);
    }
  }
  if (images.length) {
    lines.push("Attached images:");
    for (const image of images) {
      lines.push(`- ${image.name}`);
    }
  }
  return lines.join("\n");
}

export function readAttachmentFile(rel: string): string {
  const abs = resolveAttachmentPath(rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Error: Attachment not found: '${rel}'`);
  }
  return documentText(path.basename(abs), fs.readFileSync(abs));
}

export function loadImageData(files: Attachment[]): Array<{ mime: string; data: string }> {
  const images: Array<{ mime: string; data: string }> = [];
  for (const file of files) {
    if (file.kind !== "image") {
      continue;
    }
    let abs: string;
    try {
      abs = resolveAttachmentPath(file.path);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) {
      continue;
    }
    images.push({ mime: file.mime || "image/png", data: fs.readFileSync(abs).toString("base64") });
  }
  return images;
}

export function hydrateImages(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.attachments)) {
      continue;
    }
    const images = loadImageData(msg.attachments as Attachment[]);
    if (images.length) {
      msg.images = images;
    }
  }
}

export function documentText(name: string, bytes: Buffer): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".doc") {
    return OLD_DOC_MESSAGE;
  }
  if (IMAGE_EXT.has(ext)) {
    return "This file is an image. It is not read as text.";
  }
  if (ext === ".pdf") {
    return extractPdfText(bytes);
  }
  if (ext === ".docx") {
    return extractDocxText(bytes);
  }
  if (ext === ".html" || ext === ".htm" || ext === ".txt" || ext === ".md") {
    return bytes.toString("utf8");
  }
  return "This file type cannot be read. Use an image, PDF, Word, HTML, or text file.";
}

const PDF_SCAN_BYTES = 12 * 1024 * 1024;
const PDF_STREAM_BYTES = 2 * 1024 * 1024;
const PDF_INFLATE_BYTES = 1500 * 1024;
const PDF_TEXT_CHARS = 80_000;
const PDF_TOKEN_WINDOW = 16_000;

function decodePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function decodePdfHex(hex: string): string {
  const even = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = Buffer.from(even, "hex");
  if (!bytes.length) {
    return "";
  }
  const utf16 = (bytes[0] === 0xfe && bytes[1] === 0xff) || looksLikeUtf16Be(bytes);
  if (utf16) {
    let text = "";
    const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
    for (let i = start; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (code) {
        text += String.fromCharCode(code);
      }
    }
    return text;
  }
  let text = "";
  for (const byte of bytes) {
    if (byte >= 32 && byte !== 127) {
      text += String.fromCharCode(byte);
    }
  }
  return text;
}

function looksLikeUtf16Be(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.length % 2 !== 0) {
    return false;
  }
  let zeros = 0;
  const pairs = bytes.length / 2;
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] === 0) {
      zeros += 1;
    }
  }
  return zeros * 2 >= pairs;
}

function followedByOp(text: string, index: number, op: string): boolean {
  let cursor = index;
  const end = Math.min(text.length, index + 12);
  while (cursor < end && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  if (!text.startsWith(op, cursor)) {
    return false;
  }
  const next = text[cursor + op.length] || "";
  return !/[A-Za-z]/.test(next);
}

function readPdfLiteral(text: string, start: number): { raw: string; end: number } | undefined {
  let cursor = start + 1;
  let depth = 1;
  let raw = "";
  const limit = Math.min(text.length, start + PDF_TOKEN_WINDOW);
  while (cursor < limit && depth > 0) {
    const ch = text[cursor];
    if (ch === "\\") {
      raw += ch;
      if (cursor + 1 < text.length) {
        raw += text[cursor + 1];
        cursor += 2;
      } else {
        cursor += 1;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      raw += ch;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return { raw, end: cursor + 1 };
      }
      raw += ch;
    } else {
      raw += ch;
    }
    cursor += 1;
  }
  return undefined;
}

function readPdfHex(text: string, start: number): { raw: string; end: number } | undefined {
  let cursor = start + 1;
  const limit = Math.min(text.length, start + 8192);
  let raw = "";
  while (cursor < limit) {
    const ch = text[cursor];
    if (ch === ">") {
      return raw.length ? { raw, end: cursor + 1 } : undefined;
    }
    if (/[0-9A-Fa-f]/.test(ch)) {
      raw += ch;
      cursor += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      cursor += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function stringsFromPdf(text: string, limit: number): string[] {
  const out: string[] = [];
  let used = 0;
  let cursor = 0;
  while (cursor < text.length && used < limit) {
    const ch = text[cursor];
    if (ch === "(") {
      const parsed = readPdfLiteral(text, cursor);
      if (!parsed) {
        cursor = Math.min(text.length, cursor + PDF_TOKEN_WINDOW);
        continue;
      }
      cursor = parsed.end;
      if (followedByOp(text, cursor, "Tj")) {
        const decoded = decodePdfLiteral(parsed.raw).trim();
        if (decoded) {
          out.push(decoded);
          used += decoded.length + 1;
        }
      }
      continue;
    }
    if (ch === "<" && text[cursor + 1] !== "<") {
      const parsed = readPdfHex(text, cursor);
      if (!parsed) {
        cursor = Math.min(text.length, cursor + PDF_TOKEN_WINDOW);
        continue;
      }
      cursor = parsed.end;
      if (followedByOp(text, cursor, "Tj")) {
        const decoded = decodePdfHex(parsed.raw).trim();
        if (decoded) {
          out.push(decoded);
          used += decoded.length + 1;
        }
      }
      continue;
    }
    if (ch === "[") {
      const found = scanPdfArray(text, cursor);
      if (!found) {
        cursor = Math.min(text.length, cursor + PDF_TOKEN_WINDOW);
        continue;
      }
      cursor = found.end;
      if (followedByOp(text, cursor, "TJ")) {
        for (const piece of found.pieces) {
          out.push(piece);
          used += piece.length + 1;
          if (used >= limit) {
            break;
          }
        }
      }
      continue;
    }
    cursor += 1;
  }
  return out;
}

function scanPdfArray(text: string, start: number): { end: number; pieces: string[] } | undefined {
  const pieces: string[] = [];
  const limit = Math.min(text.length, start + PDF_TOKEN_WINDOW);
  let cursor = start + 1;
  while (cursor < limit) {
    const ch = text[cursor];
    if (ch === "]") {
      return { end: cursor + 1, pieces };
    }
    if (ch === "(") {
      const parsed = readPdfLiteral(text, cursor);
      if (!parsed || parsed.end > limit) {
        return undefined;
      }
      const decoded = decodePdfLiteral(parsed.raw).trim();
      if (decoded) {
        pieces.push(decoded);
      }
      cursor = parsed.end;
      continue;
    }
    if (ch === "<" && text[cursor + 1] !== "<") {
      const parsed = readPdfHex(text, cursor);
      if (!parsed || parsed.end > limit) {
        return undefined;
      }
      const decoded = decodePdfHex(parsed.raw).trim();
      if (decoded) {
        pieces.push(decoded);
      }
      cursor = parsed.end;
      continue;
    }
    cursor += 1;
  }
  return undefined;
}

function inflatePdfStream(raw: Buffer): Buffer | undefined {
  if (!raw.length || raw.length > PDF_STREAM_BYTES) {
    return undefined;
  }
  const attempts = [raw];
  if (raw.length > 2) {
    attempts.push(raw.subarray(0, raw.length - 1));
  }
  const options = { maxOutputLength: PDF_INFLATE_BYTES };
  for (const buf of attempts) {
    try {
      return zlib.inflateSync(buf, options);
    } catch {
      try {
        return zlib.inflateRawSync(buf, options);
      } catch {
        /* try the next buffer */
      }
    }
  }
  return undefined;
}

function isImageStream(dict: string): boolean {
  return /\/Subtype\s*\/Image\b|\/DCTDecode\b|\/JPXDecode\b|\/CCITTFaxDecode\b|\/JBIG2Decode\b/.test(dict);
}

function streamLength(dict: string): number | undefined {
  const match = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (!match) {
    return undefined;
  }
  const length = Number(match[1]);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function pdfStreamBodies(source: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < source.length && bodies.length < 400) {
    const at = source.indexOf("stream", cursor);
    if (at < 0) {
      break;
    }
    const before = at === 0 ? " " : source[at - 1];
    const after = source[at + 6] || "";
    if (!/\s/.test(before) || !/[\s\r\n]/.test(after)) {
      cursor = at + 6;
      continue;
    }
    const dict = source.slice(Math.max(0, at - 800), at);
    let dataStart = at + 6;
    if (source[dataStart] === "\r" && source[dataStart + 1] === "\n") {
      dataStart += 2;
    } else if (source[dataStart] === "\n" || source[dataStart] === "\r") {
      dataStart += 1;
    }
    if (isImageStream(dict)) {
      const length = streamLength(dict);
      cursor = length != null ? dataStart + length : dataStart;
      const end = source.indexOf("endstream", cursor);
      cursor = end < 0 ? source.length : end + 9;
      continue;
    }
    const length = streamLength(dict);
    let raw: string;
    if (length != null && length <= PDF_STREAM_BYTES && dataStart + length <= source.length) {
      raw = source.slice(dataStart, dataStart + length);
      cursor = dataStart + length;
    } else {
      const end = source.indexOf("endstream", dataStart);
      if (end < 0) {
        break;
      }
      raw = source.slice(dataStart, end).replace(/\r?\n$/, "");
      cursor = end + 9;
    }
    if (!raw || raw.length > PDF_STREAM_BYTES) {
      continue;
    }
    const inflated = inflatePdfStream(Buffer.from(raw, "latin1"));
    bodies.push(inflated ? inflated.toString("latin1") : raw.slice(0, PDF_INFLATE_BYTES));
  }
  return bodies;
}

export function extractPdfText(bytes: Buffer): string {
  const slice = bytes.length > PDF_SCAN_BYTES ? bytes.subarray(0, PDF_SCAN_BYTES) : bytes;
  const pieces: string[] = [];
  let used = 0;
  for (const body of pdfStreamBodies(slice.toString("latin1"))) {
    for (const piece of stringsFromPdf(body, PDF_TEXT_CHARS - used)) {
      pieces.push(piece);
      used += piece.length + 1;
      if (used >= PDF_TEXT_CHARS) {
        break;
      }
    }
    if (used >= PDF_TEXT_CHARS) {
      break;
    }
  }
  const text = pieces.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || "This PDF has no extractable text.";
}

function inflateZip(method: number, comp: Buffer): string | undefined {
  if (method === 0) {
    return comp.toString("utf8");
  }
  if (method === 8) {
    return zlib.inflateRawSync(comp).toString("utf8");
  }
  return undefined;
}

function readLocalZip(data: Buffer, wanted: string): string | undefined {
  let offset = 0;
  while (offset + 30 <= data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) {
      break;
    }
    const method = data.readUInt16LE(offset + 8);
    const compSize = data.readUInt32LE(offset + 18);
    const nameLen = data.readUInt16LE(offset + 26);
    const extraLen = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.slice(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    if (name === wanted) {
      return inflateZip(method, data.slice(dataStart, dataStart + compSize));
    }
    offset = dataStart + compSize;
  }
  return undefined;
}

function readZipEntry(data: Buffer, wanted: string): string | undefined {
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = data.lastIndexOf(marker);
  if (eocd >= 0 && eocd + 22 <= data.length) {
    const count = data.readUInt16LE(eocd + 10);
    let cursor = data.readUInt32LE(eocd + 16);
    for (let i = 0; i < count && cursor + 46 <= data.length; i++) {
      if (data.readUInt32LE(cursor) !== 0x02014b50) {
        break;
      }
      const method = data.readUInt16LE(cursor + 10);
      const compSize = data.readUInt32LE(cursor + 20);
      const nameLen = data.readUInt16LE(cursor + 28);
      const extraLen = data.readUInt16LE(cursor + 30);
      const commentLen = data.readUInt16LE(cursor + 32);
      const localOff = data.readUInt32LE(cursor + 42);
      const name = data.slice(cursor + 46, cursor + 46 + nameLen).toString("utf8");
      if (name === wanted && localOff + 30 <= data.length) {
        const nameLenLocal = data.readUInt16LE(localOff + 26);
        const extraLenLocal = data.readUInt16LE(localOff + 28);
        const start = localOff + 30 + nameLenLocal + extraLenLocal;
        return inflateZip(method, data.slice(start, start + compSize));
      }
      cursor += 46 + nameLen + extraLen + commentLen;
    }
  }
  return readLocalZip(data, wanted);
}

function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractDocxText(bytes: Buffer): string {
  let xml: string | undefined;
  try {
    xml = readZipEntry(bytes, "word/document.xml");
  } catch {
    xml = undefined;
  }
  if (!xml) {
    return "This .docx file could not be read. Save it again as .docx and attach that.";
  }
  return docxXmlToText(xml) || "This .docx file has no extractable text.";
}
