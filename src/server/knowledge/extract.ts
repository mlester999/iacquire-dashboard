import "server-only";
import zlib from "node:zlib";
import { sanitizeClientText } from "@/server/workforce/compiler";

/**
 * Bounded, dependency-free text extraction for the document formats the Knowledge Center accepts.
 *
 * Supported today:
 *   - plain text, Markdown and CSV (already decoded by the caller);
 *   - PDFs with selectable Latin/UTF-16 text in uncompressed or Flate-compressed content streams;
 *   - DOCX text in word/document.xml plus headers, footers, footnotes and endnotes.
 *
 * Not supported, and reported honestly instead of guessed: encrypted PDFs, scanned/image-only PDFs,
 * PDFs that need OCR, exotic PDF filters, malformed archives and documents over the processing limits.
 */

export type ExtractionMethod = "plain_text" | "pdf" | "docx";
export type ExtractionFailureCode = "encrypted" | "scanned" | "malformed" | "unsupported" | "too_large" | "empty" | "failed";

export type ExtractionResult =
  | { ok: true; text: string; method: ExtractionMethod; detail?: string }
  | { ok: false; code: ExtractionFailureCode; detail: string; method: ExtractionMethod };

const MAX_TEXT = 200_000;
const MAX_DECOMPRESSED = 8 * 1024 * 1024;
const MAX_STREAMS = 400;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ENTRY_OUTPUT = 4 * 1024 * 1024;

export function extractPlainText(bytes: Buffer): ExtractionResult {
  const text = sanitizeClientText(bytes.toString("utf8"), MAX_TEXT);
  if (!text) return { ok: false, code: "empty", detail: "The document contains no readable text.", method: "plain_text" };
  return { ok: true, text, method: "plain_text" };
}

// ---------------------------------------------------------------------------
// DOCX: a small RFC 1951/1952 ZIP reader plus WordprocessingML text extraction
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_OUTPUT) throw new Error("zip_entry_too_large");
  if (entry.localOffset + 30 > buf.length) throw new Error("zip_truncated");
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("zip_local_header");
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length || start > end) throw new Error("zip_truncated");
  const data = buf.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: Math.min(entry.uncompressedSize || MAX_ENTRY_OUTPUT, MAX_ENTRY_OUTPUT) });
  }
  throw new Error("zip_compression");
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip_eocd");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("zip64");
  if (count > MAX_ZIP_ENTRIES) throw new Error("zip_too_many_entries");
  if (cdOffset + cdSize > buf.length) throw new Error("zip_truncated");
  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip_central_directory");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLen + extraLen + commentLen > buf.length) throw new Error("zip_truncated");
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function wordXmlText(xml: string) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(/<w:cr\b[^>]*\/>/gi, "\n")
    .split(/<\/w:p>/i)
    .map((paragraph) => {
      const parts = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map((m) => decodeXmlEntities(m[1]));
      return parts.join("");
    })
    .filter((paragraph) => paragraph.trim().length > 0)
    .join("\n");
}

export function extractDocx(bytes: Buffer): ExtractionResult {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return { ok: false, code: "malformed", detail: "This isn't a valid Word .docx archive.", method: "docx" };
  }
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(bytes);
  } catch (err) {
    const code = String((err as Error).message);
    return {
      ok: false,
      code: code === "zip64" ? "unsupported" : "malformed",
      detail: code === "zip64" ? "ZIP64 Word documents aren't supported yet." : "The Word document archive is malformed or truncated.",
      method: "docx",
    };
  }
  const wanted = entries.filter((entry) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(entry.name));
  if (!wanted.some((entry) => /^word\/document\.xml$/i.test(entry.name))) {
    return { ok: false, code: "malformed", detail: "The Word document is missing its main document part.", method: "docx" };
  }
  const chunks: string[] = [];
  for (const entry of wanted) {
    try {
      chunks.push(wordXmlText(readZipEntry(bytes, entry).toString("utf8")));
    } catch {
      return { ok: false, code: "failed", detail: `The Word document part ${entry.name} couldn't be read.`, method: "docx" };
    }
  }
  const text = sanitizeClientText(chunks.filter(Boolean).join("\n\n"), MAX_TEXT);
  if (!text) return { ok: false, code: "empty", detail: "The Word document contains no selectable text.", method: "docx" };
  return { ok: true, text, method: "docx" };
}

// ---------------------------------------------------------------------------
// PDF: bounded stream reader plus text-showing operators
// ---------------------------------------------------------------------------

function decodePdfLiteral(raw: string) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "\r") {
      if (body[i + 1] === "\n") i++;
    } else if (next === "\n") {
      // escaped newline is a continuation
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(body[i + 1] ?? ""); j++) octal += body[++i];
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function decodePdfHex(raw: string) {
  let hex = raw.slice(1, -1).replace(/\s+/g, "");
  if (hex.length % 2) hex += "0";
  if (!/^[0-9a-f]*$/i.test(hex)) return "";
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  // A preponderance of zero high bytes is the usual PDF UTF-16BE encoding of Latin text.
  let zeroHigh = 0;
  for (let i = 1; i < bytes.length; i += 2) if (bytes[i] === 0) zeroHigh++;
  if (bytes.length >= 4 && zeroHigh >= Math.floor(bytes.length / 4)) {
    const swapped = Buffer.from(bytes);
    if (swapped.length % 2) return "";
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("latin1");
}

function pdfContentText(content: string) {
  const token = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[jJ]\b|\bT[dD]\b|\bT\*\b|'|"|\bBT\b|\bET\b/g;
  let out = "";
  let pieces = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(content))) {
    const value = match[0];
    if (value.startsWith("(")) {
      out += decodePdfLiteral(value);
      pieces++;
    } else if (value.startsWith("<")) {
      out += decodePdfHex(value);
      pieces++;
    } else if (value === "'" || value === '"' || value === "T*" || value === "ET" || value === "Td" || value === "TD") {
      if (out && !out.endsWith("\n")) out += "\n";
    }
  }
  return { text: out, pieces };
}

function usablePdfText(text: string) {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return "";
  const chars = [...clean];
  const printable = chars.filter((ch) => ch === "\n" || ch === "\t" || (ch >= " " && ch <= "~") || ch.charCodeAt(0) >= 0xa0).length;
  if (printable / chars.length < 0.7) return "";
  return clean;
}

export function extractPdf(bytes: Buffer): ExtractionResult {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, code: "malformed", detail: "This isn't a valid PDF file.", method: "pdf" };
  }
  const raw = bytes.toString("latin1");
  if (/\/Encrypt\b/.test(raw)) {
    return { ok: false, code: "encrypted", detail: "This PDF is encrypted. Upload an unprotected copy or a text version.", method: "pdf" };
  }
  const object = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
  let decompressedTotal = 0;
  let streamsSeen = 0;
  const textParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = object.exec(raw)) && streamsSeen < MAX_STREAMS) {
    const body = match[2];
    const streamMatch = /\bstream\r?\n/.exec(body);
    if (!streamMatch) continue;
    const dataStart = match.index + match[0].indexOf(body) + streamMatch.index + streamMatch[0].length;
    const endstream = body.indexOf("endstream", streamMatch.index + streamMatch[0].length);
    if (endstream < 0) continue;
    const dataEnd = match.index + match[0].indexOf(body) + endstream;
    if (dataEnd <= dataStart) continue;
    const dictionary = body.slice(0, streamMatch.index);
    let stream = bytes.subarray(dataStart, dataEnd);
    if (/\/FlateDecode\b/.test(dictionary)) {
      if (decompressedTotal >= MAX_DECOMPRESSED) break;
      try {
        stream = zlib.inflateSync(stream, { maxOutputLength: Math.min(MAX_DECOMPRESSED - decompressedTotal, 2 * 1024 * 1024) });
      } catch {
        continue;
      }
    } else if (/\/Filter\b/.test(dictionary)) {
      continue; // unsupported filter (LZW, ASCII85, JBIG2, image codecs)
    }
    decompressedTotal += stream.length;
    if (decompressedTotal > MAX_DECOMPRESSED) break;
    streamsSeen++;
    const content = stream.toString("latin1");
    if (!/\bBT\b/.test(content)) continue;
    const parsed = pdfContentText(content);
    if (parsed.pieces > 0 && parsed.text.trim()) textParts.push(parsed.text);
  }
  const text = sanitizeClientText(usablePdfText(textParts.join("\n")), MAX_TEXT);
  if (!text) {
    return {
      ok: false,
      code: streamsSeen ? "scanned" : "malformed",
      detail: streamsSeen
        ? "No selectable text was found. This may be a scanned/image-only PDF or use a compression layout we can't read; OCR isn't supported."
        : "The PDF didn't contain a readable text stream.",
      method: "pdf",
    };
  }
  return { ok: true, text, method: "pdf" };
}

export function extractDocumentText(ext: string, bytes: Buffer): ExtractionResult {
  if (ext === "pdf") return extractPdf(bytes);
  if (ext === "docx") return extractDocx(bytes);
  return extractPlainText(bytes);
}
