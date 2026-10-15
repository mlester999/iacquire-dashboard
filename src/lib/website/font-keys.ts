// The typefaces a website can use, as plain data. The loader that actually brings them in is in fonts.ts (it needs Next.js), so everything
// that only needs to know which faces exist, such as the document schema and the CSS generator, can run anywhere, tests included.
export type FontCategory = "serif" | "sans" | "display" | "mono";
export interface FontDef {
  label: string;
  category: FontCategory;
  /** CSS custom property that holds the loaded family name. */
  variable: string;
  fallback: string;
  /** Weights that really exist, so the editor never offers a weight the face can't draw. */
  weights: number[];
  italic: boolean;
}

const SERIF_FALLBACK = 'Georgia, "Times New Roman", serif';
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const VAR = [300, 400, 500, 600, 700, 800, 900];
const VAR5 = [300, 400, 500, 600, 700];

export const FONTS = {
  fraunces: { label: "Fraunces", category: "serif", variable: "--f-fraunces", fallback: SERIF_FALLBACK, weights: VAR, italic: true },
  playfair: { label: "Playfair Display", category: "serif", variable: "--f-playfair", fallback: SERIF_FALLBACK, weights: [400, 500, 600, 700, 800, 900], italic: true },
  cormorant: { label: "Cormorant Garamond", category: "serif", variable: "--f-cormorant", fallback: SERIF_FALLBACK, weights: VAR5, italic: true },
  dmserif: { label: "DM Serif Display", category: "serif", variable: "--f-dmserif", fallback: SERIF_FALLBACK, weights: [400], italic: true },
  instrument: { label: "Instrument Serif", category: "serif", variable: "--f-instrument", fallback: SERIF_FALLBACK, weights: [400], italic: true },
  newsreader: { label: "Newsreader", category: "serif", variable: "--f-newsreader", fallback: SERIF_FALLBACK, weights: [200, 300, 400, 500, 600, 700, 800], italic: true },
  lora: { label: "Lora", category: "serif", variable: "--f-lora", fallback: SERIF_FALLBACK, weights: [400, 500, 600, 700], italic: true },
  baskerville: { label: "Libre Baskerville", category: "serif", variable: "--f-baskerville", fallback: SERIF_FALLBACK, weights: [400, 700], italic: true },
  bodoni: { label: "Bodoni Moda", category: "serif", variable: "--f-bodoni", fallback: SERIF_FALLBACK, weights: [400, 500, 600, 700, 800, 900], italic: true },
  inter: { label: "Inter", category: "sans", variable: "--f-inter", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  manrope: { label: "Manrope", category: "sans", variable: "--f-manrope", fallback: SANS_FALLBACK, weights: [200, 300, 400, 500, 600, 700, 800], italic: false },
  dmsans: { label: "DM Sans", category: "sans", variable: "--f-dmsans", fallback: SANS_FALLBACK, weights: VAR, italic: true },
  jakarta: { label: "Plus Jakarta Sans", category: "sans", variable: "--f-jakarta", fallback: SANS_FALLBACK, weights: [200, 300, 400, 500, 600, 700, 800], italic: false },
  outfit: { label: "Outfit", category: "sans", variable: "--f-outfit", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  sora: { label: "Sora", category: "sans", variable: "--f-sora", fallback: SANS_FALLBACK, weights: [300, 400, 500, 600, 700, 800], italic: false },
  grotesk: { label: "Space Grotesk", category: "sans", variable: "--f-grotesk", fallback: SANS_FALLBACK, weights: VAR5, italic: false },
  bricolage: { label: "Bricolage Grotesque", category: "display", variable: "--f-bricolage", fallback: SANS_FALLBACK, weights: [300, 400, 500, 600, 700, 800], italic: false },
  syne: { label: "Syne", category: "display", variable: "--f-syne", fallback: SANS_FALLBACK, weights: [400, 500, 600, 700, 800], italic: false },
  urbanist: { label: "Urbanist", category: "sans", variable: "--f-urbanist", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  figtree: { label: "Figtree", category: "sans", variable: "--f-figtree", fallback: SANS_FALLBACK, weights: [300, 400, 500, 600, 700, 800, 900], italic: false },
  hanken: { label: "Hanken Grotesk", category: "sans", variable: "--f-hanken", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  archivo: { label: "Archivo", category: "sans", variable: "--f-archivo", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  albert: { label: "Albert Sans", category: "sans", variable: "--f-albert", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  vietnam: { label: "Be Vietnam Pro", category: "sans", variable: "--f-vietnam", fallback: SANS_FALLBACK, weights: [300, 400, 500, 600, 700, 800], italic: false },
  jost: { label: "Jost", category: "sans", variable: "--f-jost", fallback: SANS_FALLBACK, weights: VAR, italic: false },
  barlow: { label: "Barlow Condensed", category: "display", variable: "--f-barlow", fallback: SANS_FALLBACK, weights: [400, 500, 600, 700, 800], italic: false },
  unbounded: { label: "Unbounded", category: "display", variable: "--f-unbounded", fallback: SANS_FALLBACK, weights: [300, 400, 500, 600, 700, 800, 900], italic: false },
  jetbrains: { label: "JetBrains Mono", category: "mono", variable: "--f-jetbrains", fallback: MONO_FALLBACK, weights: [300, 400, 500, 600, 700, 800], italic: false },
  dmmono: { label: "DM Mono", category: "mono", variable: "--f-dmmono", fallback: MONO_FALLBACK, weights: [300, 400, 500], italic: true },
} as const satisfies Record<string, FontDef>;


export type FontKey = keyof typeof FONTS;
export const FONT_KEYS = Object.keys(FONTS) as FontKey[];
export const isFontKey = (v: unknown): v is FontKey => typeof v === "string" && v in FONTS;

export const fontStack = (key: FontKey): string => `var(${FONTS[key].variable}), ${FONTS[key].fallback}`;
/** The nearest weight the face actually has, so an out-of-range choice still draws sensibly. */
export function nearestWeight(key: FontKey, weight: number): number {
  const w = FONTS[key].weights;
  return w.reduce((best, x) => (Math.abs(x - weight) < Math.abs(best - weight) ? x : best), w[0]);
}
