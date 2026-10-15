import { describe, expect, it } from "vitest";
import { contrast } from "@/lib/website/color";
import { bgCss, paletteFor, siteCss } from "@/lib/website/css";
import { charEm, FONT_KEYS } from "@/lib/website/font-keys";
import { longestWord } from "@/lib/website/markup";
import { ALL_TEMPLATE_KEYS, sampleSite } from "@/lib/website/templates";
import type { Section, SiteContent } from "@/lib/website/doc";
import { BACKDROP_OVERLAY_FLOOR, withLegibleBackdrops } from "@/lib/website/template-images";

// Rendering rules that keep text inside its box and readable at every width. The browser audit (npm run studio:qa:text-fit) proves them against the
// real layout for all 50 templates; these tests pin the rules themselves so a refactor cannot quietly remove one.

describe("longest word", () => {
  it("is measured on the text as it is read, not as it is marked up", () => {
    expect(longestWord("Make a little *everyday* delight")).toBe("everyday".length);
    expect(longestWord("Hello")).toBe(5);
  });
  it("lets a line break at a hyphen, and is never zero or unbounded", () => {
    expect(longestWord("state-of-the-art")).toBe("state".length);
    expect(longestWord("")).toBe(1);
    expect(longestWord("x".repeat(200))).toBe(40);
  });
});

describe("font widths used to fit headings", () => {
  it("are known for every font and sit in a sensible range", () => {
    for (const key of FONT_KEYS) {
      const em = charEm(key);
      expect(em, key).toBeGreaterThan(0.4);
      expect(em, key).toBeLessThan(0.9);
    }
  });
});

describe("heading fit variables", () => {
  const key = "bold.pop";
  const content = sampleSite(key);
  const css = siteCss(content, content.pages[0], { scope: "fit" });

  it("publish the width of the site's heading font, and every column's real share of the row", () => {
    expect(css).toMatch(/--cw:\d+\.\d{3};/);
    expect(css).toMatch(/--cs:[\d.]+/);
    expect(css).toMatch(/--cf:[\d.]+/);
    expect(css).toMatch(/--ww:/);
  });

  it("cap a large size only when a heading has published how long its longest word is", () => {
    // The cap reads --fit, which only a heading sets; a size used anywhere else must be unaffected (the fallback is effectively unbounded).
    expect(css).toMatch(/min\([^;]*var\(--fit,999rem\)\)/);
  });
});

describe("brand text on the tint of its own colour", () => {
  it("meets AA on the soft brand band of every built-in template, on the light and dark surfaces", () => {
    const failures: string[] = [];
    for (const key of ALL_TEMPLATE_KEYS()) {
      const design = sampleSite(key).design;
      for (const tone of ["light", "dark"] as const) {
        const set = paletteFor(design, tone);
        for (const [name, text, soft] of [["primary", set.pText, set.pSoft], ["accent", set.aText, set.aSoft]] as const) {
          const ratio = contrast(text, soft);
          if (ratio < 4.5) failures.push(`${key} ${tone} ${name}-text on ${name}-soft ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the faint band on a brand-coloured surface from costing the surface's text its contrast", () => {
    // The brand and accent tones paint their text in the colour that reads best on the brand colour itself. A mid-tone brand colour may allow no
    // better than that, so the band must read at AA where the surface allows it and otherwise lose no more than a fraction of what the surface itself offers; the rendered result is audited in the browser.
    for (const key of ALL_TEMPLATE_KEYS()) {
      const design = sampleSite(key).design;
      for (const tone of ["brand", "accent"] as const) {
        const set = paletteFor(design, tone);
        const onBand = contrast(set.pText, set.pSoft);
        const onSurface = contrast(set.pText, set.bg);
        expect(onBand, `${key} ${tone}`).toBeGreaterThanOrEqual(Math.min(4.5, onSurface - 0.65));
      }
    }
  });
});

describe("section backdrops", () => {
  it("use the real brand colours, so an accent-toned band with an accent backdrop stays the accent colour", () => {
    expect(bgCss({ kind: "color", color: "accent" }).backgroundColor).toBe("var(--c-accent)");
    expect(bgCss({ kind: "color", color: "primary" }).backgroundColor).toBe("var(--c-primary)");
    expect(bgCss({ kind: "color", color: "surface" }).backgroundColor).toBe("var(--surface)");
  });

  it("agree with the colour the text on that band was chosen for", () => {
    const design = sampleSite("bold.pop").design;
    // In the accent tone the palette swaps the two brand colours (p becomes the readable ink, a becomes the primary colour); the backdrop must not.
    const accent = paletteFor(design, "accent");
    expect(accent.bg).toBe(design.colors.accent);
    expect(accent.a).toBe(design.colors.primary);
    expect(bgCss({ kind: "color", color: "accent" }).backgroundColor).not.toBe("var(--a)");
  });
});

describe("text over the starter photographs", () => {
  const sections = (c: SiteContent): Section[] => [c.header, c.footer, ...Object.values(c.globals), ...c.pages.flatMap((p) => p.items.filter((i): i is Section => i.type === "section"))].filter((s): s is Section => Boolean(s));

  it("always has an even overlay at least as strong as the floor measured in the browser", () => {
    let photos = 0;
    for (const key of ALL_TEMPLATE_KEYS()) {
      for (const s of sections(sampleSite(key))) {
        if (s.bg.kind !== "image" || s.bg.src?.kind !== "template") continue;
        photos++;
        const floor = s.bg.overlay.color === "dark" ? BACKDROP_OVERLAY_FLOOR.dark : BACKDROP_OVERLAY_FLOOR.other;
        expect(s.bg.overlay.dir, `${key} ${s.id}`).toBe("flat");
        expect(s.bg.overlay.opacity, `${key} ${s.id}`).toBeGreaterThanOrEqual(floor);
      }
    }
    expect(photos).toBeGreaterThan(50);
  });

  it("leaves a client's own picture and any stronger overlay alone", () => {
    const content = structuredClone(sampleSite("luxe.maison"));
    const photo = sections(content).find((s) => s.bg.kind === "image" && s.bg.src?.kind === "template")!;
    if (photo.bg.kind !== "image") throw new Error("expected a photograph backdrop");
    photo.bg.overlay = { color: "dark", opacity: 90, dir: "left" };
    const own = sections(content).find((s) => s !== photo && s.bg.kind === "image")!;
    if (own.bg.kind === "image") own.bg = { ...own.bg, src: { kind: "asset", id: "11111111-1111-4111-8111-111111111111" }, overlay: { color: "dark", opacity: 10, dir: "left" } };
    const after = withLegibleBackdrops(content);
    expect(photo.bg.overlay.opacity).toBe(90);
    if (own.bg.kind === "image") expect(own.bg.overlay).toEqual({ color: "dark", opacity: 10, dir: "left" });
    expect(after).toBe(content);
  });
});
