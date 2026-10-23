// The pixel size of a PNG, JPEG or WebP, read from its header, as the picture is shown (a JPEG's EXIF rotation is applied). Pure and small on purpose: a
// picture's shape decides whether Instagram will take it, and this is all that is needed to know. It returns null for anything it cannot read, and the caller
// says so rather than guessing.

export interface Size {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

function png(b: Uint8Array): Size | null {
  if (b.length < 24 || u32be(b, 0) !== 0x89504e47) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/**
 * The EXIF Orientation of a JPEG's APP1 segment (`start` is its first data byte, `end` one past its last), or null when the segment is not EXIF or has no
 * readable Orientation. Every read stays inside the segment: this is parsing a file a stranger chose.
 */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66 || b[start + 4] !== 0 || b[start + 5] !== 0) return null;
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
  const short = (i: number) => (little ? u16le(b, i) : u16be(b, i));
  const long = (i: number) => (little ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  if (short(tiff + 2) !== 42) return null;
  const ifd = tiff + long(tiff + 4);
  if (ifd + 2 > end) return null;
  const entries = short(ifd);
  for (let k = 0; k < entries; k += 1) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (short(e) === 0x0112) {
      const v = short(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function jpeg(b: Uint8Array): Size | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  // A phone photo is usually stored as it came off the sensor with a note saying how to turn it. Browsers and Instagram show it turned, so the shape that
  // matters is the turned one: orientations 5 to 8 swap the sides.
  let orientation = 1;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    if (len < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, Math.min(i + 2 + len, b.length)) ?? orientation;
    i += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): Size | null {
  if (b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...b.subarray(8, 12)) !== "WEBP") return null;
  const kind = String.fromCharCode(...b.subarray(12, 16));
  if (kind === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

export function imageSize(bytes: Uint8Array, mime: string): Size | null {
  const s = mime === "image/png" ? png(bytes) : mime === "image/jpeg" ? jpeg(bytes) : mime === "image/webp" ? webp(bytes) : null;
  return s && s.width > 0 && s.height > 0 && s.width < 100_000 && s.height < 100_000 ? s : null;
}
