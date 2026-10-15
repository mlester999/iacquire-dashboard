// Plain colour maths on hex strings. Text colours are computed (not chosen), so whatever colours an owner picks, buttons and links stay
// readable. Nothing user-controlled reaches CSS except validated hex and fixed vocabulary.

type RGB = [number, number, number];
export const hexToRgb = (hex: string): RGB => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;

export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};

export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const INK = "#0b0d14";
const PAPER = "#ffffff";

/** Text colour for a background: white or the soft near-black if either reaches 4.5:1; otherwise pure black or white, whichever is higher. */
export function readableOn(bg: string): string {
  if (contrast(PAPER, bg) >= 4.5) return PAPER;
  if (contrast(INK, bg) >= 4.5) return INK;
  return contrast(PAPER, bg) >= contrast("#000000", bg) ? PAPER : "#000000";
}

/** Moves a colour toward black or white until it reaches the contrast ratio against its background. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = luminance(bg) > 0.5 ? "#000000" : "#ffffff";
  for (let t = 0.1; t <= 1.0001; t += 0.05) {
    const candidate = mix(fg, target, t);
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return target;
}

/** Like ensureContrast, but the colour must reach the ratio on every one of the backgrounds it can sit on. */
export function ensureContrastAll(fg: string, bgs: string[], min = 4.5): string {
  const worst = (c: string) => Math.min(...bgs.map((b) => contrast(c, b)));
  if (worst(fg) >= min) return fg;
  const avg = bgs.reduce((n, b) => n + luminance(b), 0) / bgs.length;
  const target = avg > 0.5 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = mix(fg, target, t);
    if (worst(candidate) >= min) return candidate;
  }
  return target;
}

export const withAlpha = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${Math.max(0, Math.min(1, alpha))})`;
};

/** Hue (0–360), saturation and lightness (0–1), for building related tints. */
export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
