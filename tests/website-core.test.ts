import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteRenderer } from "@/components/website/site-renderer";
import type { ResolvedAsset } from "@/components/website/parts";
import { generateSiteContent, sampleContent, splitServices } from "@/lib/website/generate";
import { checkReadiness } from "@/lib/website/lint";
import { newSection, parseContent, referencedAssetIds, safeHref, type SiteContent } from "@/lib/website/schema";
import { SECTION_DEFS, SECTION_TYPES } from "@/lib/website/sections";
import { ALL_TEMPLATE_KEYS, FAMILIES, designSignature, familiesForIndustry, resolveTemplate } from "@/lib/website/templates";
import { contrast, deriveTheme, ensureContrast, readableOn } from "@/lib/website/theme";

const noAssets = () => null;
const asset = (id: string | null | undefined): ResolvedAsset | null => (id ? { src: `/img/${id}.webp`, width: 800, height: 600, alt: "A photo" } : null);
const render = (content: SiteContent, key: string, over: Partial<React.ComponentProps<typeof SiteRenderer>> = {}) =>
  renderToStaticMarkup(
    React.createElement(SiteRenderer, {
      content, templateKey: key, pageSlug: "home", resolveAsset: noAssets, mode: "published", formAction: "/__iaq/form", formToken: "tok", hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`), year: 2026, ...over,
    }),
  );

describe("template catalog", () => {
  it("offers ten families of five variations, each resolvable", () => {
    expect(FAMILIES).toHaveLength(10);
    for (const f of FAMILIES) expect(f.variations).toHaveLength(5);
    expect(ALL_TEMPLATE_KEYS).toHaveLength(50);
    expect(new Set(ALL_TEMPLATE_KEYS).size).toBe(50);
    for (const key of ALL_TEMPLATE_KEYS) expect(resolveTemplate(key), key).not.toBeNull();
    expect(resolveTemplate("nope.nope")).toBeNull();
    expect(resolveTemplate("../etc.passwd")).toBeNull();
  });

  it("makes every variation genuinely different, not just a colour change", () => {
    const sigs = ALL_TEMPLATE_KEYS.map((k) => ({ k, s: designSignature(resolveTemplate(k)!.spec) }));
    const distance = (a: string[], b: string[]) => a.filter((x, i) => x !== b[i]).length;
    let minWithin = Infinity;
    let minAcross = Infinity;
    for (let i = 0; i < sigs.length; i += 1) {
      for (let j = i + 1; j < sigs.length; j += 1) {
        const d = distance(sigs[i].s, sigs[j].s);
        const sameFamily = sigs[i].k.split(".")[0] === sigs[j].k.split(".")[0];
        if (sameFamily) minWithin = Math.min(minWithin, d);
        else minAcross = Math.min(minAcross, d);
        // No two templates may share more than a handful of design choices.
        expect(d, `${sigs[i].k} vs ${sigs[j].k}`).toBeGreaterThanOrEqual(7);
      }
    }
    expect(minWithin).toBeGreaterThanOrEqual(9);
    expect(minAcross).toBeGreaterThanOrEqual(7);
    // Layout diversity: every header, hero, services and footer style is actually used.
    const specs = ALL_TEMPLATE_KEYS.map((k) => resolveTemplate(k)!.spec);
    expect(new Set(specs.map((s) => s.header)).size).toBe(5);
    expect(new Set(specs.map((s) => s.hero)).size).toBe(8);
    expect(new Set(specs.map((s) => s.services)).size).toBe(6);
    expect(new Set(specs.map((s) => s.footer)).size).toBe(4);
    expect(new Set(specs.map((s) => s.type.heading)).size).toBeGreaterThanOrEqual(6);
  });

  it("ranks families by industry without hiding any", () => {
    expect(familiesForIndustry("real_estate")[0].id).toBe("meridian");
    expect(familiesForIndustry("healthcare")[0].id).toBe("haven");
    expect(familiesForIndustry("home_services")[0].id).toBe("forge");
    expect(familiesForIndustry("agency")[0].id).toBe("pulse");
    expect(familiesForIndustry("anything-else")).toHaveLength(10);
  });
});

describe("rendering every template", () => {
  const industry = (key: string) => resolveTemplate(key)!.family.industries[0] ?? "other";

  it("renders all fifty on every kind of page, with correct structure", () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      const content = sampleContent(industry(key), key);
      for (const slug of content.pages.map((p) => p.slug)) {
        const html = render(content, key, { pageSlug: slug });
        expect(html, `${key}/${slug}`).toContain(`data-site-template="${key}"`);
        expect(html.match(/<h1[\s>]/g)?.length, `${key}/${slug} must have exactly one h1`).toBe(1);
        expect(html).toContain('<main id="main">');
        expect(html).toContain("Skip to content");
        expect(html).toContain("@container");
        expect(html.match(/<header/g)?.length).toBe(1);
        expect(html.match(/<footer/g)?.length).toBe(1);
      }
    }
  });

  it("keeps a valid heading outline and valid description lists on every template and page", () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      const content = sampleContent("other", key);
      // Also exercise a page with no hero and a section with no heading of its own.
      const bare = JSON.parse(JSON.stringify(content)) as SiteContent;
      (bare.pages.find((p) => p.slug === "services")!.sections[0].data as { heading: string }).heading = "";
      for (const c of [content, bare]) {
        for (const slug of c.pages.map((p) => p.slug)) {
          const html = render(c, key, { pageSlug: slug });
          const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
          expect(levels[0], `${key}/${slug} starts at h1`).toBe(1);
          levels.forEach((lvl, i) => {
            if (i > 0) expect(lvl, `${key}/${slug} jumps from h${levels[i - 1]} to h${lvl}`).toBeLessThanOrEqual(levels[i - 1] + 1);
          });
          // A description list group holds only dt and dd (no icon span or wrapper between).
          for (const dl of html.match(/<dl[\s\S]*?<\/dl>/g) ?? []) {
            for (const group of dl.match(/<div[^>]*><(?!dt|dd)[a-z]+/g) ?? []) expect(group, `${key}/${slug} dl group`).toMatch(/^<div[^>]*><(dt|dd)/);
          }
        }
      }
    }
  });

  it("produces a visibly different page structure for every template", () => {
    const hashes = new Map<string, string>();
    for (const key of ALL_TEMPLATE_KEYS) {
      const html = render(sampleContent("other", key), key).replace(/ style="[^"]*"/g, "").replace(/>[^<]+</g, "><");
      const h = crypto.createHash("sha1").update(html).digest("hex");
      expect(hashes.get(h), `${key} renders the same markup as ${hashes.get(h)}`).toBeUndefined();
      hashes.set(h, key);
    }
    expect(hashes.size).toBe(50);
  });

  it("renders every section type under every services, hero and faq layout without error", () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      const base = sampleContent("other", key);
      const content = JSON.parse(JSON.stringify(base)) as SiteContent;
      const page = content.pages[0];
      const extra: Array<ReturnType<typeof newSection>> = [];
      for (const t of SECTION_TYPES) {
        if (page.sections.some((s) => s.type === t) && !SECTION_DEFS[t].repeatable) continue;
        const s = newSection(t, `extra-${t.toLowerCase()}`);
        const d = s.data as Record<string, unknown>;
        if (t === "gallery") d.images = [{ image: "11111111-1111-4111-8111-111111111111", caption: "c" }];
        if (t === "team") d.members = [{ name: "Sam", role: "Owner", photo: null, bio: "Hi" }];
        if (t === "pricing") d.plans = [{ name: "Basic", price: "$10", description: "d", features: ["a"], cta: { label: "Go", href: "/contact" } }];
        if (t === "stats") d.items = [{ value: "10", label: "things" }];
        if (t === "areas") d.areas = ["Here"];
        if (t === "process") d.steps = [{ title: "One", description: "d" }];
        extra.push(s);
      }
      page.sections.push(...extra);
      const parsed = parseContent(content);
      expect(parsed.ok, `${key}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      if (parsed.ok) expect(() => render(parsed.content, key, { resolveAsset: asset })).not.toThrow();
    }
  });
});

describe("safety of rendered content", () => {
  const base = () => generateSiteContent({ businessName: "Safe Co", industry: "other", services: [{ title: "Thing one" }, { title: "Thing two" }], description: "We do things.", phone: "+15125550100", email: "a@b.co" }, "summit.peak");

  it("treats every piece of owner text as text, never markup", () => {
    const c = base();
    c.business.name = `<img src=x onerror=alert(1)> Co`;
    (c.pages[0].sections[0].data as { headline: string }).headline = `<script>alert('xss')</script>`;
    const html = render(c, "summit.peak");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("only allows safe link schemes", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,AAA", "vbscript:x", "//evil.test", "file:///etc/passwd", " javascript:alert(1)", "https://user:pw@x.test", "/path with space", "http://localhost", "tel:abc", "mailto:not-an-email"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
    for (const ok of ["", "/about", "/", "#contact", "https://example.com/x?y=1", "mailto:a@b.co", "tel:+15125550100", "/services#top"]) expect(safeHref(ok), ok).not.toBeNull();
    const c = base();
    (c.pages[0].sections[0].data as { primaryCta: { label: string; href: string } }).primaryCta = { label: "Go", href: "javascript:alert(1)" };
    expect(parseContent(c).ok).toBe(false);
  });

  it("opens external links safely", () => {
    const c = base();
    (c.pages[0].sections[0].data as { secondaryCta: { label: string; href: string } }).secondaryCta = { label: "Elsewhere", href: "https://partner.example.org/x" };
    const html = render(c, "summit.peak");
    expect(html).toMatch(/href="https:\/\/partner\.example\.org\/x"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("rejects colours that could smuggle CSS", () => {
    const c = base();
    for (const bad of ["#000;background:url(//evil)", "red", "#12345", "rgb(0,0,0)", "var(--x)", "#gggggg"]) {
      expect(parseContent({ ...c, brand: { ...c.brand, primary: bad } }).ok, bad).toBe(false);
    }
    expect(parseContent({ ...c, brand: { ...c.brand, primary: "#ABCDEF" } }).ok).toBe(true);
  });

  it("enforces structure and limits", () => {
    const c = base();
    expect(parseContent({ ...c, pages: [] }).ok).toBe(false);
    expect(parseContent({ ...c, pages: c.pages.filter((p) => p.slug !== "home") }).ok).toBe(false);
    expect(parseContent({ ...c, pages: [...c.pages, { ...c.pages[0], slug: "contact" }] }).ok).toBe(false); // duplicate
    for (const slug of ["api", "_next", "__iaq", "admin", "sitemap", "robots", "thanks"]) {
      expect(parseContent({ ...c, pages: [...c.pages, { ...c.pages[0], slug }] }).ok, slug).toBe(false);
    }
    expect(parseContent({ ...c, pages: [...c.pages, { ...c.pages[0], slug: "Has Spaces" }] }).ok).toBe(false);
    const twoHeroes = { ...c, pages: [{ ...c.pages[0], sections: [...c.pages[0].sections, { ...c.pages[0].sections[0], id: "hero-2" }] }, ...c.pages.slice(1)] };
    expect(parseContent(twoHeroes).ok).toBe(false);
    const dupId = { ...c, pages: [{ ...c.pages[0], sections: [c.pages[0].sections[0], { ...c.pages[0].sections[1], id: c.pages[0].sections[0].id }] }, ...c.pages.slice(1)] };
    expect(parseContent(dupId).ok).toBe(false);
    expect(parseContent({ ...c, pages: Array.from({ length: 13 }, (_, i) => ({ ...c.pages[0], slug: i === 0 ? "home" : `p${i}` })) }).ok).toBe(false);
    const unknown = { ...c, pages: [{ ...c.pages[0], sections: [{ id: "x-1", type: "iframe", hidden: false, data: {} }] }] };
    expect(parseContent(unknown).ok).toBe(false);
    const huge = { ...c, footer: { ...c.footer, note: "x".repeat(10) }, pages: [{ ...c.pages[0], sections: [{ id: "rt-1", type: "richText", hidden: false, data: { heading: "h", body: "x".repeat(250_000) } }] }] };
    expect(parseContent(huge).ok).toBe(false);
    expect(parseContent({ ...c, business: { ...c.business, phone: "5125550100" } }).ok).toBe(false);
    expect(parseContent({ ...c, social: { ...c.social, facebook: "https://evil.example/facebook.com" } }).ok).toBe(false);
    expect(parseContent({ ...c, social: { ...c.social, facebook: "https://www.facebook.com/safeco" } }).ok).toBe(true);
  });

  it("strips control characters and tidies whitespace", () => {
    const c = base();
    const res = parseContent({ ...c, business: { ...c.business, tagline: "  Hello\u0000 world\r\n\r\n\r\n\r\nagain  " } });
    expect(res.ok && res.content.business.tagline).toBe("Hello world\n\nagain");
  });

  it("collects exactly the images a site uses", () => {
    const c = base();
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const typed = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    (c.pages[0].sections[0].data as { image: string }).image = a;
    c.brand.logoAssetId = b;
    // A UUID typed into a text field is only text, not an image reference.
    c.business.tagline = typed;
    expect(referencedAssetIds(c).sort()).toEqual([a, b].sort());
  });
});

describe("the generator tells the truth", () => {
  const details = { businessName: "Brightside Roofing", industry: "home_services", services: splitServices("Roof inspections, repairs and gutter replacement. Free inspection!").map((title) => ({ title })), description: "We repair and replace roofs for homeowners in Austin.", phone: "+15125550100", areas: ["Austin", "Round Rock"], tagline: "" };

  it("splits free text into services without inventing any", () => {
    expect(splitServices("Roof inspections, repairs and gutter replacement")).toEqual(["Roof inspections", "repairs", "gutter replacement"]);
    expect(splitServices("")).toEqual([]);
    expect(splitServices("a, b, ok service")).toEqual(["ok service"]);
  });

  it("never creates testimonials, statistics, awards, prices or process steps", () => {
    const c = generateSiteContent({ ...details, pages: ["home", "about", "services", "faq", "gallery", "contact"] }, "forge.foreman");
    const types = new Set(c.pages.flatMap((p) => p.sections.map((s) => s.type)));
    for (const forbidden of ["testimonials", "stats", "pricing", "process", "team"]) expect(types.has(forbidden as never), forbidden).toBe(false);
    const text = JSON.stringify(c).toLowerCase();
    for (const claim of ["award", "guarantee", "licensed", "certified", "years", "5-star", "best in"]) expect(text, claim).not.toContain(claim);
    expect(checkReadiness(c).warnings.filter((w) => w.code.startsWith("claim_"))).toEqual([]);
  });

  it("builds a coherent site from the facts and follows the template's composition", () => {
    const c = generateSiteContent({ ...details, faqs: [{ question: "Do you offer free quotes?", answer: "Yes." }], pages: ["home", "about", "services", "faq", "contact"] }, "forge.foreman");
    expect(c.pages.map((p) => p.slug)).toEqual(["home", "about", "services", "faq", "contact"]);
    const home = c.pages[0];
    expect(home.sections[0].type).toBe("hero");
    expect((home.sections[0].data as { headline: string; eyebrow: string; primaryCta: { href: string } }).headline).toBe("Roof inspections and repairs in Austin");
    expect((home.sections[0].data as { eyebrow: string }).eyebrow).toBe("Serving Austin and Round Rock");
    expect((home.sections[0].data as { primaryCta: { href: string } }).primaryCta.href).toBe("tel:+15125550100"); // trades lead with the phone
    expect(c.form.fields.service).toBe("optional");
    expect(c.form.services).toEqual(["Roof inspections", "repairs", "gutter replacement", "Free inspection"]);
    // Unconfirmed policy-like text can't sneak in: only faqs passed explicitly appear.
    expect(JSON.stringify(c)).not.toContain("Invented");
  });

  it("omits whatever the owner has not provided", () => {
    const c = generateSiteContent({ businessName: "Bare Co", industry: "other", services: [] }, "summit.peak");
    expect(c.pages.map((p) => p.slug)).toEqual(["home", "contact"]);
    expect(c.pages[0].sections.some((s) => s.type === "services")).toBe(false);
    expect(parseContent(c).ok).toBe(true);
  });

  it("offers a booking-request flow without pretending to book", () => {
    const c = generateSiteContent({ ...details, primaryAction: "book" }, "haven.calm");
    const contact = c.pages.find((p) => p.slug === "contact")!;
    expect(contact.title).toBe("Book");
    const data = contact.sections[0].data as { intro: string; submitLabel: string };
    expect(data.submitLabel).toBe("Request appointment");
    expect(data.intro).toMatch(/confirm availability/);
  });

  it("marks template previews as sample content that cannot be published", () => {
    const sample = sampleContent("real_estate", "meridian.estate");
    expect(sample.isSample).toBe(true);
    const r = checkReadiness(sample);
    expect(r.blockers.map((b) => b.code)).toContain("sample_content");
    expect(r.blockers.map((b) => b.code)).toContain("placeholder");
  });
});

describe("publish readiness", () => {
  const clean = () => generateSiteContent({ businessName: "Brightside Roofing", industry: "home_services", services: [{ title: "Roof repair" }, { title: "Gutters" }], description: "We repair roofs for homeowners in Austin.", phone: "+15125550100", email: "hello@brightside.test" }, "forge.foreman");

  it("passes honest, complete content", () => {
    const r = checkReadiness(clean());
    expect(r.blockers).toEqual([]);
  });

  it("blocks testimonials that are not confirmed real or have no author", () => {
    const c = clean();
    const t = newSection("testimonials", "testimonials-1");
    (t.data as { items: unknown[] }).items = [{ quote: "Brilliant work.", author: "", role: "", confirmedReal: false }];
    c.pages[0].sections.push(t);
    const codes = checkReadiness(c).blockers.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["testimonial_unconfirmed", "testimonial_unattributed"]));
    (t.data as { items: Array<{ confirmedReal: boolean; author: string }> }).items[0].confirmedReal = true;
    (t.data as { items: Array<{ confirmedReal: boolean; author: string }> }).items[0].author = "Sam R.";
    expect(checkReadiness(c).blockers).toEqual([]);
  });

  it("blocks placeholder text and bracketed fill-ins", () => {
    const c = clean();
    (c.pages[0].sections[0].data as { subheadline: string }).subheadline = "Lorem ipsum dolor sit amet";
    c.business.tagline = "Serving [city] since forever";
    const codes = checkReadiness(c).blockers.filter((b) => b.code === "placeholder").map((b) => b.match);
    expect(codes).toEqual(expect.arrayContaining(["Lorem ipsum", "[city]"]));
  });

  it("flags claims the owner must be able to back up, naming exactly what was written", () => {
    const c = clean();
    (c.pages[0].sections[0].data as { subheadline: string; badges: string[] }).subheadline = "Award-winning roofers with 25 years of experience. 100% satisfaction guaranteed.";
    (c.pages[0].sections[0].data as { badges: string[] }).badges = ["Licensed & insured", "5-star rated"];
    const warnings = checkReadiness(c).warnings;
    const codes = new Set(warnings.map((w) => w.code));
    for (const code of ["claim_superlative", "claim_figure", "claim_guarantee", "claim_credential", "claim_reviews"]) expect(codes.has(code), code).toBe(true);
    expect(warnings.find((w) => w.code === "claim_superlative")!.match?.toLowerCase()).toBe("award-winning");
    expect(warnings.every((w) => w.where.length > 0)).toBe(true);
  });

  it("requires a way to be contacted", () => {
    const c = clean();
    c.business.phone = "";
    c.business.email = "";
    c.form.enabled = false;
    expect(checkReadiness(c).blockers.map((b) => b.code)).toContain("no_contact");
  });
});

describe("theme and accessibility", () => {
  const brands = ["#2c5bff", "#ffe600", "#ffffff", "#000000", "#12c9a5", "#e5484d", "#f4e9d8", "#7a5cff", "#0a0d14", "#fafad2", "#808080"];

  it("computes readable text colours for any brand colour", () => {
    expect(readableOn("#ffe600")).toBe("#0b0d14");
    expect(readableOn("#0a0d14")).toBe("#ffffff");
    for (const b of brands) {
      expect(contrast(readableOn(b), b), b).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["#ffffff", "#0b0d14"]) expect(contrast(ensureContrast(b, bg, 4.5), bg), `${b} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps text, buttons and links above 4.5:1 in every template with any brand colours", () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      const spec = resolveTemplate(key)!.spec;
      for (const primary of brands) {
        const accent = brands[(brands.indexOf(primary) + 3) % brands.length];
        const v = deriveTheme({ primary, accent }, spec);
        const check = (fg: string, bg: string, label: string) => expect(contrast(v[fg], v[bg]), `${key} ${primary} ${label}`).toBeGreaterThanOrEqual(4.5);
        check("--s-ink", "--s-bg", "ink on bg");
        check("--s-ink", "--s-surface", "ink on surface");
        check("--s-ink", "--s-surface-2", "ink on surface-2");
        check("--s-muted", "--s-bg", "muted on bg");
        check("--s-muted", "--s-surface-2", "muted on surface-2");
        check("--s-on-primary", "--s-primary", "button text");
        check("--s-on-accent", "--s-accent", "accent button text");
        check("--s-primary-text", "--s-bg", "link on bg");
        check("--s-primary-text", "--s-surface-2", "link on surface-2");
        check("--s-primary-text", "--s-primary-soft", "link on soft tile");
        check("--s-on-dark", "--s-dark", "text on dark");
        check("--s-on-dark-muted", "--s-dark", "muted on dark");
        check("--s-on-dark-accent", "--s-dark", "link on dark");
      }
    }
  });

  it("renders accessible markup: labelled fields, alt text, unique ids, safe external links", () => {
    for (const key of ["summit.peak", "pulse.neon", "meridian.skyline", "canvas.folio", "bloom.petal"]) {
      const c = sampleContent("other", key);
      const html = render(c, key, { pageSlug: "contact" });
      const inputs = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
      for (const id of inputs) expect(html, `${key} label for ${id}`).toContain(`for="${id}"`);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `${key} duplicate ids`).toBe(ids.length);
      for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="/);
      expect(html).toMatch(/aria-label="Main"/);
      expect(html).toContain('name="company_website"'); // trap field
      const consent = (html.match(/<input\b[^>]*>/g) ?? []).find((t) => t.includes('name="consent"'));
      expect(consent, `${key} consent checkbox`).toBeDefined();
      expect(consent).toContain("required"); // the enquiry cannot be sent without agreeing to be contacted
    }
  });

  it("uses container queries only, so previews match published pages at any frame width", () => {
    const dir = path.resolve(process.cwd(), "src/components/website");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      // A viewport breakpoint such as md: or lg: (not @md:) would make a narrow preview frame disagree with a real phone.
      const offenders = [...source.matchAll(/(?<![@\w-])(sm|md|lg|xl|2xl):[a-z\[]/g)].map((m) => m[0]);
      expect(offenders, file).toEqual([]);
    }
  });
});

describe("preview equals publication", () => {
  it("draws identical markup in preview and published mode for the same content", () => {
    for (const key of ["forge.torque", "atlas.quill", "haven.family"]) {
      const c = generateSiteContent({ businessName: "Parity Co", industry: "other", services: [{ title: "One" }, { title: "Two" }], description: "We do things for people.", phone: "+15125550100", pages: ["home", "about", "services", "contact"], aboutText: "Our story." }, key);
      for (const slug of c.pages.map((p) => p.slug)) {
        const published = render(c, key, { pageSlug: slug, mode: "published", formAction: "/__iaq/form" });
        const preview = render(c, key, { pageSlug: slug, mode: "preview", formAction: "/__iaq/form" });
        expect(preview, `${key}/${slug}`).toBe(published);
      }
    }
  });

  it("never shows an unconfirmed testimonial on the live site, even if one is stored", () => {
    const c = generateSiteContent({ businessName: "Honest Co", industry: "other", services: [{ title: "One" }], description: "We do things for people.", phone: "+15125550100" }, "summit.peak");
    const t = newSection("testimonials", "testimonials-1");
    (t.data as { items: unknown[] }).items = [{ quote: "Unverified words from nobody.", author: "Nobody", role: "", confirmedReal: false }];
    c.pages[0].sections.splice(1, 0, t);
    expect(render(c, "summit.peak", { mode: "published" })).not.toContain("Unverified words");
    const preview = render(c, "summit.peak", { mode: "preview" });
    expect(preview).toContain("Unverified words");
    expect(preview).toMatch(/Not confirmed/);
  });

  it("switches the form off in preview but not on the live site", () => {
    const c = generateSiteContent({ businessName: "Form Co", industry: "other", services: [{ title: "One" }], description: "We do things for people.", phone: "+15125550100" }, "summit.peak");
    const live = render(c, "summit.peak", { pageSlug: "contact", mode: "published", formAction: "/__iaq/form" });
    const prev = render(c, "summit.peak", { pageSlug: "contact", mode: "preview", formAction: null });
    expect(live).toContain('action="/__iaq/form"');
    expect(live).not.toMatch(/<fieldset[^>]*disabled/);
    expect(prev).toMatch(/<fieldset[^>]*disabled/);
    expect(prev).toContain("Preview only");
  });
});
