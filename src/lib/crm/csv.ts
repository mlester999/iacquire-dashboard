// CSV reading and writing (RFC 4180): quoted fields, doubled quotes, newlines inside quotes, CRLF or LF, and a leading byte-order mark.

export class CsvError extends Error {}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/**
 * Parses CSV text. The first non-empty row is the header. Fully empty rows are dropped. Limits protect the server from a huge or
 * malformed upload; exceeding one is an error, never a silent truncation.
 */
export function parseCsv(text: string, opts: { maxRows?: number; maxColumns?: number; maxCellLength?: number } = {}): ParsedCsv {
  const maxRows = opts.maxRows ?? 50_000;
  const maxColumns = opts.maxColumns ?? 200;
  const maxCell = opts.maxCellLength ?? 5000;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(src);
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > maxCell) throw new CsvError(`A value in row ${records.length + 1} is longer than ${maxCell} characters.`);
    row.push(cell);
    cell = "";
    if (row.length > maxColumns) throw new CsvError(`Row ${records.length + 1} has more than ${maxColumns} columns.`);
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c.trim() !== "")) {
      records.push(row);
      if (records.length > maxRows + 1) throw new CsvError(`This file has more than ${maxRows.toLocaleString("en-US")} rows. Split it into smaller files.`);
    }
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      pushCell();
      i++;
    } else if (ch === "\r") {
      pushRow();
      i += src[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      pushRow();
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (quoted) throw new CsvError("The file ends inside a quoted value. Check for a missing closing quote.");
  if (cell !== "" || row.length) pushRow();
  if (!records.length) throw new CsvError("The file is empty.");
  const headers = records[0].map((h) => h.trim());
  if (headers.every((h) => !h)) throw new CsvError("The first row must contain column names.");
  const seen = new Map<string, number>();
  const unique = headers.map((h, idx) => {
    const base = h || `Column ${idx + 1}`;
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
  const rows = records.slice(1).map((r) => unique.map((_, idx) => (r[idx] ?? "").trim()));
  return { headers: unique, rows };
}

/** Comma unless the header line clearly uses semicolons or tabs (common in some regional spreadsheet exports). */
function detectDelimiter(src: string): string {
  const firstLine = src.slice(0, src.search(/\r?\n/) === -1 ? src.length : src.search(/\r?\n/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const comma = count(",");
  if (count("\t") > comma && count("\t") >= count(";")) return "\t";
  if (count(";") > comma) return ";";
  return ",";
}

/**
 * One CSV cell. Values that a spreadsheet would run as a formula (starting with = + - @, tab or carriage return) are prefixed with an
 * apostrophe so opening an export can never execute something a customer typed into a form.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = Array.isArray(value) ? value.join("; ") : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
