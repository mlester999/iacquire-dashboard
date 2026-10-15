import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { parseContent, type ImageSrc } from "@/lib/website/doc";
import { templateImageRef, withTemplateImageDefault } from "@/lib/website/template-images";
import { ALL_TEMPLATE_KEYS, FAMILIES, buildSite, sampleSite } from "@/lib/website/templates/index";

const render = (content: ReturnType<typeof sampleSite>, page = "home", mode: "published" | "preview" = "preview") =>
  renderToStaticMarkup(React.createElement(SiteRenderer, { content, pageSlug: page, resolveAsset: () => null, mode, formAction: mode === "published" ? "/__iaq/form" : null, hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`) }));

function templateRefs(value: unknown): Array<{ id: string; label: string }> {
  const found: Array<{ id: string; label: string }> = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.kind === "template" && typeof record.id === "string" && typeof record.label === "string") found.push({ id: record.id, label: record.label });
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

describe("template catalog", () => {
  it("builds every template into a valid sample site that renders every page", () => {
    for (const key of ALL_TEMPLATE_KEYS()) {
      const site = sampleSite(key);
      expect(parseContent(site).ok, key).toBe(true);
      expect(site.isSample).toBe(true);
      for (const p of site.pages) {
        const html = render(site, p.slug);
        expect(html.length, `${key} ${p.slug}`).toBeGreaterThan(500);
      }
    }
  });
  it("every family has five variations", () => {
    for (const f of FAMILIES) expect(f.variations, f.id).toHaveLength(5);
  });
  it("builds from real details without inventing proof", () => {
    const site = buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Test Co", industry: "other", services: [{ title: "Repairs" }] });
    expect(site.isSample).toBe(false);
    expect(/\(sample\)/i.test(JSON.stringify(site))).toBe(false);
  });

  it("gives all 50 variations their own hero image and family-matched supporting images", () => {
    for (const key of ALL_TEMPLATE_KEYS()) {
      const site = sampleSite(key);
      const home = site.pages.find((page) => page.slug === "home")!;
      const first = home.items[0];
      const hero = first.type === "ref" ? site.globals[first.ref] : first;
      const family = key.split(".")[0];
      const refs = templateRefs(site);
      expect(templateRefs(hero).some((src) => src.id === key.replace(".", "-")), key).toBe(true);
      expect(refs.length, key).toBeGreaterThan(0);
      expect(refs.every((src) => src.id.startsWith(`${family}-`)), key).toBe(true);
      expect(new Set(refs.map((src) => src.id)).size, key).toBeGreaterThan(1);
    }
  });

  it("keeps a restore point on client image overrides", () => {
    const starter = templateImageRef("meridian-estate", "Hero image");
    const upload: ImageSrc = { kind: "asset", id: "00000000-0000-4000-8000-000000000001" };
    const replaced = withTemplateImageDefault(upload, starter);
    expect(replaced?.kind).toBe("asset");
    expect(replaced?.kind === "asset" ? replaced.default : null).toEqual(starter);
    expect(withTemplateImageDefault(null, replaced)).toEqual(starter);
  });
});
