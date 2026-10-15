// Turns an agency-designed template into a client's own website. A template is a starting point: this makes a copy with the client's facts
// filled in, and the copy is never linked back. The only substitution is a fixed set of {{tokens}} replaced with the client's own words, so
// a template cannot pull anything in that the client didn't provide. A token with no fact behind it is left as it is, where the publish
// check will refuse it.
import { ELEMENT_DEFS, type FieldSpec } from "./catalog";
import { parseContent, tidy, type ContentResult, type ElementNode, type Section, type SiteContent } from "./doc";
import { escapeMarkup } from "./markup";
import { footerMinimal, headerBar } from "./templates/chrome";
import { makeCtx } from "./templates/compose";
import type { SiteDetails } from "./templates/types";

const TOKEN = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

/** The facts a token can name. Anything not listed here is left untouched. */
export function tokenValues(d: SiteDetails): Record<string, string> {
  const v: Record<string, string> = {
    "business.name": d.businessName, "business.tagline": d.tagline ?? "", "business.phone": d.phone ?? "", "business.email": d.email ?? "", "business.address": d.address ?? "",
    "business.hours": d.hours ?? "", "business.description": d.description ?? "",
  };
  d.services.slice(0, 8).forEach((s, i) => {
    v[`service.${i + 1}`] = s.title;
    v[`service.${i + 1}.description`] = s.description ?? "";
  });
  (d.areas ?? []).slice(0, 6).forEach((a, i) => (v[`area.${i + 1}`] = a));
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim() !== ""));
}

function fill(text: string, values: Record<string, string>, markup: boolean): string {
  return text.replace(TOKEN, (whole, key: string) => {
    const hit = values[key.toLowerCase()];
    return hit === undefined ? whole : markup ? escapeMarkup(hit) : hit;
  });
}

function fillProps(fields: FieldSpec[], data: unknown, values: Record<string, string>): unknown {
  if (!data || typeof data !== "object") return data;
  const rec = { ...(data as Record<string, unknown>) };
  for (const f of fields) {
    const v = rec[f.key];
    if (f.type === "text" || f.type === "longtext") rec[f.key] = typeof v === "string" ? fill(v, values, false) : v;
    else if (f.type === "markup") rec[f.key] = typeof v === "string" ? fill(v, values, true) : v;
    else if (f.type === "link" && v && typeof v === "object") rec[f.key] = { ...(v as object), label: fill(String((v as { label?: string }).label ?? ""), values, false) };
    else if (f.type === "textlist" && Array.isArray(v)) rec[f.key] = v.map((t) => (typeof t === "string" ? fill(t, values, false) : t));
    else if (f.type === "list" && Array.isArray(v)) rec[f.key] = v.map((row) => fillProps(f.item, row, values));
  }
  return rec;
}

function fillElement(e: ElementNode, values: Record<string, string>): ElementNode {
  return { ...e, props: fillProps(ELEMENT_DEFS[e.type].fields, e.props, values) as Record<string, unknown>, ...(e.children ? { children: e.children.map((c) => fillElement(c, values)) } : {}) };
}
const fillSection = (s: Section, values: Record<string, string>): Section => ({ ...s, columns: s.columns.map((c) => ({ ...c, elements: c.elements.map((e) => fillElement(e, values)) })) });

export interface Origin {
  key: string;
  templateId: string | null;
  version: number;
}

/** A new site from a template's content and a business's facts. Returns validated content, or the reason it could not be built. */
export function instantiateTemplate(template: SiteContent, details: SiteDetails, origin: Origin): ContentResult {
  const values = tokenValues(details);
  const f = (t: string) => fill(t, values, false);
  const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`);
  const b = template.business;
  const doc: SiteContent = {
    ...template,
    isSample: false,
    origin,
    business: {
      name: details.businessName.trim() || b.name,
      tagline: clip(details.tagline ?? f(b.tagline), 140),
      phone: details.phone ?? "",
      email: details.email ?? "",
      address: clip(details.address ?? "", 200),
      hours: clip(details.hours ?? "", 300),
      areas: (details.areas ?? []).slice(0, 30),
    },
    brand: { logoAssetId: details.logoAssetId ?? null, logoVariant: "original" },
    design: { ...template.design, colors: { ...template.design.colors, ...(details.primary ? { primary: details.primary } : {}), ...(details.accent ? { accent: details.accent } : {}) } },
    seo: { ...template.seo, title: clip(f(template.seo.title), 70), description: clip(f(template.seo.description), 160) },
    form: { ...template.form, services: details.services.map((s) => s.title.slice(0, 60)).slice(0, 12) },
    header: template.header ? fillSection(template.header, values) : null,
    footer: template.footer ? fillSection(template.footer, values) : null,
    globals: Object.fromEntries(Object.entries(template.globals).map(([k, s]) => [k, fillSection(s, values)])),
    pages: template.pages.map((p) => ({
      ...p, title: tidy(f(p.title)), navLabel: tidy(f(p.navLabel)), seoTitle: tidy(f(p.seoTitle)), seoDescription: tidy(f(p.seoDescription)),
      items: p.items.map((i) => (i.type === "ref" ? i : fillSection(i, values))),
    })),
  };
  return parseContent(doc);
}

/** A blank template: a header, a hero, one section and a footer, in the default design, ready to be designed. */
export function blankTemplateContent(name: string): SiteContent {
  const sec = (id: string, nm: string, body: string): Section => ({
    id, type: "section", name: nm, hidden: false, tone: "auto", bg: { kind: "none" },
    layout: { width: "regular", pt: "xl", pb: "xl", gutter: true, minH: "auto", valign: "center", gap: "l", stack: "mobile", reverse: false, sticky: false, float: false, inset: false },
    decor: [], anim: { preset: "none", delay: 0, speed: "normal", stagger: false },
    columns: [{ id: `${id}c`, span: 12, gap: "s", pad: "0", surface: "none", elements: [
      { id: `${id}h`, type: "heading", props: { text: body, level: id === "hero" ? "1" : "2" }, style: { size: id === "hero" ? "6xl" : "4xl" } },
      { id: `${id}t`, type: "text", props: { text: "{{business.tagline}}", role: "lede" } },
    ] }],
  });
  const ctx = makeCtx({ businessName: name.slice(0, 120) || "New template", industry: "other", services: [] }, { sample: true, idPrefix: "bl" });
  const r = parseContent({
    schemaVersion: 2, isSample: true, origin: { key: "", templateId: null, version: 0 },
    business: { name: name.slice(0, 120) || "New template", tagline: "", phone: "", email: "", address: "", hours: "", areas: [] },
    pages: [{ id: "pg-home", slug: "home", title: "Home", items: [sec("hero", "Hero", "{{business.name}}"), sec("intro", "Introduction", "What we do")] }],
    header: headerBar(ctx, { sticky: true }), footer: footerMinimal(ctx),
  });
  if (!r.ok) throw new Error(`The blank template is invalid: ${r.error}`);
  return r.content;
}
