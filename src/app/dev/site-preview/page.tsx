import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { SiteRenderer } from "@/components/website/site-renderer";
import { TemplateThumb } from "@/components/website/template-thumb";
import type { ResolvedAsset } from "@/components/website/parts";
import { sampleContent } from "@/lib/website/generate";
import { ALL_TEMPLATE_KEYS, FAMILIES, resolveTemplate } from "@/lib/website/templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website template preview" };

// A gradient picture so layouts that expect photos can be judged with images present.
const picture = (id: string | null | undefined): ResolvedAsset | null => {
  if (!id) return null;
  const hue = (id.charCodeAt(0) * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 60% 35%)"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/></svg>`;
  return { src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, width: 1200, height: 800, alt: "Sample picture" };
};

/**
 * Development only (404 in production): the real site renderer on sample data, to judge templates at any width.
 *   ?view=grid                       every template as a live thumbnail
 *   ?template=forge.foreman&w=390    one template in a frame of that width (390, 768, 1280)
 */
export default async function SitePreview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const industry = q.industry ?? "other";
  const primary = /^[0-9a-f]{6}$/i.test(q.primary ?? "") ? `#${q.primary}` : undefined;
  const accent = /^[0-9a-f]{6}$/i.test(q.accent ?? "") ? `#${q.accent}` : undefined;
  const brand = primary || accent ? { primary: primary ?? "#2c5bff", accent: accent ?? "#12c9a5" } : undefined;

  if (q.view === "grid") {
    return (
      <div className="min-h-dvh bg-[#f5f6fa] p-6">
        <p className="mb-4 text-sm text-[#646d80]">Design preview: sample content, {ALL_TEMPLATE_KEYS.length} templates.</p>
        <div className="space-y-10">
          {FAMILIES.map((f) => (
            <section key={f.id}>
              <h2 className="mb-3 text-lg font-semibold">{f.name} <span className="text-sm font-normal text-[#646d80]">{f.tagline}</span></h2>
              <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
                {f.variations.map((v) => (
                  <a key={v.id} href={`?template=${f.id}.${v.id}&industry=${f.industries[0] ?? "other"}`} className="block">
                    <TemplateThumb templateKey={`${f.id}.${v.id}`} industry={f.industries[0] ?? "other"} scale={0.2} brand={brand} />
                    <p className="mt-1.5 text-sm font-medium">{v.name}</p>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  const key = q.template && resolveTemplate(q.template) ? q.template : "summit.peak";
  const width = Math.min(1600, Math.max(320, Number(q.w) || 1280));
  const content = sampleContent(industry, key);
  const page = content.pages.find((p) => p.slug === q.page)?.slug ?? "home";
  const shown = brand ? { ...content, brand: { ...content.brand, ...brand } } : content;
  return (
    <div className="min-h-dvh bg-[#d9dce5] py-4">
      <p className="mb-2 text-center text-xs text-[#4b5563]">
        {key} · {page} · {width}px · pages: {content.pages.map((p) => p.slug).join(", ")}
      </p>
      <div className="mx-auto overflow-hidden bg-white shadow-xl" style={{ width }}>
        <SiteRenderer content={shown} templateKey={key} pageSlug={page} resolveAsset={q.images === "0" ? () => null : picture} mode="preview" formAction={null} hrefFor={(s) => `?template=${key}&industry=${industry}&w=${width}&page=${s}`} year={2026} />
      </div>
    </div>
  );
}
