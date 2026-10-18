// Deterministic synthetic documents for extraction tests. They are deliberately tiny and contain no real data.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: Buffer }>) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = zlib.deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(file.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function makeDocx(text: string) {
  const paragraphs = text
    .split(/\n/)
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`)
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
  return zip([{ name: "word/document.xml", data: Buffer.from(document, "utf8") }]);
}

export function makeMalformedDocx() {
  return Buffer.from("PK\x03\x04this is not a complete archive", "latin1");
}

function pdfEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(text: string, opts: { flate?: boolean; encrypted?: boolean; imageOnly?: boolean } = {}) {
  const content = opts.imageOnly
    ? "q 100 0 0 100 0 0 cm /Im0 Do Q"
    : `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
  const raw = Buffer.from(content, "latin1");
  const body = opts.flate ? zlib.deflateSync(raw) : raw;
  const dict = `<< /Length ${body.length}${opts.flate ? " /Filter /FlateDecode" : ""} >>`;
  const head = "%PDF-1.4\n";
  const object1 = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
  const object2 = "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n";
  const object3 = "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n";
  const before = Buffer.from(head + object1 + object2 + object3 + `4 0 obj ${dict}\nstream\n`, "latin1");
  const after = Buffer.from(`\nendstream endobj\n${opts.encrypted ? "trailer << /Encrypt 5 0 R >>\n" : ""}%%EOF\n`, "latin1");
  return Buffer.concat([before, body, after]);
}

export function makeEncryptedPdf() {
  return makePdf("This must never be extracted.", { encrypted: true });
}

export function makeScannedPdf() {
  return makePdf("", { imageOnly: true });
}
