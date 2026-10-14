// Turns an owner's two brand colours plus a template's design spec into a complete, accessible set of CSS
// variables. Text colours are computed (not chosen), so whatever colours an owner picks, buttons and links stay
// readable. Everything here is plain math on hex strings; nothing user-controlled reaches CSS except validated hex.
import type { DesignSpec, FontKey } from "./templates";

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
/**
 * Text colour for a background: white or the soft near-black if either reaches 4.5:1; otherwise pure black or white,
 * whichever is higher. At least one of pure black and pure white always reaches 4.58:1, so this is always readable.
 */
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

export const FONT_STACKS: Record<FontKey, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Nunito, "Segoe UI", system-ui, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", "Segoe UI", Arial, sans-serif',
  humanist: '"Gill Sans", "Gill Sans MT", Calibri, "Trebuchet MS", "Segoe UI", sans-serif',
  slab: 'Rockwell, "Rockwell Nova", "Roboto Slab", "Courier New", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

const RADIUS: Record<DesignSpec["radius"], { r: string; lg: string; btn: string }> = {
  square: { r: "2px", lg: "4px", btn: "2px" },
  soft: { r: "10px", lg: "16px", btn: "10px" },
  round: { r: "18px", lg: "28px", btn: "14px" },
  pill: { r: "24px", lg: "36px", btn: "9999px" },
};

// Heading sizes use container-query units so a narrow preview frame and a real phone behave identically.
const SCALE: Record<DesignSpec["type"]["scale"], { h1: string; h2: string; h3: string }> = {
  compact: { h1: "clamp(1.9rem, 6.5cqw, 3rem)", h2: "clamp(1.4rem, 4.2cqw, 2.1rem)", h3: "1.1rem" },
  regular: { h1: "clamp(2.1rem, 7.5cqw, 3.75rem)", h2: "clamp(1.55rem, 4.8cqw, 2.5rem)", h3: "1.2rem" },
  grand: { h1: "clamp(2.4rem, 9cqw, 5rem)", h2: "clamp(1.75rem, 5.6cqw, 3.1rem)", h3: "1.3rem" },
};
const WEIGHT: Record<DesignSpec["type"]["weight"], string> = { medium: "500", bold: "700", black: "850" };
const TRACKING: Record<DesignSpec["type"]["tracking"], string> = { tight: "-0.025em", normal: "0", wide: "0.04em" };

interface Palette {
  bg: string; surface: string; surface2: string; ink: string; muted: string; line: string; dark: boolean;
}
function palette(tone: DesignSpec["tone"], primary: string): Palette {
  switch (tone) {
    case "white": return { bg: "#ffffff", surface: "#ffffff", surface2: "#f5f6f8", ink: "#0f1419", muted: "#4b5563", line: "#e3e6eb", dark: false };
    case "warm": return { bg: "#fbf8f3", surface: "#ffffff", surface2: "#f3ede3", ink: "#1f1a14", muted: "#5c5247", line: "#e5dccd", dark: false };
    case "cool": return { bg: "#f6f9fc", surface: "#ffffff", surface2: "#e9eff6", ink: "#0e1a2b", muted: "#46556b", line: "#d6e0ec", dark: false };
    case "tinted": return { bg: mix("#ffffff", primary, 0.06), surface: "#ffffff", surface2: mix("#ffffff", primary, 0.13), ink: "#101828", muted: "#475467", line: mix("#ffffff", primary, 0.22), dark: false };
    case "dark": {
      const bg = mix("#0b0d14", primary, 0.1);
      return { bg, surface: mix(bg, "#ffffff", 0.06), surface2: mix(bg, "#ffffff", 0.1), ink: "#f4f6fb", muted: "#aab3c5", line: mix(bg, "#ffffff", 0.16), dark: true };
    }
  }
}

export function deriveTheme(brand: { primary: string; accent: string }, spec: DesignSpec): Record<string, string> {
  const p = palette(spec.tone, brand.primary);
  const primaryButton = brand.primary;
  const onPrimary = readableOn(primaryButton);
  const accentButton = brand.accent;
  const darkSection = mix("#0b0d14", brand.primary, 0.16);
  const primarySoft = mix(p.bg, brand.primary, p.dark ? 0.22 : 0.1);
  const r = RADIUS[spec.radius];
  // Capital letters in a heavy weight read much larger than the same size in mixed case, so they get a smaller scale.
  const s = spec.type.upper ? { h1: "clamp(2rem, 6.4cqw, 3.6rem)", h2: "clamp(1.5rem, 4.2cqw, 2.4rem)", h3: SCALE[spec.type.scale].h3 } : SCALE[spec.type.scale];
  return {
    "--s-bg": p.bg,
    "--s-surface": p.surface,
    "--s-surface-2": p.surface2,
    "--s-ink": p.ink,
    "--s-muted": p.muted,
    "--s-line": p.line,
    "--s-primary": primaryButton,
    "--s-on-primary": onPrimary,
    "--s-primary-text": ensureContrastAll(brand.primary, [p.bg, p.surface, p.surface2, primarySoft], 4.5),
    "--s-primary-soft": primarySoft,
    "--s-accent": accentButton,
    "--s-on-accent": readableOn(accentButton),
    "--s-accent-text": ensureContrastAll(brand.accent, [p.bg, p.surface, p.surface2], 4.5),
    "--s-dark": darkSection,
    "--s-on-dark": "#f4f6fb",
    "--s-on-dark-muted": "#b6bfd0",
    "--s-on-dark-accent": ensureContrastAll(brand.accent, [darkSection, mix(darkSection, "#ffffff", 0.14)], 4.5),
    "--s-r": r.r,
    "--s-r-lg": r.lg,
    "--s-r-btn": r.btn,
    "--s-font-h": FONT_STACKS[spec.type.heading],
    "--s-font-b": FONT_STACKS[spec.type.body],
    "--s-h1": s.h1,
    "--s-h2": s.h2,
    "--s-h3": s.h3,
    "--s-weight": WEIGHT[spec.type.weight],
    "--s-track": TRACKING[spec.type.tracking],
    "--s-shadow": p.dark ? "0 1px 2px rgb(0 0 0 / .4), 0 12px 32px -12px rgb(0 0 0 / .6)" : "0 1px 2px rgb(16 24 40 / .06), 0 12px 32px -14px rgb(16 24 40 / .18)",
  };
}

/** Whether the template's page background is dark. Used for choosing image overlays and scheme hints. */
export const isDarkTone = (spec: DesignSpec) => spec.tone === "dark";
