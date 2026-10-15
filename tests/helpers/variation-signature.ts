import { eachElement, isRef, type ElementNode, type Section, type SiteContent } from "@/lib/website/doc";
import { sampleSite } from "@/lib/website/templates";

export type Sig = { key: string; family: string; dims: Record<string, string> };

const kindsOf = (s: Section): string[] => {
  const out: string[] = [];
  const visit = (e: ElementNode) => { out.push(e.type); e.children?.forEach(visit); };
  s.columns.forEach((c) => c.elements.forEach(visit));
  return out;
};
const frame = (s: Section) => `${s.columns.length}:${s.columns.map((c) => c.span).join("-")}:${s.bg.kind}:${s.layout.minH}:${s.layout.width}:${s.tone}`;
const hue = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return "grey";
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return String(Math.floor((((h * 60 + 360) % 360) / 40)));
};
const rhythm = (home: Section[]) => home.slice(1).map((s) => {
  const k = kindsOf(s);
  return k.find((x) => !["heading", "text", "badge", "divider", "spacer", "button", "group", "card", "icon", "image"].includes(x)) ?? (k.includes("image") ? "image" : "text");
}).join(",");

export function signature(key: string): Sig {
  const d: SiteContent = sampleSite(key);
  const home = d.pages[0].items.filter((i): i is Section => !isRef(i));
  const hero = home[0];
  return {
    key, family: key.split(".")[0],
    dims: {
      headingFont: d.design.fonts.heading,
      pair: `${d.design.fonts.heading}/${d.design.fonts.body}`,
      mode: d.design.mode,
      radius: d.design.radius,
      buttons: `${d.design.buttons.style}:${d.design.buttons.caps}`,
      header: d.header ? `${frame(d.header)}:${d.header.layout.float}:${d.header.layout.sticky}` : "none",
      heroFrame: frame(hero),
      heroElements: [...new Set(kindsOf(hero))].sort().join("+"),
      rhythm: rhythm(home),
      colour: `${hue(d.design.colors.primary)}:${hue(d.design.colors.accent)}`,
      heroArt: JSON.stringify(((): unknown => { let art = ""; eachElement({ ...d, pages: [{ ...d.pages[0], items: [hero] }], header: null, footer: null }, (e) => { if (e.type === "image" && !art) art = JSON.stringify(e.props.src ?? null); }); return art; })()),
    },
  };
}
/** The things that give a site its character. Mode, corner radius and button style are left out: most designs share them, so they say little. */
export const CHARACTER = ["pair", "header", "heroFrame", "heroElements", "rhythm", "colour"] as const;
export const distance = (a: Sig, b: Sig) => CHARACTER.filter((k) => a.dims[k] !== b.dims[k]).length;

