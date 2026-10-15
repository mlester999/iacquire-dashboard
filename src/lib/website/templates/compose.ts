// Turns a template's recipe and a business's facts into a complete website document.
import { createBuilder } from "../build";
import { contentShape, parseContent, type Design, type Page, type PageItem, type Section, type SiteContent } from "../doc";
import type { FamilyDef, Has, Recipe, SiteDetails, TemplateCtx, VariationDef } from "./types";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

const validPhone = (raw?: string) => {
  const t = (raw ?? "").replace(/[\s().-]/g, "");
  return /^\+[1-9][0-9]{6,14}$/.test(t) ? t : "";
};
const validEmail = (raw?: string) => {
  const t = (raw ?? "").trim().toLowerCase();
  return t.length <= 320 && /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(t) ? t : "";
};

/** Everything a template needs to know about the business, in one place. */
export function makeCtx(details: SiteDetails, opts: { sample: boolean; idPrefix?: string }): TemplateCtx {
  const d: SiteDetails = { ...details, phone: validPhone(details.phone), email: validEmail(details.email) };
  const name = d.businessName.trim() || "Your business";
  const services = d.services.filter((s) => s.title.trim());
  d.services = services;
  const areas = (d.areas ?? []).filter(Boolean);
  const wanted = new Set(d.pages ?? ["home", "about", "services", "contact"]);
  const action = d.primaryAction ?? (d.industry === "home_services" ? "call" : "enquire");
  const has: Has = {
    services: services.length > 0,
    about: Boolean((d.aboutText ?? d.description ?? "").trim()),
    faqs: (d.faqs ?? []).filter((f) => f.question && f.answer).length > 0,
    areas: areas.length > 0,
    gallery: (d.galleryAssetIds?.length ?? 0) > 0 || opts.sample,
    stats: opts.sample && (d.stats?.length ?? 0) > 0,
    testimonials: opts.sample && (d.testimonials?.length ?? 0) > 0,
    team: opts.sample && (d.team?.length ?? 0) > 0,
    steps: opts.sample && (d.steps?.length ?? 0) > 0,
    pricing: opts.sample && (d.pricing?.length ?? 0) > 0,
    phone: Boolean(d.phone),
    email: Boolean(d.email),
    address: Boolean((d.address ?? "").trim()),
    hours: Boolean((d.hours ?? "").trim()),
    logo: Boolean(d.logoAssetId),
    highlights: (d.highlights?.length ?? 0) > 0 && opts.sample,
  };
  const area = areas[0];
  const headline = d.tagline?.trim() || (services.length ? `${services.slice(0, 2).map((s) => s.title).join(" and ")}${area ? ` in ${area}` : ""}` : name);
  const phoneLink = d.phone ? { label: "Call us", href: `tel:${d.phone}` } : null;
  const primary = action === "call" && phoneLink ? phoneLink : { label: action === "book" ? "Request an appointment" : "Get in touch", href: "/contact" };
  const secondary = services.length && wanted.has("services") ? { label: "See what we do", href: "/services" } : phoneLink && primary !== phoneLink ? phoneLink : null;
  const pages = new Set<"about" | "services" | "faq" | "gallery">();
  if (wanted.has("about") && has.about) pages.add("about");
  if (wanted.has("services") && has.services) pages.add("services");
  if (wanted.has("faq") && has.faqs) pages.add("faq");
  if (wanted.has("gallery") && has.gallery) pages.add("gallery");
  return {
    b: createBuilder(opts.idPrefix ?? ""), d, has, sample: opts.sample, name, headline: clip(headline, 120), lede: clip((d.description ?? "").replace(/\s+/g, " ").trim(), 320),
    primaryHref: primary.href, primaryLabel: primary.label, secondary, phoneLink, pages, action,
  };
}

const sectionsOf = (items: Array<PageItem | null | undefined>) => items.filter((x): x is PageItem => Boolean(x));

/** Builds the document for a variation. */
export function assemble(ctx: TemplateCtx, recipe: Recipe, meta: { key: string; family: FamilyDef; variation: VariationDef }): SiteContent {
  const d = ctx.d;
  const base = contentShape.parse({
    isSample: ctx.sample,
    origin: { key: meta.key },
    business: { name: ctx.name, tagline: clip((d.tagline ?? "").replace(/\*/g, ""), 140), phone: d.phone ?? "", email: d.email ?? "", address: clip(d.address ?? "", 200), hours: clip(d.hours ?? "", 300), areas: (d.areas ?? []).slice(0, 30) },
    brand: { logoAssetId: d.logoAssetId ?? null, logoVariant: "original" },
    design: {},
    seo: { title: clip(d.tagline ? `${ctx.name} | ${d.tagline.replace(/\*/g, "")}` : ctx.name, 70), description: clip((d.description ?? "").replace(/\s+/g, " "), 160), ogImage: null, noindex: false },
    form: { enabled: true, fields: { phone: "optional", message: "required", service: ctx.d.services.length >= 2 ? "optional" : "hidden" }, services: ctx.d.services.map((s) => clip(s.title, 60)).slice(0, 12) },
    pages: [{ id: "pg-home", slug: "home", title: "Home", items: [] }],
  });
  const design: Design = {
    ...base.design,
    ...recipe.design,
    colors: { ...base.design.colors, ...(recipe.design.colors ?? {}), ...(d.primary ? { primary: d.primary } : {}), ...(d.accent ? { accent: d.accent } : {}) },
    fonts: { ...base.design.fonts, ...(recipe.design.fonts ?? {}) },
    heading: { ...base.design.heading, ...(recipe.design.heading ?? {}) },
    buttons: { ...base.design.buttons, ...(recipe.design.buttons ?? {}) },
  };
  const mk = (id: string, slug: string, title: string, navLabel: string, items: Array<PageItem | null | undefined>, extra: Partial<Page> = {}): Page => ({
    id, slug, title, kind: "page", navLabel, showInNav: true, seoTitle: "", seoDescription: "", ogImage: null, noindex: false, ...extra, items: sectionsOf(items),
  });
  const booking = ctx.action === "book";
  const pages: Page[] = [mk("pg-home", "home", ctx.name, "Home", recipe.home)];
  if (ctx.pages.has("about") && recipe.about?.length) pages.push(mk("pg-about", "about", "About", "About", recipe.about));
  if (ctx.pages.has("services") && recipe.services?.length) pages.push(mk("pg-services", "services", "Services", "Services", recipe.services));
  if (ctx.pages.has("faq") && recipe.faq?.length) pages.push(mk("pg-faq", "faq", "FAQ", "FAQ", recipe.faq));
  if (ctx.pages.has("gallery") && recipe.gallery?.length) pages.push(mk("pg-gallery", "gallery", "Gallery", "Gallery", recipe.gallery));
  pages.push(mk("pg-contact", "contact", booking ? "Book" : "Contact", booking ? "Book" : "Contact", recipe.contact));
  // A section used on several pages (a closing call to action, a process) is one shared section, so editing it once changes it everywhere.
  const counts = new Map<string, number>();
  for (const p of pages) for (const it of p.items) if (it.type === "section") counts.set(it.id, (counts.get(it.id) ?? 0) + 1);
  const globals: Record<string, Section> = { ...(recipe.globals ?? {}) };
  for (const p of pages) {
    p.items = p.items.map((it) => {
      if (it.type !== "section" || (counts.get(it.id) ?? 0) < 2) return it;
      globals[it.id] = it;
      return { id: `r-${it.id}-${p.slug}`.slice(0, 31), type: "ref" as const, ref: it.id };
    });
  }
  const doc = { ...base, design, header: recipe.header, footer: recipe.footer, globals, pages };
  const parsed = parseContent(doc);
  if (!parsed.ok) throw new Error(`Template ${meta.key} built an invalid site: ${parsed.error} (${parsed.path})`);
  return parsed.content;
}

export type { Section };
