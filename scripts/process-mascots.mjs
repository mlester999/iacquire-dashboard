// Converts the six iAcquire mascot PNGs (black background) into transparent WebP avatars.
// The background is removed with an edge-seeded flood fill so the mascots' black eyes,
// which are enclosed by the body, are preserved.
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";

const SOURCE_DIR = process.argv[2] ?? path.join(process.env.USERPROFILE ?? "", "Downloads");
const OUT_DIR = path.resolve("public/mascots");
const MAP = {
  "AI Operations Manager.png": "operations-manager",
  "AI Lead Hunter.png": "lead-hunter",
  "AI Appointment Setter.png": "appointment-setter",
  "AI Sales Assistant.png": "sales-assistant",
  "AI CRM Manager.png": "crm-manager",
  "AI Performance Analyst.png": "performance-analyst",
};

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [file, slug] of Object.entries(MAP)) {
  const src = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(src)) {
    console.warn(`missing ${src}; skipped`);
    continue;
  }
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const isBg = (i) => data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40;
  const visited = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const p = stack.pop();
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    if (!isBg(i)) continue;
    data[i + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - width);
    if (y < height - 1) stack.push(p + width);
  }
  // Soften the anti-aliased dark fringe that borders removed background.
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    const x = p % width;
    const y = (p / width) | 0;
    const nearClear =
      (x > 0 && data[i - 4 + 3] === 0) ||
      (x < width - 1 && data[i + 4 + 3] === 0) ||
      (y > 0 && data[i - width * 4 + 3] === 0) ||
      (y < height - 1 && data[i + width * 4 + 3] === 0);
    if (nearClear) {
      const lum = Math.max(data[i], data[i + 1], data[i + 2]);
      if (lum < 90) data[i + 3] = Math.round((lum / 90) * 255);
    }
  }
  const img = sharp(data, { raw: { width, height, channels: 4 } }).trim({ threshold: 1 });
  const trimmed = await img.png().toBuffer();
  for (const size of [128, 256, 512]) {
    await sharp(trimmed)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 88, alphaQuality: 95 })
      .toFile(path.join(OUT_DIR, `${slug}-${size}.webp`));
  }
  console.log(`processed ${slug}`);
}
