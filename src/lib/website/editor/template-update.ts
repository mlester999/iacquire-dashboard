// Templates are starting points: a website is its own copy, and changing a template never changes it. When the agency publishes a newer version
// of a template, the website's owner may choose to take the new look (colours, fonts, shapes and spacing) while every word, picture and
// section stays exactly as it is. This works out what would change so the person can see it first.
import { FONTS, type FontKey } from "../font-keys";
import type { Design, SiteContent } from "../doc";

export interface DesignChange {
  label: string;
  from: string;
  to: string;
  /** Set when the value is a colour, so it can be shown as a swatch. */
  swatch?: { from: string; to: string };
}

const font = (k: string) => (k in FONTS ? FONTS[k as FontKey].label : k);
const words = (v: string | boolean) => (typeof v === "boolean" ? (v ? "on" : "off") : v.replace(/_/g, " "));

export function designChanges(current: Design, latest: Design): DesignChange[] {
  const out: DesignChange[] = [];
  const add = (label: string, a: string | boolean, b: string | boolean) => {
    if (a !== b) out.push({ label, from: words(a), to: words(b) });
  };
  for (const [key, label] of [["primary", "Main colour"], ["accent", "Accent colour"], ["bg", "Page background"], ["surface", "Card background"], ["ink", "Text colour"]] as const) {
    if (current.colors[key] !== latest.colors[key]) out.push({ label, from: current.colors[key], to: latest.colors[key], swatch: { from: current.colors[key], to: latest.colors[key] } });
  }
  for (const [key, label] of [["heading", "Heading font"], ["body", "Body font"], ["accent", "Accent font"]] as const) {
    if (current.fonts[key] !== latest.fonts[key]) out.push({ label, from: font(current.fonts[key]), to: font(latest.fonts[key]) });
  }
  add("Light or dark", current.mode, latest.mode);
  add("Heading weight", String(current.heading.weight), String(latest.heading.weight));
  add("Capital-letter headings", current.heading.transform === "uppercase", latest.heading.transform === "uppercase");
  add("Text size", current.scale, latest.scale);
  add("Corners", current.radius, latest.radius);
  add("Button style", current.buttons.style, latest.buttons.style);
  add("Capital-letter buttons", current.buttons.caps, latest.buttons.caps);
  add("Button hover", current.buttons.hover, latest.buttons.hover);
  add("Spacing", current.spacing, latest.spacing);
  add("Shadows", current.shadow, latest.shadow);
  add("Content width", current.width, latest.width);
  add("Motion", current.motion, latest.motion);
  add("Film grain", current.grain, latest.grain);
  return out;
}

/** Takes the template's newer look and records which version it came from. Content, pages and sections are untouched. */
export function applyDesignUpdate(doc: SiteContent, latest: Design, version: number): SiteContent {
  return { ...doc, design: structuredClone(latest), origin: { ...doc.origin, version } };
}
