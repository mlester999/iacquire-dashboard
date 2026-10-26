// A small, deterministic PDF writer for text documents: pages, wrapped paragraphs with bold and italic, bullet lists, rules, shaded boxes and tables that break across pages.
// No dependency, no compression, no clock and no randomness: the same input always makes the same bytes, so the hash stored with a document stays true and a copy made again
// later can be compared with it. Standard fonts only (src/lib/pdf/fonts.ts), Latin text, no images.
//
// The file is plain ASCII (non-ASCII characters are written as escapes), which also keeps cross-reference offsets equal to character counts.
import { FONT_NAMES, FONT_RESOURCES, charWidth, pdfLiteral, textWidth, type FontKey } from "@/lib/pdf/fonts";

export type { FontKey } from "@/lib/pdf/fonts";

export const PAGE_SIZES = { A4: { width: 595, height: 842 }, LETTER: { width: 612, height: 792 } } as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

/** A line is broken a little early, because the widths used are the published ones and are not checked against the font itself. */
export const LINE_SAFETY = 0.985;
/** Pages beyond this are refused rather than produced: a document that long is a mistake, and a serverless function must not spend its time on it. */
export const MAX_PAGES = 200;
/** The largest file produced. */
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

export class PdfLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfLimitError";
  }
}

export type Rgb = readonly [number, number, number];
export const INK: Rgb = [0.07, 0.08, 0.1];
export const MUTED: Rgb = [0.38, 0.4, 0.45];
export const LINE: Rgb = [0.82, 0.84, 0.88];
export const PANEL: Rgb = [0.955, 0.96, 0.97];

/** A number as short plain text: at most two decimals, no exponent, no negative zero. */
export function num(x: number): string {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

const color = (c: Rgb) => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

// ---------------------------------------------------------------------------
// Text runs
// ---------------------------------------------------------------------------

export interface Run {
  text: string;
  font: FontKey;
}

/**
 * Splits wording with **bold** and *italic* into runs. A marker with no partner stays as the text it is, so "5 * 3" and a lone asterisk print as typed. With base "bold" the
 * whole text is bold and markers are text.
 */
export function parseInline(text: string, base: "regular" | "bold" = "regular"): Run[] {
  if (base === "bold") return text ? [{ text, font: "bold" }] : [];
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    const font: FontKey = bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += buffer;
    else runs.push({ text: buffer, font });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i) && (bold || text.indexOf("**", i + 2) > i + 2)) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    const next = text[i + 1];
    if (text[i] === "*" && (italic || (next !== undefined && next !== " " && next !== "*" && text.indexOf("*", i + 1) > i + 1))) {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return runs;
}

interface Word {
  /** A word is one or more pieces of text when its style changes inside it ("**bo**ld"). */
  segs: Run[];
  width: number;
  /** The font of the space that follows it; null when it is the last word. */
  spaceFont: FontKey | null;
}

function wordsOf(runs: readonly Run[], size: number): Word[] {
  const words: Word[] = [];
  let open: Word | null = null;
  for (const run of runs) {
    for (const part of run.text.split(/( +)/)) {
      if (part === "") continue;
      if (part.trim() === "") {
        const last = words[words.length - 1];
        if (last) last.spaceFont = run.font;
        open = null;
        continue;
      }
      const width = textWidth(part, run.font, size);
      if (open) {
        open.segs.push({ text: part, font: run.font });
        open.width += width;
      } else {
        open = { segs: [{ text: part, font: run.font }], width, spaceFont: null };
        words.push(open);
      }
    }
  }
  return words;
}

export interface LaidLine {
  runs: Run[];
  width: number;
}

/** Breaks runs into lines no wider than `maxWidth` points. A word wider than a whole line is cut where it must be. */
export function wrapRuns(runs: readonly Run[], size: number, maxWidth: number): LaidLine[] {
  const limit = maxWidth * LINE_SAFETY;
  const lines: LaidLine[] = [];
  let cur: Run[] = [];
  let width = 0;
  const push = (text: string, font: FontKey) => {
    const last = cur[cur.length - 1];
    if (last && last.font === font) last.text += text;
    else cur.push({ text, font });
  };
  const endLine = () => {
    if (cur.length) lines.push({ runs: cur, width });
    cur = [];
    width = 0;
  };
  let before: Word | null = null;
  for (const w of wordsOf(runs, size)) {
    const gap = before?.spaceFont ? textWidth(" ", before.spaceFont, size) : 0;
    if (w.width > limit) {
      // Too long for any line: start it on a line of its own and cut it into whole lines.
      endLine();
      for (const seg of w.segs) {
        for (const ch of seg.text) {
          const cw = (charWidth(ch, seg.font) * size) / 1000;
          if (width + cw > limit && cur.length) endLine();
          push(ch, seg.font);
          width += cw;
        }
      }
    } else {
      if (cur.length && width + gap + w.width > limit) endLine();
      if (cur.length) {
        push(" ", before?.spaceFont ?? "regular");
        width += gap;
      }
      for (const seg of w.segs) push(seg.text, seg.font);
      width += w.width;
    }
    before = w;
  }
  endLine();
  return lines;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

interface PageData {
  ops: string[];
}

export interface PdfInfo {
  title: string;
  author?: string;
  subject?: string;
  /** Written as the creation date. Pass the moment the document's content was frozen, never "now": the date is part of the bytes. */
  createdAt: Date;
  /** Two identical documents with the same seed get the same file identifier. Pass the content hash. */
  idSeed: string;
}

export interface TextOptions {
  font?: FontKey;
  size?: number;
  color?: Rgb;
}

function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** A 16-byte file identifier (32 hex characters) from a seed. The seed is already a hash, so this only has to be stable. */
function fileId(seed: string): string {
  const hex = seed.toLowerCase().replace(/[^0-9a-f]/g, "");
  return (hex + "0".repeat(32)).slice(0, 32);
}

export class PdfDocument {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  private pages: PageData[] = [];

  constructor(readonly info: PdfInfo, opts: { size?: PageSizeName; margin?: number } = {}) {
    const size = PAGE_SIZES[opts.size ?? "A4"];
    this.width = size.width;
    this.height = size.height;
    this.margin = opts.margin ?? 54;
    this.addPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): number {
    if (this.pages.length >= MAX_PAGES) throw new PdfLimitError(`This document is longer than ${MAX_PAGES} pages, which is more than a proposal should be.`);
    this.pages.push({ ops: [] });
    return this.pages.length - 1;
  }

  private page(index: number): PageData {
    const p = this.pages[index];
    if (!p) throw new Error("No such page.");
    return p;
  }

  /** One line of text with its baseline `yTop` points from the TOP of the page. */
  textRuns(pageIndex: number, x: number, yTop: number, runs: readonly Run[], size: number, c: Rgb = INK): void {
    if (!runs.some((r) => r.text)) return;
    const parts: string[] = ["BT", `${color(c)} rg`, `1 0 0 1 ${num(x)} ${num(this.height - yTop)} Tm`];
    let current: FontKey | null = null;
    for (const run of runs) {
      if (!run.text) continue;
      if (run.font !== current) {
        parts.push(`/${FONT_RESOURCES[run.font]} ${num(size)} Tf`);
        current = run.font;
      }
      parts.push(`${pdfLiteral(run.text)} Tj`);
    }
    parts.push("ET");
    this.page(pageIndex).ops.push(parts.join("\n"));
  }

  text(pageIndex: number, x: number, yTop: number, text: string, o: TextOptions = {}): void {
    this.textRuns(pageIndex, x, yTop, [{ text, font: o.font ?? "regular" }], o.size ?? 10, o.color ?? INK);
  }

  /** The same, aligned so the text ENDS at `xRight`. */
  textRight(pageIndex: number, xRight: number, yTop: number, text: string, o: TextOptions = {}): void {
    this.text(pageIndex, xRight - textWidth(text, o.font ?? "regular", o.size ?? 10), yTop, text, o);
  }

  rule(pageIndex: number, x1: number, x2: number, yTop: number, c: Rgb = LINE, weight = 0.6): void {
    const y = this.height - yTop;
    this.page(pageIndex).ops.push(`${color(c)} RG\n${num(weight)} w\n${num(x1)} ${num(y)} m\n${num(x2)} ${num(y)} l\nS`);
  }

  /** A filled rectangle whose TOP edge is `yTop`. */
  fillRect(pageIndex: number, x: number, yTop: number, w: number, h: number, c: Rgb): void {
    this.page(pageIndex).ops.push(`${color(c)} rg\n${num(x)} ${num(this.height - yTop - h)} ${num(w)} ${num(h)} re\nf`);
  }

  /** The file. */
  build(): Buffer {
    const out: string[] = [];
    const offsets: number[] = [];
    let length = 0;
    const add = (s: string) => {
      out.push(s);
      length += s.length;
    };
    const object = (n: number, body: string) => {
      offsets[n] = length;
      add(`${n} 0 obj\n${body}\nendobj\n`);
    };
    // 1 catalog, 2 page tree, 3 info, 4-7 fonts, then a page object and a content stream for each page.
    const firstPage = 8;
    const kids = this.pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");
    add("%PDF-1.4\n%âãÏÓ\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R /Lang (en) /ViewerPreferences << /DisplayDocTitle true >> >>");
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    const info = [`/Title ${pdfLiteral(this.info.title)}`, `/Producer ${pdfLiteral("iAcquire")}`, `/Creator ${pdfLiteral("iAcquire proposals")}`, `/CreationDate (${pdfDate(this.info.createdAt)})`];
    if (this.info.author) info.push(`/Author ${pdfLiteral(this.info.author)}`);
    if (this.info.subject) info.push(`/Subject ${pdfLiteral(this.info.subject)}`);
    object(3, `<< ${info.join(" ")} >>`);
    const keys = Object.keys(FONT_NAMES) as FontKey[];
    keys.forEach((key, i) => object(4 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[key]} /Encoding /WinAnsiEncoding >>`));
    const fonts = keys.map((key, i) => `/${FONT_RESOURCES[key]} ${4 + i} 0 R`).join(" ");
    this.pages.forEach((page, i) => {
      const n = firstPage + i * 2;
      object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << ${fonts} >> >> /Contents ${n + 1} 0 R >>`);
      const content = page.ops.join("\n");
      object(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });
    const size = firstPage + this.pages.length * 2;
    const xrefAt = length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    add(xref);
    const id = fileId(this.info.idSeed);
    add(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const bytes = Buffer.from(out.join(""), "latin1");
    if (bytes.length > MAX_PDF_BYTES) throw new PdfLimitError("The document is too large to turn into a PDF.");
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Flowing layout
// ---------------------------------------------------------------------------

export interface ParagraphOptions {
  size?: number;
  color?: Rgb;
  /** "bold" sets the whole paragraph in bold (a heading); inline markers are then text. */
  base?: "regular" | "bold";
  indent?: number;
  spaceAfter?: number;
  /** The leading is the size times this. */
  leading?: number;
  /** Keep the paragraph's last line company: do not leave a heading alone at the bottom of a page. */
  keepWithNext?: boolean;
  /** Plain text: markers are written as they are. */
  literal?: boolean;
}

export interface TableColumn {
  /** Relative width. */
  weight: number;
  align?: "left" | "right";
  header: string;
}

export interface TableCell {
  /** One or more paragraphs; each is wrapped separately. */
  paragraphs: Array<{ text: string; font?: FontKey; size?: number; color?: Rgb; /** Read **bold** and *italic* in the text. */ inline?: boolean }>;
}

/**
 * Lays content down the page from the top margin, starting a new page when there is no room. Page furniture (footers) is drawn by the caller afterwards, once the page count
 * is known.
 */
export class Flow {
  y: number;
  page = 0;

  constructor(readonly doc: PdfDocument, private readonly top = doc.margin, private readonly bottom = doc.margin + 24) {
    this.y = top;
  }

  get left(): number {
    return this.doc.margin;
  }
  get right(): number {
    return this.doc.width - this.doc.margin;
  }
  get contentWidth(): number {
    return this.right - this.left;
  }
  /** Points left on this page above the bottom margin. */
  get remaining(): number {
    return this.doc.height - this.bottom - this.y;
  }

  /** A new page if fewer than `h` points are left. Returns true when it started one. */
  need(h: number): boolean {
    if (this.remaining >= h) return false;
    this.newPage();
    return true;
  }

  newPage(): void {
    this.page = this.doc.addPage();
    this.y = this.top;
  }

  space(h: number): void {
    this.y += h;
  }

  rule(c: Rgb = LINE): void {
    this.need(8);
    this.doc.rule(this.page, this.left, this.right, this.y + 2, c);
    this.y += 8;
  }

  /** A paragraph; line breaks in the text start new lines. Returns the number of lines set. */
  paragraph(text: string, o: ParagraphOptions = {}): number {
    const size = o.size ?? 10;
    const leading = size * (o.leading ?? 1.35);
    const indent = o.indent ?? 0;
    let count = 0;
    const blocks = text.split("\n");
    blocks.forEach((block, bi) => {
      if (block.trim() === "") {
        this.y += leading * 0.6;
        return;
      }
      const runs = o.literal ? [{ text: block, font: (o.base ?? "regular") as FontKey }] : parseInline(block, o.base ?? "regular");
      const lines = wrapRuns(runs, size, this.contentWidth - indent);
      lines.forEach((line, li) => {
        // A paragraph of several lines never starts with its first line alone at the bottom of a page or ends with its last line alone at the top of the next, and a heading
        // always has room for the first two lines of what it introduces.
        let reserve = leading;
        if (li === 0 && lines.length > 1) reserve = leading * 2;
        if (li === lines.length - 2 && lines.length > 2) reserve = leading * 2;
        if (li === 0 && o.keepWithNext && bi === blocks.length - 1) reserve += leading * 2;
        this.need(reserve);
        this.doc.textRuns(this.page, this.left + indent, this.y + size, line.runs, size, o.color ?? INK);
        this.y += leading;
        count += 1;
      });
    });
    this.y += o.spaceAfter ?? 0;
    return count;
  }

  heading(text: string, size = 13): void {
    this.paragraph(text, { size, base: "bold", spaceAfter: 4, keepWithNext: true, literal: true });
  }

  private item(marker: string, body: string, size: number, c: Rgb): void {
    const leading = size * 1.35;
    const markerWidth = 16;
    const lines = wrapRuns(parseInline(body), size, this.contentWidth - markerWidth);
    lines.forEach((l, i) => {
      this.need(i === 0 && lines.length > 1 ? leading * 2 : leading);
      // The marker belongs to the first line; a long item that runs onto the next page continues there without it.
      if (i === 0) this.doc.text(this.page, this.left + 4, this.y + size, marker, { size, color: c });
      this.doc.textRuns(this.page, this.left + markerWidth, this.y + size, l.runs, size, c);
      this.y += leading;
    });
    this.y += 2;
  }

  /** Wording with "- " bullets and "1. " numbers set as lists, the rest as paragraphs (consecutive lines of text join into one). */
  wording(text: string, o: { size?: number; color?: Rgb; spaceAfter?: number } = {}): void {
    const size = o.size ?? 10;
    const c = o.color ?? INK;
    let paragraph: string[] = [];
    const flushParagraph = () => {
      if (paragraph.length) this.paragraph(paragraph.join(" "), { size, color: c, spaceAfter: 5 });
      paragraph = [];
    };
    for (const line of text.split("\n")) {
      const bullet = /^\s*[-*] (.*)$/.exec(line);
      const numbered = /^\s*(\d{1,3})[.)] (.*)$/.exec(line);
      if (bullet || numbered) {
        flushParagraph();
        this.item(bullet ? "•" : `${numbered?.[1]}.`, (bullet ? bullet[1] : numbered?.[2]) ?? "", size, c);
      } else if (line.trim() === "") flushParagraph();
      else paragraph.push(line.trim());
    }
    flushParagraph();
    this.y += o.spaceAfter ?? 0;
  }

  /** A table whose header repeats on every page. A row stays whole when it fits and is split between lines only when it is taller than the room it has. */
  table(columns: readonly TableColumn[], rows: readonly (readonly TableCell[])[], o: { size?: number; padding?: number } = {}): void {
    const size = o.size ?? 9;
    const pad = o.padding ?? 5;
    const leading = size * 1.3;
    const total = columns.reduce((s, c) => s + c.weight, 0);
    const widths = columns.map((c) => (c.weight / total) * this.contentWidth);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const headerHeight = leading + pad * 2;

    const drawHeader = () => {
      this.need(headerHeight + leading + pad * 2);
      this.doc.fillRect(this.page, this.left, this.y, this.contentWidth, headerHeight, PANEL);
      columns.forEach((c, i) => {
        const x = c.align === "right" ? xs[i] + widths[i] - pad - textWidth(c.header, "bold", size) : xs[i] + pad;
        this.doc.text(this.page, x, this.y + pad + size, c.header, { font: "bold", size, color: MUTED });
      });
      this.y += headerHeight;
    };
    const layRow = (row: readonly TableCell[]) =>
      row.map((cell, i) => {
        const lines: Array<{ line: LaidLine; size: number; color: Rgb }> = [];
        for (const p of cell.paragraphs) {
          const psize = p.size ?? size;
          for (const line of wrapRuns(p.inline ? parseInline(p.text) : [{ text: p.text, font: p.font ?? "regular" }], psize, widths[i] - pad * 2)) lines.push({ line, size: psize, color: p.color ?? INK });
        }
        return lines;
      });
    const laidRows = rows.map(layRow);
    const linesOf = (laid: ReturnType<typeof layRow>) => Math.max(1, ...laid.map((l) => l.length));
    // Lines a row can have on a page of its own, under a header.
    const pageRoom = Math.floor((this.doc.height - this.bottom - this.top - headerHeight - pad * 2) / leading);
    // The header never stands alone at the foot of a page: the table starts only where its first row (or a few lines of it, if it is taller than a page) fits under it.
    if (laidRows.length) this.need(headerHeight + pad * 2 + (linesOf(laidRows[0]) <= pageRoom ? linesOf(laidRows[0]) : Math.min(3, linesOf(laidRows[0]))) * leading);
    drawHeader();

    for (const laid of laidRows) {
      const count = linesOf(laid);
      const linesFitting = () => Math.floor((this.remaining - pad * 2) / leading);
      // A row that fits on a page but not on what is left of this one starts the next; one taller than a page starts there too unless a few lines of it fit here.
      if (linesFitting() < count && (count <= pageRoom || linesFitting() < Math.min(3, count))) {
        this.newPage();
        drawHeader();
      }
      let done = 0;
      while (done < count) {
        const take = Math.max(1, Math.min(count - done, linesFitting()));
        for (let i = 0; i < laid.length; i++) {
          laid[i].slice(done, done + take).forEach((l, k) => {
            const x = columns[i].align === "right" ? xs[i] + widths[i] - pad - l.line.width : xs[i] + pad;
            this.doc.textRuns(this.page, x, this.y + pad + k * leading + l.size, l.line.runs, l.size, l.color);
          });
        }
        this.y += take * leading + pad * 2;
        done += take;
        this.doc.rule(this.page, this.left, this.right, this.y);
        if (done < count) {
          this.newPage();
          drawHeader();
        }
      }
    }
  }
}
