import "server-only";
import sharp from "sharp";

// Resized copies of a published picture, made when first asked for and remembered for a while. A picture's address is its content hash, so a
// variant never goes stale; the cache only has to stay small.
const MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let held = 0;

function remember(key: string, bytes: Buffer) {
  cache.set(key, bytes);
  held += bytes.length;
  for (const [k, v] of cache) {
    if (held <= MAX_BYTES) break;
    cache.delete(k);
    held -= v.length;
  }
}

/** A WebP copy no wider than `width`. Returns null when the picture is already that small (the original is served) or can't be read. */
export async function resizedVariant(sha256: string, original: Buffer, width: number): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const key = `${sha256}:${width}`;
  const hit = cache.get(key);
  if (hit) return { bytes: hit, mimeType: "image/webp" };
  try {
    const meta = await sharp(original, { limitInputPixels: 40_000_000 }).metadata();
    if (!meta.width || meta.width <= width) return null;
    const bytes = await sharp(original, { limitInputPixels: 40_000_000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    remember(key, bytes);
    return { bytes, mimeType: "image/webp" };
  } catch {
    return null;
  }
}
