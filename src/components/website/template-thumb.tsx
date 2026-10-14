import * as React from "react";
import { sampleContent } from "@/lib/website/generate";
import type { SiteContent } from "@/lib/website/schema";
import { SiteRenderer } from "./site-renderer";
import type { ResolvedAsset } from "./parts";

const noAssets = (): ResolvedAsset | null => null;
const hrefFor = () => "#";

/**
 * A live, scaled-down render of a template for browsing. It draws the same renderer as the real site (so what you
 * choose is what you get), is inert (no focus, no clicks) and hidden from assistive technology; the label next to
 * it describes the template.
 */
export function TemplateThumb({
  templateKey, industry = "other", content, width = 1280, height = 820, scale = 0.24, pageSlug = "home", brand, maxSections = 3,
}: {
  templateKey: string; industry?: string; content?: SiteContent; width?: number; height?: number; scale?: number; pageSlug?: string; brand?: { primary: string; accent: string };
  /** Only the top of the page is ever visible in a thumbnail, so the rest is not drawn. */
  maxSections?: number;
}) {
  const base = content ?? sampleContent(industry, templateKey);
  const withBrand = brand ? { ...base, brand: { ...base.brand, ...brand } } : base;
  const shown: SiteContent = { ...withBrand, pages: withBrand.pages.map((p) => (p.slug === pageSlug ? { ...p, sections: p.sections.slice(0, maxSections) } : p)) };
  return (
    <div aria-hidden className="relative overflow-hidden rounded-xl border border-line bg-white" style={{ width: width * scale, height: height * scale }}>
      <div inert style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none" }}>
        <SiteRenderer content={shown} templateKey={templateKey} pageSlug={pageSlug} resolveAsset={noAssets} mode="preview" embedded formAction={null} hrefFor={hrefFor} year={2026} />
      </div>
    </div>
  );
}
