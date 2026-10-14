import "server-only";
import sharp from "sharp";

// Conservative background removal for logos. It only ever removes a background that is a single
// solid colour AND is connected to the image border, so white text inside a logo stays put. Anything
// uncertain is reported as failed or unsupported and the caller keeps the original untouched.

export type BackgroundResult =
  | { status: "processed"; bytes: Buffer; removedPercent: number; note: string }
  | { status: "failed" | "unsupported"; note: string };

const MAX_WORK_SIDE = 1600;
const TOLERANCE = 38; // RGB distance still counted as "the same background"
const FEATHER = 1.7;

const quantize = (r: number, g: number, b: number) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

export async function removeSolidBackground(input: Buffer): Promise<BackgroundResult> {
  let image = sharp(input, { limitInputPixels: 50_000_000 }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) return { status: "failed", note: "The image could not be read." };
  if (meta.width > MAX_WORK_SIDE || meta.height > MAX_WORK_SIDE) image = image.resize({ width: MAX_WORK_SIDE, height: MAX_WORK_SIDE, fit: "inside" });

  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const total = width * height;
  const px = (x: number, y: number) => (y * width + x) * 4;

  // Already transparent? Then there is nothing to remove.
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent += 1;
  if (transparent / total > 0.08) return { status: "unsupported", note: "This image already has a transparent background." };

  // Border colour census.
  const counts = new Map<number, number>();
  let border = 0;
  const sample = (x: number, y: number) => {
    const o = px(x, y);
    const key = quantize(data[o], data[o + 1], data[o + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    border += 1;
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }
  let topKey = -1;
  let topCount = 0;
  for (const [key, count] of counts) if (count > topCount) [topKey, topCount] = [key, count];
  if (topCount / border < 0.85) return { status: "unsupported", note: "The background isn't a single plain colour, so it can't be removed safely." };

  // Average the actual border pixels in the dominant bucket for an accurate reference colour.
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const gather = (x: number, y: number) => {
    const o = px(x, y);
    if (quantize(data[o], data[o + 1], data[o + 2]) !== topKey) return;
    sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; sn += 1;
  };
  for (let x = 0; x < width; x += 1) { gather(x, 0); gather(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { gather(0, y); gather(width - 1, y); }
  const br = sr / sn, bg = sg / sn, bb = sb / sn;
  const distance = (o: number) => Math.hypot(data[o] - br, data[o + 1] - bg, data[o + 2] - bb);

  // Flood fill from every border pixel that matches the background.
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (visited[i] || distance(i * 4) > TOLERANCE) return;
    visited[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, y = (i - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  const removed = tail;
  const removedFraction = removed / total;
  if (removedFraction < 0.05) return { status: "failed", note: "No separable background was found; your original is unchanged." };
  if (removedFraction > 0.93) return { status: "failed", note: "Removing the background would have left almost nothing, so your original is unchanged." };

  // Apply: transparent where flooded; soft alpha on the immediate edge to avoid a harsh fringe.
  const out = Buffer.from(data);
  for (let i = 0; i < total; i += 1) if (visited[i]) out[i * 4 + 3] = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (visited[i]) continue;
      const touches = (x > 0 && visited[i - 1]) || (x < width - 1 && visited[i + 1]) || (y > 0 && visited[i - width]) || (y < height - 1 && visited[i + width]);
      if (!touches) continue;
      const d = distance(i * 4);
      if (d < TOLERANCE * FEATHER) out[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0.15, (d - TOLERANCE * 0.5) / (TOLERANCE * FEATHER - TOLERANCE * 0.5))));
    }
  }

  // The remaining subject must occupy a sensible part of the frame.
  let minX = width, minY = height, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (out[(y * width + x) * 4 + 3] > 40) {
        opaque += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (opaque / total < 0.03 || maxX < 0 || ((maxX - minX + 1) * (maxY - minY + 1)) / total < 0.05) {
    return { status: "failed", note: "The logo couldn't be separated cleanly, so your original is unchanged." };
  }
  const bytes = await sharp(out, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { status: "processed", bytes, removedPercent: Math.round(removedFraction * 100), note: `Removed a plain ${removedFraction > 0.5 ? "" : "partial "}background (${Math.round(removedFraction * 100)}% of the image). Your original is kept.` };
}
