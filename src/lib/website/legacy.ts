// Sites saved before the visual builder used a fixed list of section forms (schema version 1). They are upgraded when read: the owner's
// own words, images, contact details and settings are carried into a site built from a current template, so nothing they wrote is lost.
// Nothing here is ever written back until the owner saves, and the version history keeps the original.
import { parseContent, type ContentResult } from "./doc";
import { buildSite, DEFAULT_TEMPLATE_KEY, FAMILIES, resolveTemplate } from "./templates";
import type { SiteDetails } from "./templates/types";

interface V1Section { type?: string; hidden?: boolean; data?: Record<string, unknown> }
interface V1Page { slug?: string; sections?: V1Section[] }
interface V1 {
  business?: Record<string, string>;
  brand?: { primary?: string; accent?: string; logoAssetId?: string | null; logoVariant?: "original" | "processed" };
  seo?: { title?: string; description?: string; ogImageAssetId?: string | null; noindex?: boolean };
  social?: Record<string, string>;
  form?: Record<string, unknown>;
  pages?: V1Page[];
}

/** The family each earlier design maps onto. */
const FAMILY_MAP: Record<string, string> = { meridian: "meridian", haven: "minimal", forge: "bold", atlas: "corp", pulse: "tech", local: "local", ledger: "corp", bloom: "care", summit: "local", canvas: "agency" };

/** A template key that exists today, for a key saved against an earlier collection. */
export function currentTemplateKey(key: string): string {
  if (resolveTemplate(key)) return key;
  const family = FAMILIES.find((f) => f.id === FAMILY_MAP[key.split(".")[0]]);
  return family ? `${family.id}.${family.variations[0].id}` : DEFAULT_TEMPLATE_KEY;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>) : []);
const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

function sectionOf(v1: V1, type: string): V1Section | undefined {
  for (const p of v1.pages ?? []) for (const s of p.sections ?? []) if (s.type === type) return s;
  return undefined;
}

/** Rebuilds a version-2 document from a version-1 one. Returns raw data for `parseContent` to validate. */
export function upgradeLegacy(input: unknown, templateKey: string): unknown {
  const v1 = (input ?? {}) as V1;
  const key = currentTemplateKey(templateKey);
  const hero = sectionOf(v1, "hero")?.data ?? {};
  const about = sectionOf(v1, "about")?.data ?? {};
  const services = list(sectionOf(v1, "services")?.data?.items);
  const faqs = list(sectionOf(v1, "faq")?.data?.items);
  const gallery = list(sectionOf(v1, "gallery")?.data?.images);
  const areas = sectionOf(v1, "areas")?.data?.areas;
  const b = v1.business ?? {};
  const slugs = (v1.pages ?? []).map((p) => p.slug ?? "");
  const heroCta = hero.primaryCta as { href?: string } | undefined;
  const details: SiteDetails = {
    businessName: str(b.name) || "Your business",
    industry: "other",
    tagline: str(b.tagline) || str(hero.headline),
    description: str(hero.subheadline) || str(about.body),
    services: services.map((s) => ({ title: str(s.title), description: str(s.description) || undefined })).filter((s) => s.title),
    phone: str(b.phone), email: str(b.email), address: str(b.address), hours: str(b.hours),
    areas: Array.isArray(areas) ? (areas as unknown[]).map(str).filter(Boolean) : [],
    primary: v1.brand?.primary, accent: v1.brand?.accent,
    pages: (["home", "about", "services", "faq", "gallery", "contact"] as const).filter((s) => slugs.includes(s)),
    faqs: faqs.map((f) => ({ question: str(f.question), answer: str(f.answer) })).filter((f) => f.question && f.answer),
    aboutText: str(about.body),
    logoAssetId: uuid(v1.brand?.logoAssetId),
    heroImageId: uuid(hero.image), aboutImageId: uuid(about.image),
    galleryAssetIds: gallery.map((g) => uuid(g.image)).filter((x): x is string => Boolean(x)),
    primaryAction: str(heroCta?.href).startsWith("tel:") ? "call" : "enquire",
  };
  const site = buildSite(key, details, { sample: false });
  const og = uuid(v1.seo?.ogImageAssetId);
  return {
    ...site,
    brand: { logoAssetId: uuid(v1.brand?.logoAssetId), logoVariant: v1.brand?.logoVariant === "processed" ? "processed" : "original" },
    seo: { title: str(v1.seo?.title), description: str(v1.seo?.description), ogImage: og ? { kind: "asset", id: og } : null, noindex: v1.seo?.noindex === true },
    social: { ...site.social, ...(v1.social ?? {}) },
    form: { ...site.form, ...(v1.form ?? {}) },
    origin: { ...site.origin, key },
  };
}

/** Reads stored content of either schema version. Use this wherever content comes out of the database. */
export function parseStoredContent(input: unknown, templateKey: string): ContentResult {
  return parseContent(input, (legacy) => upgradeLegacy(legacy, templateKey));
}
