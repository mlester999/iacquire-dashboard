// The website content model. Everything an owner (or the generator) can put on a site is plain, length-limited
// data validated here. There is no HTML, script, style or URL scheme beyond a short allowlist, so a published
// site cannot carry anything executable by construction.
import { z } from "zod";
import { SECTION_DEFS, SECTION_TYPES, defaultSectionData, type FieldSpec, type SectionType } from "./sections";

export const CONTENT_SCHEMA_VERSION = 1;
export const LIMITS = { pages: 12, sectionsPerPage: 24, totalBytes: 200_000 } as const;
/** Paths the site runtime itself uses; a page can never take one of these slugs. */
export const RESERVED_SLUGS = new Set(["api", "admin", "_next", "__iaq", "assets", "_a", "sitemap", "robots", "favicon", "thanks", "static", "login"]);

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const tidy = (s: string) => s.replace(CONTROL, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const HEX = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Returns a safe, normalized href or null. Only internal paths, anchors, https/http, mailto and tel pass. */
export function safeHref(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "";
  if (v.length > 300 || /[\u0000-\u001F\u007F\s]/.test(v)) return null;
  if (v.startsWith("#")) return /^#[A-Za-z0-9_-]{1,60}$/.test(v) ? v : null;
  if (v.startsWith("/")) return /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?(?:#[A-Za-z0-9_-]{1,60})?$/.test(v) ? v : null;
  if (/^mailto:/i.test(v)) return /^mailto:[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/i.test(v) ? v : null;
  if (/^tel:/i.test(v)) return /^tel:\+?[0-9][0-9().-]{4,24}$/i.test(v) ? v : null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.username || u.password || !u.hostname.includes(".")) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  return null;
}
export const isExternalHref = (href: string) => /^https?:\/\//i.test(href);

// ---------------------------------------------------------------------------
// Field-spec → zod
// ---------------------------------------------------------------------------

const str = (max: number) => z.string().max(max, `Keep this to ${max} characters or fewer.`).transform(tidy).default("");
const hrefSchema = z.string().default("").transform((v, ctx) => {
  const ok = safeHref(v);
  if (ok === null) {
    ctx.addIssue({ code: "custom", message: "Use a web address (https://…), an email (mailto:), a phone (tel:), a page (/about) or an anchor (#contact)." });
    return z.NEVER;
  }
  return ok;
});
const linkSchema = z.object({ label: str(60), href: hrefSchema }).default({ label: "", href: "" });
const assetSchema = z.union([z.string().regex(UUID, "Choose an image from your library."), z.null()]).default(null);

function fieldSchema(f: FieldSpec): z.ZodTypeAny {
  switch (f.type) {
    case "text":
    case "longtext": return str(f.max);
    case "link": return linkSchema;
    case "image": return assetSchema;
    case "select": return z.enum(f.options.map((o) => o.value) as [string, ...string[]]).default(f.options[0].value);
    case "toggle": return z.boolean().default(false);
    case "color": return z.string().regex(HEX, "Use a colour like #2C5BFF.").default("#2c5bff");
    case "textlist": return z.array(str(f.itemMax)).max(f.max, `Add up to ${f.max}.`).default([]).transform((a) => a.filter(Boolean));
    case "list": return z.array(objectSchema(f.item)).max(f.max, `Add up to ${f.max}.`).default([]);
  }
}
const objectSchema = (fields: FieldSpec[]) => z.object(Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f)])));

const sectionData = Object.fromEntries(SECTION_TYPES.map((t) => [t, objectSchema(SECTION_DEFS[t].fields)])) as Record<SectionType, z.ZodObject>;

const sectionBase = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Each section needs a short id."), type: z.enum(SECTION_TYPES), hidden: z.boolean().default(false), data: z.record(z.string(), z.unknown()) });
const sectionSchema = sectionBase.transform((s, ctx) => {
  const parsed = sectionData[s.type].safeParse(s.data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: ["data", ...issue.path] });
    return z.NEVER;
  }
  return { id: s.id, type: s.type, hidden: s.hidden, data: parsed.data as Record<string, unknown> };
});

const pageSchema = z.object({
  slug: z.string().regex(SLUG, "A page address can use lowercase letters, numbers and hyphens.").max(40),
  title: str(60).refine((v) => v.length > 0, "Give the page a title."),
  navLabel: str(30),
  showInNav: z.boolean().default(true),
  seoTitle: str(70),
  seoDescription: str(160),
  sections: z.array(sectionSchema).max(LIMITS.sectionsPerPage, `A page can hold up to ${LIMITS.sectionsPerPage} sections.`),
});

const hex = z.string().regex(HEX, "Use a colour like #2C5BFF.").transform((v) => v.toLowerCase());
const socialUrl = (hosts: string[]) =>
  z.string().default("").transform((v, ctx) => {
    const t = v.trim();
    if (!t) return "";
    try {
      const u = new URL(t);
      if (u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) && !u.username) return u.toString();
    } catch {
      /* fall through */
    }
    ctx.addIssue({ code: "custom", message: `Use your ${hosts[0]} page address (https://…).` });
    return z.NEVER;
  });
const fieldMode = z.enum(["required", "optional", "hidden"]);

export const contentSchema = z.object({
  schemaVersion: z.literal(CONTENT_SCHEMA_VERSION).default(CONTENT_SCHEMA_VERSION),
  /** Marks the example content shown while browsing templates. Sample content can never be published. */
  isSample: z.boolean().default(false),
  business: z.object({
    name: str(120).refine((v) => v.length >= 2, "Add your business name."),
    tagline: str(140),
    phone: z.string().default("").transform((v, ctx) => {
      const t = v.replace(/[\s().-]/g, "");
      if (!t) return "";
      if (!E164.test(t)) {
        ctx.addIssue({ code: "custom", message: "Enter the phone number with its country code, like +1 512 555 0100." });
        return z.NEVER;
      }
      return t;
    }),
    email: z.string().default("").transform((v, ctx) => {
      const t = v.trim().toLowerCase();
      if (!t) return "";
      if (t.length > 320 || !/^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(t)) {
        ctx.addIssue({ code: "custom", message: "That email address doesn't look right." });
        return z.NEVER;
      }
      return t;
    }),
    address: str(200),
    hours: str(300),
  }),
  brand: z.object({
    primary: hex.default("#2c5bff"),
    accent: hex.default("#12c9a5"),
    logoAssetId: assetSchema,
    logoVariant: z.enum(["original", "processed"]).default("original"),
  }),
  seo: z.object({ title: str(70), description: str(160), ogImageAssetId: assetSchema, noindex: z.boolean().default(false) }),
  social: z.object({
    facebook: socialUrl(["facebook.com"]), instagram: socialUrl(["instagram.com"]), linkedin: socialUrl(["linkedin.com"]),
    x: socialUrl(["x.com", "twitter.com"]), youtube: socialUrl(["youtube.com"]), tiktok: socialUrl(["tiktok.com"]),
  }),
  form: z.object({
    enabled: z.boolean().default(true),
    fields: z.object({ phone: fieldMode.default("optional"), message: fieldMode.default("required"), service: fieldMode.default("hidden") }),
    services: z.array(str(60)).max(12).default([]).transform((a) => a.filter(Boolean)),
    successMessage: str(200).transform((v) => v || "Thanks. We've received your message and will be in touch."),
    consentText: str(240).transform((v) => v || "I agree to be contacted about my enquiry."),
    marketingOptIn: z.boolean().default(false),
    marketingText: str(240).transform((v) => v || "Send me occasional updates and offers."),
  }),
  footer: z.object({ note: str(240), poweredBy: z.boolean().default(false) }),
  pages: z.array(pageSchema).min(1, "A website needs at least one page.").max(LIMITS.pages, `A website can have up to ${LIMITS.pages} pages.`),
});

export type SiteContent = z.output<typeof contentSchema>;
export type SitePage = SiteContent["pages"][number];
export type SiteSection = SitePage["sections"][number];

// ---------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------

export type ContentResult = { ok: true; content: SiteContent } | { ok: false; error: string; path: string };

const pathLabel = (path: PropertyKey[]) =>
  path
    .map((p) => (typeof p === "number" ? `#${p + 1}` : String(p)))
    .join(" › ");

/** Parses and normalizes arbitrary input into valid content, or explains the first problem in plain language. */
export function parseContent(input: unknown): ContentResult {
  const size = (() => {
    try {
      return JSON.stringify(input)?.length ?? 0;
    } catch {
      return Infinity;
    }
  })();
  if (size > LIMITS.totalBytes) return { ok: false, error: "This site is too large. Remove some content or images.", path: "" };
  const parsed = contentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, path: pathLabel(issue.path) };
  }
  const content = parsed.data;
  const slugs = new Set<string>();
  for (const [i, page] of content.pages.entries()) {
    if (RESERVED_SLUGS.has(page.slug)) return { ok: false, error: `"${page.slug}" is reserved. Choose a different page address.`, path: `pages › #${i + 1} › slug` };
    if (slugs.has(page.slug)) return { ok: false, error: `Two pages use the address "${page.slug}".`, path: `pages › #${i + 1} › slug` };
    slugs.add(page.slug);
    const ids = new Set<string>();
    for (const [j, s] of page.sections.entries()) {
      if (ids.has(s.id)) return { ok: false, error: "Two sections share the same id.", path: `pages › #${i + 1} › sections › #${j + 1}` };
      ids.add(s.id);
      if (!SECTION_DEFS[s.type].repeatable && page.sections.filter((x) => x.type === s.type).length > 1) {
        return { ok: false, error: `A page can have only one ${SECTION_DEFS[s.type].label} section.`, path: `pages › #${i + 1} › sections › #${j + 1}` };
      }
    }
  }
  if (!slugs.has("home")) return { ok: false, error: "Your site needs a home page.", path: "pages" };
  return { ok: true, content };
}

export function newSection(type: SectionType, id: string): SiteSection {
  return { id, type, hidden: false, data: defaultSectionData(type) };
}

export const homePage = (c: SiteContent): SitePage => c.pages.find((p) => p.slug === "home") ?? c.pages[0];
export const pagePath = (slug: string) => (slug === "home" ? "/" : `/${slug}`);
export const findPage = (c: SiteContent, slug: string) => c.pages.find((p) => p.slug === slug) ?? null;

/** Every image a site references, taken only from image-typed fields, so a publication copies exactly those and nothing else. */
export function referencedAssetIds(c: SiteContent): string[] {
  const ids = new Set<string>();
  const walk = (fields: FieldSpec[], data: unknown) => {
    if (!data || typeof data !== "object") return;
    const record = data as Record<string, unknown>;
    for (const f of fields) {
      const v = record[f.key];
      if (f.type === "image" && typeof v === "string" && UUID.test(v)) ids.add(v.toLowerCase());
      else if (f.type === "list" && Array.isArray(v)) for (const row of v) walk(f.item, row);
    }
  };
  if (c.brand.logoAssetId) ids.add(c.brand.logoAssetId.toLowerCase());
  if (c.seo.ogImageAssetId) ids.add(c.seo.ogImageAssetId.toLowerCase());
  for (const p of c.pages) for (const s of p.sections) walk(SECTION_DEFS[s.type].fields, s.data);
  return [...ids];
}
