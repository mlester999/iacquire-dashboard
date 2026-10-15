import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { parseContent } from "@/lib/website/doc";
import { ALL_TEMPLATE_KEYS, FAMILIES, buildSite, sampleSite } from "@/lib/website/templates/index";

const render = (content: ReturnType<typeof sampleSite>, page = "home", mode: "published" | "preview" = "preview") =>
  renderToStaticMarkup(React.createElement(SiteRenderer, { content, pageSlug: page, resolveAsset: () => null, mode, formAction: mode === "published" ? "/__iaq/form" : null, hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`) }));

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
});
