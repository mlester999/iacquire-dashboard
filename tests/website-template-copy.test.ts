import { describe, expect, it } from "vitest";
import { eachElement, parseContent, type SiteContent } from "@/lib/website/doc";
import { ALL_TEMPLATE_KEYS, BUILTIN_TEMPLATE_REVISION, buildSite, resolveTemplate, sampleSite } from "@/lib/website/templates";
import { applyTemplateStarterContent } from "@/lib/website/templates/starter-content";
import { STARTER_IDENTITIES, templateStarter } from "@/lib/website/templates/starter-content-catalog";

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const words = (text: string) => new Set(normalise(text).split(" ").filter((word) => word.length > 3));
function similarity(a: string, b: string) {
  const left = words(a), right = words(b);
  return [...left].filter((word) => right.has(word)).length / new Set([...left, ...right]).size;
}
function visibleHeadings(content: SiteContent) {
  const out: string[] = [];
  eachElement(content, (element) => {
    if (element.type === "heading") out.push(String(element.props.text));
  });
  return out;
}

describe("authored built-in starter content", () => {
  it("covers the exact 50-template collection with complete original identities", () => {
    expect(STARTER_IDENTITIES).toHaveLength(50);
    expect(STARTER_IDENTITIES.map((entry) => entry.key).sort()).toEqual(ALL_TEMPLATE_KEYS().sort());
    const fields: Record<string, string[]> = {
      brands: [], descriptions: [], heroes: [], ledes: [], about: [], primaryActions: [], secondaryActions: [],
      sectionTitles: [], serviceDescriptions: [], faqQuestions: [], faqAnswers: [], galleryCaptions: [], footers: [],
    };
    for (const entry of STARTER_IDENTITIES) {
      fields.brands.push(entry.sample.businessName);
      fields.descriptions.push(entry.description);
      fields.heroes.push(entry.sample.tagline!);
      fields.ledes.push(entry.sample.description!);
      fields.about.push(entry.sample.aboutText!);
      fields.primaryActions.push(entry.primaryLabel);
      fields.secondaryActions.push(entry.secondaryLabel);
      fields.sectionTitles.push(...entry.headings);
      fields.serviceDescriptions.push(...entry.sample.services.map((service) => service.description!));
      fields.faqQuestions.push(...entry.sample.faqs!.map((faq) => faq.question));
      fields.faqAnswers.push(...entry.sample.faqs!.map((faq) => faq.answer));
      fields.galleryCaptions.push(...entry.captions);
      fields.footers.push(entry.footer);
      expect(entry.primaryLabel.length, entry.key).toBeLessThanOrEqual(40);
      expect(entry.description.length, entry.key).toBeLessThanOrEqual(180);
      expect(entry.footer, entry.key).toMatch(/fictional/i);
      expect(entry.sample.stats, entry.key).toBeUndefined();
      expect(entry.sample.testimonials, entry.key).toBeUndefined();
    }
    // Common navigation labels are deliberately excluded. Distinctive, visible editorial copy
    // must stay original, including less prominent FAQ answers and gallery captions.
    for (const [field, values] of Object.entries(fields)) {
      const seen = new Set<string>();
      for (const value of values) {
        expect(value.trim().length, field).toBeGreaterThan(field === "brands" ? 5 : 8);
        expect(seen.has(normalise(value)), `${field}: ${value}`).toBe(false);
        seen.add(normalise(value));
      }
    }
    for (let i = 0; i < STARTER_IDENTITIES.length; i++) for (let j = i + 1; j < STARTER_IDENTITIES.length; j++) {
      const left = STARTER_IDENTITIES[i], right = STARTER_IDENTITIES[j];
      expect(similarity(left.sample.tagline!, right.sample.tagline!), `${left.key} / ${right.key}`).toBeLessThan(0.75);
    }
  });

  it("uses the authored identity, metadata, and revision in every canonical sample", () => {
    const headingOwners = new Map<string, string>();
    for (const key of ALL_TEMPLATE_KEYS()) {
      const entry = templateStarter(key)!;
      const site = sampleSite(key);
      expect(parseContent(site).ok, key).toBe(true);
      expect(site.origin.version, key).toBe(BUILTIN_TEMPLATE_REVISION);
      expect(site.business.name, key).toBe(entry.sample.businessName);
      expect(resolveTemplate(key)!.variation.description).toBe(entry.description);
      expect(site.pages.map((page) => page.slug), key).toEqual(["home", "about", "services", "faq", "gallery", "contact"]);
      const headings = visibleHeadings(site);
      for (const heading of new Set(headings)) {
        const normalised = normalise(heading);
        expect(headingOwners.get(normalised), `${key}: repeated visible heading '${heading}'`).toBeUndefined();
        headingOwners.set(normalised, key);
      }
      expect(headings, key).toContain(entry.sample.tagline);
      expect(headings, key).toContain(entry.headings[2]);
      expect(headings, key).toContain(entry.headings[3]);
      expect(headings, key).toContain(entry.headings[4]);
      expect(headings, key).toContain(entry.headings[5]);
      const json = JSON.stringify(site);
      expect(json, key).toContain(entry.footer);
      for (const faq of entry.sample.faqs!) expect(json, `${key}: ${faq.question}`).toContain(faq.question);
      expect(json, key).not.toMatch(/operating system.{0,10}for modern service teams|impossible.{0,10}to scroll past|Emergencies: call any time|Awards shortlisted|Asking price achieved|Faster replies|Fewer no-shows/);
      eachElement(site, (element) => {
        expect(element.type, `${key}: invented testimonial`).not.toBe("testimonials");
        if (element.type === "stats") {
          for (const item of element.props.items as Array<{ value: string; label: string; suffix: string }>) {
            expect(item.value, key).toMatch(/^0[1-3]$/);
            expect(entry.sample.services.map((service) => service.title), key).toContain(item.label);
            expect(item.suffix, key).toBe("");
          }
        }
        if (element.type === "button") {
          const link = element.props.link as { label: string; href: string };
          if (link.href.startsWith("tel:")) expect(link.label, key).toBe(`Call ${entry.sample.businessName}`);
        }
      });
    }
  });

  it("never repeats prose-length visible copy between templates", () => {
    // Walks everything a visitor can read in every page, the header and the footer. Editor-only fields (layer names, image-source labels, style
    // settings) are skipped. Short stock labels such as "Get in touch" may repeat; anything sentence-length (20+ characters, 3+ words) may not, apart from the opening-hours
    // line each family of five shares on purpose.
    const editorOnly = new Set(["id", "style", "responsive", "r", "origin", "design", "seo", "anim", "key", "kind", "type", "src", "name", "href", "image", "icon", "layout", "ref", "bg", "tone", "at", "size", "scene", "default"]);
    const allowed = new Set(STARTER_IDENTITIES.map((entry) => normalise(entry.sample.hours!)));
    const owners = new Map<string, string>();
    const collect = (value: unknown, found: string[]) => {
      if (typeof value === "string") { if (value.length >= 20 && value.trim().split(/\s+/).length >= 3 && !/^(https?:|\/|#|mailto:|tel:)/.test(value)) found.push(value); return; }
      if (Array.isArray(value)) { for (const item of value) collect(item, found); return; }
      if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) if (!editorOnly.has(name)) collect(child, found);
    };
    for (const key of ALL_TEMPLATE_KEYS()) {
      const site = sampleSite(key);
      const found: string[] = [];
      collect({ pages: site.pages.map((page) => page.items), header: site.header, footer: site.footer, globals: site.globals, business: site.business }, found);
      expect(found.length, key).toBeGreaterThan(20);
      for (const text of new Set(found)) {
        const id = normalise(text);
        if (!id || allowed.has(id)) continue;
        expect(owners.get(id), `${key} repeats '${text}'`).toSatisfy((owner: string | undefined) => owner === undefined || owner === key);
        owners.set(id, key);
      }
    }
  });

  it("gives every design its own contact details", () => {
    const phones = new Set<string>();
    const addresses = new Set<string>();
    for (const entry of STARTER_IDENTITIES) {
      expect(entry.sample.phone, entry.key).toMatch(/^\+1512555\d{4}$/);
      phones.add(entry.sample.phone!);
      addresses.add(entry.sample.address!);
      expect(entry.sample.address, entry.key).toContain(entry.sample.businessName);
    }
    expect(phones.size).toBe(50);
    expect(addresses.size).toBe(50);
  });

  it("does not invent operational metrics, endorsements, or availability for real customer builds", () => {
    for (const key of ALL_TEMPLATE_KEYS()) {
      const site = buildSite(key, {
        businessName: "The owner's business", industry: "home_services", phone: "+15125550143",
        tagline: "The owner's headline", description: "An owner-approved description.",
        aboutText: "An owner-approved account of the business.",
        services: [{ title: "Owner's service", description: "The owner's actual service description." }],
      });
      eachElement(site, (element) => {
        expect(["stats", "testimonials", "logos"], `${key}: invented proof`).not.toContain(element.type);
      });
      expect(JSON.stringify(site), key).not.toMatch(/usually the same day|Emergencies: call any time|Get a free quote|Free, clear quotes|Ready in a day|New: automations|Now with smart scheduling|12 new messages routed|2\.4m/);
    }
  });

  it("does not mutate source documents or apply authored samples to customer content", () => {
    const key = "tech.nova";
    const customer = buildSite(key, {
      businessName: "Customer's own business", industry: "agency", tagline: "A customer-edited heading",
      description: "An owner-provided introduction.", aboutText: "The owner's own story.",
      services: [{ title: "A real service", description: "A description supplied by the owner." }],
    });
    const before = JSON.stringify(customer);
    expect(applyTemplateStarterContent(customer, key)).toBe(customer);
    expect(JSON.stringify(customer)).toBe(before);
    expect(before).not.toContain("Novaline");
    expect(before).toContain("A customer-edited heading");
    expect(before).toContain("The owner's own story.");

    const source = sampleSite(key);
    const sourceBefore = JSON.stringify(source);
    const updated = applyTemplateStarterContent(source, key);
    expect(updated).not.toBe(source);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    const custom = structuredClone(source);
    custom.origin = { key: "custom.approved-snapshot", templateId: "00000000-0000-4000-8000-000000000001", version: 7 };
    expect(applyTemplateStarterContent(custom, key)).toBe(custom);
    expect(custom.origin.version).toBe(7);
  });
});
