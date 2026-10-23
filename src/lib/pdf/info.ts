// Facts read back out of a PDF that src/lib/pdf/writer.ts made. Pure. It reads only the page tree as that writer writes it (a plain, uncompressed file), so it answers null for
// any other kind of PDF instead of guessing.

/** How many pages the document has, or null when this is not a file the writer made. */
export function pdfPageCount(bytes: Buffer): number | null {
  if (bytes.length < 16 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  const m = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d{1,4})\b/.exec(bytes.toString("latin1"));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}
