// Pictures are delivered at the size they are drawn, not the size they were uploaded. A few fixed widths keep the number of distinct files small
// (so a CDN caches them well and nobody can request a thousand different sizes), and the browser picks from them with `srcset`.
export const IMAGE_WIDTHS = [480, 768, 1080, 1440, 1920] as const;

/** The allowed width for a request, or null when the request isn't one of the fixed sizes. */
export function allowedWidth(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{3,4}$/.test(raw)) return null;
  const w = Number(raw);
  return (IMAGE_WIDTHS as readonly number[]).includes(w) ? w : null;
}

/** `srcset` for a picture of a known width, or undefined when it is already small enough that one file does the job. */
export function srcSetFor(src: string, intrinsicWidth: number | null | undefined): string | undefined {
  if (!intrinsicWidth || intrinsicWidth <= IMAGE_WIDTHS[0]) return undefined;
  const sizes = IMAGE_WIDTHS.filter((w) => w < intrinsicWidth);
  return [...sizes.map((w) => `${src}?w=${w} ${w}w`), `${src} ${intrinsicWidth}w`].join(", ");
}
